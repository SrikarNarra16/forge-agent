/**
 * ReviewTracker: the "Review (N files)" queue shown in the Agent panel. One entry per pending
 * propose_edit/create_file call, updated by the review handler as it moves through the states.
 * Pure and vscode-free.
 */
/** `applying` = the user decided and the accepted hunks are being written (the panel disables its buttons meanwhile). */
export type ReviewState = "queued" | "reviewing" | "applying" | "applied" | "rejected" | "failed" | "cancelled";

export interface ReviewEntry {
  callId: string;
  path: string;
  kind: "edit" | "create";
  summary: string;
  state: ReviewState;
  /** Total hunks, known once the proposal was computed. */
  hunks?: number;
  /** Hunks written, once applied. */
  applied?: number;
  /** While reviewing: hunks accepted / rejected so far (the rest are undecided and count as rejected on Apply). */
  accepted?: number;
  rejected?: number;
  /** Why it failed or was rejected, for display. */
  detail?: string;
}

export type TrackerListener = (entries: readonly ReviewEntry[]) => void;

export class ReviewTracker {
  private readonly map = new Map<string, ReviewEntry>();
  private readonly listeners = new Set<TrackerListener>();

  list(): ReviewEntry[] {
    return [...this.map.values()];
  }

  get(callId: string): ReviewEntry | undefined {
    return this.map.get(callId);
  }

  add(entry: ReviewEntry): void {
    this.map.set(entry.callId, entry);
    this.emit();
  }

  update(callId: string, patch: Partial<Omit<ReviewEntry, "callId">>): void {
    const current = this.map.get(callId);
    if (!current) return;
    this.map.set(callId, { ...current, ...patch });
    this.emit();
  }

  /** Drops finished entries (called when a new user request starts). */
  clearFinished(): void {
    for (const [id, entry] of this.map) if (entry.state !== "queued" && entry.state !== "reviewing" && entry.state !== "applying") this.map.delete(id);
    this.emit();
  }

  clear(): void {
    this.map.clear();
    this.emit();
  }

  onChange(listener: TrackerListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(): void {
    const snapshot = this.list();
    for (const listener of [...this.listeners]) listener(snapshot);
  }
}
