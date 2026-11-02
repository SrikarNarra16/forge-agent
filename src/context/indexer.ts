import { HostError, type WorkspaceHost } from "../mcp/host";
import { estimateTokens } from "../util/tokens";
import { Bm25Index, type SearchOptions } from "./bm25";
import { chunkFile } from "./chunkers";
import { queryTerms, tokenize, tokenizePath } from "./tokenize";
import { SYMBOL_KINDS, type Chunk, type ChunkKind } from "./types";
import { yieldToEventLoop } from "./yield";

/**
 * ContextIndex: an in-memory, deterministic, lexical index of the workspace (vscode-free). It reads files
 * through the WorkspaceHost (so open, unsaved buffers are indexed as the user sees them), chunks them,
 * and ranks chunks with BM25. Building is async, yields to the event loop every YIELD_EVERY files and is
 * abortable; single files can be re-indexed (`update`) or dropped (`remove`) when they change.
 */
export const MAX_FILE_CHARS = 300_000;
export const YIELD_EVERY = 25;
export const DEFAULT_MAX_FILES = 5000;
export const DEFAULT_MAX_CHUNKS = 60_000;

/** Text-ish files that are noise for retrieval. */
const NOISE = /(?:\.lock|\.min\.js|\.map|\.svg|\.csv|\.log)$|(?:^|\/)package-lock\.json$/i;

export interface IndexProgress {
  done: number;
  total: number;
}

export interface IndexStats {
  files: number;
  chunks: number;
  tokens: number;
  buildMs: number;
  skippedLarge: number;
  skippedUnreadable: number;
  /** A file or chunk cap stopped the build early. */
  truncated: boolean;
}

export interface IndexHit {
  chunk: Chunk;
  score: number;
  /** Top matched terms: the reason shown to the user. */
  terms: string[];
}

export type IndexState = "empty" | "building" | "ready";

export interface ContextIndexOptions {
  maxFiles?: number;
  maxChunks?: number;
  now?: () => number;
}

export interface IndexSearchOptions extends SearchOptions {
  /** Only these chunk kinds. */
  kinds?: ReadonlySet<ChunkKind>;
  /** Only paths accepted by this predicate. */
  pathFilter?: (path: string) => boolean;
}

export class ContextIndex {
  private readonly chunks = new Map<number, Chunk>();
  private readonly byPath = new Map<string, number[]>();
  private readonly bm25 = new Bm25Index();
  private nextId = 1;
  private currentState: IndexState = "empty";
  private buildPromise: Promise<IndexStats> | undefined;
  private lastStats: IndexStats = { files: 0, chunks: 0, tokens: 0, buildMs: 0, skippedLarge: 0, skippedUnreadable: 0, truncated: false };
  private readonly readyWaiters = new Set<() => void>();
  private readonly maxFiles: number;
  private readonly maxChunks: number;
  private readonly now: () => number;

  constructor(options: ContextIndexOptions = {}) {
    this.maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES;
    this.maxChunks = options.maxChunks ?? DEFAULT_MAX_CHUNKS;
    this.now = options.now ?? (() => performance.now());
  }

  get state(): IndexState {
    return this.currentState;
  }

  get ready(): boolean {
    return this.currentState === "ready";
  }

  get stats(): IndexStats {
    return { ...this.lastStats, files: this.byPath.size, chunks: this.chunks.size };
  }

  /** Resolves true as soon as the index is ready, or false after `timeoutMs` (never rejects, never blocks longer). */
  whenReady(timeoutMs: number): Promise<boolean> {
    if (this.ready) return Promise.resolve(true);
    return new Promise((resolve) => {
      const done = (value: boolean): void => {
        clearTimeout(timer);
        this.readyWaiters.delete(onReady);
        resolve(value);
      };
      const onReady = (): void => done(true);
      const timer = setTimeout(() => done(false), timeoutMs);
      this.readyWaiters.add(onReady);
    });
  }

  /** Builds (or rebuilds) the whole index. A build already in progress is joined, not duplicated. */
  build(host: WorkspaceHost, options: { signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void } = {}): Promise<IndexStats> {
    if (this.buildPromise) return this.buildPromise;
    this.buildPromise = this.runBuild(host, options).finally(() => {
      this.buildPromise = undefined;
    });
    return this.buildPromise;
  }

