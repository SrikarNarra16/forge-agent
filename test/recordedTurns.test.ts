import { describe, expect, it } from "vitest";
import { AgentController } from "../src/trueforge/agentController";
import { TurnReducer } from "../src/trueforge/events";
import { loadRecording } from "./helpers/fixtures";
import { ALLOW, FakeClient, RecordingUi, ScriptedApprovals, events } from "./helpers/fakeClient";

/** Reducer and controller against events captured from a real TrueForge (docs/approval-spike.md). */
describe("TurnReducer on recorded TrueForge streams", () => {
  it("g_plain: streamed text merges into one complete message", async () => {
    const [turn] = await loadRecording("g_plain");
    const r = new TurnReducer();
    for (const e of turn!.events) r.apply(e);
    const view = r.view;
    expect(r.orphanDeltas).toBe(0);
    expect(view.messages).toHaveLength(1);
    expect(view.messages[0]).toMatchObject({ complete: true, threadId: "main" });
    expect(view.messages[0]?.text.length).toBeGreaterThan(10);
    expect(view.done).toMatchObject({ status: "done" });
    expect(view.mcpServers).toEqual(["forge-spike-mcp"]);
    expect(view.pendingApprovals).toEqual([]);
    // turn.done.output is the same text the deltas built.
    const output = view.done?.status === "done" ? view.done.output : null;
    expect(output?.content).toBe(view.messages[0]?.text);
  });

  it("h_ungated: an ungated tool call runs without any pause", async () => {
    const [turn] = await loadRecording("h_ungated");
    const r = new TurnReducer();
    for (const e of turn!.events) r.apply(e);
    const calls = r.view.toolCalls;
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ name: "echo_read", status: "done", threadId: "main" });
    expect(calls[0]?.response).toMatch(/^list is/);
    expect(calls[0]?.durationMs).toBeGreaterThanOrEqual(0);
    expect(r.view.pendingApprovals).toEqual([]);
    expect(r.view.timeline.map((t) => t.kind)).toEqual(["message", "tool", "message"]);
  });

  it("a_allow: turn 1 pauses on one gated call, turn 2 completes it", async () => {
    const [t1, t2] = await loadRecording("a_allow");
    const r = new TurnReducer();
    r.beginRound();
    for (const e of t1!.events) r.apply(e);
    expect(r.view.pendingApprovals).toHaveLength(1);
    const pending = r.view.pendingApprovals[0]!;
    expect(r.toolCall(pending.toolCallId)).toMatchObject({ name: "echo_write", args: '{"text": "alpha"}', status: "awaiting_approval" });
    expect(r.view.done).toMatchObject({ status: "done", output: null });
    expect(r.view.unsupportedPauses).toEqual([]);

    r.beginRound();
    r.noteApproval(pending.toolCallId, { status: "allow" }, "2026-11-02T04:15:39.600Z");
    for (const e of t2!.events) r.apply(e);
    expect(r.orphanDeltas).toBe(0);
    expect(r.view.pendingApprovals).toEqual([]);
    expect(r.view.toolCalls.map((c) => [c.name, c.status])).toEqual([
      ["echo_write", "done"],
      ["echo_read", "done"],
    ]);
    expect(r.toolCall(pending.toolCallId)?.response).toBe('appended "alpha"; list is now ["alpha"]');
    expect(r.view.done).toMatchObject({ status: "done" });
  });

  it("b_deny: the call stays denied and the model sees the reason", async () => {
    const [t1, t2] = await loadRecording("b_deny");
    const r = new TurnReducer();
    r.beginRound();
    for (const e of t1!.events) r.apply(e);
    const id = r.view.pendingApprovals[0]!.toolCallId;
    r.beginRound();
    r.noteApproval(id, { status: "deny", reason: "User rejected: writes are not allowed in this test" }, "2026-11-02T04:15:42.000Z");
    for (const e of t2!.events) r.apply(e);
    expect(r.toolCall(id)).toMatchObject({ status: "denied", denyReason: "User rejected: writes are not allowed in this test" });
    expect(r.toolCall(id)?.response).toContain("User denied tool call: User rejected");
  });

  it("c_parallel: both calls are pending in one round, in TrueForge's order", async () => {
    const [t1, t2] = await loadRecording("c_parallel");
    const r = new TurnReducer();
    r.beginRound();
    for (const e of t1!.events) r.apply(e);
    const pending = r.view.pendingApprovals;
    expect(pending).toHaveLength(2);
    expect(pending[0]?.sourceEventId).toBe(pending[1]?.sourceEventId);
    expect(r.view.toolCalls.map((c) => c.args)).toEqual(['{"text": "one"}', '{"text": "two"}']);
    expect(pending.map((p) => p.toolCallId)).toEqual((t2!.input as Array<{ toolCallId: string }>).map((i) => i.toolCallId));
  });

  it("d_paused_state: a paused turn is turn.done(done) with requiredActions, not a 'paused' status", async () => {
    const [t1] = await loadRecording("d_paused_state");
    const r = new TurnReducer();
    for (const e of t1!.events) r.apply(e);
    expect(r.view.done).toMatchObject({ status: "done", output: null });
    expect(r.view.pendingApprovals).toHaveLength(1); // streamed AND in requiredActions: deduplicated
  });
});

describe("AgentController replaying recorded streams", () => {
  it("a_allow: sends exactly the approval input TrueForge accepted in the recording", async () => {
    const recording = await loadRecording("a_allow");
    const client = new FakeClient(...recording.map((t) => () => events(...t.events)));
    const ui = new RecordingUi();
    const controller = new AgentController({ client, agentName: "forge-spike", ui, approvals: new ScriptedApprovals(() => ALLOW) });
    await controller.send("Call echo_write exactly once with text 'alpha'.");
    expect(ui.states).toEqual(["running", "awaitingApproval", "running", "done"]);
    expect(client.turns[1]?.input).toEqual(recording[1]?.input);
  });

  it("c_parallel: two pending calls give one resume turn identical to the recorded one", async () => {
    const recording = await loadRecording("c_parallel");
    const client = new FakeClient(...recording.map((t) => () => events(...t.events)));
    const controller = new AgentController({ client, agentName: "forge-spike", ui: new RecordingUi(), approvals: new ScriptedApprovals(() => ALLOW) });
    await controller.send("two parallel writes");
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]?.input).toEqual(recording[1]?.input);
  });

  it("b_deny: the deny reason is sent through unchanged", async () => {
    const recording = await loadRecording("b_deny");
    const client = new FakeClient(...recording.map((t) => () => events(...t.events)));
    const approvals = new ScriptedApprovals(() => ({ status: "deny", reason: "User rejected: writes are not allowed in this test" }));
    const controller = new AgentController({ client, agentName: "forge-spike", ui: new RecordingUi(), approvals });
    await controller.send("write beta");
    expect(client.turns[1]?.input).toEqual(recording[1]?.input);
    expect(controller.state).toBe("done");
  });
});
