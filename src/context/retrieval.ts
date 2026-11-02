import { packContext, type Candidate, type ContextPlan } from "./budget";
import type { ContextIndex, IndexHit } from "./indexer";
import { tokenize } from "./tokenize";

/**
 * Automatic retrieval: query -> BM25 hits -> diversified candidates -> a plan that fits the token budget.
 * Strategy (also the write-up): lexical BM25 over identifier-aware tokens with field boosts (symbol x3, path x2,
 * signature x2, body x1); at most 2 chunks per file unless a further chunk scores close to the best hit; for each
 * file prefer the chunk whose SYMBOL matches the query; skip chunks that overlap ones already chosen or the
 * user's pinned items; small path-intent boosts when the request mentions tests or documentation. No embeddings,
 * no network: deterministic and fast. Pure and vscode-free.
 */
export const DEFAULT_MAX_PER_FILE = 2;
export const DEFAULT_POOL = 60;
/** A further chunk of an already-chosen file is allowed when it scores at least this fraction of the best hit. */
export const NEAR_TOP_RATIO = 0.8;
export const INTENT_BOOST = 1.25;

const TEST_PATH = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
const DOC_PATH = /(^|\/)docs?\/|\.(rst|md)$/i;
const TEST_WORDS = /\b(tests?|pytest|testing|unit tests?)\b/i;
const DOC_WORDS = /\b(docs?|documented|documenting|documentation|document|readme)\b/i;

export function isTestPath(path: string): boolean {
  return TEST_PATH.test(path);
}
export function isDocPath(path: string): boolean {
  return DOC_PATH.test(path);
}

/** Path multipliers implied by the request ("have a test" -> test files, "documented" -> docs). */
export function intentBoost(query: string): (path: string) => number {
  const wantsTests = TEST_WORDS.test(query);
  const wantsDocs = DOC_WORDS.test(query);
  return (path) => (wantsTests && isTestPath(path) ? INTENT_BOOST : 1) * (wantsDocs && isDocPath(path) ? INTENT_BOOST : 1);
}

function overlaps(a: { startLine: number; endLine: number }, b: { startLine: number; endLine: number }): boolean {
  const overlap = Math.min(a.endLine, b.endLine) - Math.max(a.startLine, b.startLine) + 1;
  if (overlap <= 0) return false;
  const smaller = Math.min(a.endLine - a.startLine + 1, b.endLine - b.startLine + 1);
  return overlap / smaller > 0.5;
}

/** True when a matched query term is part of the chunk's symbol name (the best evidence that this chunk is "the" one). */
function symbolMatches(hit: IndexHit): boolean {
  if (!hit.chunk.symbol) return false;
  const symbolTokens = new Set(tokenize(hit.chunk.symbol));
  return hit.terms.some((t) => symbolTokens.has(t));
}

export function diversify(hits: readonly IndexHit[], options: { maxPerFile?: number; nearTopRatio?: number; exclude?: readonly { path: string; startLine: number; endLine: number }[] } = {}): IndexHit[] {
  const maxPerFile = options.maxPerFile ?? DEFAULT_MAX_PER_FILE;
  const ratio = options.nearTopRatio ?? NEAR_TOP_RATIO;
  const top = hits[0]?.score ?? 0;
  const perFile = new Map<string, IndexHit[]>();
  for (const hit of hits) {
    if (options.exclude?.some((e) => e.path === hit.chunk.path && overlaps(e, hit.chunk))) continue;
    const list = perFile.get(hit.chunk.path) ?? [];
    if (list.some((h) => overlaps(h.chunk, hit.chunk))) continue;
    list.push(hit);
    perFile.set(hit.chunk.path, list);
  }
  const selected: IndexHit[] = [];
  for (const list of perFile.values()) {
    const ordered = [...list].sort((a, b) => Number(symbolMatches(b)) - Number(symbolMatches(a)) || b.score - a.score);
    ordered.forEach((hit, i) => {
      if (i < maxPerFile || hit.score >= top * ratio) selected.push(hit);
    });
  }
  return selected.sort((a, b) => b.score - a.score || (a.chunk.path < b.chunk.path ? -1 : a.chunk.path > b.chunk.path ? 1 : a.chunk.startLine - b.chunk.startLine));
}

export function toCandidate(hit: IndexHit): Candidate {
  return {
    path: hit.chunk.path,
    startLine: hit.chunk.startLine,
    endLine: hit.chunk.endLine,
    ...(hit.chunk.symbol ? { symbol: hit.chunk.symbol } : {}),
    kind: hit.chunk.kind,
    ...(hit.chunk.signature ? { signature: hit.chunk.signature } : {}),
    text: hit.chunk.text,
    source: "auto",
    score: hit.score,
    reason: hit.terms.length > 0 ? `matches: ${hit.terms.join(", ")}` : "matches the request",
  };
}

export interface RetrieveRequest {
  query: string;
  pinned?: readonly Candidate[];
  budgetTokens: number;
  /** Extra terms, e.g. the names of @symbol mentions. */
  extraTerms?: readonly string[];
  maxPerFile?: number;
  pool?: number;
  intentHints?: boolean;
  autoBodies?: number;
}

export interface RetrievalTiming {
  searchMs: number;
  packMs: number;
  totalMs: number;
}

export interface RetrievalResult {
  plan: ContextPlan;
  /** Raw BM25 hits considered, before diversification. */
  considered: number;
  timing: RetrievalTiming;
}

export function retrieve(index: ContextIndex, request: RetrieveRequest, now: () => number = () => performance.now()): RetrievalResult {
  const started = now();
  const query = [request.query, ...(request.extraTerms ?? [])].join(" ");
  const pinned = request.pinned ?? [];
  const boost = request.intentHints === false ? undefined : intentBoost(request.query);
  const hits = index.ready ? index.search(query, { limit: request.pool ?? DEFAULT_POOL, ...(boost ? { boost: (id: number) => boost(index.chunk(id)?.path ?? "") } : {}) }) : [];
  const chosen = diversify(hits, { ...(request.maxPerFile !== undefined ? { maxPerFile: request.maxPerFile } : {}), exclude: pinned });
  const searched = now();
  const plan = packContext({ pinned, auto: chosen.map(toCandidate), budgetTokens: request.budgetTokens, ...(request.autoBodies !== undefined ? { autoBodies: request.autoBodies } : {}) });
  const finished = now();
  return { plan, considered: hits.length, timing: { searchMs: searched - started, packMs: finished - searched, totalMs: finished - started } };
}
