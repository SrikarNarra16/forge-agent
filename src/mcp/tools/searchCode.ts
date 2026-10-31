import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitToBudget } from "../../util/tokens";
import type { WorkspaceHost } from "../host";
import { extractSymbols, languageOf } from "../symbols";
import { READ_ONLY, errorResult, runTool, summarize, textResult, throwIfAborted, yieldToEventLoop, type ToolDeps } from "./common";

const MAX_FILES = 5000;
const MAX_FILE_CHARS = 1_000_000;
const MAX_LINE_PREVIEW = 200;
const YIELD_EVERY_FILES = 50;
const SOURCE_GLOBS = ["*.py", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

export type SearchKind = "text" | "symbol" | "path";

export interface SearchCodeArgs {
  query: string;
  kind?: SearchKind | undefined;
  max?: number | undefined;
}

/**
 * search_code: until the P07 index exists this scans files from host.findFiles, asynchronously and
 * cancellably (yielding every 50 files). Case-insensitive literal matching, never a regex.
 */
export async function runSearchCode(host: WorkspaceHost, deps: ToolDeps, args: SearchCodeArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "search_code", summarize({ query: args.query, kind: args.kind, max: args.max }), signal, async () => {
    const query = (args.query ?? "").trim();
    if (query === "") return errorResult("query is required and must not be empty. Pass a function name, identifier or text to find, e.g. query='get_debug_flag'.");
    const kind = args.kind ?? "text";
    if (!["text", "symbol", "path"].includes(kind)) return errorResult(`kind must be one of text, symbol, path (got '${String(args.kind)}').`);
    const max = args.max ?? 20;
    if (!Number.isInteger(max) || max < 1 || max > 100) return errorResult(`max must be a whole number from 1 to 100 (got ${String(args.max)}).`);

    const needle = query.toLowerCase();
    const found = await host.findFiles({ ...(kind === "symbol" ? { globs: SOURCE_GLOBS } : {}), max: MAX_FILES, ...(signal ? { signal } : {}) });
    const matches: string[] = [];
    let scanned = 0;

    if (kind === "path") {
      const base = (p: string): string => p.slice(p.lastIndexOf("/") + 1).toLowerCase();
      const hits = found.files.filter((f) => f.toLowerCase().includes(needle)).sort((a, b) => Number(base(b).includes(needle)) - Number(base(a).includes(needle)) || a.localeCompare(b));
      matches.push(...hits.slice(0, max + 1));
      scanned = found.files.length;
    } else {
      for (const [i, file] of found.files.entries()) {
        throwIfAborted(signal);
        if (i % YIELD_EVERY_FILES === YIELD_EVERY_FILES - 1) await yieldToEventLoop();
        let text: string;
        try {
          text = await host.readText(file, signal);
        } catch {
          throwIfAborted(signal);
          continue; // unreadable (binary, too large, vanished): skip
        }
        scanned++;
        if (text.length > MAX_FILE_CHARS || text.includes("\0")) continue;
        if (kind === "text" && !text.toLowerCase().includes(needle)) continue;
        const lines = text.split("\n");
        if (kind === "text") {
          for (const [n, line] of lines.entries()) {
            if (line.toLowerCase().includes(needle)) matches.push(`${file}:${n + 1}: ${line.trim().slice(0, MAX_LINE_PREVIEW)}`);
            if (matches.length > max) break;
          }
        } else {
          const language = languageOf(file);
          if (!language) continue;
          for (const sym of extractSymbols(text, language)) {
            if (sym.name.toLowerCase().includes(needle)) matches.push(`${file}:${sym.line}: ${(lines[sym.line - 1] ?? "").trim().slice(0, MAX_LINE_PREVIEW)}`);
            if (matches.length > max) break;
          }
        }
        if (matches.length > max) break;
      }
    }

    if (matches.length === 0) {
      return textResult(
        `No matches for '${query}' (kind=${kind}, scanned ${scanned} files). Try a shorter or differently spelled query, kind=symbol to match function/class names, or kind=path to match file names.`,
      );
    }
    const moreExist = matches.length > max;
    const shownMatches = matches.slice(0, max);
    const fit = fitToBudget(shownMatches, deps.budgets.searchCodeTokens);
    const notes: string[] = [];
    if (fit.truncated) notes.push(`[truncated at the ${deps.budgets.searchCodeTokens}-token output budget: showing ${fit.shown} of ${shownMatches.length}${moreExist ? "+" : ""} matches; narrow the query]`);
    else if (moreExist) notes.push(`[showing the first ${max} matches; more exist. Narrow the query or raise max (up to 100)]`);
    if (found.truncated) notes.push(`[only the first ${MAX_FILES} files were searched]`);
    return textResult([fit.text, ...notes].join("\n"));
  });
}

export function registerSearchCode(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search the workspace. kind=text (default): case-insensitive literal text search over file contents, returns 'path:line: text' (NOT a regex). kind=symbol: functions/classes whose NAME contains the query (best for finding a definition). kind=path: files whose PATH contains the query. Respects .gitignore. Results are capped; refine the query if truncated.",
      inputSchema: {
        query: z.string().describe("What to look for: an identifier like 'get_debug_flag', a phrase, or part of a file path. Plain text, not a regex."),
        kind: z.enum(["text", "symbol", "path"]).optional().describe("text (default) = file contents; symbol = function/class names; path = file paths."),
        max: z.number().optional().describe("Maximum results, 1-100. Default 20."),
      },
      annotations: { title: "Search code", ...READ_ONLY },
    },
    (args, extra) => runSearchCode(host, deps, args, extra.signal),
  );
}

