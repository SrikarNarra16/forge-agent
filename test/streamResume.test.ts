import { describe, expect, it } from "vitest";
import { AgentController } from "../src/trueforge/agentController";
import { TurnReducer, type StreamEvent } from "../src/trueforge/events";
import { delta, modelMessage, turnCreated, turnDone } from "./helpers/events";
import { ALLOW, FakeClient, RecordingUi, ScriptedApprovals, events, type TurnScript } from "./helpers/fakeClient";

/** A stream that delivers `before` and then drops the connection like undici's "terminated". */
function dropping(before: StreamEvent[], error = "terminated"): TurnScript {
  return () =>
    (async function* () {
      for (const e of before) yield e;
      throw new TypeError(error);
    })();
}

function rig(script: TurnScript) {
  const client = new FakeClient(script);
  const ui = new RecordingUi();
  const logs: string[] = [];
  const controller = new AgentController({ client, agentName: "forge-agent", ui, approvals: new ScriptedApprovals(() => ALLOW), log: (m) => logs.push(m) });
  return { controller, client, ui, logs };
}

const TURN = "turn_resume_1";
const head = (): StreamEvent[] => [turnCreated(TURN), modelMessage({ id: "m1" }), delta({ id: "m1", content: "Hel" }), delta({ id: "m1", content: "lo " })];
const tail = (): StreamEvent[] => [delta({ id: "m1", content: "world", finish: "stop" }), turnDone({ status: "done", text: "Hello world" })];

