import type { ContextIndex, IndexHit } from "../../context/indexer";
import { SYMBOL_KINDS, type Chunk } from "../../context/types";
import { languageOf } from "../symbols";

/** Index-backed answers for search_code and repo_map (no file reads; unsaved edits included). */

const MAX_LINE_PREVIEW = 200;

/** First line of a chunk that holds the definition itself (decorators and comments come before it). */
export function definitionLine(chunk: Chunk): number {
  const lines = chunk.text.split("\n");
  let offset = 0;
  while (offset < lines.length - 1 && /^\s*(@|#)/.test(lines[offset] ?? "")) offset++;
  return chunk.startLine + offset;
}

function lineAt(chunk: Chunk, line: number): string {
  return (chunk.text.split("\n")[line - chunk.startLine] ?? "").trim().slice(0, MAX_LINE_PREVIEW);
}

function reason(hit: IndexHit): string {
  return hit.terms.length > 0 ? ` [matches: ${hit.terms.join(", ")}]` : "";
}

/** Literal, case-insensitive line matches ("path:line: text"), in path then line order, each line once. */
export function indexedTextMatches(index: ContextIndex, needle: string, limit: number): { matches: string[]; files: number } {
  const matches: string[] = [];
  const files = index.files().sort((a, b) => a.localeCompare(b));
  for (const file of files) {
    const found = new Map<number, string>();
    for (const chunk of index.chunksOf(file)) {
      if (!chunk.text.toLowerCase().includes(needle)) continue;
      chunk.text.split("\n").forEach((line, i) => {
        if (line.toLowerCase().includes(needle)) found.set(chunk.startLine + i, line.trim().slice(0, MAX_LINE_PREVIEW));
      });
    }
    for (const [line, text] of [...found.entries()].sort((a, b) => a[0] - b[0])) matches.push(`${file}:${line}: ${text}`);
    if (matches.length > limit) break;
  }
  return { matches, files: files.length };
}

/** Symbols whose own name contains the needle: "path:line: definition line". */
export function indexedSymbolMatches(index: ContextIndex, needle: string): string[] {
  return index
    .symbols()
    .filter((c) => SYMBOL_KINDS.has(c.kind) && languageOf(c.path) !== undefined && (c.symbol ?? "").slice((c.symbol ?? "").lastIndexOf(".") + 1).toLowerCase().includes(needle))
    .sort((a, b) => a.path.localeCompare(b.path) || a.startLine - b.startLine)
    .map((c) => {
      const line = definitionLine(c);
      return `${c.path}:${line}: ${lineAt(c, line)}`;
    });
}

/** Ranked chunks as "path:start-end symbol [matches: ...]". */
export function rankedLines(hits: readonly IndexHit[]): string[] {
  return hits.map((h) => `${h.chunk.path}:${h.chunk.startLine}-${h.chunk.endLine} ${h.chunk.symbol ?? h.chunk.kind}${reason(h)}`);
}

export interface MappedSymbol {
  kind: string;
  name: string;
  line: number;
}

/** Top-level symbols per source file, from the index; `scope` is a directory or file ("" = everything). */
export function indexedRepoMap(index: ContextIndex, scope: string): Array<{ path: string; symbols: MappedSymbol[] }> {
  const inScope = (p: string): boolean => scope === "" || p === scope || p.startsWith(`${scope}/`);
  return index
    .files()
    .filter((p) => languageOf(p) !== undefined && inScope(p))
    .sort((a, b) => a.localeCompare(b))
    .map((path) => ({
      path,
      symbols: index
        .chunksOf(path)
        .filter((c) => SYMBOL_KINDS.has(c.kind) && c.kind !== "method" && c.symbol !== undefined && !c.symbol.includes("."))
        .sort((a, b) => a.startLine - b.startLine)
        .map((c) => ({ kind: c.kind, name: c.symbol ?? "", line: definitionLine(c) })),
    }));
}
