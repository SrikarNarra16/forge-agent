import type { ApprovalDecision, ApprovalHandler, NoticeLevel, PendingToolCall, SessionSpec, TurnClient, TurnInput, UiSink } from "../../src/trueforge/agentController";
import type { ReducerChange, StreamEvent, TurnView } from "../../src/trueforge/events";
import type { RunState } from "../../src/trueforge/runState";

/** One scripted TrueForge turn: given the turn input, yields stream events (or throws). */
export type TurnScript = (input: TurnInput[], sessionId: string) => AsyncIterable<StreamEvent> | Promise<AsyncIterable<StreamEvent>>;

export async function* events(...list: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of list) yield e;
}

/** Yields `before`, waits for `gate`, then yields `after` (lets a test act mid-stream). */
export async function* gated(before: StreamEvent[], gate: Promise<unknown>, after: StreamEvent[]): AsyncGenerator<StreamEvent> {
  for (const e of before) yield e;
  await gate;
  for (const e of after) yield e;
}

export function deferred<T = void>(): { promise: Promise<T>; resolve: (v: T) => void; reject: (e: unknown) => void } {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

export class FakeClient implements TurnClient {
  readonly sessions: string[] = [];
  readonly sessionSpecs: Array<SessionSpec | undefined> = [];
  readonly turns: Array<{ sessionId: string; input: TurnInput[] }> = [];
  readonly cancels: string[] = [];
  private readonly scripts: TurnScript[];
  /** Called when cancel() is invoked. */
  onCancel: (sessionId: string) => void = () => undefined;
  cancelError: Error | undefined;
  /** Optional recovery hooks (stream drop tests). */
  turnStatus: ((sessionId: string, turnId: string) => Promise<string>) | undefined;
  subscribe: ((sessionId: string, turnId: string, options: { afterSequenceNumber: number }) => Promise<AsyncIterable<StreamEvent>>) | undefined;
  listEvents: ((sessionId: string, turnId: string) => Promise<StreamEvent[]>) | undefined;
  readonly resumeCalls: string[] = [];

  constructor(...scripts: TurnScript[]) {
    this.scripts = [...scripts];
  }

  push(...scripts: TurnScript[]): void {
    this.scripts.push(...scripts);
  }

  createSession(spec?: SessionSpec): Promise<{ id: string }> {
    const id = `sess-${this.sessions.length + 1}`;
    this.sessions.push(id);
    this.sessionSpecs.push(spec);
    return Promise.resolve({ id });
  }

  async createTurnStream(sessionId: string, input: TurnInput[]): Promise<AsyncIterable<StreamEvent>> {
    this.turns.push({ sessionId, input });
    const script = this.scripts.shift();
    if (!script) throw new Error("FakeClient: no script left for this turn");
    return script(input, sessionId);
  }

  getTurnStatus(sessionId: string, turnId: string): Promise<string> {
    this.resumeCalls.push(`status:${turnId}`);
    if (!this.turnStatus) return Promise.reject(new Error("no turnStatus hook"));
    return this.turnStatus(sessionId, turnId);
  }

  subscribeToTurn(sessionId: string, turnId: string, options: { afterSequenceNumber: number }): Promise<AsyncIterable<StreamEvent>> {
    this.resumeCalls.push(`subscribe:${turnId}:after=${options.afterSequenceNumber}`);
    if (!this.subscribe) return Promise.reject(new Error("no subscribe hook"));
    return this.subscribe(sessionId, turnId, options);
  }

  listTurnEvents(sessionId: string, turnId: string): Promise<StreamEvent[]> {
    this.resumeCalls.push(`list:${turnId}`);
    if (!this.listEvents) return Promise.reject(new Error("no listEvents hook"));
    return this.listEvents(sessionId, turnId);
  }

  cancel(sessionId: string): Promise<void> {
    this.cancels.push(sessionId);
    if (this.cancelError) return Promise.reject(this.cancelError);
    this.onCancel(sessionId);
    return Promise.resolve();
  }
}

export class RecordingUi implements UiSink {
  readonly states: RunState[] = [];
  readonly details: Array<string | undefined> = [];
  readonly notices: Array<{ level: NoticeLevel; text: string }> = [];
  readonly users: string[] = [];
  readonly sessionsSeen: Array<{ sessionId: string; model?: string }> = [];
  resets = 0;
  lastView: TurnView | undefined;
  changes: ReducerChange[] = [];

  onState(state: RunState, detail?: string): void {
    this.states.push(state);
    this.details.push(detail);
  }
  onUserMessage(text: string): void {
    this.users.push(text);
  }
  onTurnChange(view: TurnView, change: ReducerChange): void {
    this.lastView = view;
    this.changes.push(change);
  }
  onSession(info: { sessionId: string; model?: string }): void {
    this.sessionsSeen.push(info);
  }
  onNotice(level: NoticeLevel, text: string): void {
    this.notices.push({ level, text });
  }
  onReset(): void {
    this.resets++;
  }
}

/** Approval handler driven by a function; records the calls it saw and when each started/finished. */
export class ScriptedApprovals implements ApprovalHandler {
  readonly started: string[] = [];
  readonly finished: string[] = [];
  readonly signals: AbortSignal[] = [];
  constructor(private readonly decide_: (call: PendingToolCall, signal: AbortSignal) => Promise<ApprovalDecision> | ApprovalDecision) {}

  async decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision> {
    this.started.push(call.id);
    this.signals.push(signal);
    const decision = await this.decide_(call, signal);
    this.finished.push(call.id);
    return decision;
  }
}

/** Resolves when the abort signal fires (for handlers that wait for the user forever). */
export function rejectOnAbort(signal: AbortSignal): Promise<never> {
  return new Promise((_resolve, reject) => {
    signal.addEventListener("abort", () => reject(new Error("approval aborted")), { once: true });
  });
}

export const ALLOW: ApprovalDecision = { status: "allow" };
export function DENY(reason = "User denied it"): ApprovalDecision {
  return { status: "deny", reason };
}

/** Lets pending microtasks and a macrotask run. */
export function tick(): Promise<void> {
  return new Promise((resolve) => setImmediate(resolve));
}
