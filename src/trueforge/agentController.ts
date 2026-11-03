import { classifyFailure, exhaustedMessage, isModelFailure, planNext, retryingMessage, shortReason, sideEffectsMessage, switchedMessage, type AttemptRecord, type ChainEvent, type Failure, type FailureClass, type FailureSource } from "./modelChain";
import type { RunRegistry } from "./runRegistry";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { describeError } from "./client";
import { TurnReducer, type ReducerChange, type StreamEvent, type TurnView } from "./events";
import { RunStateMachine, type RunState } from "./runState";

/**
 * AgentController: drives one agent run through TrueForge, vscode-free so it is unit-testable.
 *
 * `send()` creates the session lazily (saved agent by name), streams a turn into a TurnReducer and
 * reports to a UiSink. When the turn pauses for tool approval it asks the ApprovalHandler about ALL
 * pending calls at once, then sends ONE resume turn containing only `user.tool_approval` items (in the
 * order TrueForge listed the calls) and keeps going until the turn is done, failed or cancelled.
 * Any other pause (ask_user_question, MCP auth, unknown) ends the run as an error instead of hanging.
 * The run state machine is the single source of truth for the UI.
 */

export type ApprovalDecision = { status: "allow"; /** Remember this exact command for the run (run_command cards). */ remember?: boolean } | { status: "deny"; reason: string };

export interface PendingToolCall {
  id: string;
  name: string;
  /** Raw JSON string of the arguments. */
  args: string;
  threadId: string;
  sourceEventId: string;
}

export interface ApprovalHandler {
  /**
   * Decide one pending call. Called for all pending calls of a round at the same time. Must settle
   * promptly (reject or resolve) once `signal` aborts, which happens when the user presses Stop.
   */
  decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision>;
}

export type TurnInput = TrueForgeApi.TurnInputItem;

/** The few TrueForge operations the controller needs (see sdkAdapter.ts). */
export interface SessionSpec {
  agentName: string;
  /** Run the agent on this model instead of the one in its definition (the adapter overrides model.name in the session spec). */
  model?: string;
  metadata?: Record<string, string>;
}

export interface TurnClient {
  createSession(spec: SessionSpec): Promise<{ id: string }>;
  createTurnStream(sessionId: string, input: TurnInput[], options?: { signal?: AbortSignal }): Promise<AsyncIterable<StreamEvent>>;
  cancel(sessionId: string): Promise<void>;
  /** Status of a turn: "running" while the server is still working on it. Used to recover from a dropped stream. */
  getTurnStatus?(sessionId: string, turnId: string): Promise<string>;
  /** Re-attaches to a turn; `afterSequenceNumber` = how many of its events were already received (all events count, deltas too). */
  subscribeToTurn?(sessionId: string, turnId: string, options: { afterSequenceNumber: number; signal?: AbortSignal }): Promise<AsyncIterable<StreamEvent>>;
  /** The compact event log of a (finished) turn: turn.created, the merged model messages, tool events, turn.done. */
  listTurnEvents?(sessionId: string, turnId: string): Promise<StreamEvent[]>;
}

export type NoticeLevel = "info" | "warning" | "error";

export interface UiSink {
  onState(state: RunState, detail?: string): void;
  onUserMessage(text: string): void;
  onTurnChange(view: TurnView, change: ReducerChange): void;
  onSession(info: { sessionId: string; model?: string }): void;
  onNotice(level: NoticeLevel, text: string): void;
  /** The conversation was cleared (New chat). */
  onReset(): void;
  /** Model retry / fallback progress (a notice that updates in place). */
  onChain?(event: ChainEvent): void;
  /** The failed attempt's partial output (assistant text, tool cards) must disappear before the next attempt. */
  onAttemptDiscarded?(): void;
}

export type PrepareResult = { ok: true; model?: string } | { ok: false; message: string };

/**
 * What to do with a session whose last turn is still paused (the user pressed Stop during an approval,
 * or the agent asked for input we cannot give): keep using it, or silently start a new one.
 */
export type AfterPausePolicy = "continue" | "new-session";

/**
 * Spike result (docs/approval-spike.md, scenario f): TrueForge accepts a new user.message on a session whose
 * last turn is paused on an approval, so the conversation can simply continue. If a session ever rejects it,
 * the controller silently falls back to a new session.
 */
export const DEFAULT_AFTER_PAUSE: AfterPausePolicy = "continue";
const MAX_ROUNDS = 100;

