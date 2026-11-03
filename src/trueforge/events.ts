import { isEventDelta, mergeEventDelta, type TrueForgeApi } from "@truefoundry/trueforge-sdk";

/**
 * Pure (vscode-free) reducer over TrueForge stream events. One reducer lives for one user send and is
 * fed every round of it (the first turn plus any approval-resume turns), because a tool call is announced
 * in one turn and its response arrives in the next. It merges `model.message` deltas with the SDK helpers,
 * keeps a `tool_call.id -> {name, args, thread}` map, tracks subagent threads, compaction and the final
 * `turn.done`, and extracts what the turn is waiting for (tool approvals vs. unsupported pauses).
 */

export type StreamEvent = TrueForgeApi.TurnStreamingEvent;
export type TurnDoneState = TrueForgeApi.TurnDoneEventState;

export type ToolCallStatus = "running" | "awaiting_approval" | "done" | "denied";

export interface ToolCallInfo {
  id: string;
  name: string;
  /** Raw JSON string of the arguments, as the model produced it. */
  args: string;
  threadId: string;
  /** Id of the model.message that made the call. */
  sourceEventId: string;
  status: ToolCallStatus;
  /** tool.response content. */
  response?: string;
  /** Why the user denied it, when they did. */
  denyReason?: string;
  /** ISO time the tool started executing (message time, or approval time for gated calls). */
  startedAt?: string;
  endedAt?: string;
  durationMs?: number;
}

export interface MessageInfo {
  id: string;
  threadId: string;
  text: string;
  reasoning: string;
  /** True once a finish reason has been seen. */
  complete: boolean;
  toolCallIds: string[];
}

export interface ThreadInfo {
  id: string;
  title: string;
  model?: string;
  parentThreadId?: string;
  parentToolCallId?: string;
  state: "running" | "done" | "error";
}

export interface PendingApproval {
  toolCallId: string;
  threadId: string;
  sourceEventId: string;
}

export type TimelineEntry = { kind: "message"; id: string } | { kind: "tool"; id: string };

export interface CompactionInfo {
  active: boolean;
  count: number;
  lastDurationMs?: number;
}

/** Input-token accounting TrueForge reports for one model call. */
export interface ModelUsage {
  messageId: string;
  threadId: string;
  /** All input tokens of the call. */
  inputTokens: number;
  outputTokens?: number;
  /** The part of them that is conversation messages (excludes harness, instructions and tool definitions). */
  messageTokens?: number;
}

export interface TurnView {
  messages: MessageInfo[];
  /** Usage of each model call that reported it, in call order. */
  usage: ModelUsage[];
  toolCalls: ToolCallInfo[];
  /** Messages and tool calls in the order they first appeared. */
  timeline: TimelineEntry[];
  threads: ThreadInfo[];
  mcpServers: string[];
  compaction: CompactionInfo;
  /** Tool calls waiting for an approval decision in the current round, in the order TrueForge listed them. */
  pendingApprovals: PendingApproval[];
  /** Event types of pauses Forge cannot answer (tool.response_required, mcp.auth_required, unknown). */
  unsupportedPauses: string[];
  /** The current round's turn.done state. Undefined while streaming. */
  done: TurnDoneState | undefined;
}

/** What one `apply` changed, so the UI only touches affected items. */
export interface ReducerChange {
  messages: string[];
  toolCalls: string[];
  threads: string[];
  compaction: boolean;
  /** pendingApprovals or unsupportedPauses changed. */
  pause: boolean;
  done: boolean;
}

export type ApprovalOutcome = { status: "allow" } | { status: "deny"; reason?: string | undefined };

