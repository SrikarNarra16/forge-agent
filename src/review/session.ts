import { composeText, computeHunks, layoutText, totalStats, type Decision, type Hunk, type HunkStats, type Layout } from "./hunks";

/**
 * ReviewSession: the state of ONE file's review. Pure and vscode-free. It owns the hunks and the per-hunk
 * decisions, derives what the proposal side of the diff should show, and resolves exactly once when the
 * user applies, rejects everything, or the review is cancelled (Stop). Undecided hunks count as NOT
 * accepted: nothing reaches the file without an explicit accept.
 */

export interface ReviewInfo {
  /** Tool call id this review answers. */
  callId: string;
  /** Workspace-relative path. */
  path: string;
  kind: "edit" | "create";
  /** The agent's one-line summary of the change. */
  summary: string;
  original: string;
  proposed: string;
}

export type ReviewResult =
  /** The user pressed Apply with at least one accepted hunk. `accepted` holds hunk ids in file order. */
  | { kind: "apply"; accepted: number[] }
  /** Reject all, or Apply with nothing accepted. */
  | { kind: "rejected-all" }
  /** Stop / abort: change nothing. */
  | { kind: "cancelled" };

export type SessionListener = () => void;

export class ReviewSession {
  readonly hunks: Hunk[];
  readonly done: Promise<ReviewResult>;
  private decisions: Decision[];
  private result: ReviewResult | undefined;
  private resolveDone!: (result: ReviewResult) => void;
  private readonly listeners = new Set<SessionListener>();

  constructor(readonly info: ReviewInfo, hunks: Hunk[] = computeHunks(info.original, info.proposed)) {
    this.hunks = hunks;
    this.decisions = hunks.map(() => "pending");
    this.done = new Promise<ReviewResult>((resolve) => {
      this.resolveDone = resolve;
    });
  }

  get finished(): boolean {
    return this.result !== undefined;
  }

  get decisionList(): readonly Decision[] {
    return this.decisions;
  }

  count(which: Decision): number {
    return this.decisions.filter((d) => d === which).length;
  }

  get acceptedIds(): number[] {
    return this.hunks.filter((h) => this.decisions[h.id] === "accepted").map((h) => h.id);
  }

  /** What the proposal side of the diff shows right now (rejected hunks reverted) and where each hunk is. */
  layout(): Layout {
    return layoutText(this.info.original, this.hunks, this.decisions);
  }

  /** The file text if the user applied right now (only accepted hunks). */
  composed(): string {
    return composeText(this.info.original, this.hunks, this.decisions);
  }

  acceptedStats(): HunkStats {
    return totalStats(this.hunks, this.decisions, "accepted");
  }

  accept(id: number): void {
    this.set(id, "accepted");
  }

  reject(id: number): void {
    this.set(id, "rejected");
  }

  acceptAll(): void {
    if (this.finished) return;
    this.decisions = this.decisions.map(() => "accepted");
    this.emit();
  }

  /** Rejects every hunk and finishes the review. */
  rejectAll(): void {
    if (this.finished) return;
    this.decisions = this.decisions.map(() => "rejected");
    this.emit();
    this.finish({ kind: "rejected-all" });
  }

  /** Apply: accepted hunks are written, everything else (rejected or undecided) is not. */
  apply(): void {
    if (this.finished) return;
    const accepted = this.acceptedIds;
    this.finish(accepted.length > 0 ? { kind: "apply", accepted } : { kind: "rejected-all" });
  }

  cancel(): void {
    this.finish({ kind: "cancelled" });
  }

  onChange(listener: SessionListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private set(id: number, decision: Decision): void {
    if (this.finished || id < 0 || id >= this.decisions.length || this.decisions[id] === decision) return;
    this.decisions = this.decisions.map((d, i) => (i === id ? decision : d));
    this.emit();
  }

  private finish(result: ReviewResult): void {
    if (this.result) return;
    this.result = result;
    this.resolveDone(result);
    this.emit();
  }

  private emit(): void {
    for (const listener of [...this.listeners]) listener();
  }
}
