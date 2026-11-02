import { describe, expect, it } from "vitest";
import { AgentController, type AfterPausePolicy, type ControllerDeps } from "../src/trueforge/agentController";
import { modelMessage, pausedOnApprovals, toolResponse, toolResponseRequired, turnDone, turnCreated, delta } from "./helpers/events";
import { ALLOW, DENY, FakeClient, RecordingUi, ScriptedApprovals, deferred, events, gated, rejectOnAbort, tick, type TurnScript } from "./helpers/fakeClient";

interface Rig {
  controller: AgentController;
  client: FakeClient;
  ui: RecordingUi;
  approvals: ScriptedApprovals;
}

function rig(scripts: TurnScript[], opts: { approvals?: ScriptedApprovals; afterPause?: AfterPausePolicy; prepare?: ControllerDeps["prepare"] } = {}): Rig {
  const client = new FakeClient(...scripts);
  const ui = new RecordingUi();
  const approvals = opts.approvals ?? new ScriptedApprovals(() => ALLOW);
  const controller = new AgentController({
    client,
    agentName: "forge-agent",
    ui,
    approvals,
    ...(opts.afterPause ? { afterPause: opts.afterPause } : {}),
    ...(opts.prepare ? { prepare: opts.prepare } : {}),
    now: () => new Date("2026-11-02T10:00:10.000Z"),
  });
  return { controller, client, ui, approvals };
}

const answer = (text: string): TurnScript => () => events(turnCreated(), modelMessage({ id: nextMsg(), content: text, finish: "stop" }), turnDone({ status: "done", text }));
let msgCounter = 0;
const nextMsg = (): string => `msg_${++msgCounter}`;

/** A turn where the model calls `names.length` gated tools, then pauses on their approvals. */
function gatedCalls(msgId: string, calls: Array<{ id: string; name?: string; args?: string }>): TurnScript {
  const specs = calls.map((c) => ({ id: c.id, name: c.name ?? "echo_write", args: c.args ?? '{"text":"x"}' }));
  return () => events(turnCreated(), modelMessage({ id: msgId, calls: specs, finish: "tool_calls" }), ...pausedOnApprovals(calls.map((c) => ({ id: c.id, sourceEventId: msgId }))));
}

describe("AgentController: plain runs", () => {
  it("runs a turn, creates the session lazily and reports states and view", async () => {
    const { controller, client, ui } = rig([answer("Hello!")]);
    expect(client.sessions).toEqual([]);
    const res = await controller.send("  hi  ");
    expect(res).toEqual({ ok: true, state: "done" });
    expect(client.sessions).toEqual(["sess-1"]);
    expect(client.turns).toEqual([{ sessionId: "sess-1", input: [{ type: "user.message", content: "hi" }] }]);
    expect(ui.states).toEqual(["running", "done"]);
    expect(ui.users).toEqual(["hi"]);
    expect(ui.lastView?.messages[0]?.text).toBe("Hello!");
    expect(ui.lastView?.done?.status).toBe("done"); // regression: the sink must see the view AFTER the last event
    expect(ui.sessionsSeen).toEqual([{ sessionId: "sess-1" }]);
  });

  it("reuses the session for the next message", async () => {
    const { controller, client } = rig([answer("one"), answer("two")]);
    await controller.send("a");
    await controller.send("b");
    expect(client.sessions).toEqual(["sess-1"]);
    expect(client.turns.map((t) => t.sessionId)).toEqual(["sess-1", "sess-1"]);
  });

  it("streams deltas into the view while the turn is still running", async () => {
    const gate = deferred();
    const { controller, ui } = rig([() => gated([turnCreated(), modelMessage({ id: "m1" }), delta({ id: "m1", content: "Hel" })], gate.promise, [delta({ id: "m1", content: "lo", finish: "stop" }), turnDone({ status: "done" })])]);
    const run = controller.send("hi");
    await tick();
    expect(controller.state).toBe("running");
    expect(ui.lastView?.messages[0]?.text).toBe("Hel");
    gate.resolve();
    await run;
    expect(ui.lastView?.messages[0]?.text).toBe("Hello");
  });

  it("ignores empty input", async () => {
    const { controller, client } = rig([]);
    expect(await controller.send("   ")).toEqual({ ok: false, reason: "empty" });
    expect(client.sessions).toEqual([]);
    expect(controller.state).toBe("idle");
  });

  it("rejects a second send while running, with a clear notice, and does not start another turn", async () => {
    const gate = deferred();
    const { controller, client, ui } = rig([() => gated([turnCreated()], gate.promise, [turnDone({ status: "done" })])]);
    const first = controller.send("one");
    await tick();
    expect(await controller.send("two")).toEqual({ ok: false, reason: "busy" });
    expect(ui.notices).toEqual([{ level: "warning", text: expect.stringContaining("still working on the previous message") }]);
    expect(client.turns).toHaveLength(1);
    gate.resolve();
    await first;
    expect(controller.state).toBe("done");
  });
});

