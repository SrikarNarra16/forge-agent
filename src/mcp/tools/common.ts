import * as path from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { isInside } from "../../util/paths";
import { HostError } from "../host";
import { DecisionStore } from "../decisions";
import type { McpEvents } from "../events";

/** Shared helpers for the MCP tools: dependencies, path safety, result builders and the tool runner. */

export interface ToolBudgets {
  /** Token budget of a repo_map result. */
  repoMapTokens: number;
  /** Token budget of a search_code result. */
  searchCodeTokens: number;
  /** Maximum lines returned by one read_file call. */
  readFileMaxLines: number;
  /** Maximum entries returned by one list_dir call. */
  listDirMaxEntries: number;
}

export const DEFAULT_BUDGETS: ToolBudgets = {
  repoMapTokens: 3000,
  searchCodeTokens: 4000,
  readFileMaxLines: 400,
  listDirMaxEntries: 200,
};

export interface ToolDeps {
  /** Receives tool name, duration and an argument summary. Never file contents. */
  log: (message: string) => void;
  events: McpEvents;
  budgets: ToolBudgets;
  /** What the user decided for propose_edit / create_file calls (written by the extension's review handler). */
  decisions: DecisionStore;
}

export function createToolDeps(deps: Pick<ToolDeps, "log" | "events"> & { budgets?: Partial<ToolBudgets>; decisions?: DecisionStore }): ToolDeps {
  return { log: deps.log, events: deps.events, budgets: { ...DEFAULT_BUDGETS, ...deps.budgets }, decisions: deps.decisions ?? new DecisionStore() };
}

/** Annotations for the read-only tools; annotations are informational, gating is by NAME in the agent spec. */
export const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;

/** Path segments the agent can never address, even with an explicit path. */
export const BLOCKED_SEGMENTS = [".git", "node_modules", ".venv"] as const;

export type PathResolution = { ok: true; rel: string; abs: string } | { ok: false; message: string };

/**
 * Resolves an agent-supplied path against the workspace root. Rejects traversal (`..`), absolute paths
 * outside the root and anything under .git / node_modules / .venv, with a message that teaches the fix.
 * `rel` is POSIX-separated; "" means the root.
 */
export function resolveWorkspacePath(root: string, input: string | undefined, options: { allowRoot?: boolean } = {}): PathResolution {
  const raw = (input ?? "").trim().replace(/\\/g, "/");
  if (raw === "" || raw === "." || raw === "./") {
    return options.allowRoot === false
      ? { ok: false, message: "A path is required. Pass a path relative to the workspace root, e.g. 'src/app.py'." }
      : { ok: true, rel: "", abs: root };
  }
  const abs = path.isAbsolute(raw) ? path.resolve(raw) : path.resolve(root, raw);
  if (!isInside(root, abs)) {
    return {
      ok: false,
      message: `Path is outside the workspace: ${raw}. Use a path relative to the workspace root (e.g. 'src/flask/helpers.py'); '..' and absolute paths elsewhere are not allowed.`,
    };
  }
  const rel = path.relative(root, abs).split(path.sep).join("/");
  const blocked = rel.split("/").find((seg) => (BLOCKED_SEGMENTS as readonly string[]).includes(seg.toLowerCase()));
  if (blocked) {
    return {
      ok: false,
      message: `Access denied: ${rel} is under '${blocked}', which is never exposed to the agent (.git, node_modules and .venv are excluded). Use list_dir or search_code to find project source files.`,
    };
  }
  return { ok: true, rel, abs };
}

export function textResult(text: string): CallToolResult {
  return { content: [{ type: "text", text }] };
}

export function errorResult(message: string): CallToolResult {
  return { isError: true, content: [{ type: "text", text: message }] };
}

/** Teaching message for a HostError raised while handling `rel`, or undefined if it is not one we explain. */
export function explainHostError(err: unknown, rel: string): string | undefined {
  if (!(err instanceof HostError)) return undefined;
  const shown = rel === "" ? "." : rel;
  switch (err.code) {
    case "ENOENT":
      return `Not found: ${shown}. Use list_dir to browse the directory, or search_code with kind=path to find the file by name.`;
    case "EISDIR":
      return `${shown} is a directory, not a file. Use list_dir to see its contents.`;
    case "ENOTDIR":
      return `${shown} is a file, not a directory. Use read_file to read it, or list_dir on its parent directory.`;
    case "EBINARY":
      return `${shown} looks like a binary file and cannot be shown as text.`;
    case "ETOOBIG":
      return `${shown} is too large to read in one piece (${err.message}). Use search_code to locate the part you need.`;
    case "ESYMLINK":
      return `${shown} is a symbolic link; Forge does not follow symbolic links. Address the real path instead.`;
    case "ENOWORKSPACE":
      return "No workspace folder is open in VS Code, so there is nothing to read. Ask the user to open a folder.";
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  signal?.throwIfAborted();
}

/** Yields to the event loop so long scans never starve the extension host. */
export function yieldToEventLoop(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}

function isAbortError(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/**
 * Runs a tool body: never throws, converts failures into isError results, honours the abort signal and
 * logs `tool <name> <ms> <outcome> <summary>` (summary must not contain file contents).
 */
export async function runTool(
  deps: ToolDeps,
  name: string,
  summary: string,
  signal: AbortSignal | undefined,
  body: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  const started = performance.now();
  let outcome = "ok";
  try {
    throwIfAborted(signal);
    const result = await body();
    if (result.isError) outcome = "error";
    return result;
  } catch (err) {
    if (signal?.aborted || isAbortError(err)) {
      outcome = "cancelled";
      return errorResult("Cancelled.");
    }
    outcome = "failed";
    const detail = err instanceof Error ? err.message : String(err);
    return errorResult(`Unexpected error in ${name}: ${detail}. This is a problem in the Forge editor server; try different arguments or another tool.`);
  } finally {
    deps.log(`tool ${name} ${Math.round(performance.now() - started)}ms ${outcome} ${summary}`);
  }
}

/** Short, content-free argument summary for logs. */
export function summarize(args: Record<string, unknown>): string {
  return Object.entries(args)
    .filter(([, v]) => v !== undefined)
    .map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(v.length > 60 ? `${v.slice(0, 60)}…` : v) : String(v)}`)
    .join(" ");
}
