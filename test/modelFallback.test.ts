import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentController, type ChainDeps } from "../src/trueforge/agentController";
import { snapshotSelection } from "../src/inline/message";
import { runInlineEdit, type InlineUi } from "../src/inline/runner";
import { delta, modelMessage, pausedOnApprovals, turnCreated, turnDone } from "./helpers/events";
import { ALLOW, FakeClient, RecordingUi, ScriptedApprovals, events, tick, type TurnScript } from "./helpers/fakeClient";

afterEach(() => vi.useRealTimers());

const REAL_503 = "[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.";
const REAL_REFUSED = "[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9";
const REAL_AUTH = "[Model Error] Request failed (400): API key not valid. Please pass a valid API key.";

const fails = (message: string, partial?: string): TurnScript => () =>
  (async function* () {
    yield turnCreated();
    yield modelMessage({ id: "m-fail" });
    if (partial) yield delta({ id: "m-fail", content: partial });
    yield turnDone({ status: "error", message });
  })();
const answers = (text = "Done."): TurnScript => () => events(turnCreated(), modelMessage({ id: "m-ok", content: text, finish: "stop" }), turnDone({ status: "done", text }));
const hangs: TurnScript = () =>
  (async function* () {
    yield turnCreated();
    yield modelMessage({ id: "m-hang" });
    await new Promise<never>(() => undefined);
  })();

interface Opts {
  models?: string[];
  chain?: Partial<ChainDeps>;
  approvals?: ScriptedApprovals;
}

function rig(scripts: TurnScript[], opts: Opts = {}) {
  const client = new FakeClient(...scripts);
  const ui = new RecordingUi();
  const sleeps: number[] = [];
  const logs: string[] = [];
  const controller = new AgentController({
    client,
    agentName: "forge-agent",
    ui,
    approvals: opts.approvals ?? new ScriptedApprovals(() => ALLOW),
    log: (m) => logs.push(m),
    getRunId: () => "run-1",
    chain: {
      models: () => opts.models ?? ["m1", "m2"],
      sleep: (ms) => (sleeps.push(ms), Promise.resolve()),
      random: () => 0.5,
      ...opts.chain,
    },
  });
  return { controller, client, ui, sleeps, logs };
}

const userTexts = (client: FakeClient): unknown[] => client.turns.map((t) => JSON.stringify(t.input));
const modelsUsed = (client: FakeClient): Array<string | undefined> => client.sessionSpecs.map((s) => s?.model);

