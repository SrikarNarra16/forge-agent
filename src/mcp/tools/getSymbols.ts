import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { SymbolInfo, WorkspaceHost } from "../host";
import { extractSymbols, languageOf } from "../symbols";
import { READ_ONLY, errorResult, explainHostError, resolveWorkspacePath, runTool, summarize, textResult, type ToolDeps } from "./common";

const MAX_SYMBOLS = 300;

export interface GetSymbolsArgs {
  path: string;
}

function flatten(symbols: readonly SymbolInfo[], depth: number, out: string[]): void {
  for (const s of symbols) {
    out.push(`${"  ".repeat(depth)}${s.kind} ${s.name} L${s.line}-${s.endLine}`);
    if (s.children?.length) flatten(s.children, depth + 1, out);
  }
}

/** get_symbols: language-server outline of one file, with a regex fallback when the server returns nothing. */
export async function runGetSymbols(host: WorkspaceHost, deps: ToolDeps, args: GetSymbolsArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "get_symbols", summarize({ path: args.path }), signal, async () => {
    const root = await host.rootPath();
    const target = resolveWorkspacePath(root, args.path, { allowRoot: false });
    if (!target.ok) return errorResult(target.message);

    const lines: string[] = [];
    let source = "language server";
    let symbols: readonly SymbolInfo[] = [];
    try {
      symbols = await host.documentSymbols(target.rel);
      if (symbols.length > 0) {
        flatten(symbols, 0, lines);
      } else {
        const language = languageOf(target.rel);
        const text = await host.readText(target.rel, signal);
        source = "regex fallback; the language server returned nothing";
        if (language) for (const s of extractSymbols(text, language)) lines.push(`${s.kind} ${s.name} L${s.line}`);
      }
    } catch (err) {
      const teaching = explainHostError(err, target.rel);
      if (teaching) return errorResult(teaching);
      throw err;
    }

    if (lines.length === 0) {
      return textResult(`No symbols found in ${target.rel}. It may not be a supported source file; use read_file to look at it directly.`);
    }
    const shown = lines.slice(0, MAX_SYMBOLS);
    const footer = lines.length > shown.length ? `\n[${lines.length - shown.length} more symbols omitted]` : "";
    return textResult(`Symbols in ${target.rel} (${source}):\n${shown.join("\n")}${footer}`);
  });
}

export function registerGetSymbols(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "get_symbols",
    {
      title: "Get symbols",
      description:
        "Outline of one file: classes, functions and methods (nested) with their line ranges, from the editor's language server (regex fallback if none is available). Use it to find the exact line range to pass to read_file.",
      inputSchema: {
        path: z.string().describe("File path relative to the workspace root, e.g. 'src/flask/helpers.py'."),
      },
      annotations: { title: "Get symbols", ...READ_ONLY },
    },
    (args, extra) => runGetSymbols(host, deps, args, extra.signal),
  );
}
