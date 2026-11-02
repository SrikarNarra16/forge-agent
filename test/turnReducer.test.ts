import { describe, expect, it } from "vitest";
import { TurnReducer, messageText, type StreamEvent } from "../src/trueforge/events";
import {
  approvalRequired, compactionFinished, compactionStarted, delta, mcpAuthRequired, mcpInitialize, modelMessage, pausedOnApprovals,
  threadCreated, threadDone, toolResponse, toolResponseRequired, turnDone,
} from "./helpers/events";

function feed(reducer: TurnReducer, events: StreamEvent[]): void {
  for (const e of events) reducer.apply(e);
}

describe("TurnReducer: messages", () => {
  it("merges streamed deltas into the base model.message", () => {
    const r = new TurnReducer();
    feed(r, [modelMessage({ id: "m1" }), delta({ id: "m1", content: "Hel" }), delta({ id: "m1", content: "lo" }), delta({ id: "m1", content: " world", finish: "stop" })]);
    expect(r.view.messages).toEqual([{ id: "m1", threadId: "main", text: "Hello world", reasoning: "", complete: true, toolCallIds: [] }]);
  });

  it("does not mutate the caller's event objects", () => {
    const r = new TurnReducer();
    const base = modelMessage({ id: "m1", content: "a" });
    r.apply(base);
    r.apply(delta({ id: "m1", content: "b" }));
    expect((base as { content?: string }).content).toBe("a");
    expect(r.view.messages[0]?.text).toBe("ab");
  });

  it("reports which items changed", () => {
    const r = new TurnReducer();
    r.apply(modelMessage({ id: "m1" }));
    expect(r.apply(delta({ id: "m1", content: "x" })).messages).toEqual(["m1"]);
  });

  it("counts a delta with no base message instead of throwing", () => {
    const r = new TurnReducer();
    r.apply(delta({ id: "ghost", content: "x" }));
    expect(r.orphanDeltas).toBe(1);
    expect(r.view.messages).toEqual([]);
  });

  it("extracts text from content parts", () => {
    expect(messageText([{ type: "text", text: "a" }, { type: "text", text: "b" }] as never)).toBe("ab");
    expect(messageText(null)).toBe("");
    expect(messageText(undefined)).toBe("");
  });
});

describe("TurnReducer: tool calls", () => {
  it("builds the tool-call map from deltas merged by index", () => {
    const r = new TurnReducer();
    feed(r, [
      modelMessage({ id: "m1" }),
      delta({ id: "m1", calls: [{ index: 0, id: "c1", name: "read_file", args: "" }] }),
      delta({ id: "m1", calls: [{ index: 0, args: '{"path":"a.py",' }] }),
      delta({ id: "m1", calls: [{ index: 0, args: '"why":"look"}' }] }),
      delta({ id: "m1", calls: [{ index: 1, id: "c2", name: "list_dir", args: "{}" }], finish: "tool_calls" }),
    ]);
    const calls = r.view.toolCalls;
    expect(calls.map((c) => [c.id, c.name, c.args, c.threadId, c.sourceEventId, c.status])).toEqual([
      ["c1", "read_file", '{"path":"a.py","why":"look"}', "main", "m1", "running"],
      ["c2", "list_dir", "{}", "main", "m1", "running"],
    ]);
    expect(r.view.messages[0]?.toolCallIds).toEqual(["c1", "c2"]);
  });

  it("reads calls that arrive complete on a non-streamed model.message", () => {
    const r = new TurnReducer();
    r.apply(modelMessage({ id: "m1", calls: [{ id: "c1", name: "ping" }] }));
    expect(r.toolCall("c1")).toMatchObject({ name: "ping", args: "{}", status: "running" });
  });

  it("keeps messages and tool calls in order of appearance", () => {
    const r = new TurnReducer();
    feed(r, [modelMessage({ id: "m1", calls: [{ id: "c1", name: "ping" }] }), toolResponse({ toolCallId: "c1", content: "pong" }), modelMessage({ id: "m2", content: "done" })]);
    expect(r.view.timeline).toEqual([
      { kind: "message", id: "m1" },
      { kind: "tool", id: "c1" },
      { kind: "message", id: "m2" },
    ]);
  });

  it("records tool.response content, status and duration", () => {
    const r = new TurnReducer();
    feed(r, [modelMessage({ id: "m1", calls: [{ id: "c1", name: "ping" }], seconds: 1 }), toolResponse({ toolCallId: "c1", content: "pong", seconds: 3 })]);
    expect(r.toolCall("c1")).toMatchObject({ status: "done", response: "pong", durationMs: 2000 });
  });

  it("ignores a tool.response for an unknown call", () => {
    const r = new TurnReducer();
    expect(r.apply(toolResponse({ toolCallId: "nope", content: "x" })).toolCalls).toEqual([]);
  });
});

