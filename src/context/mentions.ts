import type { WorkspaceHost } from "../mcp/host";
import type { Candidate } from "./budget";
import type { ContextIndex } from "./indexer";
import { isDocPath, isTestPath } from "./retrieval";
import type { Chunk } from "./types";

/**
 * @mentions: `@path/to/file.py` pins a file (fuzzy: `@cli.py`, `@helpers`), `@#name` / `@symbol:name` pins a
 * symbol. Typed tokens are parsed from the message; the panel's chips add structured mentions. Resolution is
 * against the index, and anything that cannot be resolved yields a visible warning (never a silent drop).
 * Also provides the fuzzy suggestions behind the autocomplete. Pure and vscode-free.
 */
export type MentionKind = "file" | "symbol";

export interface Mention {
  kind: MentionKind;
  value: string;
}

const TOKEN = /(^|[\s(["'`])@(?:(#|symbol:)([A-Za-z_][\w.]*)|([\w./\-]*\w))/g;

/** Mentions typed in the text, in order, without duplicates. */
export function parseMentions(text: string): Mention[] {
  const found: Mention[] = [];
  for (const m of text.matchAll(TOKEN)) {
    const mention: Mention = m[3] ? { kind: "symbol", value: m[3] } : { kind: "file", value: m[4] ?? "" };
    if (mention.value !== "" && !found.some((f) => f.kind === mention.kind && f.value === mention.value)) found.push(mention);
  }
  return found;
}

/** The text without its @tokens, for building the retrieval query. */
export function stripMentions(text: string): string {
  return text.replace(TOKEN, (_m, lead: string) => lead).replace(/[ \t]{2,}/g, " ").trim();
}

export function mergeMentions(...lists: ReadonlyArray<readonly Mention[]>): Mention[] {
  const out: Mention[] = [];
  for (const mention of lists.flat()) if (!out.some((o) => o.kind === mention.kind && o.value === mention.value)) out.push(mention);
  return out;
}

/** Greedy subsequence match of `q` in `c`; returns undefined if it is not a subsequence. Bonuses for consecutive runs and word starts. */
function subsequence(q: string, c: string, base: number): { score: number; first: number } | undefined {
  let qi = 0;
  let score = 0;
  let previous = -2;
  let first = -1;
  for (let ci = 0; ci < c.length && qi < q.length; ci++) {
    if (c[ci] !== q[qi]) continue;
    if (first < 0) first = ci;
    score += 1;
    if (ci === previous + 1) score += 2;
    if (ci === 0 || "/._-".includes(c[ci - 1] ?? "")) score += 3;
    if (ci >= base) score += 1;
    previous = ci;
    qi++;
  }
  return qi < q.length ? undefined : { score, first };
}

/**
 * Fuzzy match of a query against a path (0 = no match). The file name is scored on its own as well as the
 * whole path, so `confg` prefers `config.py` over a match scattered through `src/...`; earlier matches in
 * the name, exact/prefix names and shorter paths win ties.
 */
export function fuzzyScore(query: string, candidate: string): number {
  const q = query.toLowerCase().replace(/\s+/g, "");
  const c = candidate.toLowerCase();
  if (q === "") return 1;
  const base = c.lastIndexOf("/") + 1;
  const name = c.slice(base);
  const stem = name.replace(/\.[^.]*$/, "");
  const whole = subsequence(q, c, base);
  const inName = subsequence(q, name, 0);
  let score = Math.max(whole?.score ?? 0, inName ? inName.score + 15 - inName.first * 0.5 : 0);
  if (score <= 0) return 0;
  if (name === q || stem === q) score += 50;
  else if (name.startsWith(q) || stem.startsWith(q)) score += 20;
  if (c.includes(q)) score += 10;
  // On a tie, source code is a better guess than docs or tests.
  return score - c.length * 0.01 - (isDocPath(c) || isTestPath(c) ? 0.3 : 0);
}

export interface FileSuggestion {
  kind: "file";
  value: string;
}
export interface SymbolSuggestion {
  kind: "symbol";
  value: string;
  path: string;
  line: number;
  detail: string;
}

export function suggestFiles(index: ContextIndex, query: string, limit = 8): FileSuggestion[] {
  return index
    .files()
    .map((path) => ({ path, score: fuzzyScore(query, path) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1))
    .slice(0, limit)
    .map((f) => ({ kind: "file", value: f.path }));
}

function symbolMatchScore(query: string, symbol: string): number {
  const q = query.toLowerCase();
  const s = symbol.toLowerCase();
  const last = s.slice(s.lastIndexOf(".") + 1);
  if (q === "") return 1;
  if (s === q) return 100;
  if (last === q) return 90;
  if (last.startsWith(q)) return 70;
  if (s.startsWith(q)) return 60;
  if (last.includes(q)) return 40;
  if (s.includes(q)) return 30;
  const fuzzy = fuzzyScore(q, s);
  return fuzzy > 0 ? Math.min(25, fuzzy) : 0;
}

export function suggestSymbols(index: ContextIndex, query: string, limit = 8): SymbolSuggestion[] {
  return index
    .symbols()
    .map((chunk) => ({ chunk, score: symbolMatchScore(query, chunk.symbol ?? "") }))
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || (a.chunk.symbol ?? "").length - (b.chunk.symbol ?? "").length || (a.chunk.path < b.chunk.path ? -1 : 1))
    .slice(0, limit)
    .map(({ chunk }) => ({ kind: "symbol", value: chunk.symbol ?? "", path: chunk.path, line: chunk.startLine, detail: `${chunk.path}:${chunk.startLine}` }));
}

export interface ResolvedMention {
  mention: Mention;
  path: string;
  symbol?: string;
}

export interface MentionResolution {
  pinned: Candidate[];
  resolved: ResolvedMention[];
  warnings: string[];
}

const OUTLINE_MAX = 80;

function outlineOf(index: ContextIndex, path: string): string[] {
  return index
    .chunksOf(path)
    .filter((c) => c.symbol && c.kind !== "doc")
    .slice(0, OUTLINE_MAX)
    .map((c) => `${c.startLine}: ${c.signature ?? c.symbol ?? ""}`);
}

function candidateOfChunk(chunk: Chunk, reason: string): Candidate {
  return {
    path: chunk.path,
    startLine: chunk.startLine,
    endLine: chunk.endLine,
    ...(chunk.symbol ? { symbol: chunk.symbol } : {}),
    kind: chunk.kind,
    ...(chunk.signature ? { signature: chunk.signature } : {}),
    text: chunk.text,
    source: "mention",
    score: 0,
    reason,
  };
}

function bestFile(index: ContextIndex, value: string): { path: string; others: string[] } | undefined {
  const files = index.files();
  const clean = value.replace(/^\.?\//, "");
  if (files.includes(clean)) return { path: clean, others: [] };
  const suffix = files.filter((f) => f.endsWith(`/${clean}`));
  if (suffix.length > 0) {
    const sorted = [...suffix].sort((a, b) => a.length - b.length || (a < b ? -1 : 1));
    return { path: sorted[0] ?? "", others: sorted.slice(1, 4) };
  }
  const ranked = files
    .map((path) => ({ path, score: fuzzyScore(clean, path) }))
    .filter((f) => f.score > 0)
    .sort((a, b) => b.score - a.score || (a.path < b.path ? -1 : 1));
  const first = ranked[0];
  if (!first) return undefined;
  const near = ranked.slice(1, 4).filter((r) => r.score >= first.score * 0.9).map((r) => r.path);
  return { path: first.path, others: near };
}

/** Resolves mentions to pinned candidates (files: live text + outline; symbols: the symbol's chunk). */
export async function resolveMentions(index: ContextIndex, host: WorkspaceHost, mentions: readonly Mention[]): Promise<MentionResolution> {
  const pinned: Candidate[] = [];
  const resolved: ResolvedMention[] = [];
  const warnings: string[] = [];
  for (const mention of mentions) {
    const label = `@${mention.kind === "symbol" ? "#" : ""}${mention.value}`;
    if (!index.ready) {
      warnings.push(`Index still building: could not resolve ${label}.`);
      continue;
    }
    if (mention.kind === "file") {
      const match = bestFile(index, mention.value);
      if (!match) {
        warnings.push(`Could not resolve ${label}: no file in the index matches.`);
        continue;
      }
      if (match.others.length > 0) warnings.push(`${label} matches several files; using ${match.path} (also: ${match.others.join(", ")}).`);
      let text = "";
      let lines = 0;
      try {
        text = await host.readText(match.path);
        lines = text === "" ? 0 : text.split("\n").length - (text.endsWith("\n") ? 1 : 0);
      } catch {
        text = ""; // unreadable now: the outline still helps
      }
      const chunkLines = Math.max(0, ...index.chunksOf(match.path).map((c) => c.endLine));
      pinned.push({
        path: match.path,
        startLine: 1,
        endLine: Math.max(lines, chunkLines, 1),
        kind: "module",
        text: text.endsWith("\n") ? text.slice(0, -1) : text,
        source: "mention",
        score: 0,
        reason: `pinned by ${label}`,
        outline: outlineOf(index, match.path),
      });
      resolved.push({ mention, path: match.path });
    } else {
      const ranked = index
        .symbols()
        .map((chunk) => ({ chunk, score: symbolMatchScore(mention.value, chunk.symbol ?? "") }))
        .filter((s) => s.score >= 30)
        .sort((a, b) => b.score - a.score || (a.chunk.symbol ?? "").length - (b.chunk.symbol ?? "").length || (a.chunk.path < b.chunk.path ? -1 : 1));
      const first = ranked[0];
      if (!first) {
        warnings.push(`Could not resolve ${label}: no symbol with that name in the index.`);
        continue;
      }
      const same = ranked.filter((r) => r.score === first.score && r.chunk !== first.chunk).slice(0, 3);
      if (same.length > 0) warnings.push(`${label} matches several symbols; using ${first.chunk.symbol} in ${first.chunk.path} (also: ${same.map((s) => `${s.chunk.symbol} in ${s.chunk.path}`).join(", ")}).`);
      pinned.push(candidateOfChunk(first.chunk, `pinned by ${label}`));
      resolved.push({ mention, path: first.chunk.path, ...(first.chunk.symbol ? { symbol: first.chunk.symbol } : {}) });
    }
  }
  return { pinned, resolved, warnings };
}