describe("automatic fallback", () => {
  it("unreachable endpoint: advances to the next model at once (no retry), replaying the SAME text in a NEW session", async () => {
    const { controller, client, ui, sleeps } = rig([fails(REAL_REFUSED), answers()]);
    const result = await controller.send("CONTEXT BLOCK\n\nUser request:\nfix it", { display: "fix it" });
    expect(result).toMatchObject({ ok: true, state: "done" });
    expect(sleeps).toEqual([]);
    expect(modelsUsed(client)).toEqual(["m1", "m2"]);
    expect(client.sessions).toHaveLength(2); // a new session per attempt
    const [first, second] = userTexts(client);
    expect(second).toBe(first); // identical turn input: same text and same context block
    expect(ui.users).toEqual(["fix it"]); // one user entry, no duplicate
    expect(ui.discards).toBe(1); // the failed attempt's partial output is dropped from the UI
    const sw = ui.chainEvents.find((e) => e.kind === "switched");
    expect(sw?.text).toMatch(/^m1 unreachable \(connection refused\) -> switched to m2 \(after \d+(?:\.\d s| ms)\)\.$/);
    expect(typeof sw?.afterMs).toBe("number");
  });

  it("auth failures skip retries too", async () => {
    const { controller, client, sleeps } = rig([fails(REAL_AUTH), answers()]);
    expect(await controller.send("go")).toMatchObject({ state: "done" });
    expect(sleeps).toEqual([]);
    expect(modelsUsed(client)).toEqual(["m1", "m2"]);
  });

  it("transient: retries the same model twice (500 ms, 1.5 s with jitter), then advances", async () => {
    const { controller, client, sleeps, ui } = rig([fails(REAL_503), fails(REAL_503), fails(REAL_503), answers()]);
    expect(await controller.send("go")).toMatchObject({ state: "done" });
    expect(sleeps).toEqual([500, 1500]);
    expect(modelsUsed(client)).toEqual(["m1", "m1", "m1", "m2"]);
    expect(ui.chainEvents.filter((e) => e.kind === "retrying").map((e) => e.text)).toEqual(["Retrying m1 in 0.5 s (503: high demand)", "Retrying m1 in 1.5 s (503: high demand)"]);
    expect(ui.discards).toBe(3);
  });

  it("a transient failure that clears on the retry never switches models", async () => {
    const { controller, client, ui } = rig([fails(REAL_503), answers()]);
    expect(await controller.send("go")).toMatchObject({ state: "done" });
    expect(modelsUsed(client)).toEqual(["m1", "m1"]);
    expect(ui.chainEvents.some((e) => e.kind === "switched")).toBe(false);
  });

  it("discards the failed attempt's partial assistant text", async () => {
    const { controller, ui } = rig([fails(REAL_REFUSED, "I was about to say"), answers("The real answer")]);
    await controller.send("go");
    expect(ui.discards).toBe(1);
    expect(ui.lastView?.messages.map((m) => m.text)).toEqual(["The real answer"]); // the reducer of the new attempt starts clean
  });

  it("chain exhausted: a clear final error naming every model and class, the run ends (idle for the next send)", async () => {
    const { controller, ui } = rig([fails(REAL_REFUSED), fails(REAL_AUTH)]);
    const result = await controller.send("go");
    expect(result).toMatchObject({ ok: true, state: "error" });
    const text = ui.notices.at(-1)?.text ?? "";
    expect(text).toContain("No model could answer.");
    expect(text).toContain("m1 (unreachable: connection refused)");
    expect(text).toContain("m2 (auth: 400: api key not valid)");
    expect(text).toMatch(/Check Settings -> Models in TrueForge.*forge\.models/);
    expect(ui.chainEvents.at(-1)?.kind).toBe("exhausted");
    // the next send works
    controller.runState.canTransition("running");
    expect(controller.state).toBe("error");
  });

  it("a single-model chain with an unreachable endpoint ends with a clear error", async () => {
    const { controller, ui } = rig([fails(REAL_REFUSED)], { models: ["broken-endpoint/broken"] });
    expect(await controller.send("go")).toMatchObject({ state: "error" });
    expect(ui.notices.at(-1)?.text).toContain("broken-endpoint/broken (unreachable: connection refused)");
  });

  it("fatal errors (agent / tool problems) are NOT model failures and never fall back", async () => {
    const { controller, client } = rig([fails("propose_edit: old_text not found"), answers()]);
    expect(await controller.send("go")).toMatchObject({ state: "error" });
    expect(client.turns).toHaveLength(1);
  });

  it("TrueForge itself being down is not a model failure: stop, say so, no fallback", async () => {
    const { controller, client, ui } = rig([answers()]);
    client.createSession = () => Promise.reject(new TypeError("fetch failed"));
    expect(await controller.send("go")).toMatchObject({ state: "error" });
    expect(ui.chainEvents.map((e) => e.kind)).toEqual(["trueforge-down"]);
    expect(client.turns).toHaveLength(0);
  });

  it("a dropped stream that cannot be resumed is a transient model failure and is retried", async () => {
    const drop: TurnScript = () =>
      (async function* () {
        yield turnCreated();
        yield modelMessage({ id: "m-drop" });
        throw new TypeError("terminated");
      })();
    const { controller, client } = rig([drop, answers()]);
    client.turnStatus = () => Promise.resolve("running");
    client.subscribe = () => Promise.reject(new TypeError("terminated")); // the single re-attach fails as well
    expect(await controller.send("go")).toMatchObject({ state: "done" });
    expect(modelsUsed(client)).toEqual(["m1", "m1"]);
  });

  it("a dropped stream where TrueForge cannot even report the turn status is 'TrueForge down', not a model failure", async () => {
    const drop: TurnScript = () =>
      (async function* () {
        yield turnCreated();
        throw new TypeError("terminated");
      })();
    const { controller, client, ui } = rig([drop, answers()]);
    client.turnStatus = () => Promise.reject(new TypeError("fetch failed"));
    expect(await controller.send("go")).toMatchObject({ state: "error" });
    expect(client.turns).toHaveLength(1);
    expect(ui.chainEvents.map((e) => e.kind)).toEqual(["trueforge-down"]);
  });

  it("attempts are bounded: a provider that always fails ends the run, it never loops", async () => {
    const many = Array.from({ length: 12 }, () => fails(REAL_503));
    const { controller, client } = rig(many, { models: ["a", "b", "c"] });
    expect(await controller.send("go")).toMatchObject({ state: "error" });
    expect(client.turns.length).toBeLessThanOrEqual(8);
  });

  it("tells the user when earlier messages of a longer chat are not in the new session", async () => {
    const { controller, ui } = rig([answers("first answer"), fails(REAL_REFUSED), answers("second answer")]);
    await controller.send("one");
    await controller.send("two");
    expect(ui.chainEvents.find((e) => e.kind === "switched")?.text).toMatch(/does not contain the earlier messages of this chat/);
  });
});