/** Plain text of a model message (string content or text parts; refusals are ignored). */
export function messageText(content: TrueForgeApi.ModelMessageEvent["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((part) => ("text" in part && typeof part.text === "string" ? part.text : "")).join("");
}

function emptyChange(): ReducerChange {
  return { messages: [], toolCalls: [], threads: [], compaction: false, pause: false, done: false };
}

function ms(iso: string | undefined): number | undefined {
  if (!iso) return undefined;
  const t = Date.parse(iso);
  return Number.isNaN(t) ? undefined : t;
}

export class TurnReducer {
  /** Base events by id (deltas are merged into these in place, so they are private copies). */
  private readonly modelMessages = new Map<string, TrueForgeApi.ModelMessageEvent>();
  private readonly messages = new Map<string, MessageInfo>();
  private readonly toolCalls = new Map<string, ToolCallInfo>();
  private readonly threads = new Map<string, ThreadInfo>();
  private readonly timeline: TimelineEntry[] = [];
  private readonly mcpServers: string[] = [];
  private compaction: CompactionInfo = { active: false, count: 0 };
  private pending: PendingApproval[] = [];
  private unsupported: string[] = [];
  private done: TurnDoneState | undefined;
  /** Deltas that arrived without their base message (should not happen on a full stream). */
  orphanDeltas = 0;

  /** Call before each round (initial turn or approval resume): clears the pause and done state, keeps history. */
  beginRound(): void {
    this.pending = [];
    this.unsupported = [];
    this.done = undefined;
  }

  get view(): TurnView {
    return {
      messages: [...this.messages.values()],
      usage: this.collectUsage(),
      toolCalls: [...this.toolCalls.values()],
      timeline: [...this.timeline],
      threads: [...this.threads.values()],
      mcpServers: [...this.mcpServers],
      compaction: { ...this.compaction },
      pendingApprovals: [...this.pending],
      unsupportedPauses: [...this.unsupported],
      done: this.done,
    };
  }

  private collectUsage(): ModelUsage[] {
    const out: ModelUsage[] = [];
    for (const message of this.modelMessages.values()) {
      const usage: unknown = (message as { usage?: unknown }).usage;
      if (typeof usage !== "object" || usage === null) continue;
      const input = (usage as { inputTokens?: unknown }).inputTokens;
      if (typeof input !== "number") continue;
      const breakdown = (usage as { inputTokensBreakdown?: { messages?: unknown } }).inputTokensBreakdown;
      out.push({
        messageId: message.id,
        threadId: message.threadId,
        inputTokens: input,
        ...(typeof (usage as { outputTokens?: unknown }).outputTokens === "number" ? { outputTokens: (usage as { outputTokens: number }).outputTokens } : {}),
        ...(typeof breakdown?.messages === "number" ? { messageTokens: breakdown.messages } : {}),
      });
    }
    return out;
  }

  toolCall(id: string): ToolCallInfo | undefined {
    return this.toolCalls.get(id);
  }

  /**
   * Records the user's decision for a gated call. TrueForge may also echo a `user.tool_approval` event in
   * the resume stream; both paths end in the same state. `nowIso` is when execution starts for allowed calls.
   */
  noteApproval(toolCallId: string, outcome: ApprovalOutcome, nowIso: string): ReducerChange {
    const change = emptyChange();
    const call = this.toolCalls.get(toolCallId);
    if (!call) return change;
    if (outcome.status === "allow") {
      call.status = "running";
      call.startedAt = nowIso;
    } else {
      call.status = "denied";
      if (outcome.reason !== undefined) call.denyReason = outcome.reason;
    }
    change.toolCalls.push(toolCallId);
    return change;
  }

  apply(event: StreamEvent): ReducerChange {
    const change = emptyChange();
    if (isEventDelta(event)) {
      const base = this.modelMessages.get(event.id);
      if (!base) {
        this.orphanDeltas++;
        return change;
      }
      mergeEventDelta(base, event);
      this.syncMessage(base, change);
      return change;
    }
    switch (event.type) {
      case "model.message": {
        const base = structuredClone(event);
        this.modelMessages.set(base.id, base);
        this.syncMessage(base, change);
        break;
      }
      case "tool.response": {
        const call = this.toolCalls.get(event.toolCallId);
        if (call) {
          call.response = event.content;
          call.endedAt = event.createdAt;
          const start = ms(call.startedAt);
          const end = ms(event.createdAt);
          if (start !== undefined && end !== undefined) call.durationMs = Math.max(0, end - start);
          if (call.status !== "denied") call.status = "done";
          change.toolCalls.push(call.id);
        }
        break;
      }
      case "user.tool_approval": {
        const outcome: ApprovalOutcome =
          event.approval.status === "allow" ? { status: "allow" } : { status: "deny", reason: event.approval.reason };
        const call = this.toolCalls.get(event.toolCallId);
        // The echo carries no new information when the controller already noted the decision.
        if (call && call.status === "awaiting_approval") return this.noteApproval(event.toolCallId, outcome, event.createdAt);
        break;
      }
      case "tool.approval_required":
        this.addPendingApprovals(event.threadId, event.toolCalls, change);
        break;
      case "tool.response_required":
      case "mcp.auth_required":
        this.addUnsupported(event.type, change);
        break;
      case "thread.created": {
        const thread: ThreadInfo = {
          id: event.threadId,
          title: event.title,
          state: "running",
          parentThreadId: event.parent.threadId,
          parentToolCallId: event.parent.toolCallId,
          ...(event.agentInfo.model ? { model: event.agentInfo.model } : {}),
        };
        this.threads.set(thread.id, thread);
        change.threads.push(thread.id);
        break;
      }
      case "thread.done": {
        const existing = this.threads.get(event.threadId);
        const thread: ThreadInfo = existing ?? { id: event.threadId, title: event.title, state: "running" };
        thread.state = event.state.status === "error" ? "error" : "done";
        thread.title = event.title || thread.title;
        this.threads.set(thread.id, thread);
        change.threads.push(thread.id);
        break;
      }
      case "mcp.initialize":
        for (const server of event.mcpServers) if (!this.mcpServers.includes(server.name)) this.mcpServers.push(server.name);
        break;
      case "thread.context_compaction_started":
        this.compaction.active = true;
        change.compaction = true;
        break;
      case "thread.context_compaction_finished":
        this.compaction = { active: false, count: this.compaction.count + 1, lastDurationMs: event.durationMs };
        change.compaction = true;
        break;
      case "turn.done":
        this.done = event.state;
        change.done = true;
        if (event.state.status === "done") {
          for (const action of event.state.requiredActions) this.applyRequiredAction(action, change);
        }
        break;
      default:
        break; // turn.created, turn.update, sandbox.created, user.message echoes, ...: nothing to track
    }
    return change;
  }

  private applyRequiredAction(action: TrueForgeApi.ActionRequiredEvent, change: ReducerChange): void {
    // `type` is read as a plain string so a future action type lands in the unsupported bucket instead of being dropped.
    const type: string = action.type;
    if (type === "tool.approval_required") {
      const approval = action as TrueForgeApi.ToolApprovalRequiredEvent;
      this.addPendingApprovals(approval.threadId, approval.toolCalls, change);
    } else {
      this.addUnsupported(type, change);
    }
  }

  private addPendingApprovals(threadId: string, refs: readonly TrueForgeApi.ToolCallRef[], change: ReducerChange): void {
    for (const ref of refs) {
      if (this.pending.some((p) => p.toolCallId === ref.id)) continue; // streamed AND listed in requiredActions
      this.pending.push({ toolCallId: ref.id, threadId, sourceEventId: ref.sourceEventId });
      const call = this.toolCalls.get(ref.id) ?? this.recoverToolCall(ref, threadId);
      if (call) {
        call.status = "awaiting_approval";
        change.toolCalls.push(call.id);
      }
      change.pause = true;
    }
  }

  /** A tool call named by an approval ref but not yet in the map: read it from its source message. */
  private recoverToolCall(ref: TrueForgeApi.ToolCallRef, threadId: string): ToolCallInfo | undefined {
    const source = this.modelMessages.get(ref.sourceEventId);
    if (!source) return undefined;
    this.syncMessage(source, emptyChange());
    const call = this.toolCalls.get(ref.id);
    if (call) call.threadId = call.threadId || threadId;
    return call;
  }

  private addUnsupported(type: string, change: ReducerChange): void {
    if (!this.unsupported.includes(type)) this.unsupported.push(type);
    change.pause = true;
  }

  /** Mirrors a (merged) model.message into MessageInfo and its tool calls into the tool-call map. */
  private syncMessage(base: TrueForgeApi.ModelMessageEvent, change: ReducerChange): void {
    let info = this.messages.get(base.id);
    if (!info) {
      info = { id: base.id, threadId: base.threadId, text: "", reasoning: "", complete: false, toolCallIds: [] };
      this.messages.set(base.id, info);
      this.timeline.push({ kind: "message", id: base.id });
    }
    info.text = messageText(base.content);
    info.reasoning = base.reasoningContent ?? "";
    info.complete = base.finishReason != null;
    change.messages.push(base.id);

    for (const tc of base.toolCalls ?? []) {
      if (!tc.id) continue;
      const name = tc.toolInfo?.name || tc.function?.name || "";
      const args = tc.function?.arguments ?? "";
      let call = this.toolCalls.get(tc.id);
      if (!call) {
        call = { id: tc.id, name, args, threadId: base.threadId, sourceEventId: base.id, status: "running", startedAt: base.createdAt };
        this.toolCalls.set(tc.id, call);
        this.timeline.push({ kind: "tool", id: tc.id });
        info.toolCallIds.push(tc.id);
      } else {
        call.name = name || call.name;
        call.args = args;
      }
      change.toolCalls.push(tc.id);
    }
  }
}
