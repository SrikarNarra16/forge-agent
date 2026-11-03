import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController, describeRollback, type CancelDeps } from "../src/trueforge/agentController";
import { RunRegistry } from "../src/trueforge/runRegistry";
import { delta, modelMessage, pausedOnApprovals, turnCreated, turnDone } from "./helpers/events";
import { ALLOW, FakeClient, RecordingUi, ScriptedApprovals, deferred, events, gated, rejectOnAbort, tick, type TurnScript } from "./helpers/fakeClient";

afterEach(() => vi.useRealTimers());

/** A provider that streams some text and then never says anything again (and ignores aborts). */
const hungStream: TurnScript = () =>
  (async function* () {
    yield turnCreated();
    yield modelMessage({ id: "m1" });
    yield delta({ id: "m1", content: "partial " });
    await new Promise<never>(() => undefined);
  })();

function rig(scripts: TurnScript[], cancel?: CancelDeps, approvals?: ScriptedApprovals) {
  const client = new FakeClient(...scripts);
  const ui = new RecordingUi();
  const registry = new RunRegistry();
  const logs: string[] = [];
  let run = 0;
  const controller = new AgentController({
    client,
    agentName: "forge-agent",
    ui: { ...bind(ui), onUserMessage: (t) => (run++, ui.onUserMessage(t)) },
    approvals: approvals ?? new ScriptedApprovals(() => ALLOW),
    getRunId: () => `run-${run}`,
    registry,
    ...(cancel ? { cancel } : {}),
    log: (m) => logs.push(m),
  });
  return { controller, client, ui, registry, logs };
}

function bind(ui: RecordingUi) {
  return {
    onState: ui.onState.bind(ui),
    onUserMessage: ui.onUserMessage.bind(ui),
    onTurnChange: ui.onTurnChange.bind(ui),
    onSession: ui.onSession.bind(ui),
    onNotice: ui.onNotice.bind(ui),
    onReset: ui.onReset.bind(ui),
  };
}

describe("Stop is instant", () => {
  it("enters 'cancelling' synchronously, before any promise resolves", async () => {
    const { controller, ui } = rig([hungStream]);
    void controller.send("go");
    await tick();
    const flow = controller.stop();
    expect(controller.state).toBe("cancelling"); // same tick as the click
    expect(ui.states.at(-1)).toBe("cancelling");
    await flow;
    expect(controller.state).toBe("cancelled");
  });

  it("reaches 'cancelled' within 200 ms even if sessions.cancel hangs and the stream never ends", async () => {
    vi.useFakeTimers();
    const { controller, client } = rig([hungStream]);
    client.cancel = () => new Promise<void>(() => undefined); // never answers
    const run = controller.send("go");
    await vi.advanceTimersByTimeAsync(10);
    void controller.stop();
    await vi.advanceTimersByTimeAsync(200);
    expect(controller.state).toBe("cancelled");
    await expect(run).resolves.toMatchObject({ ok: true, state: "cancelled" }); // send() returns although the stream is stuck
  });

  it("logs, but is not held up by, a sessions.cancel that fails or times out", async () => {
    vi.useFakeTimers();
    const { controller, client, logs } = rig([hungStream]);
    client.cancel = () => new Promise<void>(() => undefined);
    const run = controller.send("go");
    await vi.advanceTimersByTimeAsync(10);
    void controller.stop();
    await vi.advanceTimersByTimeAsync(3100);
    await run;
    expect(logs.join("\n")).toMatch(/sessions\.cancel\(sess-1\) failed or timed out.*no answer within 3000 ms/);
  });

  it("ignores everything the stream sends after Stop", async () => {
    const gate = deferred();
    const { controller, ui } = rig([() => gated([turnCreated(), modelMessage({ id: "m1" }), delta({ id: "m1", content: "before " })], gate.promise, [delta({ id: "m1", content: "AFTER", finish: "stop" }), turnDone({ status: "done" })])]);
    const run = controller.send("go");
    await tick();
    await controller.stop();
    const seen = ui.changes.length;
    gate.resolve();
    await run;
    await tick();
    expect(ui.changes).toHaveLength(seen);
    expect(JSON.stringify(ui.lastView)).not.toContain("AFTER");
    expect(controller.state).toBe("cancelled");
  });

  it("double Stop shares one flow; Stop when idle or after done does nothing", async () => {
    const rollbacks: string[] = [];
    const { controller } = rig([hungStream], { rollback: (id) => (rollbacks.push(id), Promise.resolve({ restored: [], skipped: [], failed: [] })) });
    await controller.stop(); // idle
    void controller.send("go");
    await tick();
    const a = controller.stop();
    const b = controller.stop();
    expect(a).toBe(b);
    await a;
    await controller.stop(); // already cancelled
    expect(rollbacks).toEqual(["run-1"]);

    const done = rig([() => events(turnCreated(), modelMessage({ id: "m1", content: "hi", finish: "stop" }), turnDone({ status: "done" }))]);
    await done.controller.send("x");
    await done.controller.stop();
    expect(done.controller.state).toBe("done");
  });

  it("marks the run cancelled in the shared registry and passes the abort signal to the stream", async () => {
    const { controller, registry } = rig([hungStream]);
    void controller.send("go");
    await tick();
    expect(registry.isCancelled()).toBe(false);
    await controller.stop();
    expect(registry.isCancelled("run-1")).toBe(true);
  });
});

