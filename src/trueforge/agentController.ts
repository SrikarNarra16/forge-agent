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
  createTurnStream(sessionId: string, input: TurnInput[]): Promise<AsyncIterable<StreamEvent>>;
  cancel(sessionId: string): Promise<void>;
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

class StopRequested extends Error {
  constructor(readonly reason = "Stopped") {
    super(reason);
    this.name = "StopRequested";
  }
}

class RunFailed extends Error {}

interface SessionRef {
  id: string;
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
    this.abort = new AbortController();
    this.ctx = { options, session: undefined };
    this.lastView = undefined;
    this.lastDetail = undefined;
    this.runState.transition("running");
    this.deps.ui.onUserMessage(options.display ?? message);
    try {
      await this.run(message);
    } catch (err) {
      if (err instanceof StopRequested) this.finish("cancelled", err.reason);
      else this.fail(err instanceof RunFailed ? err.message : describeError(err));
    }
    const view = this.lastView ?? new TurnReducer().view;
    return { ok: true, state: this.runState.state, view, ...(this.lastDetail !== undefined ? { detail: this.lastDetail } : {}) };
  }

  /**
   * Stop button. While running it asks TrueForge to cancel and lets the stream end itself with
   * turn.done(cancelled); while waiting for approval it abandons the pending decisions without resuming.
   */
  async stop(): Promise<void> {
    const state = this.runState.state;
    if (state === "awaitingApproval") {
      this.stopRequested = true;
      this.abort.abort();
      return;
    }
    if (state !== "running") return;
    this.stopRequested = true;
    const session = this.ctx?.session;
    if (!session) {
      this.abort.abort(); // still preparing/creating the session: no turn exists yet
      return;
    }
    try {
      await this.deps.client.cancel(session.id);
    } catch (err) {
      this.stopRequested = false;
      this.deps.ui.onNotice("error", `Could not cancel the run: ${describeError(err)}`);
    }
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

  private async run(text: string): Promise<void> {
    const { ui } = this.deps;
    const reducer = new TurnReducer();
    const continuingPausedSession = await this.ensureSession();
    if (this.stopRequested) throw new StopRequested();

    let input: TurnInput[] = [{ type: "user.message", content: text }];
    for (let round = 0; round < MAX_ROUNDS; round++) {
      reducer.beginRound();
      const stream = await this.openStream(input, round === 0 && continuingPausedSession);
      for await (const event of stream) {
        const change = reducer.apply(event); // apply first: `view` must reflect this event
        this.lastView = reducer.view;
        ui.onTurnChange(this.lastView, change);
      }
      const view = reducer.view;
      this.lastView = view;

      if (!view.done) {
        if (this.stopRequested) throw new StopRequested();
        throw new RunFailed("The connection to TrueForge ended before the turn finished.");
      }
      if (view.done.status === "error") throw new RunFailed(view.done.message);
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
    if (!fresh && this.session) {
      ctx.session = this.session;
      return continuingPaused;
    }

    const agentName = fresh ? (ctx.options.agentName ?? this.deps.agentName) : this.deps.agentName;
    const requestedModel = ctx.options.model;
    let model = requestedModel;
    if (this.deps.prepare) {
      const prepared = await this.deps.prepare({ agentName, ...(requestedModel ? { model: requestedModel } : {}) });
      if (!prepared.ok) throw new RunFailed(prepared.message);
      model = prepared.model ?? requestedModel;
    }
    if (this.stopRequested) throw new StopRequested();
    const created = await this.deps.client.createSession({
      agentName,
      ...(requestedModel ? { model: requestedModel } : {}),
      metadata: { client: "forge-agent", purpose: ctx.options.purpose ?? (fresh ? "fresh-run" : "panel") },
    });
    const ref: SessionRef = { id: created.id, paused: false };
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
      return await this.deps.client.createTurnStream(session.id, input);
    } catch (err) {
      if (!mayFallBackToNewSession) throw err;
      this.deps.log?.(`continuing the paused session failed (${describeError(err)}); starting a new session`);
      this.session = undefined;
      await this.ensureSession();
      const fresh = this.ctx?.session;
      if (!fresh) throw new RunFailed("No session.");
      return this.deps.client.createTurnStream(fresh.id, input);
    }
  }

  private markPaused(): void {
    // Only the panel's conversation can be continued later; a fresh (inline) session is used once.
    if (this.ctx?.options.freshSession !== true && this.ctx?.session) this.ctx.session.paused = true;
  }

  private finish(state: "done" | "error" | "cancelled", detail?: string): void {
    if (!this.runState.busy) return;
    this.lastDetail = detail;
    this.runState.transition(state, detail);
  }

  private fail(message: string): void {
    this.deps.ui.onNotice("error", message);
    this.finish("error", message);
  }
}