describe("AgentController: tool approvals", () => {
  it("allow: asks the handler, resumes with ONLY a user.tool_approval item and continues to done", async () => {
    const resume: TurnScript = () => events(turnCreated(), toolResponse({ toolCallId: "c1", content: "written" }), modelMessage({ id: "m2", content: "Done", finish: "stop" }), turnDone({ status: "done", text: "Done" }));
    const { controller, client, ui, approvals } = rig([gatedCalls("m1", [{ id: "c1", args: '{"text":"a"}' }]), resume]);
    await controller.send("write a");
    expect(approvals.started).toEqual(["c1"]);
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]).toEqual({ sessionId: "sess-1", input: [{ type: "user.tool_approval", threadId: "main", toolCallId: "c1", approval: { status: "allow" } }] });
    expect(ui.states).toEqual(["running", "awaitingApproval", "running", "done"]);
    expect(ui.lastView?.toolCalls[0]).toMatchObject({ id: "c1", name: "echo_write", status: "done", response: "written" });
  });

  it("passes the tool name, args and thread to the handler", async () => {
    const seen: unknown[] = [];
    const approvals = new ScriptedApprovals((call) => {
      seen.push(call);
      return ALLOW;
    });
    const { controller } = rig([gatedCalls("m1", [{ id: "c1", name: "propose_edit", args: '{"path":"a.py"}' }]), answer("ok")], { approvals });
    await controller.send("edit");
    expect(seen).toEqual([{ id: "c1", name: "propose_edit", args: '{"path":"a.py"}', threadId: "main", sourceEventId: "m1" }]);
  });

  it("deny: resumes with the reason, marks the call denied, and the agent continues", async () => {
    const approvals = new ScriptedApprovals(() => DENY("not allowed to write"));
    const resume: TurnScript = () => events(turnCreated(), toolResponse({ toolCallId: "c1", content: "denied: not allowed to write" }), modelMessage({ id: "m2", content: "Understood", finish: "stop" }), turnDone({ status: "done", text: "Understood" }));
    const { controller, client, ui } = rig([gatedCalls("m1", [{ id: "c1" }]), resume], { approvals });
    await controller.send("write");
    expect(client.turns[1]?.input).toEqual([{ type: "user.tool_approval", threadId: "main", toolCallId: "c1", approval: { status: "deny", reason: "not allowed to write" } }]);
    expect(ui.lastView?.toolCalls[0]).toMatchObject({ status: "denied", denyReason: "not allowed to write" });
    expect(controller.state).toBe("done");
  });

  it("parallel calls: decides all at once and sends ONE resume turn, in TrueForge's order, even if decisions finish out of order", async () => {
    const gates = { c1: deferred<void>(), c2: deferred<void>(), c3: deferred<void>() };
    const approvals = new ScriptedApprovals(async (call) => {
      await gates[call.id as keyof typeof gates].promise;
      return call.id === "c2" ? DENY("no") : ALLOW;
    });
    const resume: TurnScript = () => events(turnCreated(), modelMessage({ id: "m2", content: "ok", finish: "stop" }), turnDone({ status: "done" }));
    const { controller, client } = rig([gatedCalls("m1", [{ id: "c1" }, { id: "c2" }, { id: "c3" }]), resume], { approvals });
    const run = controller.send("write three");
    await tick();
    expect(controller.state).toBe("awaitingApproval");
    expect(approvals.started).toEqual(["c1", "c2", "c3"]); // all started before any decision came in
    expect(approvals.finished).toEqual([]);
    gates.c3.resolve();
    await tick();
    gates.c1.resolve();
    await tick();
    expect(client.turns).toHaveLength(1); // still waiting for c2
    gates.c2.resolve();
    await run;
    expect(approvals.finished).toEqual(["c3", "c1", "c2"]);
    expect(client.turns).toHaveLength(2);
    expect(client.turns[1]?.input).toEqual([
      { type: "user.tool_approval", threadId: "main", toolCallId: "c1", approval: { status: "allow" } },
      { type: "user.tool_approval", threadId: "main", toolCallId: "c2", approval: { status: "deny", reason: "no" } },
      { type: "user.tool_approval", threadId: "main", toolCallId: "c3", approval: { status: "allow" } },
    ]);
  });

  it("handles several approval rounds in one run", async () => {
    const round2: TurnScript = () => events(turnCreated(), toolResponse({ toolCallId: "c1", content: "r1" }), modelMessage({ id: "m2", calls: [{ id: "c2", name: "echo_write" }], finish: "tool_calls" }), ...pausedOnApprovals([{ id: "c2", sourceEventId: "m2" }]));
    const round3: TurnScript = () => events(turnCreated(), toolResponse({ toolCallId: "c2", content: "r2" }), modelMessage({ id: "m3", content: "all done", finish: "stop" }), turnDone({ status: "done" }));
    const { controller, client, ui } = rig([gatedCalls("m1", [{ id: "c1" }]), round2, round3]);
    await controller.send("two writes");
    expect(client.turns).toHaveLength(3);
    expect(client.turns[2]?.input).toEqual([{ type: "user.tool_approval", threadId: "main", toolCallId: "c2", approval: { status: "allow" } }]);
    expect(ui.states).toEqual(["running", "awaitingApproval", "running", "awaitingApproval", "running", "done"]);
    expect(ui.lastView?.toolCalls.map((c) => c.status)).toEqual(["done", "done"]);
  });

  it("uses the thread id of the approval event for subagent calls", async () => {
    const sub: TurnScript = () => events(turnCreated(), modelMessage({ id: "ms", threadId: "t_sub", calls: [{ id: "cs", name: "echo_write" }], finish: "tool_calls" }), ...pausedOnApprovals([{ id: "cs", sourceEventId: "ms" }], "t_sub"));
    const { controller, client } = rig([sub, answer("ok")]);
    await controller.send("go");
    expect(client.turns[1]?.input).toEqual([{ type: "user.tool_approval", threadId: "t_sub", toolCallId: "cs", approval: { status: "allow" } }]);
  });
});

