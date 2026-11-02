/**
 * Run state machine: the single source of truth for what the agent is doing. The UI renders from it.
 *
 *   idle -> running -> awaitingApproval -> running -> done | error | cancelled
 *
 * `done`, `error` and `cancelled` are terminal for a run but behave like `idle` for the next send.
 */
export type RunState = "idle" | "running" | "awaitingApproval" | "done" | "error" | "cancelled";

const ALLOWED: Readonly<Record<RunState, readonly RunState[]>> = {
  idle: ["running"],
  running: ["awaitingApproval", "done", "error", "cancelled"],
  awaitingApproval: ["running", "cancelled", "error"],
  done: ["running"],
  error: ["running"],
  cancelled: ["running"],
};

export type RunStateListener = (state: RunState, previous: RunState, detail?: string) => void;

export class IllegalTransitionError extends Error {
  constructor(from: RunState, to: RunState) {
    super(`Illegal run state transition: ${from} -> ${to}`);
    this.name = "IllegalTransitionError";
  }
}

export class RunStateMachine {
  private current: RunState = "idle";
  private readonly listeners = new Set<RunStateListener>();

  get state(): RunState {
    return this.current;
  }

  /** True while a run is in progress (including while it waits for an approval). */
  get busy(): boolean {
    return this.current === "running" || this.current === "awaitingApproval";
  }

  canTransition(to: RunState): boolean {
    return ALLOWED[this.current].includes(to);
  }

  transition(to: RunState, detail?: string): void {
    if (!this.canTransition(to)) throw new IllegalTransitionError(this.current, to);
    const previous = this.current;
    this.current = to;
    for (const listener of [...this.listeners]) listener(to, previous, detail);
  }

  onChange(listener: RunStateListener): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
}