describe("side effects forbid a replay", () => {
  it("an applied edit: no replay, the message lists the files and offers Undo run", async () => {
    const { controller, client, ui } = rig([fails(REAL_503), answers()], { chain: { sideEffects: () => ({ files: ["src/flask/cli.py"], commands: [] }) } });
    const result = await controller.send("go");
    expect(result).toMatchObject({ ok: true, state: "error" });
    expect(client.turns).toHaveLength(1);
    const text = ui.notices.at(-1)?.text ?? "";
    expect(text).toContain("applied 1 file (src/flask/cli.py)");
    expect(text).toContain("did not replay");
    expect(text).toContain("Undo run");
    expect(ui.chainEvents.at(-1)?.kind).toBe("blocked");
    expect(ui.discards).toBe(0);
  });
  it("an executed run_command counts too", async () => {
    const { controller, client, ui } = rig([fails(REAL_REFUSED), answers()], { chain: { sideEffects: () => ({ files: [], commands: ["pytest -q"] }) } });
    await controller.send("go");
    expect(client.turns).toHaveLength(1);
    expect(ui.notices.at(-1)?.text).toContain("ran 1 command (pytest -q)");
  });
  it("no side effects -> replays normally", async () => {
    const { controller, client } = rig([fails(REAL_503), answers()], { chain: { sideEffects: () => ({ files: [], commands: [] }) } });
    await controller.send("go");
    expect(client.turns).toHaveLength(2);
  });
});

describe("Stop cancels the whole chain", () => {
  it("during the backoff", async () => {
    const waits: Array<() => void> = [];
    const { controller, client } = rig([fails(REAL_503), answers()], { chain: { sleep: (_ms, signal) => new Promise<void>((resolve) => (waits.push(resolve), signal.addEventListener("abort", () => resolve()))) } });
    const run = controller.send("go");
    for (let i = 0; i < 30 && waits.length === 0; i++) await tick();
    expect(waits).toHaveLength(1); // sleeping before the retry
    await controller.stop();
    await run;
    expect(controller.state).toBe("cancelled");
    expect(client.turns).toHaveLength(1); // no retry happened
  });
  it("during the fallback attempt", async () => {
    const { controller, client } = rig([fails(REAL_REFUSED), hangs]);
    const run = controller.send("go");
    for (let i = 0; i < 30 && client.turns.length < 2; i++) await tick();
    expect(client.turns).toHaveLength(2);
    await controller.stop();
    await run;
    expect(controller.state).toBe("cancelled");
    expect(client.cancels).toEqual(["sess-2"]); // the running fallback session is the one cancelled
  });
});

