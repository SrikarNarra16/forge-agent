/**
 * BM25 (k1 1.2, b 0.75) over field-weighted term frequencies, kept as an inverted index so adding and
 * removing one document is cheap (incremental re-indexing of a changed file). Field boosts: symbol name x3,
 * path x2, signature x2, body x1. Deterministic: ties break by document id, which follows insertion order.
 * Each hit also reports its top matched terms, which become the human-readable "reason".
 */
export const K1 = 1.2;
export const B = 0.75;
export const FIELD_BOOSTS = { symbol: 3, path: 2, signature: 2, body: 1 } as const;
export const MAX_REASON_TERMS = 3;

export interface Bm25Fields {
  symbol: readonly string[];
  path: readonly string[];
  signature: readonly string[];
  body: readonly string[];
}

export interface Bm25Hit {
  id: number;
  score: number;
  /** Up to MAX_REASON_TERMS query terms that contributed most to the score. */
  terms: string[];
}

export interface SearchOptions {
  limit?: number;
  /** Only documents for which this returns true can be hits. */
  filter?: (id: number) => boolean;
  /** Multiplies a document's score (e.g. a small path-intent boost). */
  boost?: (id: number) => number;
}

export class Bm25Index {
  private readonly postings = new Map<string, Map<number, number>>();
  private readonly lengths = new Map<number, number>();
  private readonly termsOf = new Map<number, string[]>();
  private totalLength = 0;

  get size(): number {
    return this.lengths.size;
  }

  add(id: number, fields: Bm25Fields): void {
    if (this.lengths.has(id)) this.remove(id);
    const weighted = new Map<string, number>();
    let length = 0;
    for (const [field, boost] of Object.entries(FIELD_BOOSTS) as Array<[keyof Bm25Fields, number]>) {
      for (const term of fields[field]) {
        weighted.set(term, (weighted.get(term) ?? 0) + boost);
        length += boost;
      }
    }
    for (const [term, tf] of weighted) {
      let posting = this.postings.get(term);
      if (!posting) {
        posting = new Map();
        this.postings.set(term, posting);
      }
      posting.set(id, tf);
    }
    this.lengths.set(id, length);
    this.termsOf.set(id, [...weighted.keys()]);
    this.totalLength += length;
  }

  remove(id: number): void {
    const length = this.lengths.get(id);
    if (length === undefined) return;
    for (const term of this.termsOf.get(id) ?? []) {
      const posting = this.postings.get(term);
      posting?.delete(id);
      if (posting && posting.size === 0) this.postings.delete(term);
    }
    this.termsOf.delete(id);
    this.lengths.delete(id);
    this.totalLength -= length;
  }

  clear(): void {
    this.postings.clear();
    this.lengths.clear();
    this.termsOf.clear();
    this.totalLength = 0;
  }

  /** Number of documents containing the term. */
  docFrequency(term: string): number {
    return this.postings.get(term)?.size ?? 0;
  }

  search(terms: readonly string[], options: SearchOptions = {}): Bm25Hit[] {
    const n = this.lengths.size;
    if (n === 0 || terms.length === 0) return [];
    const avgLength = this.totalLength / n || 1;
    const scores = new Map<number, number>();
    const contributions = new Map<number, Map<string, number>>();

    for (const term of new Set(terms)) {
      const posting = this.postings.get(term);
      if (!posting) continue;
      const idf = Math.log(1 + (n - posting.size + 0.5) / (posting.size + 0.5));
      for (const [id, tf] of posting) {
        if (options.filter && !options.filter(id)) continue;
        const length = this.lengths.get(id) ?? avgLength;
        const part = idf * ((tf * (K1 + 1)) / (tf + K1 * (1 - B + (B * length) / avgLength)));
        scores.set(id, (scores.get(id) ?? 0) + part);
        let per = contributions.get(id);
        if (!per) {
          per = new Map();
          contributions.set(id, per);
        }
        per.set(term, part);
      }
    }

    const hits: Bm25Hit[] = [];
    for (const [id, raw] of scores) {
      const score = raw * (options.boost?.(id) ?? 1);
      const terms = [...(contributions.get(id) ?? [])]
        .sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : 1))
        .slice(0, MAX_REASON_TERMS)
        .map(([t]) => t);
      hits.push({ id, score, terms });
    }
    hits.sort((a, b) => b.score - a.score || a.id - b.id);
    return options.limit !== undefined ? hits.slice(0, options.limit) : hits;
  }
}
