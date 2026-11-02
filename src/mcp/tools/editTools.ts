import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { decisionKey, type EditDecision } from "../decisions";
import { errorResult, runTool, summarize, textResult, type ToolDeps } from "./common";

/**
 * propose_edit and create_file. They NEVER write. TrueForge gates them by name; the extension's
 * ApprovalHandler runs the diff review, applies the accepted hunks and records a decision; these handlers
 * only look that decision up and report it to the agent. If there is none the call was not approved and
 * nothing changed.
 */

export const WRITE_ANNOTATIONS = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false } as const;

// Schemas keep to types and required fields; semantic checks (non-empty, size) happen in the handlers so
// the model gets a teaching isError result instead of a JSON-RPC validation error.
export const proposeEditShape = {
  path: z.string().describe("Existing file to change, relative to the workspace root, e.g. 'src/flask/helpers.py'. One file per call."),
  edits: z
    .array(
      z.object({
        old_text: z.string().describe("Exact text currently in the file, copied character for character (indentation included), WITHOUT read_file's line numbers. It must occur exactly once: use a short anchor of a few lines that is unique."),
        new_text: z.string().describe("The replacement text, in the same indentation and style as the surrounding code. Use an empty string to delete old_text."),
      }),
    )
    .describe("Search/replace edits, applied in order; each old_text is matched against the file after the previous edits."),
  summary: z.string().describe("One sentence saying what this change does. It is shown to the user above the diff."),
};

export const createFileShape = {
  path: z.string().describe("New file to create, relative to the workspace root. Parent folders are created. The file must not exist yet. One file per call."),
  content: z.string().describe("The complete content of the new file."),
  summary: z.string().describe("One sentence saying what this file is for. It is shown to the user above the diff."),
};

export const proposeEditSchema = z.object(proposeEditShape);
export const createFileSchema = z.object(createFileShape);

export type ProposeEditArgs = z.infer<typeof proposeEditSchema>;
export type CreateFileArgs = z.infer<typeof createFileSchema>;
export type EditToolName = "propose_edit" | "create_file";

export type ParsedEditArgs = { ok: true; tool: "propose_edit"; args: ProposeEditArgs } | { ok: true; tool: "create_file"; args: CreateFileArgs } | { ok: false; error: string };

/**
 * Parses raw tool arguments (an object, or the JSON string the model produced) with the schema the tool
 * itself uses. Both the approval handler and the tool handler go through this, so the decision key is
 * computed from identical, schema-stripped data on both sides.
 */
export function parseEditArgs(tool: EditToolName, raw: unknown): ParsedEditArgs {
  let value = raw;
  if (typeof raw === "string") {
    try {
      value = JSON.parse(raw);
    } catch {
      return { ok: false, error: `The arguments of ${tool} are not valid JSON. Call ${tool} again with a JSON object.` };
    }
  }
  if (tool === "propose_edit") {
    const parsed = proposeEditSchema.safeParse(value);
    if (!parsed.success) return { ok: false, error: `Invalid arguments for propose_edit: ${describeIssues(parsed.error)}. Expected {path, edits:[{old_text,new_text}], summary}.` };
    if (parsed.data.edits.length === 0) return { ok: false, error: "propose_edit needs at least one edit in `edits`." };
    if (parsed.data.summary.trim() === "") return { ok: false, error: "`summary` is required: one sentence describing the change." };
    return { ok: true, tool, args: parsed.data };
  }
  const parsed = createFileSchema.safeParse(value);
  if (!parsed.success) return { ok: false, error: `Invalid arguments for create_file: ${describeIssues(parsed.error)}. Expected {path, content, summary}.` };
  if (parsed.data.summary.trim() === "") return { ok: false, error: "`summary` is required: one sentence describing the file." };
  return { ok: true, tool, args: parsed.data };
}

function describeIssues(error: z.ZodError): string {
  return error.issues.map((i) => `${i.path.join(".") || "(arguments)"}: ${i.message}`).join("; ");
}

/** The decision key for a tool call, from raw arguments. Undefined when the arguments do not parse. */
export function keyForCall(tool: EditToolName, raw: unknown): string | undefined {
  const parsed = parseEditArgs(tool, raw);
  return parsed.ok ? decisionKey(tool, parsed.args) : undefined;
}

/** The agent-facing sentence for a recorded decision. */
export function formatDecision(d: EditDecision): string {
  if (d.kind === "create") return `created ${d.path} (+${d.added} lines)`;
  const stats = `(+${d.added} -${d.removed} lines)`;
  const base = `applied ${d.applied} of ${d.total} hunks ${stats} to ${d.path}`;
  return d.rejected.length > 0 ? `${base}; rejected: ${d.rejected.join("; ")}` : base;
}

async function report(deps: ToolDeps, tool: EditToolName, raw: unknown, signal: AbortSignal | undefined, summaryArgs: Record<string, unknown>): Promise<CallToolResult> {
  return runTool(deps, tool, summarize(summaryArgs), signal, () => {
    const key = keyForCall(tool, raw);
    const decision = key ? deps.decisions.take(key) : undefined;
    if (!decision) {
      return Promise.resolve(
        errorResult(`not approved: there is no user approval recorded for this ${tool} call, so nothing was changed. Do not retry the identical call; explain what you wanted to change and ask the user how to proceed.`),
      );
    }
    if (decision.applied === 0) return Promise.resolve(errorResult(`User rejected all changes to ${decision.path}`));
    return Promise.resolve(textResult(formatDecision(decision)));
  });
}

export function runProposeEdit(deps: ToolDeps, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const a = args as Partial<ProposeEditArgs> | undefined;
  return report(deps, "propose_edit", args, signal, { path: a?.path, edits: Array.isArray(a?.edits) ? a.edits.length : undefined });
}

export function runCreateFile(deps: ToolDeps, args: unknown, signal?: AbortSignal): Promise<CallToolResult> {
  const a = args as Partial<CreateFileArgs> | undefined;
  return report(deps, "create_file", args, signal, { path: a?.path, chars: typeof a?.content === "string" ? a.content.length : undefined });
}

export function registerEditTools(server: McpServer, deps: ToolDeps): void {
  server.registerTool(
    "propose_edit",
    {
      title: "Propose edit",
      description:
        "Propose changes to ONE existing file as search/replace edits. The user reviews every hunk in a diff and may accept some and reject others; nothing is written until they apply it. Each old_text must match the current file EXACTLY ONCE (whitespace and indentation included): use a small but unique anchor of a few lines, never the whole file. One file per call; make separate calls for other files. Read the file with read_file first so old_text is accurate and your change follows the project's conventions. The result says how many hunks were applied and which were rejected. Never tell the user a change is made until the result says 'applied'. If the user rejected everything, do not retry the same change; ask what they want instead.",
      inputSchema: proposeEditShape,
      annotations: { title: "Propose edit", ...WRITE_ANNOTATIONS },
    },
    (args, extra) => runProposeEdit(deps, args, extra.signal),
  );
  server.registerTool(
    "create_file",
    {
      title: "Create file",
      description:
        "Propose a NEW file with the given complete content. It fails if the file already exists (use propose_edit for existing files). The user reviews the file and may reject it; nothing is written until they apply it. One file per call. Follow the project's conventions for naming, style and layout (look at neighbouring files first). Never tell the user a file was created until the result says 'created'.",
      inputSchema: createFileShape,
      annotations: { title: "Create file", ...WRITE_ANNOTATIONS },
    },
    (args, extra) => runCreateFile(deps, args, extra.signal),
  );
}
