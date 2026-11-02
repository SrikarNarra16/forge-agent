import { describe, expect, it } from "vitest";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { TurnReducer } from "../src/trueforge/events";
import { preflight, type BootstrapOutcome } from "../src/trueforge/preflight";
import { ActivityLog, CompositeUi } from "../src/trueforge/uiSinks";
import { delta, modelMessage, toolResponse, turnDone } from "./helpers/events";
import { RecordingUi } from "./helpers/fakeClient";

const agent = (model: string): BootstrapOutcome["agents"][number] => ({ name: "forge-agent", description: "d", spec: { model: { name: model } } });
const ok = (model = "deepseek/flash"): BootstrapOutcome => ({ ok: true, stage: "done", message: "", agents: [agent(model)] });
const clientWith = (names: string[] | Error): TrueForge =>
  ({ models: { list: () => (names instanceof Error ? Promise.reject(names) : Promise.resolve({ data: names.map((name) => ({ name })) })) } }) as unknown as TrueForge;

describe("preflight", () => {
  const base = { baseUrl: () => "http://localhost:8790" };
  const request = { agentName: "forge-agent" };

  it("returns the model name when bootstrap worked and the model exists", async () => {
    await expect(preflight({ ...base, bootstrap: async () => ok(), getClient: () => clientWith(["deepseek/flash", "groq/x"]) }, request)).resolves.toEqual({ ok: true, model: "deepseek/flash" });
  });

  it("explains an unreachable TrueForge with the start command", async () => {
    const r = await preflight({ ...base, bootstrap: async () => ({ ok: false, stage: "unreachable", message: "x", agents: [] }), getClient: () => clientWith([]) }, request);
    expect(r).toMatchObject({ ok: false, message: expect.stringMatching(/not reachable at http:\/\/localhost:8790.*npm run tf:start.*OUTBOUND_URL_ALLOWED_HOSTS/s) });
  });

  it("passes other bootstrap failures through", async () => {
    const r = await preflight({ ...base, bootstrap: async () => ({ ok: false, stage: "mcp-verify", message: "TrueForge could not use the Forge MCP server", agents: [] }), getClient: () => clientWith([]) }, request);
    expect(r).toEqual({ ok: false, message: "TrueForge could not use the Forge MCP server" });
  });

  it("fails clearly when the model is not configured, or the model list cannot be read", async () => {
    const missing = await preflight({ ...base, bootstrap: async () => ok("deepseek/flash"), getClient: () => clientWith(["groq/x"]) }, request);
    expect(missing).toMatchObject({ ok: false, message: expect.stringContaining('Model "deepseek/flash" is not configured') });
    const broken = await preflight({ ...base, bootstrap: async () => ok(), getClient: () => clientWith(new Error("boom")) }, request);
    expect(broken).toMatchObject({ ok: false, message: expect.stringContaining("boom") });
  });

  it("a missing agent definition (e.g. agents/forge-inline.json absent) is a clear error, not a crash", async () => {
    const r = await preflight({ ...base, bootstrap: async () => ok(), getClient: () => clientWith(["deepseek/flash"]) }, { agentName: "forge-inline" });
    expect(r).toMatchObject({ ok: false, message: expect.stringContaining('The agent "forge-inline" is not defined in this extension') });
    expect(r).toMatchObject({ message: expect.stringContaining("agents/forge-inline.json is missing") });
  });

  it("checks and reports the OVERRIDE model instead of the agent file's model", async () => {
    const deps = { ...base, bootstrap: async () => ok("deepseek/flash"), getClient: () => clientWith(["deepseek/flash", "groq/gpt-oss-120b"]) };
    await expect(preflight(deps, { agentName: "forge-agent", model: "groq/gpt-oss-120b" })).resolves.toEqual({ ok: true, model: "groq/gpt-oss-120b" });
    await expect(preflight(deps, { agentName: "forge-agent", model: "nope/model" })).resolves.toMatchObject({ ok: false, message: expect.stringContaining('Model "nope/model" is not configured') });
  });
});

describe("ActivityLog", () => {
  const makeLog = () => {
    const lines: string[] = [];
    const log = { info: (m: string) => lines.push(`I ${m}`), warn: (m: string) => lines.push(`W ${m}`), error: (m: string) => lines.push(`E ${m}`) };
    return { lines, sink: new ActivityLog(log, () => "http://localhost:8790") };
  };

  it("logs the session id and URL", () => {
    const { lines, sink } = makeLog();
    sink.onSession({ sessionId: "abc123", model: "deepseek/flash" });
    expect(lines).toEqual(["I TrueForge session id: abc123 (model deepseek/flash)", "I Session URL: http://localhost:8790/sessions/abc123"]);
  });

  it("logs each tool call with its arguments (including why) once, its response, and the final answer", () => {
    const { lines, sink } = makeLog();
    const r = new TurnReducer();
    const feed = (e: Parameters<TurnReducer["apply"]>[0]) => {
      const change = r.apply(e);
      sink.onTurnChange(r.view, change);
    };
    sink.onUserMessage("find it");
    feed(modelMessage({ id: "m1" }));
    feed(delta({ id: "m1", calls: [{ index: 0, id: "c1", name: "read_file", args: '{"path":"a.py","why":"check parsing"}' }] }));
    feed(delta({ id: "m1", content: "", finish: "tool_calls" }));
    feed(toolResponse({ toolCallId: "c1", content: "1| x", seconds: 3 }));
    feed(toolResponse({ toolCallId: "c1", content: "1| x", seconds: 3 }));
    feed(modelMessage({ id: "m2", content: "It lives in a.py:1", finish: "stop" }));
    feed(turnDone({ status: "done", text: "It lives in a.py:1" }));
    const text = lines.join("\n");
    expect(text.match(/tool call read_file/g)).toHaveLength(1);
    expect(text).toContain('tool call read_file({"path":"a.py","why":"check parsing"})');
    expect(text).toContain("tool.response read_file (2000 ms): 1| x");
    expect(text.match(/tool\.response/g)).toHaveLength(1);
    expect(text).toContain('turn.done status=done answer="It lives in a.py:1"');
  });

  it("logs notices at the matching level", () => {
    const { lines, sink } = makeLog();
    sink.onNotice("warning", "careful");
    sink.onNotice("error", "bad");
    expect(lines).toEqual(["W notice: careful", "E notice: bad"]);
  });
});

describe("CompositeUi", () => {
  it("forwards every call to every sink", () => {
    const a = new RecordingUi();
    const b = new RecordingUi();
    const ui = new CompositeUi([a, b]);
    ui.onState("running");
    ui.onUserMessage("hi");
    ui.onNotice("info", "n");
    ui.onSession({ sessionId: "s" });
    ui.onReset();
    for (const sink of [a, b]) {
      expect(sink.states).toEqual(["running"]);
      expect(sink.users).toEqual(["hi"]);
      expect(sink.notices).toEqual([{ level: "info", text: "n" }]);
      expect(sink.sessionsSeen).toEqual([{ sessionId: "s" }]);
      expect(sink.resets).toBe(1);
    }
  });
});
