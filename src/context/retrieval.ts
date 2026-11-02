import { packContext, type Candidate, type ContextPlan } from "./budget";
import type { ContextIndex, IndexHit } from "./indexer";
import { queryTerms, stem, tokenize } from "./tokenize";

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

/** A query word that equals a symbol's own name means "show me that definition". */
export const EXACT_SYMBOL_BOOST = 1.8;
/** Reciprocal-rank-fusion constant: small, so the top few ranks of each list dominate. */
export const RRF_K = 10;
/** A sentence needs at least this many distinct content terms to be searched on its own. */
export const MIN_CLAUSE_TERMS = 3;

/** A plain word counts as "an identifier the user means" only if it occurs in fewer than this fraction of chunks. */
export const IDENTIFIER_RARITY = 0.05;
/** Unstructured 60-line windows (data files, configs) are lower-quality evidence than parsed code or doc sections. */
export const WINDOW_PENALTY = 0.7;
/** Release notes mention every symbol ever touched, so they match everything. */
export const CHANGELOG_PENALTY = 0.5;

const CHANGELOG_PATH = /(^|\/)(changes|changelog|history|news|releases?)(\.[a-z]+)?$/i;
const TEST_PATH = /(^|\/)(tests?|__tests__)\/|(^|\/)test_[^/]*$|_test\.[a-z]+$|\.(test|spec)\.[a-z]+$/i;
const DOC_PATH = /(^|\/)docs?\/|\.(rst|md)$/i;
// Intent is a request to PRODUCE tests/docs ("add a test", "tests for", "documented"), not any mention of the word
// ("where is the test client created" is about code, not about tests).
const TEST_WORDS = /\b(?:(?:add|write|have|has|with|include|including|need|needs|create|new|update|an?|some|unit)\s+)(?:(?:an?|some|the|unit|new)\s+)*tests?\b|\btests?\s+(?:for|that|to|covering)\b|\bpytest\b/i;
const DOC_WORDS = /\b(?:docs?|documented|documenting|documentation|document|readme)\b/i;
const DOC_WORDS_GLOBAL = new RegExp(DOC_WORDS.source, "gi");

/**
 * "documented" asks for documentation (handled by the docs-path boost); as a lexical term it would only match
 * unrelated prose that happens to use the word, so it is removed from the text that is searched.
 */
export function withoutIntentWords(query: string): string {
  return DOC_WORDS.test(query) ? query.replace(DOC_WORDS_GLOBAL, " ") : query;
}

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

/** Chunk-level multiplier: intent hints + exact symbol match + quality of the chunk kind and path. */
export function chunkAdjustment(
  query: string,
  options: { intentHints?: boolean; commonness?: (word: string) => number } = {},
): (chunk: { path: string; symbol?: string; kind: string }) => number {
  const intent = options.intentHints === false ? undefined : intentBoost(query);
  // Words that can name a symbol: identifier-shaped ones (get_debug_flag, AppContext) or plain words rare in this
  // codebase (jsonify). A common word like "command" must not make every `.command` method a "definition".
  const words = new Set(
    (query.match(/[A-Za-z_][A-Za-z0-9_]*/g) ?? [])
      .filter((w) => /_|[a-z][A-Z]/.test(w) || (options.commonness?.(w) ?? 1) < IDENTIFIER_RARITY)
      .flatMap((w) => [w.toLowerCase(), stem(w.toLowerCase())]),
  );
  return (chunk) => {
    let factor = intent ? intent(chunk.path) : 1;
    if (chunk.symbol) {
      const last = chunk.symbol.slice(chunk.symbol.lastIndexOf(".") + 1).toLowerCase();
      if (words.has(last) || words.has(stem(last)) || words.has(chunk.symbol.toLowerCase())) factor *= EXACT_SYMBOL_BOOST;
    }
    if (chunk.kind === "window") factor *= WINDOW_PENALTY;
    if (CHANGELOG_PATH.test(chunk.path)) factor *= CHANGELOG_PENALTY;
    return factor;
  };
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

/**
 * Splits a request into sentences that are worth searching separately (at least MIN_CLAUSE_TERMS content terms).
 * Returns [] unless there are two or more, so a single-sentence request is searched exactly as before.
 */
export function splitClauses(query: string): string[] {
  const sentences = query
    .split(/(?<=[.!?])["')\]]*\s+(?=[A-Z`"'(])/)
    .map((x) => x.trim())
    .filter((x) => queryTerms(x).length >= MIN_CLAUSE_TERMS);
  return sentences.length >= 2 ? sentences : [];
}

/**
 * Reciprocal-rank fusion: a chunk's fused score is the sum of 1/(k+rank) over the rankings it appears in, so a
 * chunk that is near the top for ANY sentence of the request is surfaced, and chunks near the top for several
 * sentences rise further. Reasons come from the ranking where the chunk placed best.
 */
export function fuseRankings(lists: ReadonlyArray<readonly IndexHit[]>, k: number = RRF_K): IndexHit[] {
  const fused = new Map<number, { hit: IndexHit; score: number; best: number }>();
  for (const list of lists) {
    list.forEach((hit, i) => {
      const entry = fused.get(hit.chunk.id) ?? { hit, score: 0, best: Number.POSITIVE_INFINITY };
      entry.score += 1 / (k + i + 1);
      if (i < entry.best) {
        entry.best = i;
        entry.hit = hit;
      }
      fused.set(hit.chunk.id, entry);
    });
  }
  return [...fused.values()]
    .map((e) => ({ ...e.hit, score: e.score }))
    .sort((a, b) => b.score - a.score || a.chunk.id - b.chunk.id);
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
  /** Also try adjacent query words joined as one identifier (default on). */
  bigrams?: boolean;
  /** Search each sentence of a multi-sentence request on its own and fuse the rankings (default on). */
  decompose?: boolean;
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
  const adjust = chunkAdjustment(request.query, { ...(request.intentHints !== undefined ? { intentHints: request.intentHints } : {}), commonness: (w) => index.commonness(w) });
  const searchOptions = {
    limit: request.pool ?? DEFAULT_POOL,
    ...(request.bigrams !== undefined ? { bigrams: request.bigrams } : {}),
    boost: (id: number) => {
      const chunk = index.chunk(id);
      return chunk ? adjust(chunk) : 1;
    },
  };
  const clauses = request.decompose === false ? [] : splitClauses(request.query);
  let hits: IndexHit[] = [];
  if (index.ready) {
    // A multi-sentence request is searched sentence by sentence and the rankings are fused; the whole request
    // is not searched again, because it would only bring back the noise the split removes.
    hits =
      clauses.length === 0
        ? index.search(withoutIntentWords(query), searchOptions)
        : fuseRankings(clauses.map((c) => index.search(withoutIntentWords([c, ...(request.extraTerms ?? [])].join(" ")), searchOptions)));
  }
  const chosen = diversify(hits, { ...(request.maxPerFile !== undefined ? { maxPerFile: request.maxPerFile } : {}), exclude: pinned });
  const searched = now();
  const plan = packContext({ pinned, auto: chosen.map(toCandidate), budgetTokens: request.budgetTokens, ...(request.autoBodies !== undefined ? { autoBodies: request.autoBodies } : {}) });
  const finished = now();
  return { plan, considered: hits.length, timing: { searchMs: searched - started, packMs: finished - searched, totalMs: finished - started } };
}