describe("stream resilience", () => {
  it("a dropped stream whose turn is still running is re-attached ONCE after the events already received", async () => {
    const { controller, client, ui, logs } = rig(dropping(head()));
    client.turnStatus = () => Promise.resolve("running");
    client.subscribe = () => Promise.resolve(events(...tail()));
    const result = await controller.send("hi");
    expect(client.resumeCalls).toEqual([`status:${TURN}`, `subscribe:${TURN}:after=4`]); // 4 events were received (turn.created counts)
    expect(result).toMatchObject({ ok: true, state: "done" });
    expect(ui.lastView?.messages[0]?.text).toBe("Hello world"); // continued, no duplicated text
    expect(logs.join("\n")).toMatch(/stream interrupted after 4 events \(terminated\)/);
    expect(logs.join("\n")).toMatch(/turn still running; re-attaching after event 4/);
  });

  it("a stream that just ends without turn.done is treated the same way", async () => {
    const { controller, client } = rig(() => events(...head()));
    client.turnStatus = () => Promise.resolve("running");
    client.subscribe = () => Promise.resolve(events(...tail()));
    expect(await controller.send("hi")).toMatchObject({ state: "done" });
    expect(client.resumeCalls).toHaveLength(2);
  });

  it("if the turn already finished, the final state is rebuilt from the turn's event log", async () => {
    const { controller, client, ui, logs } = rig(dropping(head()));
    client.turnStatus = () => Promise.resolve("done");
    client.listEvents = () => Promise.resolve([turnCreated(TURN), modelMessage({ id: "m1", content: "Hello world", finish: "stop" }), turnDone({ status: "done", text: "Hello world" })]);
    const result = await controller.send("hi");
    expect(client.resumeCalls).toEqual([`status:${TURN}`, `list:${TURN}`]);
    expect(result).toMatchObject({ ok: true, state: "done" });
    expect(ui.lastView?.messages[0]?.text).toBe("Hello world");
    expect(ui.lastView?.done?.status).toBe("done");
    expect(logs.join("\n")).toMatch(/rebuilding the final state/);
  });

  it("if the re-attached stream drops again, the run ends as an error with the real reason (no second resume)", async () => {
    const { controller, client, ui } = rig(dropping(head()));
    client.turnStatus = () => Promise.resolve("running");
    client.subscribe = () => Promise.resolve((async function* () { yield delta({ id: "m1", content: "x" }); throw new TypeError("socket hang up"); })());
    const result = await controller.send("hi");
    expect(result).toMatchObject({ ok: true, state: "error" });
    expect(ui.notices.at(-1)?.text).toMatch(/dropped again after resuming \(.*socket hang up/);
    expect(client.resumeCalls.filter((c) => c.startsWith("subscribe"))).toHaveLength(1);
  });

  it("drop -> the turn status cannot be read -> error with both reasons", async () => {
    const { controller, client, ui } = rig(dropping(head()));
    client.turnStatus = () => Promise.reject(new Error("HTTP 502"));
    expect(await controller.send("hi")).toMatchObject({ state: "error" });
    expect(ui.notices.at(-1)?.text).toMatch(/lost \(terminated\).*status could not be read \(.*502/);
  });

  it("drop -> the turn ended in error on the server: reports the server's error", async () => {
    const { controller, client } = rig(dropping(head()));
    client.turnStatus = () => Promise.resolve("error");
    client.listEvents = () => Promise.resolve([turnCreated(TURN), turnDone({ status: "error", message: "[Model Error] Request failed (503)" })]);
    const result = await controller.send("hi");
    expect(result).toMatchObject({ state: "error", detail: "[Model Error] Request failed (503)" });
  });

  it("without recovery hooks a drop is reported with its actual message", async () => {
    const client = new FakeClient(dropping(head(), "terminated"));
    delete (client as { getTurnStatus?: unknown }).getTurnStatus;
    Object.defineProperty(client, "getTurnStatus", { value: undefined });
    const ui = new RecordingUi();
    const controller = new AgentController({ client, agentName: "a", ui, approvals: new ScriptedApprovals(() => ALLOW) });
    expect(await controller.send("hi")).toMatchObject({ state: "error", detail: "terminated" });
  });

  it("Stop during a resumed stream still ends cancelled", async () => {
    const { controller, client } = rig(dropping(head()));
    client.turnStatus = () => Promise.resolve("running");
    let release!: () => void;
    client.subscribe = () => Promise.resolve((async function* () { await new Promise<void>((r) => (release = r)); yield* tail(); })());
    const run = controller.send("hi");
    for (let i = 0; i < 20 && !release; i++) await new Promise((r) => setImmediate(r));
    await controller.stop();
    release();
    expect(await run).toMatchObject({ state: "cancelled" });
  });
});

describe("the reducer is idempotent for replayed events", () => {
  const apply = (events: StreamEvent[], r = new TurnReducer()): TurnReducer => {
    for (const e of events) r.apply(e);
    return r;
  };
  it("applying the compact (non-delta) events twice gives the same view", () => {
    const compact = [turnCreated(TURN), modelMessage({ id: "m1", content: "Hello world", finish: "stop" }), turnDone({ status: "done", text: "Hello world" })];
    const once = apply(compact).view;
    const twice = apply([...compact, ...compact]).view;
    expect(twice.messages).toEqual(once.messages);
    expect(twice.toolCalls).toEqual(once.toolCalls);
    expect(twice.timeline).toEqual(once.timeline);
    expect(twice.done?.status).toBe("done");
  });
  it("a final model.message replayed after its deltas replaces the text instead of doubling it", () => {
    const r = apply([...head()]);
    r.apply(modelMessage({ id: "m1", content: "Hello world", finish: "stop" }));
    expect(r.view.messages[0]?.text).toBe("Hello world");
  });
  it("tool calls and approvals replayed do not duplicate pending approvals or calls", () => {
    const msg = modelMessage({ id: "m2", calls: [{ id: "c1", name: "propose_edit" }], finish: "tool_calls" });
    const approval = { type: "tool.approval_required", id: "a1", threadId: "main", createdAt: "2026-11-03T00:00:00Z", toolCalls: [{ id: "c1", sourceEventId: "m2" }] } as unknown as StreamEvent;
    const r = apply([turnCreated(TURN), msg, approval, msg, approval]);
    expect(r.view.toolCalls).toHaveLength(1);
    expect(r.view.pendingApprovals).toHaveLength(1);
  });
});