describe("AgentController: failures", () => {
  it("turn.done error: state error, a notice with the message, and the session is still usable", async () => {
    const { controller, client, ui } = rig([() => events(turnCreated(), turnDone({ status: "error", message: "[Model Error] Cannot connect to API" })), answer("back")]);
    await controller.send("hi");
    expect(controller.state).toBe("error");
    expect(ui.states).toEqual(["running", "error"]);
    expect(ui.notices).toEqual([{ level: "error", text: "[Model Error] Cannot connect to API" }]);
    await controller.send("again");
    expect(controller.state).toBe("done");
    expect(client.sessions).toEqual(["sess-1"]);
  });

  it("a thrown stream error becomes an error state, not an exception", async () => {
    const boom: TurnScript = () => {
      throw new Error("socket hang up");
    };
    const { controller, ui } = rig([boom]);
    await expect(controller.send("hi")).resolves.toEqual({ ok: true, state: "error" });
    expect(ui.notices[0]).toMatchObject({ level: "error", text: expect.stringContaining("socket hang up") });
  });

  it("a stream that dies mid-way is an error", async () => {
    async function* dying(): AsyncGenerator<never> {
      yield* [];
      throw new Error("connection reset");
    }
    const { controller, ui } = rig([() => dying()]);
    await controller.send("hi");
    expect(controller.state).toBe("error");
    expect(ui.notices[0]?.text).toContain("connection reset");
  });

  it("a stream that ends without turn.done is an error", async () => {
    const { controller, ui } = rig([() => events(turnCreated(), modelMessage({ id: "m1", content: "hm" }))]);
    await controller.send("hi");
    expect(controller.state).toBe("error");
    expect(ui.notices[0]?.text).toMatch(/ended before the turn finished/);
  });

  it("a failed session creation is an error state", async () => {
    const { controller, client, ui } = rig([]);
    client.createSession = () => Promise.reject(new Error("404 agent not found"));
    await controller.send("hi");
    expect(controller.state).toBe("error");
    expect(ui.notices[0]?.text).toContain("404 agent not found");
  });

  it("prepare failure ends the run before any session is created, prepare runs once per session", async () => {
    let calls = 0;
    const prepare = (): Promise<{ ok: true; model: string } | { ok: false; message: string }> => {
      calls++;
      return Promise.resolve(calls === 1 ? { ok: false, message: "Model deepseek/flash is not configured" } : { ok: true, model: "deepseek/flash" });
    };
    const { controller, client, ui } = rig([answer("a"), answer("b")], { prepare });
    await controller.send("one");
    expect(controller.state).toBe("error");
    expect(client.sessions).toEqual([]);
    expect(ui.notices[0]?.text).toBe("Model deepseek/flash is not configured");
    await controller.send("two");
    await controller.send("three");
    expect(calls).toBe(2); // not on the third message: the session already exists
    expect(ui.sessionsSeen).toEqual([{ sessionId: "sess-1", model: "deepseek/flash" }]);
  });

  it("a server-side cancellation (not from Stop) ends as cancelled with the reason", async () => {
    const { controller, ui } = rig([() => events(turnCreated(), turnDone({ status: "cancelled", reason: "server-execution-timeout" }))]);
    await controller.send("hi");
    expect(controller.state).toBe("cancelled");
    expect(ui.details.at(-1)).toBe("server-execution-timeout");
  });
});