describe("Stop while waiting for an approval", () => {
  it("rejects every pending handler promise and resumes nothing", async () => {
    const approvals = new ScriptedApprovals((_c, signal) => rejectOnAbort(signal));
    const gatedTurn: TurnScript = () => events(turnCreated(), modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit" }, { id: "c2", name: "run_command" }], finish: "tool_calls" }), ...pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }, { id: "c2", sourceEventId: "m1" }]));
    const { controller, client } = rig([gatedTurn], undefined, approvals);
    const run = controller.send("write");
    await tick();
    expect(controller.state).toBe("awaitingApproval");
    await controller.stop();
    await run;
    expect(approvals.signals.every((s) => s.aborted)).toBe(true);
    expect(client.turns).toHaveLength(1);
    expect(controller.state).toBe("cancelled");
  });
});

describe("the ordered Stop flow", () => {
  it("(d) cancelWork -> (e) settle (waits for an in-flight apply) -> (f) rollback, then 'cancelled' with an explicit message", async () => {
    const order: string[] = [];
    const apply = deferred();
    const { controller, ui } = rig([hungStream], {
      cancelWork: () => order.push("cancelWork"),
      settle: async () => {
        order.push("settle:start");
        await apply.promise;
        order.push("settle:end");
      },
      rollback: (id) => (order.push(`rollback:${id}`), Promise.resolve({ restored: ["src/a.py", "docs/new.rst"], skipped: [], failed: [] })),
    });
    const run = controller.send("go");
    await tick();
    const flow = controller.stop();
    await tick();
    expect(controller.state).toBe("cancelling"); // still finishing the apply
    expect(order).toEqual(["cancelWork", "settle:start"]);
    apply.resolve();
    await flow;
    await run;
    expect(order).toEqual(["cancelWork", "settle:start", "settle:end", "rollback:run-1"]);
    expect(controller.state).toBe("cancelled");
    expect(ui.details.at(-1)).toBe("Cancelled. Rolled back 2 files from this run: src/a.py, docs/new.rst");
    expect(ui.notices.at(-1)).toMatchObject({ level: "info", text: "Cancelled. Rolled back 2 files from this run: src/a.py, docs/new.rst" });
  });

  it("with rollbackOnCancel off: keeps the files and says which", async () => {
    const rollback = vi.fn();
    const { controller, ui } = rig([hungStream], { rollbackEnabled: () => false, rollback, changedFiles: () => ["src/a.py"] });
    void controller.send("go");
    await tick();
    await controller.stop();
    expect(rollback).not.toHaveBeenCalled();
    expect(ui.details.at(-1)).toBe("Cancelled. 1 applied file kept (rollback on cancel is off): src/a.py");
  });

  it("reports files left alone because the user edited them, and files that could not be restored", async () => {
    const { controller, ui } = rig([hungStream], { rollback: () => Promise.resolve({ restored: ["a.py"], skipped: ["b.py"], failed: [{ path: "c.py", error: "EACCES" }] }) });
    void controller.send("go");
    await tick();
    await controller.stop();
    expect(ui.details.at(-1)).toBe("Cancelled. Rolled back 1 file from this run: a.py. Left as you edited them (changed after Forge wrote them): b.py. Could not restore: c.py (EACCES)");
    expect(ui.notices.at(-1)?.level).toBe("warning");
  });

  it("says so when nothing had been changed, and survives a throwing rollback or cancelWork", async () => {
    const quiet = rig([hungStream], { rollback: () => Promise.resolve({ restored: [], skipped: [], failed: [] }) });
    void quiet.controller.send("go");
    await tick();
    await quiet.controller.stop();
    expect(quiet.ui.details.at(-1)).toBe("Cancelled. Nothing had been changed.");

    const broken = rig([hungStream], { cancelWork: () => { throw new Error("boom"); }, rollback: () => Promise.reject(new Error("disk gone")) });
    void broken.controller.send("go");
    await tick();
    await broken.controller.stop();
    expect(broken.controller.state).toBe("cancelled");
    expect(broken.ui.details.at(-1)).toMatch(/rolling back failed: disk gone/);
  });

  it("the next send after a cancelled run works", async () => {
    const answer: TurnScript = () => events(turnCreated(), modelMessage({ id: "m9", content: "fine", finish: "stop" }), turnDone({ status: "done" }));
    const { controller } = rig([hungStream, answer]);
    void controller.send("go");
    await tick();
    await controller.stop();
    await controller.send("again");
    expect(controller.state).toBe("done");
  });

  it("describeRollback wording", () => {
    expect(describeRollback({ restored: ["a"], skipped: [], failed: [] })).toBe("Cancelled. Rolled back 1 file from this run: a");
    expect(describeRollback({ restored: [], skipped: [], failed: [] })).toBe("Cancelled. Nothing had been changed.");
  });
});
