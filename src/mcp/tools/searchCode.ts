import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import { fitToBudget } from "../../util/tokens";
import type { ContextIndex } from "../../context/indexer";
import type { WorkspaceHost } from "../host";
import { SYMBOL_KINDS } from "../../context/types";
import { extractSymbols, languageOf } from "../symbols";
import { indexedSymbolMatches, indexedTextMatches, rankedLines } from "./indexSearch";
import { READ_ONLY, errorResult, runTool, summarize, textResult, throwIfAborted, yieldToEventLoop, type ToolDeps } from "./common";

const MAX_FILES = 5000;
const MAX_FILE_CHARS = 1_000_000;
const MAX_LINE_PREVIEW = 200;
const YIELD_EVERY_FILES = 50;
const SOURCE_GLOBS = ["*.py", "*.ts", "*.tsx", "*.js", "*.jsx", "*.mjs", "*.cjs"];

export type SearchKind = "text" | "symbol" | "path" | "docs";

export interface SearchCodeArgs {
  query: string;
  kind?: SearchKind | undefined;
  max?: number | undefined;
}

/**
 * search_code: served from the context index once it is ready (no file reads, unsaved edits included);
 * otherwise it scans files from host.findFiles, asynchronously and cancellably (yielding every 50 files).
 * text is case-insensitive literal matching, never a regex; symbol and docs are BM25-ranked with reasons.
 */
export async function runSearchCode(host: WorkspaceHost, deps: ToolDeps, args: SearchCodeArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "search_code", summarize({ query: args.query, kind: args.kind, max: args.max }), signal, async () => {
    const query = (args.query ?? "").trim();
    if (query === "") return errorResult("query is required and must not be empty. Pass a function name, identifier or text to find, e.g. query='get_debug_flag'.");
    const kind = args.kind ?? "text";
    if (!["text", "symbol", "path", "docs"].includes(kind)) return errorResult(`kind must be one of text, symbol, path, docs (got '${String(args.kind)}').`);
    const max = args.max ?? 20;
    if (!Number.isInteger(max) || max < 1 || max > 100) return errorResult(`max must be a whole number from 1 to 100 (got ${String(args.max)}).`);

    const needle = query.toLowerCase();
    const index = deps.index?.ready ? deps.index : undefined;
    if (index && kind !== "path") {
      const result = indexedAnswer(index, kind, query, needle, max);
      if (result) return finish(result.matches, max, deps, { header: result.header, scanned: result.scanned });
    }
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
    return finish(matches, max, deps, { truncatedWalk: found.truncated });
  });
}

interface Finish {
  header?: string | undefined;
  scanned?: number | undefined;
  truncatedWalk?: boolean | undefined;
}

function finish(matches: string[], max: number, deps: ToolDeps, extra: Finish): CallToolResult {
  const moreExist = matches.length > max;
  const shownMatches = matches.slice(0, max);
  const fit = fitToBudget(shownMatches, deps.budgets.searchCodeTokens);
  const notes: string[] = [];
  if (fit.truncated) notes.push(`[truncated at the ${deps.budgets.searchCodeTokens}-token output budget: showing ${fit.shown} of ${shownMatches.length}${moreExist ? "+" : ""} matches; narrow the query]`);
  else if (moreExist) notes.push(`[showing the first ${max} matches; more exist. Narrow the query or raise max (up to 100)]`);
  if (extra.truncatedWalk) notes.push(`[only the first ${MAX_FILES} files were searched]`);
  return textResult([...(extra.header ? [extra.header] : []), fit.text, ...notes].join("\n"));
}

/** Answers text / symbol / docs from the index. undefined = nothing found, let the caller report it. */
function indexedAnswer(index: ContextIndex, kind: SearchKind, query: string, needle: string, max: number): { matches: string[]; header?: string; scanned: number } | undefined {
  const scanned = index.stats.files;
  if (kind === "text") {
    const literal = indexedTextMatches(index, needle, max);
    if (literal.matches.length > 0) return { matches: literal.matches, scanned };
    const ranked = rankedLines(index.search(query, { limit: max }));
    return ranked.length > 0
      ? { matches: ranked, header: `No literal matches for '${query}' (kind=text, searched ${scanned} files). Closest by relevance (path:lines symbol [matches]):`, scanned }
      : undefined;
  }
  if (kind === "symbol") {
    const named = indexedSymbolMatches(index, needle);
    if (named.length > 0) return { matches: named.slice(0, max + 1), scanned };
    const ranked = rankedLines(index.search(query, { limit: max, kinds: SYMBOL_KINDS }));
    return ranked.length > 0
      ? { matches: ranked, header: `No symbol name contains '${query}'. Closest symbols by relevance (path:lines symbol [matches]):`, scanned }
      : undefined;
  }
  const docs = rankedLines(index.search(query, { limit: max, kinds: new Set(["doc"]) }));
  return docs.length > 0 ? { matches: docs, header: "Documentation sections by relevance (path:lines heading [matches]):", scanned } : undefined;
}

export function registerSearchCode(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "search_code",
    {
      title: "Search code",
      description:
        "Search the workspace. kind=text (default): case-insensitive literal text search over file contents, returns 'path:line: text' (NOT a regex). kind=symbol: functions/classes whose NAME contains the query (best for finding a definition); if none, the closest symbols by relevance. kind=docs: documentation sections (.rst/.md) ranked by relevance. kind=path: files whose PATH contains the query. When nothing matches literally, text search returns the closest chunks by relevance with the matched words. Respects .gitignore. Results are capped; refine the query if truncated.",
      inputSchema: {
        query: z.string().describe("What to look for: an identifier like 'get_debug_flag', a phrase, or part of a file path. Plain text, not a regex."),
        kind: z.enum(["text", "symbol", "path", "docs"]).optional().describe("text (default) = file contents; symbol = function/class names; docs = documentation sections; path = file paths."),
        max: z.number().optional().describe("Maximum results, 1-100. Default 20."),
      },
      annotations: { title: "Search code", ...READ_ONLY },
    },
    (args, extra) => runSearchCode(host, deps, args, extra.signal),
  );
}

