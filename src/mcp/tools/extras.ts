import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitToBudget } from "../../util/tokens";
import type { WorkspaceHost } from "../host";
import { READ_ONLY, errorResult, resolveWorkspacePath, runTool, summarize, textResult, type ToolDeps } from "./common";

/**
 * forge-editor-extras: small read-only tools registered with preload:false, so the agent discovers them through
 * TrueForge's deferred tool loading (list_tools -> get_tool_info -> call_tool). git_* run FIXED git commands through
 * the same CommandRunner as run_command (no user-supplied shell text except a validated relative path).
 */
export const EXTRAS_SERVER = "forge-editor-extras";
export const EXTRAS_TOOL_NAMES = ["git_status", "git_diff", "find_references", "open_in_editor"] as const;
const GIT_TIMEOUT_MS = 20_000;
const MAX_REFERENCES = 60;

const shellQuote = (s: string): string => `'${s.replace(/'/g, `'\\''`)}'`;

async function git(deps: ToolDeps, host: WorkspaceHost, args: string, signal: AbortSignal | undefined): Promise<{ ok: true; text: string } | { ok: false; message: string }> {
  if (!deps.commands) return { ok: false, message: "git is not available in this editor session." };
  const root = await host.rootPath();
  const result = await deps.commands.run(`git --no-pager ${args}`, { cwd: root, timeoutMs: GIT_TIMEOUT_MS, signal, usePrefix: false });
  if (result.exitCode !== 0) return { ok: false, message: `git failed (exit ${String(result.exitCode)}): ${result.output.trim().split("\n").slice(-3).join(" ").slice(0, 300)}` };
  return { ok: true, text: result.output };
}

export async function runGitStatus(host: WorkspaceHost, deps: ToolDeps, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "git_status", "", signal, async () => {
    const out = await git(deps, host, "status --porcelain=v1 --branch", signal);
    if (!out.ok) return errorResult(out.message);
    const lines = out.text.trim().split("\n").filter(Boolean);
    const fit = fitToBudget(lines, 1500);
    const clean = lines.length <= 1;
    return textResult(`${fit.text}${fit.truncated ? `\n[showing ${fit.shown} of ${lines.length} lines]` : ""}${clean ? "\n(working tree clean)" : ""}`);
  });
}

export async function runGitDiff(host: WorkspaceHost, deps: ToolDeps, args: { path?: string | undefined }, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "git_diff", summarize({ path: args.path }), signal, async () => {
    let pathArg = "";
    if (args.path !== undefined && args.path.trim() !== "") {
      const target = resolveWorkspacePath(await host.rootPath(), args.path);
      if (!target.ok) return errorResult(target.message);
      pathArg = ` -- ${shellQuote(target.rel)}`;
    }
    const out = await git(deps, host, `diff --no-color --no-ext-diff HEAD${pathArg}`, signal);
    if (!out.ok) return errorResult(out.message);
    if (out.text.trim() === "") return textResult("No changes compared with HEAD (new untracked files are not shown; see git_status).");
    const lines = out.text.replace(/\n$/, "").split("\n");
    const fit = fitToBudget(lines, deps.budgets.searchCodeTokens);
    return textResult(`${fit.text}${fit.truncated ? `\n[diff truncated at the ${deps.budgets.searchCodeTokens}-token budget: showing ${fit.shown} of ${lines.length} lines; pass a path to see one file]` : ""}`);
  });
}

export async function runFindReferences(deps: ToolDeps, args: { symbol: string; max?: number | undefined }, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "find_references", summarize({ symbol: args.symbol, max: args.max }), signal, () => {
    const symbol = (args.symbol ?? "").trim();
    if (!/^[A-Za-z_][A-Za-z0-9_.]*$/.test(symbol)) return Promise.resolve(errorResult("symbol must be an identifier such as 'get_debug_flag' or 'FlaskGroup'."));
    const index = deps.index?.ready ? deps.index : undefined;
    if (!index) return Promise.resolve(errorResult("The code index is still building. Use search_code kind=text for a literal search meanwhile."));
    const max = Math.min(Math.max(args.max ?? 30, 1), MAX_REFERENCES);
    const name = symbol.slice(symbol.lastIndexOf(".") + 1);
    const word = new RegExp(`(?<![A-Za-z0-9_])${name.replace(/[$]/g, "\\$")}(?![A-Za-z0-9_])`);
    const hits: string[] = [];
    for (const file of index.files().sort()) {
      const seen = new Set<number>();
      for (const chunk of index.chunksOf(file)) {
        if (!chunk.text.includes(name)) continue;
        chunk.text.split("\n").forEach((line, i) => {
          const n = chunk.startLine + i;
          if (!seen.has(n) && word.test(line)) {
            seen.add(n);
            hits.push(`${file}:${n}: ${line.trim().slice(0, 160)}`);
          }
        });
      }
      if (hits.length > max * 4) break;
    }
    if (hits.length === 0) return Promise.resolve(textResult(`No references to '${name}' found in the index (lexical search over indexed files).`));
    const shown = hits.slice(0, max);
    return Promise.resolve(textResult(`${shown.join("\n")}${hits.length > max ? `\n[showing ${max} of ${hits.length}+ matches; lexical word match, not a language-server reference search]` : "\n[lexical word match, not a language-server reference search]"}`));
  });
}

export async function runOpenInEditor(host: WorkspaceHost, deps: ToolDeps, editor: { reveal(path: string, line?: number): Promise<void> } | undefined, args: { path: string; line?: number | undefined }, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "open_in_editor", summarize({ path: args.path, line: args.line }), signal, async () => {
    const target = resolveWorkspacePath(await host.rootPath(), args.path, { allowRoot: false });
    if (!target.ok) return errorResult(target.message);
    if (args.line !== undefined && (!Number.isInteger(args.line) || args.line < 1)) return errorResult("line must be a whole number >= 1.");
    if (!editor) return errorResult("No editor UI is available in this session.");
    try {
      await host.readText(target.rel, signal); // exists and is text
    } catch {
      return errorResult(`Not found or not a text file: ${target.rel}. Use list_dir or search_code kind=path.`);
    }
    await editor.reveal(target.rel, args.line);
    return textResult(`Opened ${target.rel}${args.line ? ` at line ${args.line}` : ""} in the editor for the user. Nothing was changed.`);
  });
}

export function registerExtrasTools(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "git_status",
    { title: "Git status", description: "Short git status of the workspace (branch and changed/untracked files, one line each). Read-only. Use it before finishing to see which files you changed.", inputSchema: {}, annotations: { title: "Git status", ...READ_ONLY } },
    (_args, extra) => runGitStatus(host, deps, extra.signal),
  );
  server.registerTool(
    "git_diff",
    {
      title: "Git diff",
      description: "Unified diff of the workspace against HEAD (all changed files, or one file with `path`). Read-only; output is capped. Use it to review your own changes before you finish.",
      inputSchema: { path: z.string().optional().describe("Limit the diff to this file, relative to the workspace root.") },
      annotations: { title: "Git diff", ...READ_ONLY },
    },
    (args, extra) => runGitDiff(host, deps, args, extra.signal),
  );
  server.registerTool(
    "find_references",
    {
      title: "Find references",
      description: "Find where an identifier is used: every line (path:line: text) that contains the symbol as a whole word, from the code index. Lexical, not a language-server search. Read-only.",
      inputSchema: {
        symbol: z.string().describe("Function, class or variable name, e.g. 'get_debug_flag'."),
        max: z.number().optional().describe("Maximum results, 1-60. Default 30."),
      },
      annotations: { title: "Find references", ...READ_ONLY },
    },
    (args, extra) => runFindReferences(deps, args, extra.signal),
  );
  server.registerTool(
    "open_in_editor",
    {
      title: "Open in editor",
      description: "Reveal a file (optionally at a line) in the user's editor so they can look at it. Changes nothing; it only moves the user's view.",
      inputSchema: {
        path: z.string().describe("File to open, relative to the workspace root."),
        line: z.number().optional().describe("1-based line to reveal."),
      },
      annotations: { title: "Open in editor", ...READ_ONLY },
    },
    (args, extra) => runOpenInEditor(host, deps, deps.editor, args, extra.signal),
  );
}