export interface ControllerDeps {
  client: TurnClient;
  agentName: string;
  ui: UiSink;
  approvals: ApprovalHandler;
  /** Runs before the first turn of a session (bootstrap + model checks) for the agent (and model) about to be used. */
  prepare?: (request: { agentName: string; model?: string }) => Promise<PrepareResult>;
  afterPause?: AfterPausePolicy;
  now?: () => Date;
  log?: (message: string) => void;
  /** Id of the current run (RunScope mints it on each user message); needed for rollback. */
  getRunId?: () => string;
  /** Shared with the handlers and tools: once a run is cancelled nothing may act for it. */
  registry?: RunRegistry;
  /** Model fallback: the ordered models and how to judge an attempt. Without it a failure simply ends the run. */
  chain?: ChainDeps;
  /** What Stop does besides the state change; every part is optional so tests and the eval harness can inject fakes. */
  cancel?: CancelDeps;
}

export interface ChainDeps {
  /** forge.models, primary first. */
  models: () => readonly string[];
  /** Stall watchdog limits; the watchdog is off without it. */
  stall?: () => { firstMs: number; idleMs: number };
  /** Changes the failed run already made (applied files, executed commands); any of them forbids a replay. */
  sideEffects?: (runId: string | undefined) => { files: string[]; commands: string[] };
  /** Cancellable sleep for the backoff (default: setTimeout). */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  random?: () => number;
  now?: () => number;
  /** How often the watchdog checks (default 1000 ms). */
  tickMs?: number;
  sessionUrl?: (sessionId: string) => string;
}

export interface RollbackSummary {
  restored: string[];
  /** Left alone because the user changed them after Forge wrote them. */
  skipped: string[];
  failed: Array<{ path: string; error: string }>;
}

export interface CancelDeps {
  /** Synchronous, cheap: kill running commands, drop pending decisions and tickets, abort in-flight tool work. */
  cancelWork?: () => void;
  /** Resolves when no apply is in flight (an apply is atomic per file and is allowed to finish). */
  settle?: () => Promise<void>;
  rollbackEnabled?: () => boolean;
  rollback?: (runId: string) => Promise<RollbackSummary>;
  /** Files this run changed (for the "kept" message when rollback is off). */
  changedFiles?: (runId: string) => string[];
  /** sessions.cancel is fire-and-forget; this bounds how long we keep its promise alive (default 3000). */
  cancelTimeoutMs?: number;
  /** Upper bound for waiting on an in-flight apply (default 15000). */
  settleTimeoutMs?: number;
}

export interface SendOptions {
  /** Agent to run. Only honoured together with `freshSession`; the panel always talks to deps.agentName. */
  agentName?: string;
  /** Run in a brand-new session that is used once; the panel's session and its history are left alone. */
  freshSession?: boolean;
  /** Model to use instead of the agent definition's. */
  model?: string;
  /** What the transcript shows as the user's message (the prompt itself may be a long generated message). */
  display?: string;
  /** Free-form tag stored in the session metadata, e.g. "inline-edit". */
  purpose?: string;
}

export type SendResult =
  | {
      ok: true;
      state: RunState;
      /** The error message, cancel reason, ... that ended the run, if any. */
      detail?: string;
      /** Everything the run produced (messages, tool calls with responses). */
      view: TurnView;
    }
  | { ok: false; reason: "busy" | "empty" };

const CANCEL_DONE = Symbol("cancel-done");
const ABORTED = Symbol("aborted");

/** Events that show the model/provider is alive (the instant `model.message` start and turn.created are not). */
function isProgress(event: StreamEvent): boolean {
  switch (event.type) {
    case "model.message.delta":
    case "tool.response":
    case "tool.approval_required":
    case "turn.done":
    case "thread.created":
    case "thread.done":
    case "thread.context_compaction_started":
    case "thread.context_compaction_finished":
      return true;
    case "model.message": {
      const m = event as { content?: unknown; toolCalls?: unknown; finishReason?: unknown };
      return Boolean(m.content) || Boolean(m.toolCalls) || Boolean(m.finishReason);
    }
    default:
      return false;
  }
}

/** The model produced output (a token, a reasoning delta or a tool call), as opposed to bookkeeping events. */
function isToken(event: StreamEvent): boolean {
  return event.type === "model.message.delta" || (event.type === "model.message" && isProgress(event));
}