describe("AgentController: stop", () => {
  it("while running: calls sessions.cancel and ends cancelled when the stream finishes itself", async () => {
    const gate = deferred();
    const { controller, client, ui } = rig([() => gated([turnCreated(), modelMessage({ id: "m1", content: "part" })], gate.promise, [turnDone({ status: "cancelled", reason: "client-cancelled" })])]);
    client.onCancel = () => gate.resolve();
    const run = controller.send("long task");
    await tick();
    await controller.stop();
    expect(client.cancels).toEqual(["sess-1"]);
    await run;
    expect(ui.states).toEqual(["running", "cancelled"]);
    expect(controller.state).toBe("cancelled");
  });

  it("the next send after a cancelled run works in the same session", async () => {
    const gate = deferred();
    const { controller, client } = rig([() => gated([turnCreated()], gate.promise, [turnDone({ status: "cancelled" })]), answer("fine")]);
    client.onCancel = () => gate.resolve();
    const run = controller.send("a");
    await tick();
    await controller.stop();
    await run;
    await controller.send("b");
    expect(controller.state).toBe("done");
    expect(client.sessions).toEqual(["sess-1"]);
  });

  it("a failing cancel call leaves the run going and tells the user", async () => {
    const gate = deferred();
    const { controller, client, ui } = rig([() => gated([turnCreated()], gate.promise, [turnDone({ status: "done" })])]);
    client.cancelError = new Error("503");
    const run = controller.send("a");
    await tick();
    await controller.stop();
    expect(ui.notices[0]).toMatchObject({ level: "error", text: expect.stringContaining("Could not cancel") });
    expect(controller.state).toBe("running");
    gate.resolve();
    await run;
    expect(controller.state).toBe("done");
  });

  it("is a no-op when idle or finished", async () => {
    const { controller, client } = rig([answer("x")]);
    await controller.stop();
    await controller.send("hi");
    await controller.stop();
    expect(client.cancels).toEqual([]);
  });

  it("while awaiting approval: aborts the decisions, sends no resume turn, ends cancelled", async () => {
    const approvals = new ScriptedApprovals((_call, signal) => rejectOnAbort(signal));
    const { controller, client, ui } = rig([gatedCalls("m1", [{ id: "c1" }, { id: "c2" }])], { approvals });
    const run = controller.send("write");
    await tick();
    expect(controller.state).toBe("awaitingApproval");
    await controller.stop();
    await run;
    expect(controller.state).toBe("cancelled");
    expect(client.turns).toHaveLength(1);
    expect(client.cancels).toEqual([]); // nothing is running on the server
    expect(approvals.signals.every((s) => s.aborted)).toBe(true);
    expect(ui.states).toEqual(["running", "awaitingApproval", "cancelled"]);
  });

  describe("the next send after Stop during an approval pause", () => {
    const stopDuringPause = async (r: Rig): Promise<void> => {
      const run = r.controller.send("write");
      await tick();
      await r.controller.stop();
      await run;
    };
    const waitingApprovals = (): ScriptedApprovals => new ScriptedApprovals((_c, signal) => rejectOnAbort(signal));

    it("by default (the policy the spike justified) continues the same session", async () => {
      const r = rig([gatedCalls("m1", [{ id: "c1" }]), answer("same session")], { approvals: waitingApprovals() });
      await stopDuringPause(r);
      await r.controller.send("next");
      expect(r.controller.state).toBe("done");
      expect(r.client.sessions).toEqual(["sess-1"]);
    });

    it("policy new-session: silently starts a new session and works", async () => {
      const r = rig([gatedCalls("m1", [{ id: "c1" }]), answer("fresh")], { approvals: waitingApprovals(), afterPause: "new-session" });
      await stopDuringPause(r);
      await r.controller.send("next");
      expect(r.controller.state).toBe("done");
      expect(r.client.sessions).toEqual(["sess-1", "sess-2"]);
      expect(r.client.turns[1]).toMatchObject({ sessionId: "sess-2", input: [{ type: "user.message", content: "next" }] });
      expect(r.ui.notices.at(-1)).toMatchObject({ level: "info" });
    });

    it("policy continue: keeps the same session and sends the user message to it", async () => {
      const r = rig([gatedCalls("m1", [{ id: "c1" }]), answer("same session")], { approvals: waitingApprovals(), afterPause: "continue" });
      await stopDuringPause(r);
      await r.controller.send("next");
      expect(r.controller.state).toBe("done");
      expect(r.client.sessions).toEqual(["sess-1"]);
      expect(r.client.turns[1]).toMatchObject({ sessionId: "sess-1", input: [{ type: "user.message", content: "next" }] });
    });

    it("policy continue, but TrueForge rejects the paused session: silently retries in a new session", async () => {
      const reject: TurnScript = (_input, sessionId) => {
        throw new Error(`409 session ${sessionId} has a paused turn`);
      };
      const r = rig([gatedCalls("m1", [{ id: "c1" }]), reject, answer("recovered")], { approvals: waitingApprovals(), afterPause: "continue" });
      await stopDuringPause(r);
      await r.controller.send("next");
      expect(r.controller.state).toBe("done");
      expect(r.client.sessions).toEqual(["sess-1", "sess-2"]);
      expect(r.client.turns.map((t) => t.sessionId)).toEqual(["sess-1", "sess-1", "sess-2"]);
      expect(r.ui.notices.filter((n) => n.level === "error")).toEqual([]);
    });
  });
});

