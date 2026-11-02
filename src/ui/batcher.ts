/**
 * Coalesces streamed UI updates: items are keyed by id (the latest value wins, first-seen order is kept)
 * and flushed together at most once per interval, so token-by-token deltas never flood the webview.
 */
export interface Timers {
  setTimeout(fn: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const realTimers: Timers = {
  setTimeout: (fn, ms) => setTimeout(fn, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

export class Batcher<T extends { id: string }> {
  private readonly pending = new Map<string, T>();
  private timer: unknown;
  private disposed = false;

  constructor(
    private readonly onFlush: (items: T[]) => void,
    private readonly intervalMs = 30,
    private readonly timers: Timers = realTimers,
  ) {}

  push(item: T): void {
    if (this.disposed) return;
    this.pending.set(item.id, item);
    this.timer ??= this.timers.setTimeout(() => this.flush(), this.intervalMs);
  }

  /** Sends everything pending right now. */
  flush(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    if (this.pending.size === 0) return;
    const items = [...this.pending.values()];
    this.pending.clear();
    this.onFlush(items);
  }

  /** Drops anything pending (used when the conversation is cleared). */
  clear(): void {
    if (this.timer !== undefined) this.timers.clearTimeout(this.timer);
    this.timer = undefined;
    this.pending.clear();
  }

  dispose(): void {
    this.clear();
    this.disposed = true;
  }
}
