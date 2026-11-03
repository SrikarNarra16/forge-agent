import { describe, expect, it } from "vitest";
import { NodeCommandRunner, OutputCapture } from "../src/host/commandRunner";
import type { CommandResult, CommandRunner } from "../src/mcp/commandRunner";
import { formatResult, runRunCommand, tailOutput } from "../src/mcp/tools/runCommand";
import { createToolDeps } from "../src/mcp/tools/common";
import { FakeHost, makeRig, textOf } from "./helpers/fakeHost";

const ok = (over: Partial<CommandResult> = {}): CommandResult => ({ exitCode: 0, output: "", timedOut: false, aborted: false, durationMs: 1200, ...over });

function setup(runner?: CommandRunner) {
  const host = new FakeHost({ "a.py": "x" });
  const rig = makeRig();
  const events: string[] = [];
  const deps = createToolDeps({
    log: () => undefined,
    events: rig.deps.events,
    commands: runner,
    terminal: { started: (c) => events.push(`start:${c}`), output: (c) => events.push(`out:${c}`), finished: (r) => events.push(`end:${String(r.exitCode)}`) },
  });
  return { host, deps, events };
}

describe("tailOutput", () => {
  it("keeps short output whole", () => {
    expect(tailOutput("a\nb\n")).toMatchObject({ text: "a\nb", truncated: false, totalLines: 2 });
    expect(tailOutput("")).toMatchObject({ text: "", truncated: false });
  });
  it("keeps the last 200 lines and says what was cut", () => {
    const out = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join("\n");
    const t = tailOutput(out);
    expect(t.truncated).toBe(true);
    expect(t.text.startsWith("[output truncated: showing the last 200 of 500 lines]\nline 301")).toBe(true);
    expect(t.text.endsWith("line 500")).toBe(true);
  });
  it("also respects the token cap and cuts a single huge line", () => {
    const out = Array.from({ length: 150 }, () => "x".repeat(400)).join("\n"); // ~100 tokens per line
    const t = tailOutput(out, { maxTokens: 1000 });
    expect(t.shownLines).toBeLessThan(15);
    expect(t.text.endsWith("x".repeat(400))).toBe(true);
    const one = tailOutput("y".repeat(100_000), { maxTokens: 100 });
    expect(one.text.length).toBeLessThan(500);
  });
});

describe("run_command tool", () => {
  it("runs the command after the policy check and reports exit code + output tail", async () => {
    const calls: string[] = [];
    const runner: CommandRunner = { run: (c, o) => (calls.push(`${c}@${o.cwd}/${o.timeoutMs}`), o.onOutput?.("hello\n"), Promise.resolve(ok({ output: "hello\n" }))) };
    const { host, deps, events } = setup(runner);
    const text = textOf(await runRunCommand(host, deps, { command: "pytest -q" }));
    expect(text).toBe("exit code 0 (1.2s)\nhello");
    expect(calls).toEqual(["pytest -q@/work/120000"]);
    expect(events).toEqual(["start:pytest -q", "out:hello\n", "end:0"]);
  });
  it("reports non-zero exits as information, not as a tool error", async () => {
    const { host, deps } = setup({ run: () => Promise.resolve(ok({ exitCode: 1, output: "1 failed" })) });
    const r = await runRunCommand(host, deps, { command: "pytest" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/^exit code 1 .*\n1 failed$/);
  });
  it("refuses denied commands without running them", async () => {
    let ran = false;
    const { host, deps } = setup({ run: () => ((ran = true), Promise.resolve(ok())) });
    const r = await runRunCommand(host, deps, { command: "git push origin main" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Command not run: git push/);
    expect(ran).toBe(false);
  });
  it("validates arguments and clamps the timeout", async () => {
    let seen = 0;
    const { host, deps } = setup({ run: (_c, o) => ((seen = o.timeoutMs), Promise.resolve(ok())) });
    expect((await runRunCommand(host, deps, { command: "  " })).isError).toBe(true);
    expect((await runRunCommand(host, deps, { command: "ls", timeout_s: 0 })).isError).toBe(true);
    await runRunCommand(host, deps, { command: "ls", timeout_s: 9999 });
    expect(seen).toBe(300_000);
  });
  it("explains when no runner exists, and describes timeouts and cancellation", async () => {
    const none = setup(undefined);
    expect(textOf(await runRunCommand(none.host, none.deps, { command: "ls" }))).toMatch(/not available/);
    expect(formatResult(ok({ timedOut: true, exitCode: null, output: "partial" }), 5)).toMatch(/^timed out after 5s and was killed/);
    expect(formatResult(ok({ aborted: true, exitCode: null }), 5)).toMatch(/cancelled/);
    expect(formatResult(ok(), 5)).toBe("exit code 0 (1.2s)\n(no output)");
  });
});

describe("NodeCommandRunner (real processes)", () => {
  const runner = new NodeCommandRunner();
  const base = { cwd: process.cwd(), timeoutMs: 10_000 };

  it("captures merged stdout+stderr, exit code and streams chunks", async () => {
    const chunks: string[] = [];
    const r = await runner.run("echo out; echo err 1>&2; exit 3", { ...base, onOutput: (c) => chunks.push(c) });
    expect(r.exitCode).toBe(3);
    expect(r.output).toContain("out");
    expect(r.output).toContain("err");
    expect(chunks.join("")).toContain("out");
  });
  it("applies the command prefix", async () => {
    const r = await new NodeCommandRunner({ getPrefix: () => "export FORGE_PREFIX_TEST=yes &&" }).run("echo $FORGE_PREFIX_TEST", base);
    expect(r.output.trim()).toBe("yes");
  });
  it("kills the whole process tree on timeout", async () => {
    const started = Date.now();
    const r = await runner.run("sleep 30 & sleep 30; echo never", { ...base, timeoutMs: 300 });
    expect(r.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(6000);
    expect(r.output).not.toContain("never");
  }, 15_000);
  it("kills on abort and returns promptly", async () => {
    const controller = new AbortController();
    const pending = runner.run("sleep 30", { ...base, signal: controller.signal });
    setTimeout(() => controller.abort(), 100);
    const r = await pending;
    expect(r.aborted).toBe(true);
    expect(r.durationMs).toBeLessThan(6000);
  }, 15_000);
  it("returns at once when already aborted", async () => {
    const controller = new AbortController();
    controller.abort();
    const r = await runner.run("sleep 30", { ...base, signal: controller.signal });
    expect(r.aborted).toBe(true);
  }, 15_000);
  it("does not block the event loop while a command runs", async () => {
    let ticks = 0;
    const timer = setInterval(() => ticks++, 10);
    await runner.run("sleep 0.3", base);
    clearInterval(timer);
    expect(ticks).toBeGreaterThan(10);
  });
});

describe("OutputCapture", () => {
  it("keeps the head and a rolling tail beyond the cap", () => {
    const c = new OutputCapture(300_000);
    c.push("H".repeat(100_000));
    for (let i = 0; i < 10; i++) c.push(`${String(i).repeat(100_000)}`);
    const text = c.text();
    expect(text.startsWith("H")).toBe(true);
    expect(text).toMatch(/\[\.\.\. \d+ characters omitted \.\.\.\]/);
    expect(text.endsWith("9".repeat(1000))).toBe(true);
    expect(text.length).toBeLessThan(310_000);
  });
});
