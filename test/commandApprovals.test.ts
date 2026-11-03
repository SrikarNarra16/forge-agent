import { describe, expect, it } from "vitest";
import { CommandApprovalHandler, commandOf } from "../src/trueforge/commandApprovals";
import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "../src/trueforge/agentController";
import { parseWebMessage } from "../src/ui/protocol";
import { Transcript } from "../src/ui/transcript";
import { commandCardModel, type ToolItem } from "../src/ui/webview/format";

const call = (command: string, id = "c1"): PendingToolCall => ({ id, name: "run_command", args: JSON.stringify({ command }), threadId: "main", sourceEventId: "m1" });
const signal = new AbortController().signal;

function setup(answers: ApprovalDecision[]) {
  const asked: string[] = [];
  const logs: string[] = [];
  let run = "run-1";
  const inner: ApprovalHandler = { decide: (c) => (asked.push(c.args), Promise.resolve(answers.shift() ?? { status: "deny", reason: "none" })) };
  const handler = new CommandApprovalHandler({ inner, getRunId: () => run, getRoot: () => Promise.resolve("/work"), log: (m) => logs.push(m) });
  return { handler, asked, logs, nextRun: () => (run = "run-2") };
}

describe("CommandApprovalHandler", () => {
  it("denies denylisted commands before asking the user, with an actionable reason", async () => {
    const { handler, asked, logs } = setup([{ status: "allow" }]);
    const d = await handler.decide(call("git push origin main"), signal);
    expect(d).toMatchObject({ status: "deny" });
    expect((d as { reason: string }).reason).toMatch(/git push/);
    expect(asked).toEqual([]);
    expect(logs[0]).toMatch(/denied by policy/);
  });
  it("asks the user for a normal command and passes a deny reason through", async () => {
    const { handler, asked } = setup([{ status: "deny", reason: "no thanks" }]);
    expect(await handler.decide(call("pytest -q"), signal)).toEqual({ status: "deny", reason: "no thanks" });
    expect(asked).toHaveLength(1);
  });
  it("auto-allows an identical command in the same run only after 'allow this exact command for this run'", async () => {
    const { handler, asked, logs, nextRun } = setup([{ status: "allow", remember: true }, { status: "allow" }, { status: "allow" }]);
    expect(await handler.decide(call("pytest -q"), signal)).toEqual({ status: "allow" });
    expect(await handler.decide(call("pytest -q", "c2"), signal)).toEqual({ status: "allow" });
    expect(asked).toHaveLength(1);
    expect(logs.some((l) => /auto-allowed/.test(l))).toBe(true);
    expect(await handler.decide(call("pytest -q -x", "c3"), signal)).toEqual({ status: "allow" }); // different command: asked
    expect(asked).toHaveLength(2);
    nextRun();
    await handler.decide(call("pytest -q", "c4"), signal); // new run: asked again
    expect(asked).toHaveLength(3);
  });
  it("does not remember a plain allow", async () => {
    const { handler, asked } = setup([{ status: "allow" }, { status: "allow" }]);
    await handler.decide(call("ls"), signal);
    await handler.decide(call("ls", "c2"), signal);
    expect(asked).toHaveLength(2);
  });
  it("rejects malformed arguments with a hint", async () => {
    const { handler } = setup([]);
    const d = await handler.decide({ ...call("x"), args: "not json" }, signal);
    expect(d).toMatchObject({ status: "deny" });
    expect(commandOf('{"command":" ls "}')).toBe("ls");
    expect(commandOf("{}")).toBeUndefined();
  });
});

describe("command approval card", () => {
  const item = (over: Partial<ToolItem>): ToolItem => ({ kind: "tool", id: "c1", name: "run_command", argsSummary: "", args: "{}", status: "awaiting_approval", approval: "pending", command: "pytest -q", ...over });
  it("shows the exact command and offers the run checkbox only while pending", () => {
    expect(commandCardModel(item({}))).toEqual({ command: "pytest -q", offerRunAllow: true, decided: undefined });
    expect(commandCardModel(item({ approval: "allowed", status: "running" }))).toMatchObject({ offerRunAllow: false, decided: "You allowed this command." });
    expect(commandCardModel(item({ approval: "denied" }))?.decided).toBe("You denied this command.");
    expect(commandCardModel(item({ name: "read_file" }))).toBeUndefined();
  });
  it("the transcript attaches the command to run_command cards", () => {
    const t = new Transcript();
    const view = {
      messages: [], usage: [], timeline: [{ kind: "tool" as const, id: "c1" }], threads: [], mcpServers: [], compaction: { active: false, count: 0 }, pendingApprovals: [], unsupportedPauses: [], done: undefined,
      toolCalls: [{ id: "c1", name: "run_command", args: '{"command":"pytest -q"}', threadId: "main", sourceEventId: "m", status: "awaiting_approval" as const }],
    };
    const items = t.applyTurn(view, { messages: [], toolCalls: ["c1"], threads: [], compaction: false, pause: true, done: false });
    expect(items[0]).toMatchObject({ kind: "tool", command: "pytest -q", approval: "pending" });
  });
  it("validates allowThisRun in approval messages", () => {
    expect(parseWebMessage({ type: "approval", callId: "c1", decision: "allow", allowThisRun: true })).toEqual({ type: "approval", callId: "c1", decision: "allow", allowThisRun: true });
    expect(parseWebMessage({ type: "approval", callId: "c1", decision: "allow", allowThisRun: "yes" })).toBeUndefined();
    expect(parseWebMessage({ type: "approval", callId: "c1", decision: "allow" })).toEqual({ type: "approval", callId: "c1", decision: "allow" });
  });
});
