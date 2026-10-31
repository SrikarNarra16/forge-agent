import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitToBudget } from "../../util/tokens";
import { HostError, type WorkspaceHost } from "../host";
import { extractSymbols, languageOf, type FoundSymbol } from "../symbols";
import { READ_ONLY, errorResult, explainHostError, resolveWorkspacePath, runTool, summarize, textResult, throwIfAborted, yieldToEventLoop, type ToolDeps } from "./common";

const MAX_FILES = 3000;
const MAX_FILE_CHARS = 1_000_000;
const YIELD_EVERY_FILES = 50;
const SOURCE_GLOBS = ["*.py", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

export interface RepoMapArgs {
  path?: string | undefined;
}

interface MappedFile {
  path: string;
  symbols: FoundSymbol[];
}

function describeFile(file: MappedFile): string {
  if (file.symbols.length === 0) return `${file.path}: (no top-level symbols)`;
  const items = file.symbols.map((s) => (s.kind === "function" ? `${s.name}:${s.line}` : `${s.kind} ${s.name}:${s.line}`));
  return `${file.path}: ${items.join(", ")}`;
}

/** Directory summaries at the deepest depth (1..) whose rendering fits the budget. */
function summarizeDirectories(files: readonly MappedFile[], scope: string, budgetTokens: number): { text: string; depth: number } {
  const scopeDepth = scope === "" ? 0 : scope.split("/").length;
  let best = { text: "", depth: 1 };
  for (let depth = 1; depth <= 6; depth++) {
    const groups = new Map<string, { files: number; symbols: number }>();
    for (const f of files) {
      const parts = f.path.split("/").slice(0, -1);
      const key = parts.slice(0, scopeDepth + depth).join("/") || ".";
      const g = groups.get(key) ?? { files: 0, symbols: 0 };
      g.files++;
      g.symbols += f.symbols.length;
      groups.set(key, g);
    }
    const lines = [...groups.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([dir, g]) => `${dir}/ (${g.files} files, ${g.symbols} symbols)`);
    const fit = fitToBudget(lines, budgetTokens);
    if (fit.truncated && depth > 1) break;
    best = { text: fit.text, depth };
    if (fit.truncated) break;
  }
  return best;
}

/**
 * repo_map: compact outline of top-level classes/functions (with line numbers) for .py/.ts/.tsx/.js/.jsx
 * files under a path. Falls back to per-directory summaries when the detailed map exceeds the budget.
 */
export async function runRepoMap(host: WorkspaceHost, deps: ToolDeps, args: RepoMapArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "repo_map", summarize({ path: args.path }), signal, async () => {
    const root = await host.rootPath();
    const target = resolveWorkspacePath(root, args.path);
    if (!target.ok) return errorResult(target.message);

    let paths: string[];
    let truncatedWalk = false;
    try {
      if (target.rel !== "" && languageOf(target.rel)) {
        paths = [target.rel]; // a single source file
      } else {
        const found = await host.findFiles({ ...(target.rel === "" ? {} : { under: target.rel }), globs: SOURCE_GLOBS, max: MAX_FILES, ...(signal ? { signal } : {}) });
        paths = found.files;
        truncatedWalk = found.truncated;
      }
    } catch (err) {
      const teaching = explainHostError(err, target.rel);
      if (teaching) return errorResult(teaching);
      throw err;
    }
    paths.sort((a, b) => a.localeCompare(b));

    const files: MappedFile[] = [];
    for (const [i, p] of paths.entries()) {
      throwIfAborted(signal);
      if (i % YIELD_EVERY_FILES === YIELD_EVERY_FILES - 1) await yieldToEventLoop();
      const language = languageOf(p);
      if (!language) continue;
      try {
        const text = await host.readText(p, signal);
        files.push({ path: p, symbols: text.length > MAX_FILE_CHARS ? [] : extractSymbols(text, language) });
      } catch (err) {
        throwIfAborted(signal);
        if (paths.length === 1 && err instanceof HostError) {
          return errorResult(explainHostError(err, p) ?? err.message);
        }
        // unreadable files are left out of the map
      }
    }

    const scope = target.rel === "" ? "." : target.rel;
    if (files.length === 0) {
      return textResult(`No .py/.ts/.tsx/.js/.jsx source files found under ${scope}. Use list_dir to see what is there.`);
    }
    const budget = deps.budgets.repoMapTokens;
    const detailed = files.map(describeFile);
    const fit = fitToBudget(detailed, budget);
    const header = `Repo map of ${scope} (${files.length} files)`;
    const walkNote = truncatedWalk ? `\n[only the first ${MAX_FILES} files were mapped]` : "";
    if (!fit.truncated) return textResult(`${header}\n${fit.text}${walkNote}`);

    const dirs = summarizeDirectories(files, target.rel, budget);
    return textResult(
      `${header}: too large for a per-file outline, showing directory summaries\n${dirs.text}\n[call repo_map with a narrower path (e.g. one of the directories above) to see its files and symbols]${walkNote}`,
    );
  });
}

export function registerRepoMap(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "repo_map",
    {
      title: "Repo map",
      description:
        "Compact outline of the code: for each .py/.ts/.tsx/.js/.jsx file, its top-level classes and functions with line numbers ('path: class Flask:12, helper:40'). The cheapest way to orient in an unfamiliar repo before reading files. If the repo is too big, returns per-directory summaries: call again with a narrower path.",
      inputSchema: {
        path: z.string().optional().describe("Directory (or single source file) relative to the workspace root, e.g. 'src/flask'. Omit to map the whole workspace."),
      },
      annotations: { title: "Repo map", ...READ_ONLY },
    },
    (args, extra) => runRepoMap(host, deps, args, extra.signal),
  );
}