describe("stall watchdog", () => {
  const stall = { stall: () => ({ firstMs: 45_000, idleMs: 90_000 }), tickMs: 1000 };

  it("a silent model (no first token within the limit) is a stall: one retry, then advance to the next model", async () => {
    vi.useFakeTimers();
    const { controller, client, ui, sleeps } = rig([hangs, hangs, answers()], { chain: stall });
    const run = controller.send("go");
    await vi.advanceTimersByTimeAsync(44_000);
    expect(client.turns).toHaveLength(1); // not yet
    await vi.advanceTimersByTimeAsync(3000); // > 45 s: stall #1 -> retry the same model
    expect(client.turns).toHaveLength(2);
    expect(client.cancels).toEqual(["sess-1"]); // abandoned via the instant cancel path (not awaited)
    await vi.advanceTimersByTimeAsync(47_000); // stall #2 -> advance
    await run;
    expect(modelsUsed(client)).toEqual(["m1", "m1", "m2"]);
    expect(sleeps).toHaveLength(1);
    expect(ui.chainEvents.some((e) => e.kind === "switched" && /stopped responding/.test(e.text))).toBe(true);
    expect(controller.state).toBe("done");
  });

  it("uses the longer idle limit once tokens have flowed", async () => {
    vi.useFakeTimers();
    const slowAfterToken: TurnScript = () =>
      (async function* () {
        yield turnCreated();
        yield modelMessage({ id: "m1x" });
        yield delta({ id: "m1x", content: "thinking " });
        await new Promise<never>(() => undefined);
      })();
    const { controller, client } = rig([slowAfterToken, answers()], { chain: stall });
    void controller.send("go");
    await vi.advanceTimersByTimeAsync(80_000);
    expect(client.turns).toHaveLength(1); // 80 s of silence after a token is still within the 90 s idle limit
    await vi.advanceTimersByTimeAsync(15_000);
    expect(client.turns).toHaveLength(2);
  });

  it("does NOT fire while the run waits for the user's approval", async () => {
    vi.useFakeTimers();
    const approvals = new ScriptedApprovals(() => new Promise(() => undefined)); // the user takes forever
    const paused: TurnScript = () => events(turnCreated(), modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit" }], finish: "tool_calls" }), ...pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }]));
    const { controller, client } = rig([paused], { chain: stall, approvals });
    void controller.send("go");
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(controller.state).toBe("awaitingApproval");
    expect(client.turns).toHaveLength(1);
    expect(client.cancels).toEqual([]);
  });

  it("does NOT fire while a tool call is in flight (a long run_command)", async () => {
    vi.useFakeTimers();
    const toolRunning: TurnScript = () =>
      (async function* () {
        yield turnCreated();
        yield modelMessage({ id: "m1", calls: [{ id: "c1", name: "run_command" }], finish: "tool_calls" });
        await new Promise<never>(() => undefined); // the tool takes minutes; no events meanwhile
      })();
    const { controller, client } = rig([toolRunning], { chain: stall });
    void controller.send("go");
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    expect(client.turns).toHaveLength(1);
    expect(client.cancels).toEqual([]);
    expect(controller.state).toBe("running");
  });

  it("a stream that keeps delivering events never stalls", async () => {
    vi.useFakeTimers();
    const chatty: TurnScript = () =>
      (async function* () {
        yield turnCreated();
        yield modelMessage({ id: "mc" });
        for (let i = 0; i < 20; i++) {
          await new Promise((r) => setTimeout(r, 40_000));
          yield delta({ id: "mc", content: `part${i} ` });
        }
        yield delta({ id: "mc", content: "end", finish: "stop" });
        yield turnDone({ status: "done" });
      })();
    const { controller, client } = rig([chatty], { chain: stall });
    const run = controller.send("go");
    await vi.advanceTimersByTimeAsync(20 * 40_000 + 5000);
    await run;
    expect(client.turns).toHaveLength(1);
    expect(controller.state).toBe("done");
  });
});

describe("inline edit goes through the same chain", () => {
  it("a fresh-session inline run falls back to the next model", async () => {
    const { controller, client } = rig([fails(REAL_REFUSED), answers("no edit needed")]);
    const r = snapshotSelection({ text: "def f():\n    return 1\n", start: { line: 0, character: 0 }, end: { line: 1, character: 12 }, path: "a.py", languageId: "python" });
    if (!r.ok) throw new Error("selection");
    const ui: InlineUi = { busy: () => undefined, running: () => () => undefined, applied: () => undefined, info: () => undefined, error: () => undefined };
    const outcome = await runInlineEdit({ controller, ui, agentName: "forge-inline" }, { snapshot: r.snapshot, instruction: "do it" });
    expect(outcome.kind).toBe("no-edit");
    expect(modelsUsed(client)).toEqual(["m1", "m2"]);
    expect(client.sessionSpecs.every((s) => s?.agentName === "forge-inline")).toBe(true);
  });
});