function sleepUnlessAborted(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const timer = setTimeout(done, ms);
    function done(): void {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out after ${ms} ms`)), ms);
    promise.then(
      (v) => (clearTimeout(timer), resolve(v)),
      (e: unknown) => (clearTimeout(timer), reject(e instanceof Error ? e : new Error(String(e)))),
    );
  });
}

/** "Cancelled. Rolled back N files from this run: <paths>" (+ what was left alone or could not be restored). */
export function describeRollback(r: RollbackSummary): string {
  const parts = [r.restored.length > 0 ? `Cancelled. Rolled back ${r.restored.length} file${r.restored.length === 1 ? "" : "s"} from this run: ${r.restored.join(", ")}` : "Cancelled. Nothing had been changed."];
  if (r.skipped.length > 0) parts.push(`Left as you edited them (changed after Forge wrote them): ${r.skipped.join(", ")}`);
  if (r.failed.length > 0) parts.push(`Could not restore: ${r.failed.map((f) => `${f.path} (${f.error})`).join(", ")}`);
  return parts.join(". ").replace(/\.\. /g, ". ");
}

class StopRequested extends Error {
  constructor(readonly reason = "Stopped") {
    super(reason);
    this.name = "StopRequested";
  }
}

class RunFailed extends Error {
  constructor(
    message: string,
    /** Where the message comes from: TrueForge reporting a model problem, our own transport, or the agent (never a model failure). */
    readonly source: FailureSource | "agent" = "agent",
    readonly forced?: FailureClass,
  ) {
    super(message);
  }
}

/** The stream made no progress for too long (see ChainDeps.stall). */
class StallError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "StallError";
  }
}

interface SessionRef {
  id: string;
  /** Model override this session was created with (undefined = the agent definition's model). */
  model?: string | undefined;
  /** The last turn of this session ended paused and was never resumed. */
  paused: boolean;
}

/** What the current run is using; `session` is set once the session exists. */
interface RunContext {
  options: SendOptions;
  session: SessionRef | undefined;
}

export class AgentController {
  readonly runState = new RunStateMachine();
  /** The panel's conversation. Fresh-session runs (inline edit) never touch it. */
  private session: SessionRef | undefined;
  private ctx: RunContext | undefined;
  private lastView: TurnView | undefined;
  private lastDetail: string | undefined;
  private abort = new AbortController();
  private stopRequested = false;
  /** The Stop flow in progress (shared by repeated Stop clicks). */
  private cancelFlow: Promise<void> | undefined;
  /** Aborts ONE attempt (stall watchdog or Stop); Stop aborts it through `abort`. */
  private attemptAbort = new AbortController();
  private readonly afterPause: AfterPausePolicy;

  constructor(private readonly deps: ControllerDeps) {
    this.afterPause = deps.afterPause ?? DEFAULT_AFTER_PAUSE;
    this.runState.onChange((state, _previous, detail) => deps.ui.onState(state, detail));
  }

  get state(): RunState {
    return this.runState.state;
  }

  get sessionId(): string | undefined {
    return this.session?.id;
  }

  /** Runs one user message to completion (including approval rounds). Resolves when the run ends. */
  async send(text: string, options: SendOptions = {}): Promise<SendResult> {
    const message = text.trim();
    if (message === "") return { ok: false, reason: "empty" };
    if (this.runState.busy) {
      this.deps.ui.onNotice("warning", "The agent is still working on the previous message. Wait for it to finish or press Stop.");
      return { ok: false, reason: "busy" };
    }

    this.stopRequested = false;
    this.cancelFlow = undefined;
    this.abort = new AbortController();
    this.ctx = { options, session: undefined };
    this.lastView = undefined;
    this.lastDetail = undefined;
    this.runState.transition("running");
    this.deps.ui.onUserMessage(options.display ?? message);
    this.deps.registry?.begin(this.deps.getRunId?.() ?? `run-${Date.now()}`);
    // The stream work runs as its own task: a provider that never answers must not keep send() (and so the UI) waiting
    // after Stop. When Stop finishes, send() returns even if the task is still stuck; its late events are ignored.
    const task = this.runWithChain(message).then(
      () => undefined,
      (err: unknown) => err,
    );
    const outcome = await Promise.race([task, this.cancelSignal()]);
    if (outcome !== CANCEL_DONE) {
      const err = outcome;
      if (this.stopRequested || err instanceof StopRequested) await this.stopFlowOrStart(err instanceof StopRequested ? err.reason : undefined);
      else if (err !== undefined) this.fail(err instanceof RunFailed ? err.message : describeError(err));
    }
    const view = this.lastView ?? new TurnReducer().view;
    return { ok: true, state: this.runState.state, view, ...(this.lastDetail !== undefined ? { detail: this.lastDetail } : {}) };
  }

  private cancelWaiters: Array<() => void> = [];

  /** Resolves with CANCEL_DONE once a Stop flow has finished (so send() can return without the stream task). */
  private cancelSignal(): Promise<typeof CANCEL_DONE> {
    return new Promise((resolve) => this.cancelWaiters.push(() => resolve(CANCEL_DONE)));
  }

  /** The run ended because of a cancellation that did not come from our Stop button (e.g. a server timeout). */
  private async stopFlowOrStart(reason: string | undefined): Promise<void> {
    if (this.cancelFlow) {
      await this.cancelFlow;
      return;
    }
    this.finish("cancelled", reason);
  }

  /**
   * Stop button. Everything the user sees happens synchronously (state -> cancelling, handlers aborted); nothing
   * waits for the network. Order: (a) cancelling, (b) abort the local stream and ask TrueForge to cancel without
   * waiting for the answer, (c) reject pending approvals, (d) kill commands and other in-flight work, (e) let an
   * in-flight apply finish, (f) roll back this run's changes (forge.rollbackOnCancel) and end `cancelled`.
   * Calling it again while stopping, or when nothing runs, returns the same flow / does nothing.
   */
  stop(): Promise<void> {
    if (!this.runState.stoppable) return this.cancelFlow ?? Promise.resolve();
    const wasRunning = this.runState.state === "running";
    this.stopRequested = true;
    this.runState.transition("cancelling"); // (a) the UI shows "Stopping…" in this same tick
    const runId = this.deps.getRunId?.();
    this.deps.registry?.cancel();
    this.abort.abort(); // (b) local stream reader + (c) every pending ApprovalHandler promise
    this.cancelFlow = this.cancelRun(runId, wasRunning);
    return this.cancelFlow;
  }

  /** sessions.cancel, fire and forget: a provider that hangs or never answers must not delay the UI. */
  private fireCancel(sessionId: string, why: string): void {
    const { cancel, log } = this.deps;
    const timeoutMs = cancel?.cancelTimeoutMs ?? 3000;
    const timer = new Promise<never>((_resolve, reject) => setTimeout(() => reject(new Error(`no answer within ${timeoutMs} ms`)), timeoutMs).unref?.());
    timer.catch(() => undefined);
    Promise.race([this.deps.client.cancel(sessionId), timer]).then(
      () => log?.(`sessions.cancel(${sessionId}) accepted (${why})`),
      (err: unknown) => log?.(`sessions.cancel(${sessionId}) failed or timed out (ignored): ${describeError(err)}`),
    );
  }

  private async cancelRun(runId: string | undefined, wasRunning: boolean): Promise<void> {
    const { cancel, log, ui } = this.deps;
    await Promise.resolve(); // let the "Stopping…" state reach the UI before any heavier work starts
    const session = this.ctx?.session;
    if (session && wasRunning) this.fireCancel(session.id, "Stop");
    try {
      cancel?.cancelWork?.(); // (d)
    } catch (err) {
      log?.(`cancelWork failed: ${describeError(err)}`);
    }
    try {
      if (cancel?.settle) await withTimeout(cancel.settle(), cancel.settleTimeoutMs ?? 15000); // (e)
    } catch (err) {
      log?.(`waiting for the in-flight apply failed: ${describeError(err)}`);
    }

    // (f)
    let detail = "Cancelled.";
    const changed = runId !== undefined ? (cancel?.changedFiles?.(runId) ?? []) : [];
    try {
      if (runId !== undefined && cancel?.rollback && (cancel.rollbackEnabled?.() ?? true)) {
        const r = await cancel.rollback(runId);
        detail = describeRollback(r);
        if (r.restored.length > 0 || r.skipped.length > 0 || r.failed.length > 0) ui.onNotice(r.failed.length > 0 || r.skipped.length > 0 ? "warning" : "info", detail);
      } else if (changed.length > 0) {
        detail = `Cancelled. ${changed.length} applied file${changed.length === 1 ? "" : "s"} kept (rollback on cancel is off): ${changed.join(", ")}`;
        ui.onNotice("info", detail);
      }
    } catch (err) {
      detail = `Cancelled, but rolling back failed: ${describeError(err)}`;
      ui.onNotice("error", detail);
    }
    this.lastDetail = detail;
    this.runState.transition("cancelled", detail);
    const waiters = this.cancelWaiters;
    this.cancelWaiters = [];
    for (const w of waiters) w();
  }

  /** Forgets the session so the next message starts a fresh conversation. Ignored while a run is active. */
  newChat(): boolean {
    if (this.runState.busy) {
      this.deps.ui.onNotice("warning", "Stop the current run before starting a new chat.");
      return false;
    }
    this.session = undefined;
    this.deps.ui.onReset();
    return true;
  }

  // --- internals ---------------------------------------------------------------------------------

  /** Maps whatever an attempt threw to a failure class (see modelChain.ts). */
  private failureOf(err: unknown): Failure {
    if (err instanceof StallError) return classifyFailure({ message: err.message, source: "watchdog" });
    if (err instanceof RunFailed) {
      if (err.forced) return { class: err.forced, message: err.message };
      return err.source === "agent" ? { class: "fatal", message: err.message } : classifyFailure({ message: err.message, source: err.source });
    }
    return classifyFailure({ message: describeError(err), source: "transport" });
  }

  /**
   * Runs the user's message on the first model; when the provider fails, retries or falls back per modelChain.ts
   * (a fresh TrueForge session per attempt, the SAME message text and context block), but only while the failed
   * attempt had no side effects. Stop cancels the whole chain.
   */
  private async runWithChain(text: string): Promise<void> {
    const chain = this.deps.chain;
    const models = chain?.models() ?? [];
    if (!chain || models.length === 0) return this.run(text);
    const { ui, log } = this.deps;
    const now = chain.now ?? Date.now;
    const startedAt = now();
    const baseOptions = this.ctx?.options ?? {};
    const hadEarlierTurns = baseOptions.freshSession !== true && this.session !== undefined;
    const history: AttemptRecord[] = [];
    let model = models[0] as string;
    for (let attempt = 1; ; attempt++) {
      if (this.ctx) {
        this.ctx.options = { ...baseOptions, model };
        this.ctx.session = undefined;
      }
      if (attempt > 1 && baseOptions.freshSession !== true) this.session = undefined; // every retry/advance starts a NEW session
      try {
        await this.run(text);
        return;
      } catch (err) {
        if (err instanceof StopRequested || this.stopRequested) throw err instanceof StopRequested ? err : new StopRequested();
        const failure = this.failureOf(err);
        const sessionId = this.ctx?.session?.id;
        history.push({ model, failure });
        log?.(`attempt ${attempt}: model=${model} failed class=${failure.class} (${shortReason(failure.message)})${sessionId ? ` session=${sessionId}${chain.sessionUrl ? ` url=${chain.sessionUrl(sessionId)}` : ""}` : ""}`);

        if (!isModelFailure(failure.class)) {
          if (failure.class === "trueforge-down") ui.onChain?.({ kind: "trueforge-down", model, text: failure.message });
          throw err instanceof RunFailed ? err : new RunFailed(failure.message, "agent");
        }
        // Replaying is only safe when the failed attempt changed nothing.
        const effects = chain.sideEffects?.(this.deps.getRunId?.());
        if (effects && (effects.files.length > 0 || effects.commands.length > 0)) {
          const message = sideEffectsMessage(model, failure, effects);
          ui.onChain?.({ kind: "blocked", model, text: message });
          throw new RunFailed(message, "agent");
        }
        const next = planNext(history, models, chain.random);
        if (next.kind === "stop") {
          const message = exhaustedMessage(history, models);
          ui.onChain?.({ kind: "exhausted", model, text: message });
          throw new RunFailed(message, "agent");
        }
        ui.onAttemptDiscarded?.(); // the failed attempt's partial text and tool cards must not stay in the transcript
        if (next.kind === "retry") {
          ui.onChain?.({ kind: "retrying", model, text: retryingMessage(model, next.delayMs, failure) });
          await (chain.sleep ?? sleepUnlessAborted)(next.delayMs, this.abort.signal);
          if (this.stopRequested) throw new StopRequested();
        } else {
          const afterMs = now() - startedAt;
          const note = hadEarlierTurns ? " The new session does not contain the earlier messages of this chat." : "";
          ui.onChain?.({ kind: "switched", model: next.model, text: `${switchedMessage({ model, failure }, next.model, afterMs)}.${note}`, afterMs });
          log?.(`fallback: ${model} -> ${next.model} after ${afterMs} ms`);
          model = next.model;
        }
      }
    }
  }

  private async run(text: string): Promise<void> {
    const { ui } = this.deps;
    this.attemptAbort = new AbortController();
    const attempt = this.attemptAbort;
    if (this.abort.signal.aborted) attempt.abort();
    else this.abort.signal.addEventListener("abort", () => attempt.abort(), { once: true });
    const reducer = new TurnReducer();
    const continuingPausedSession = await this.ensureSession();
    if (this.stopRequested) throw new StopRequested();

    let input: TurnInput[] = [{ type: "user.message", content: text }];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      reducer.beginRound();
      const stream = await this.openStream(input, round === 0 && continuingPausedSession);
      await this.consumeRound(stream, reducer);
      if (this.stopRequested) throw new StopRequested();
      const view = reducer.view;
      this.lastView = view;

      if (!view.done) {
        if (this.stopRequested) throw new StopRequested();
        throw new RunFailed("The connection to TrueForge ended before the turn finished.", "turn", "transient");
      }
      if (view.done.status === "error") throw new RunFailed(view.done.message, "turn");
      if (view.done.status === "cancelled") throw new StopRequested(view.done.reason);

      if (view.unsupportedPauses.length > 0) {
        this.markPaused();
        throw new RunFailed(`Agent needs input of a type Forge doesn't support yet: ${view.unsupportedPauses.join(", ")}`);
      }
      if (view.pendingApprovals.length === 0) {
        this.finish("done");
        return;
      }

      // The turn is paused on tool approvals: decide all of them at once, then resume with one turn.
      this.runState.transition("awaitingApproval");
      const calls = view.pendingApprovals.map((p): PendingToolCall => {
        const known = reducer.toolCall(p.toolCallId);
        return { id: p.toolCallId, name: known?.name || "(unknown tool)", args: known?.args ?? "", threadId: p.threadId, sourceEventId: p.sourceEventId };
      });
      let decisions: ApprovalDecision[];
      try {
        decisions = await this.collectDecisions(calls);
      } catch (err) {
        this.markPaused();
        throw err instanceof StopRequested ? err : new RunFailed(`Approval failed: ${describeError(err)}`);
      }
      this.runState.transition("running");

      const nowIso = (this.deps.now?.() ?? new Date()).toISOString();
      input = calls.map((call, i): TurnInput => {
        const approval = decisions[i] ?? { status: "deny", reason: "No decision was made." };
        const change = reducer.noteApproval(call.id, approval, nowIso);
        this.lastView = reducer.view;
        ui.onTurnChange(this.lastView, change);
        return { type: "user.tool_approval", threadId: call.threadId, toolCallId: call.id, approval };
      });
      this.deps.log?.(`approval round ${round + 1}: ${decisions.map((d) => d.status).join(",")}`);
    }
    throw new RunFailed(`The agent kept asking for approvals (more than ${MAX_ROUNDS} rounds); stopping.`);
  }

  /** Applies one event to the reducer and the UI. */
  private applyEvent(event: StreamEvent, reducer: TurnReducer): void {
    const change = reducer.apply(event); // apply first: `view` must reflect this event
    this.lastView = reducer.view;
    this.deps.ui.onTurnChange(this.lastView, change);
  }

  /**
   * Feeds one round's stream to the reducer. When the stream throws or ends without turn.done (a dropped connection,
   * "terminated"), the turn may still be running on the server: ask for its status; if running, re-attach ONCE after the
   * events already received; if finished, rebuild the end state from the turn's event log; otherwise give up with the
   * real reason. Every attempt is logged.
   */
  private async consumeRound(stream: AsyncIterable<StreamEvent>, reducer: TurnReducer): Promise<void> {
    let seen = 0;
    let turnId: string | undefined;
    const now = this.deps.chain?.now ?? Date.now;
    const stallLimits = this.deps.chain?.stall?.();
    let lastProgress = now();
    let sawToken = false;
    let stalled: string | undefined;
    let watchdog: ReturnType<typeof setInterval> | undefined;
    if (stallLimits) {
      watchdog = setInterval(() => {
        const view = reducer.view;
        // tool time and human time are not stalls: pause while a tool runs, an approval is pending or compaction runs
        const paused = this.runState.state === "awaitingApproval" || view.compaction.active || view.toolCalls.some((c) => c.status === "running" || c.status === "awaiting_approval");
        if (paused) {
          lastProgress = now();
          return;
        }
        const limit = sawToken ? stallLimits.idleMs : stallLimits.firstMs;
        if (stalled === undefined && now() - lastProgress > limit) {
          stalled = `no stream progress for ${Math.round(limit / 1000)} s${sawToken ? "" : " (no first token)"}`;
          const session = this.ctx?.session;
          if (session) this.fireCancel(session.id, "stall watchdog"); // the same instant, no-wait path as Stop
          this.attemptAbort.abort();
        }
      }, this.deps.chain?.tickMs ?? 1000);
      watchdog.unref?.();
    }
    const feed = async (source: AsyncIterable<StreamEvent>): Promise<unknown> => {
      const iterator = source[Symbol.asyncIterator]();
      const aborted = new Promise<typeof ABORTED>((resolve) => {
        const signal = this.attemptAbort.signal;
        if (signal.aborted) resolve(ABORTED);
        else signal.addEventListener("abort", () => resolve(ABORTED), { once: true });
      });
      try {
        for (;;) {
          // race the reader against the abort so a stream that ignores the signal cannot hold the run
          const step = await Promise.race([iterator.next(), aborted]);
          if (step === ABORTED) {
            void iterator.return?.().catch(() => undefined);
            if (this.stopRequested) throw new StopRequested();
            if (stalled !== undefined) throw new StallError(stalled);
            return new Error("the stream was aborted");
          }
          if (step.done) return undefined;
          const event = step.value;
          if (this.stopRequested) return undefined; // late events after Stop are ignored
          if (event.type === "turn.created") turnId = event.turnId;
          seen++;
          this.applyEvent(event, reducer);
          if (isProgress(event)) {
            lastProgress = now();
            if (isToken(event)) sawToken = true;
          }
        }
      } catch (err) {
        if (err instanceof StopRequested || err instanceof StallError) throw err;
        if (this.stopRequested) throw new StopRequested(); // the aborted reader throws; that is the Stop we asked for
        if (stalled !== undefined) throw new StallError(stalled);
        return err ?? new Error("stream error");
      }
    };
    try {
      await this.drain(feed, stream, reducer, () => seen, () => turnId);
    } finally {
      if (watchdog) clearInterval(watchdog);
    }
  }

  private async drain(feed: (source: AsyncIterable<StreamEvent>) => Promise<unknown>, stream: AsyncIterable<StreamEvent>, reducer: TurnReducer, getSeen: () => number, getTurnId: () => string | undefined): Promise<void> {
    const { log } = this.deps;
    const failure = await feed(stream);
    if (this.stopRequested || reducer.view.done) return;
    const seen = getSeen();
    const turnId = getTurnId();

    const session = this.ctx?.session;
    const client = this.deps.client;
    const reason = failure !== undefined ? describeError(failure) : "the stream ended without turn.done";
    if (!session || !turnId || !client.getTurnStatus) {
      if (failure !== undefined) throw new RunFailed(describeError(failure), "turn"); // cannot recover: report the actual error
      return; // the caller reports "connection ended"
    }
    log?.(`stream interrupted after ${seen} events (${reason}); checking turn ${turnId}`);
    let status: string;
    try {
      status = await client.getTurnStatus(session.id, turnId);
    } catch (err) {
      log?.(`resume: could not read the turn status (${describeError(err)})`);
      if (failure !== undefined) throw new RunFailed(`The connection to TrueForge was lost (${reason}) and the turn status could not be read (${describeError(err)}). Is TrueForge still running?`, "transport", "trueforge-down");
      return;
    }
    if (status === "running") {
      if (!client.subscribeToTurn) return;
      log?.(`resume: turn still running; re-attaching after event ${seen}`);
      let again: AsyncIterable<StreamEvent>;
      try {
        again = await client.subscribeToTurn(session.id, turnId, { afterSequenceNumber: seen, signal: this.attemptAbort.signal });
      } catch (err) {
        if (this.stopRequested) throw new StopRequested();
        throw new RunFailed(`The connection to TrueForge was lost (${reason}) and re-attaching to the turn failed: ${describeError(err)}`, "turn", "transient");
      }
      const second = await feed(again);
      if (!this.stopRequested && !reducer.view.done) {
        throw new RunFailed(`The connection to TrueForge dropped again after resuming (${second !== undefined ? describeError(second) : "the stream ended without turn.done"}).`, "turn", "transient");
      }
      log?.(`resume: re-attached stream delivered ${getSeen()} events in total`);
      return;
    }
    if (client.listTurnEvents) {
      log?.(`resume: turn is ${status}; rebuilding the final state from its event log`);
      let list: StreamEvent[];
      try {
        list = await client.listTurnEvents(session.id, turnId);
      } catch (err) {
        throw new RunFailed(`The connection to TrueForge was lost (${reason}) and the finished turn could not be read: ${describeError(err)}`, "transport", "trueforge-down");
      }
      for (const event of list) {
        if (this.stopRequested) throw new StopRequested();
        this.applyEvent(event, reducer); // the reducer is idempotent for these (same ids replace)
      }
    }
  }

  /** Asks the handler about every pending call at the same time; results keep TrueForge's order. */
  private async collectDecisions(calls: readonly PendingToolCall[]): Promise<ApprovalDecision[]> {
    const { signal } = this.abort;
    if (signal.aborted) throw new StopRequested();
    const aborted = new Promise<never>((_resolve, reject) => {
      signal.addEventListener("abort", () => reject(new StopRequested()), { once: true });
    });
    aborted.catch(() => undefined); // the race below observes it; avoid an unhandled rejection otherwise
    return Promise.race([Promise.all(calls.map((call) => this.deps.approvals.decide(call, signal))), aborted]);
  }

  /**
   * Makes sure the run has a session. A fresh-session run (inline edit) always creates its own and leaves the
   * panel's alone. Returns true when the run deliberately continues a panel session left paused.
   */
  private async ensureSession(): Promise<boolean> {
    const { ui } = this.deps;
    const ctx = this.ctx;
    if (!ctx) throw new RunFailed("No run in progress.");
    const fresh = ctx.options.freshSession === true;
    let continuingPaused = false;
    if (!fresh && this.session?.paused) {
      if (this.afterPause === "new-session") {
        this.session = undefined;
        ui.onNotice("info", "Started a new session (the previous one was waiting on an approval).");
      } else {
        this.session.paused = false;
        continuingPaused = true;
      }
    }
    if (!fresh && this.session && ctx.options.model !== undefined && this.session.model !== undefined && this.session.model !== ctx.options.model) {
      this.session = undefined; // the model was switched (Forge: Switch Model): a session keeps its model, so start a new one
      continuingPaused = false;
    }
    if (!fresh && this.session) {
      ctx.session = this.session;
      return continuingPaused;
    }

    const agentName = fresh ? (ctx.options.agentName ?? this.deps.agentName) : this.deps.agentName;
    const requestedModel = ctx.options.model;
    let model = requestedModel;
    if (this.deps.prepare) {
      const prepared = await this.deps.prepare({ agentName, ...(requestedModel ? { model: requestedModel } : {}) });
      if (!prepared.ok) {
        const notConfigured = /is not configured in TrueForge/.test(prepared.message);
        throw new RunFailed(prepared.message, notConfigured ? "turn" : "transport", notConfigured ? "unreachable" : /not reachable/.test(prepared.message) ? "trueforge-down" : "fatal");
      }
      model = prepared.model ?? requestedModel;
    }
    if (this.stopRequested) throw new StopRequested();
    const created = await this.deps.client.createSession({
      agentName,
      ...(requestedModel ? { model: requestedModel } : {}),
      metadata: { client: "forge-agent", purpose: ctx.options.purpose ?? (fresh ? "fresh-run" : "panel") },
    });
    const ref: SessionRef = { id: created.id, paused: false, model: requestedModel };
    ctx.session = ref;
    if (!fresh) this.session = ref;
    ui.onSession({ sessionId: created.id, ...(model ? { model } : {}) });
    return false;
  }

  /**
   * Opens the turn stream. When the panel session was left paused and we chose to continue it, a rejection by
   * TrueForge silently falls back to a new session (the user's message is simply sent there instead).
   */
  private async openStream(input: TurnInput[], mayFallBackToNewSession: boolean): Promise<AsyncIterable<StreamEvent>> {
    const session = this.ctx?.session;
    if (!session) throw new RunFailed("No session.");
    try {
      return await this.deps.client.createTurnStream(session.id, input, { signal: this.attemptAbort.signal });
    } catch (err) {
      if (!mayFallBackToNewSession) throw err;
      this.deps.log?.(`continuing the paused session failed (${describeError(err)}); starting a new session`);
      this.session = undefined;
      await this.ensureSession();
      const fresh = this.ctx?.session;
      if (!fresh) throw new RunFailed("No session.");
      return this.deps.client.createTurnStream(fresh.id, input, { signal: this.attemptAbort.signal });
    }
  }

  private markPaused(): void {
    // Only the panel's conversation can be continued later; a fresh (inline) session is used once.
    if (this.ctx?.options.freshSession !== true && this.ctx?.session) this.ctx.session.paused = true;
  }

  private finish(state: "done" | "error" | "cancelled", detail?: string): void {
    if (!this.runState.busy || this.runState.state === "cancelling") return; // the Stop flow owns the final transition
    this.lastDetail = detail;
    this.runState.transition(state, detail);
  }

  private fail(message: string): void {
    this.deps.ui.onNotice("error", message);
    this.finish("error", message);
  }
}
