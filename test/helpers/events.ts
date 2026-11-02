import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { StreamEvent } from "../../src/trueforge/events";

/** Builders for TrueForge stream events, typed loosely: tests only set the fields that matter. */

let counter = 0;
export function nextId(prefix: string): string {
  return `${prefix}_${String(++counter).padStart(4, "0")}`;
}

export function at(seconds: number): string {
  return new Date(Date.UTC(2026, 10, 2, 10, 0, seconds)).toISOString();
}

export interface CallSpec {
  id: string;
  name: string;
  args?: string;
}

function toolCallsOf(calls: readonly CallSpec[] | undefined): unknown[] | undefined {
  return calls?.map((c) => ({
    id: c.id,
    type: "function",
    function: { name: c.name, arguments: c.args ?? "{}" },
    toolInfo: { type: "mcp", name: c.name, serverId: "srv", serverName: "forge-spike-mcp" },
  }));
}

export function turnCreated(turnId = nextId("turn")): StreamEvent {
  return { type: "turn.created", id: nextId("evt"), turnId, previousTurnId: null, threadId: null, createdAt: at(0), state: { status: "running" } } as StreamEvent;
}

export function modelMessage(o: { id: string; threadId?: string; content?: string; calls?: readonly CallSpec[]; finish?: string; seconds?: number }): StreamEvent {
  const toolCalls = toolCallsOf(o.calls);
  return {
    type: "model.message",
    id: o.id,
    threadId: o.threadId ?? "main",
    createdAt: at(o.seconds ?? 1),
    ...(o.content !== undefined ? { content: o.content } : {}),
    ...(toolCalls ? { toolCalls } : {}),
    ...(o.finish ? { finishReason: o.finish } : {}),
  } as StreamEvent;
}

export function delta(o: {
  id: string;
  threadId?: string;
  content?: string;
  finish?: string;
  calls?: Array<{ index: number; id?: string; name?: string; args?: string }>;
}): StreamEvent {
  return {
    type: "model.message.delta",
    id: o.id,
    threadId: o.threadId ?? "main",
    ...(o.content !== undefined ? { content: o.content } : {}),
    ...(o.finish ? { finishReason: o.finish } : {}),
    ...(o.calls
      ? {
          toolCalls: o.calls.map((c) => ({
            index: c.index,
            ...(c.id ? { id: c.id, type: "function" } : {}),
            ...(c.name || c.args !== undefined ? { function: { ...(c.name ? { name: c.name } : {}), ...(c.args !== undefined ? { arguments: c.args } : {}) } } : {}),
            ...(c.name ? { toolInfo: { type: "mcp", name: c.name, serverId: "srv", serverName: "forge-spike-mcp" } } : {}),
          })),
        }
      : {}),
  } as StreamEvent;
}

export function toolResponse(o: { toolCallId: string; content: string; threadId?: string; seconds?: number }): StreamEvent {
  return { type: "tool.response", id: nextId("evt"), threadId: o.threadId ?? "main", toolCallId: o.toolCallId, content: o.content, createdAt: at(o.seconds ?? 2) } as StreamEvent;
}

export function approvalRequired(o: { threadId?: string; calls: ReadonlyArray<{ id: string; sourceEventId: string }> }): TrueForgeApi.ToolApprovalRequiredEvent {
  return { type: "tool.approval_required", id: nextId("evt"), threadId: o.threadId ?? "main", createdAt: at(2), toolCalls: o.calls.map((c) => ({ ...c })) };
}

export type DoneSpec =
  | { status: "done"; text?: string; required?: ReadonlyArray<{ type: string } & Record<string, unknown>> }
  | { status: "error"; message: string }
  | { status: "cancelled"; reason?: string };

export function turnDone(spec: DoneSpec = { status: "done" }): StreamEvent {
  const base = { type: "turn.done", id: nextId("evt"), threadId: null, createdAt: at(9) };
  if (spec.status === "error") return { ...base, state: { status: "error", message: spec.message, completedAt: at(9) } } as StreamEvent;
  if (spec.status === "cancelled") return { ...base, state: { status: "cancelled", reason: spec.reason ?? "client-cancelled", completedAt: at(9) } } as StreamEvent;
  return {
    ...base,
    state: {
      status: "done",
      completedAt: at(9),
      output: spec.text ? { type: "model.message", id: nextId("out"), threadId: "main", createdAt: at(9), content: spec.text } : null,
      requiredActions: spec.required ?? [],
    },
  } as StreamEvent;
}

/** A turn that pauses on the given approvals: the streamed event AND turn.done.requiredActions, like TrueForge. */
export function pausedOnApprovals(calls: ReadonlyArray<{ id: string; sourceEventId: string }>, threadId = "main"): StreamEvent[] {
  const approval = approvalRequired({ threadId, calls });
  return [approval as StreamEvent, turnDone({ status: "done", required: [approval as unknown as { type: string }] })];
}

export function threadCreated(o: { threadId: string; title: string; parentThreadId?: string; parentToolCallId?: string; model?: string }): StreamEvent {
  return {
    type: "thread.created",
    id: nextId("evt"),
    threadId: o.threadId,
    title: o.title,
    createdAt: at(3),
    parent: { threadId: o.parentThreadId ?? "main", toolCallId: o.parentToolCallId ?? "call_parent" },
    agentInfo: { type: "dynamic", name: "scout", input: "explore", ...(o.model ? { model: o.model } : {}) },
  } as StreamEvent;
}

export function threadDone(o: { threadId: string; title: string; error?: string }): StreamEvent {
  return {
    type: "thread.done",
    id: nextId("evt"),
    threadId: o.threadId,
    title: o.title,
    createdAt: at(4),
    state: o.error ? { status: "error", error: o.error } : { status: "done", output: { type: "model.message", id: nextId("out"), threadId: o.threadId, createdAt: at(4), content: "ok" } },
  } as StreamEvent;
}

export function compactionStarted(): StreamEvent {
  return { type: "thread.context_compaction_started", id: nextId("evt"), threadId: "main", createdAt: at(5), trigger: { type: "context_threshold_exceeded", contextTokens: 90000, thresholdTokens: 80000 } } as StreamEvent;
}

export function compactionFinished(durationMs = 1234): StreamEvent {
  return {
    type: "thread.context_compaction_finished",
    id: nextId("evt"),
    threadId: "main",
    createdAt: at(6),
    durationMs,
    trigger: { type: "context_threshold_exceeded", contextTokens: 90000, thresholdTokens: 80000 },
    usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 },
  } as unknown as StreamEvent;
}

export function mcpInitialize(names: string[]): StreamEvent {
  return { type: "mcp.initialize", id: nextId("evt"), threadId: "main", createdAt: at(1), mcpServers: names.map((name) => ({ id: `id_${name}`, name })) } as StreamEvent;
}

export function mcpAuthRequired(): StreamEvent {
  return { type: "mcp.auth_required", id: nextId("evt"), threadId: "main", createdAt: at(2), mcpServers: [] } as unknown as StreamEvent;
}

export function toolResponseRequired(calls: ReadonlyArray<{ id: string; sourceEventId: string }>): StreamEvent {
  return { type: "tool.response_required", id: nextId("evt"), threadId: "main", createdAt: at(2), toolCalls: calls.map((c) => ({ ...c })) } as StreamEvent;
}