  private async runBuild(host: WorkspaceHost, options: { signal?: AbortSignal; onProgress?: (progress: IndexProgress) => void }): Promise<IndexStats> {
    const started = this.now();
    this.clear();
    this.currentState = "building";
    const stats = { skippedLarge: 0, skippedUnreadable: 0, truncated: false };
    try {
      const found = await host.findFiles({ max: this.maxFiles, ...(options.signal ? { signal: options.signal } : {}) });
      stats.truncated = found.truncated;
      const total = found.files.length;
      options.onProgress?.({ done: 0, total });
      for (const [i, path] of found.files.entries()) {
        options.signal?.throwIfAborted();
        if (i % YIELD_EVERY === YIELD_EVERY - 1) await yieldToEventLoop();
        if (this.chunks.size >= this.maxChunks) {
          stats.truncated = true;
          break;
        }
        const outcome = await this.indexFile(host, path, options.signal);
        if (outcome === "large") stats.skippedLarge++;
        else if (outcome === "unreadable") stats.skippedUnreadable++;
        if ((i + 1) % 10 === 0 || i + 1 === total) options.onProgress?.({ done: i + 1, total });
      }
    } catch (err) {
      this.clear();
      this.currentState = "empty";
      throw err;
    }
    this.lastStats = { files: 0, chunks: 0, tokens: 0, buildMs: this.now() - started, ...stats };
    this.currentState = "ready";
    for (const waiter of [...this.readyWaiters]) waiter();
    return this.stats;
  }

  /** Re-indexes one file from its current text (open buffer if open). A file that no longer exists is removed. */
  async update(host: WorkspaceHost, path: string, signal?: AbortSignal): Promise<void> {
    this.removeChunks(path);
    await this.indexFile(host, path, signal);
  }

  remove(path: string): void {
    this.removeChunks(path);
  }

  private clear(): void {
    this.chunks.clear();
    this.byPath.clear();
    this.bm25.clear();
  }

  private removeChunks(path: string): void {
    for (const id of this.byPath.get(path) ?? []) {
      this.chunks.delete(id);
      this.bm25.remove(id);
    }
    this.byPath.delete(path);
  }

  private async indexFile(host: WorkspaceHost, path: string, signal?: AbortSignal): Promise<"ok" | "large" | "unreadable" | "skipped"> {
    if (NOISE.test(path)) return "skipped";
    let text: string;
    try {
      text = await host.readText(path, signal);
    } catch (err) {
      signal?.throwIfAborted();
      if (err instanceof HostError && err.code === "ENOENT") return "skipped";
      return "unreadable";
    }
    if (text.length > MAX_FILE_CHARS) return "large";
    if (text.includes("\0")) return "unreadable";
    this.addFile(path, text);
    return "ok";
  }

  private addFile(path: string, text: string): void {
    this.removeChunks(path); // an update racing a build must not leave duplicates
    const pathTokens = tokenizePath(path);
    const ids: number[] = [];
    for (const draft of chunkFile(path, text)) {
      if (this.chunks.size >= this.maxChunks) break;
      const chunk: Chunk = { ...draft, id: this.nextId++, tokens: estimateTokens(draft.text) };
      this.chunks.set(chunk.id, chunk);
      ids.push(chunk.id);
      this.bm25.add(chunk.id, {
        symbol: chunk.symbol ? tokenize(chunk.symbol) : [],
        path: pathTokens,
        signature: chunk.signature ? tokenize(chunk.signature) : [],
        body: tokenize(chunk.text),
      });
    }
    if (ids.length > 0) this.byPath.set(path, ids);
  }

  // --- queries -----------------------------------------------------------------------------------------

  /** BM25 search for natural language or identifiers. */
  search(query: string, options: IndexSearchOptions = {}): IndexHit[] {
    const { kinds, pathFilter, filter, ...rest } = options;
    const accept = (id: number): boolean => {
      const chunk = this.chunks.get(id);
      if (!chunk) return false;
      if (kinds && !kinds.has(chunk.kind)) return false;
      if (pathFilter && !pathFilter(chunk.path)) return false;
      return filter ? filter(id) : true;
    };
    return this.bm25
      .search(queryTerms(query), { ...rest, filter: accept })
      .flatMap((hit) => {
        const chunk = this.chunks.get(hit.id);
        return chunk ? [{ chunk, score: hit.score, terms: hit.terms }] : [];
      });
  }

  chunk(id: number): Chunk | undefined {
    return this.chunks.get(id);
  }

  chunksOf(path: string): Chunk[] {
    return (this.byPath.get(path) ?? []).flatMap((id) => {
      const chunk = this.chunks.get(id);
      return chunk ? [chunk] : [];
    });
  }

  hasFile(path: string): boolean {
    return this.byPath.has(path);
  }

  files(): string[] {
    return [...this.byPath.keys()].sort();
  }

  /** Every named code symbol (functions, methods, classes ...), for @symbol mentions. */
  symbols(): Chunk[] {
    return [...this.chunks.values()].filter((c) => c.symbol !== undefined && SYMBOL_KINDS.has(c.kind));
  }

  allChunks(): IterableIterator<Chunk> {
    return this.chunks.values();
  }
}