describe("AgentController: pauses Forge cannot answer", () => {
  const unsupported = (type: "tool.response_required" | "other"): TurnScript => () =>
    events(
      turnCreated(),
      modelMessage({ id: "m1", content: "I have a question", finish: "stop" }),
      type === "other" ? turnDone({ status: "done", required: [{ type: "mystery.action" }] }) : turnDone({ status: "done", required: [toolResponseRequired([{ id: "q1", sourceEventId: "m1" }]) as unknown as { type: string }] }),
    );

  it("tool.response_required (ask_user_question): clear notice, run ends as error, never calls the handler", async () => {
    const r = rig([unsupported("tool.response_required")]);
    await r.controller.send("hi");
    expect(r.controller.state).toBe("error");
    expect(r.ui.notices).toEqual([{ level: "error", text: "Agent needs input of a type Forge doesn't support yet: tool.response_required" }]);
    expect(r.approvals.started).toEqual([]);
    expect(r.client.turns).toHaveLength(1);
  });

  it("an unknown required action is handled the same way", async () => {
    const r = rig([unsupported("other")]);
    await r.controller.send("hi");
    expect(r.controller.state).toBe("error");
    expect(r.ui.notices[0]?.text).toBe("Agent needs input of a type Forge doesn't support yet: mystery.action");
  });

  it("the session stays usable afterwards (new-session policy)", async () => {
    const r = rig([unsupported("tool.response_required"), answer("works")], { afterPause: "new-session" });
    await r.controller.send("hi");
    await r.controller.send("again");
    expect(r.controller.state).toBe("done");
    expect(r.client.sessions).toEqual(["sess-1", "sess-2"]);
  });

  it("the session stays usable afterwards (continue policy)", async () => {
    const r = rig([unsupported("tool.response_required"), answer("works")], { afterPause: "continue" });
    await r.controller.send("hi");
    await r.controller.send("again");
    expect(r.controller.state).toBe("done");
    expect(r.client.sessions).toEqual(["sess-1"]);
  });
});

describe("AgentController: new chat", () => {
  it("drops the session and tells the UI; the next send starts a new one", async () => {
    const r = rig([answer("a"), answer("b")]);
    await r.controller.send("one");
    expect(r.controller.newChat()).toBe(true);
    expect(r.ui.resets).toBe(1);
    await r.controller.send("two");
    expect(r.client.sessions).toEqual(["sess-1", "sess-2"]);
  });

  it("is refused while a run is active", async () => {
    const gate = deferred();
    const r = rig([() => gated([turnCreated()], gate.promise, [turnDone({ status: "done" })])]);
    const run = r.controller.send("a");
    await tick();
    expect(r.controller.newChat()).toBe(false);
    expect(r.ui.resets).toBe(0);
    gate.resolve();
    await run;
  });
});