describe("TurnReducer: approvals", () => {
  const withGatedCalls = (): TurnReducer => {
    const r = new TurnReducer();
    r.apply(modelMessage({ id: "m1", calls: [{ id: "c1", name: "echo_write", args: '{"text":"a"}' }, { id: "c2", name: "echo_write", args: '{"text":"b"}' }] }));
    return r;
  };

  it("collects pending approvals from the stream and from turn.done.requiredActions without duplicates", () => {
    const r = withGatedCalls();
    r.beginRound();
    feed(r, pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }, { id: "c2", sourceEventId: "m1" }]));
    expect(r.view.pendingApprovals).toEqual([
      { toolCallId: "c1", threadId: "main", sourceEventId: "m1" },
      { toolCallId: "c2", threadId: "main", sourceEventId: "m1" },
    ]);
    expect(r.view.toolCalls.map((c) => c.status)).toEqual(["awaiting_approval", "awaiting_approval"]);
    expect(r.view.done?.status).toBe("done");
  });

  it("finds pending approvals that are only listed in turn.done.requiredActions", () => {
    const r = withGatedCalls();
    r.apply(turnDone({ status: "done", required: [approvalRequired({ calls: [{ id: "c2", sourceEventId: "m1" }] }) as unknown as { type: string }] }));
    expect(r.view.pendingApprovals.map((p) => p.toolCallId)).toEqual(["c2"]);
  });

  it("takes the thread id from the approval event (subagent calls)", () => {
    const r = new TurnReducer();
    r.apply(modelMessage({ id: "m9", threadId: "t_sub", calls: [{ id: "c9", name: "echo_write" }] }));
    feed(r, pausedOnApprovals([{ id: "c9", sourceEventId: "m9" }], "t_sub"));
    expect(r.view.pendingApprovals[0]).toMatchObject({ toolCallId: "c9", threadId: "t_sub" });
  });

  it("noteApproval(allow) resumes the call and starts its clock; the response then completes it", () => {
    const r = withGatedCalls();
    feed(r, pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }]));
    r.beginRound();
    r.noteApproval("c1", { status: "allow" }, "2026-11-02T10:00:10.000Z");
    expect(r.toolCall("c1")).toMatchObject({ status: "running", startedAt: "2026-11-02T10:00:10.000Z" });
    r.apply(toolResponse({ toolCallId: "c1", content: "ok", seconds: 12 }));
    expect(r.toolCall("c1")).toMatchObject({ status: "done", durationMs: 2000 });
  });

  it("noteApproval(deny) keeps the call denied even after its tool.response arrives", () => {
    const r = withGatedCalls();
    feed(r, pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }]));
    r.beginRound();
    r.noteApproval("c1", { status: "deny", reason: "no thanks" }, "2026-11-02T10:00:10.000Z");
    r.apply(toolResponse({ toolCallId: "c1", content: "Tool call denied by the user: no thanks" }));
    expect(r.toolCall("c1")).toMatchObject({ status: "denied", denyReason: "no thanks", response: "Tool call denied by the user: no thanks" });
  });

  it("beginRound clears the pause but keeps history", () => {
    const r = withGatedCalls();
    feed(r, pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }]));
    r.beginRound();
    expect(r.view.pendingApprovals).toEqual([]);
    expect(r.view.done).toBeUndefined();
    expect(r.view.toolCalls).toHaveLength(2);
    expect(r.view.messages).toHaveLength(1);
  });
});

describe("TurnReducer: other pauses and final state", () => {
  it("flags tool.response_required, mcp.auth_required and unknown required actions as unsupported", () => {
    const r = new TurnReducer();
    feed(r, [toolResponseRequired([{ id: "c1", sourceEventId: "m1" }]), mcpAuthRequired()]);
    expect(r.view.unsupportedPauses).toEqual(["tool.response_required", "mcp.auth_required"]);
    const r2 = new TurnReducer();
    r2.apply(turnDone({ status: "done", required: [{ type: "mystery.action" }] }));
    expect(r2.view.unsupportedPauses).toEqual(["mystery.action"]);
    expect(r2.view.pendingApprovals).toEqual([]);
  });

  it("records error and cancelled states", () => {
    const e = new TurnReducer();
    e.apply(turnDone({ status: "error", message: "[Model Error] boom" }));
    expect(e.view.done).toMatchObject({ status: "error", message: "[Model Error] boom" });
    const c = new TurnReducer();
    c.apply(turnDone({ status: "cancelled", reason: "client-cancelled" }));
    expect(c.view.done).toMatchObject({ status: "cancelled", reason: "client-cancelled" });
  });
});

describe("TurnReducer: subagents, MCP and compaction", () => {
  it("tracks subagent threads and their completion", () => {
    const r = new TurnReducer();
    feed(r, [threadCreated({ threadId: "t1", title: "Scout: find helpers", parentToolCallId: "call_x", model: "deepseek/flash" })]);
    expect(r.view.threads).toEqual([{ id: "t1", title: "Scout: find helpers", state: "running", parentThreadId: "main", parentToolCallId: "call_x", model: "deepseek/flash" }]);
    r.apply(threadDone({ threadId: "t1", title: "Scout: find helpers" }));
    expect(r.view.threads[0]?.state).toBe("done");
    r.apply(threadDone({ threadId: "t2", title: "Other", error: "bad" }));
    expect(r.view.threads.find((t) => t.id === "t2")?.state).toBe("error");
  });

  it("lists MCP servers from mcp.initialize once", () => {
    const r = new TurnReducer();
    feed(r, [mcpInitialize(["forge-editor"]), mcpInitialize(["forge-editor", "other"])]);
    expect(r.view.mcpServers).toEqual(["forge-editor", "other"]);
  });

  it("tracks compaction", () => {
    const r = new TurnReducer();
    r.apply(compactionStarted());
    expect(r.view.compaction).toEqual({ active: true, count: 0 });
    r.apply(compactionFinished(2500));
    expect(r.view.compaction).toEqual({ active: false, count: 1, lastDurationMs: 2500 });
  });
});
