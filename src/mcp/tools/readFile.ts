import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { estimateTokens } from "../../util/tokens";
import type { WorkspaceHost } from "../host";
import { READ_ONLY, errorResult, explainHostError, resolveWorkspacePath, runTool, summarize, textResult, type ToolDeps } from "./common";

const MAX_LINE_CHARS = 1000;
const MIN_WHY_CHARS = 5;

export interface ReadFileArgs {
  path: string;
  start?: number | undefined;
  end?: number | undefined;
  why: string;
}

/**
 * read_file: line-numbered text of a file range from the CURRENT buffer (unsaved edits included).
 * `why` is required and surfaced to the UI through the `context:read` event.
 */
export async function runReadFile(host: WorkspaceHost, deps: ToolDeps, args: ReadFileArgs, signal?: AbortSignal): Promise<CallToolResult> {
  const summary = summarize({ path: args.path, start: args.start, end: args.end, why: args.why });
  return runTool(deps, "read_file", summary, signal, async () => {
    const why = (args.why ?? "").trim();
    if (why.length < MIN_WHY_CHARS) {
      return errorResult("`why` is required: give one sentence (at least 5 characters) saying why you are reading this file, e.g. why='check how get_debug_flag parses env values'. Then call read_file again.");
    }
    const maxLines = deps.budgets.readFileMaxLines;
    const start = args.start ?? 1;
    if (!Number.isInteger(start) || start < 1) return errorResult(`start must be a whole number >= 1 (got ${String(args.start)}). Lines are 1-based.`);
    if (args.end !== undefined && (!Number.isInteger(args.end) || args.end < start)) {
      return errorResult(`end must be a whole number >= start (start=${start}, end=${String(args.end)}).`);
    }

    const root = await host.rootPath();
    const target = resolveWorkspacePath(root, args.path, { allowRoot: false });
    if (!target.ok) return errorResult(target.message);

    let text: string;
    try {
      text = await host.readText(target.rel, signal);
    } catch (err) {
      const teaching = explainHostError(err, target.rel);
      if (teaching) return errorResult(teaching);
      throw err;
    }

    const allLines = text.split(/\r?\n/);
    if (allLines.length > 1 && allLines[allLines.length - 1] === "") allLines.pop(); // trailing newline is not a line
    const total = text === "" ? 0 : allLines.length;
    if (total === 0) return textResult(`${target.rel} (empty file)`);
    if (start > total) {
      return errorResult(`${target.rel} has ${total} lines but start=${start} is past the end. Use start between 1 and ${total}.`);
    }

    const requestedEnd = Math.min(args.end ?? start + maxLines - 1, total);
    const end = Math.min(requestedEnd, start + maxLines - 1);
    const width = String(end).length;
    const body = allLines
      .slice(start - 1, end)
      .map((line, i) => {
        const shown = line.length > MAX_LINE_CHARS ? `${line.slice(0, MAX_LINE_CHARS)}… [line cut at ${MAX_LINE_CHARS} chars]` : line;
        return `${String(start + i).padStart(width)}| ${shown}`;
      })
      .join("\n");

    const footer =
      end < requestedEnd
        ? `\n[truncated: lines ${end + 1}-${requestedEnd} omitted; call read_file with start/end]`
        : end < total && args.end === undefined
          ? `\n[file has ${total} lines; call read_file with start=${end + 1} to continue]`
          : "";

    deps.events.emit("context:read", { path: target.rel, start, end, why, tokens: estimateTokens(body) });
    return textResult(`${target.rel} (lines ${start}-${end} of ${total})\n${body}${footer}`);
  });
}

export function registerReadFile(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "read_file",
    {
      title: "Read file",
      description:
        "Read a file (or a line range) from the workspace. Returns line-numbered text from the live editor buffer, so unsaved edits are included. At most 400 lines per call: for long files read the part you need with start/end. Cite what you read as path:line.",
      inputSchema: {
        path: z.string().describe("File path relative to the workspace root, e.g. 'src/flask/helpers.py'. Find it with search_code (kind=path) or list_dir if unsure."),
        start: z.number().optional().describe("First line to read, 1-based. Default 1."),
        end: z.number().optional().describe("Last line to read, inclusive. Default start+399; at most 400 lines are returned per call."),
        why: z.string().describe("REQUIRED. One sentence: why you are reading this file/range. It is shown to the user next to the file in the context panel."),
      },
      annotations: { title: "Read file", ...READ_ONLY },
    },
    (args, extra) => runReadFile(host, deps, args, extra.signal),
  );
}
