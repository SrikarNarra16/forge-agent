import type { DecisionStore } from "../mcp/decisions";
import type { NoticeLevel, UiSink } from "../trueforge/agentController";
import type { ReducerChange, TurnView } from "../trueforge/events";
import type { RunState } from "../trueforge/runState";
import type { ReviewTracker } from "./tracker";

/**
 * RunScope: one "run" is one user request. It is a UiSink only to learn when a new request starts: it then
 * mints the run id (used to group checkpoints for Undo/rollback) and drops what belonged to the previous
 * run: unconsumed decisions (an edit the agent never heard about) and finished entries of the review queue.
 */
export class RunScope implements UiSink {
  private counter = 0;

  constructor(
    private readonly deps: { decisions: DecisionStore; tracker: ReviewTracker },
  ) {}

  /** Id of the current run, e.g. "run-3". "run-0" before the first request. */
  get runId(): string {
    return `run-${this.counter}`;
  }

  onUserMessage(): void {
    this.counter++;
    this.deps.decisions.clear();
    this.deps.tracker.clearFinished();
  }

  onState(_state: RunState): void {}
  onTurnChange(_view: TurnView, _change: ReducerChange): void {}
  onSession(): void {}
  onNotice(_level: NoticeLevel, _text: string): void {}
  onReset(): void {}
}
