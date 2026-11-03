import { describe, expect, it } from "vitest";
import { HarnessCommandApproval, harnessAllows } from "../scripts/eval/commands";
import { assertThrowaway, extrasName } from "../scripts/eval/guard";
import { checkLimits, totalsOf, type LedgerEntry } from "../scripts/eval/ledger";
import { contextLink, formatContextLink, formatSummary, summarize, type RunReport } from "../scripts/eval/report";
import { BACKOFF_MS, OutageGuard, ProviderOutage, classifyFailure, withRetries } from "../scripts/eval/retry";
import { deriveSignals } from "../scripts/eval/signals";
import type { TurnView, ToolCallInfo } from "../src/trueforge/events";

describe("failure classifier", () => {
  it.each([
    "[Model Error] Request failed (503): Service is too busy.",
    "[Model Error] Request failed (500): Internal Server Error",
    "Request failed (429): rate limit exceeded",
    "client-cancelled",
    "fetch failed",
    "read ECONNRESET",
    "connect ECONNREFUSED 127.0.0.1:8790",
    "Request timed out",
    "terminated",
    "[Model Error] Response stream ended without a finish reason.",
    "other side closed",
  ])("%s is a provider failure", (e) => expect(classifyFailure([e])).toBe("provider"));
  it.each(["old_text not found in file", "Agent needs input of a type Forge doesn't support yet", "propose_edit: User rejected all changes", "Request failed (400): bad request"])("%s is an agent failure", (e) => expect(classifyFailure([e])).toBe("agent"));
  it("is a provider failure if any error is", () => expect(classifyFailure(["x", "Request failed (503)"])).toBe("provider"));
});

describe("withRetries", () => {
  it("retries provider failures with 10 s then 30 s backoff, at most 2 retries", async () => {
    const slept: number[] = [];
    const attempts = await withRetries(async () => ({ provider: true }), { retryable: (r) => r.provider, sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    expect(attempts.map((a) => a.attempt)).toEqual([1, 2, 3]);
    expect(slept).toEqual([10_000, 30_000]);
    expect([...BACKOFF_MS]).toEqual([10_000, 30_000]);
  });
  it("stops at the first success or non-provider failure", async () => {
    const outcomes = [{ provider: true }, { provider: false }];
    const attempts = await withRetries(async () => outcomes.shift() ?? { provider: false }, { retryable: (r) => r.provider, sleep: () => Promise.resolve() });
    expect(attempts).toHaveLength(2);
    expect(await withRetries(async () => 1, { retryable: () => false })).toHaveLength(1);
  });
  it("supports an async retryable check (cost guard)", async () => {
    const attempts = await withRetries(async () => 1, { retryable: () => Promise.resolve(false), sleep: () => Promise.resolve() });
    expect(attempts).toHaveLength(1);
  });
});

describe("cost guard ledger", () => {
  const e = (input: number, output: number): LedgerEntry => ({ runId: "r", task: "b", model: "m", attempt: 1, input, output, at: "" });
  it("sums tokens and attempts and stops at the limits", () => {
    const t = totalsOf([e(1000, 100), e(2000, 200)]);
    expect(t).toEqual({ attempts: 2, providerFailures: 0, input: 3000, output: 300, total: 3300 });
    expect(checkLimits(t, { tokens: 4_000_000, runs: 40 })).toEqual({ ok: true });
    expect(checkLimits({ ...t, total: 4_000_000 }, { tokens: 4_000_000, runs: 40 })).toMatchObject({ ok: false, reason: expect.stringMatching(/TOKEN LIMIT.*ask/) });
    expect(checkLimits({ ...t, attempts: 40 }, { tokens: 4_000_000, runs: 40 })).toMatchObject({ ok: false, reason: expect.stringMatching(/RUN LIMIT/) });
  });
});

describe("provider failures without tokens do not count toward the attempt cap", () => {
  const e = (input: number, output: number): LedgerEntry => ({ runId: "r", task: "b", model: "m", attempt: 1, input, output, at: "" });
  it("counts only attempts that used tokens and tracks the others separately", () => {
    const t = totalsOf([e(0, 0), e(0, 0), e(5000, 100), e(0, 0)]);
    expect(t).toMatchObject({ attempts: 1, providerFailures: 3, total: 5100 });
    expect(checkLimits({ ...t, attempts: 39 }, { tokens: 4_000_000, runs: 40 })).toEqual({ ok: true });
  });
});

describe("OutageGuard", () => {
  it("pauses 10 minutes after 3 provider failures in a row and logs it", async () => {
    const slept: number[] = [];
    const logs: string[] = [];
    const g = new OutageGuard({ sleep: (ms) => (slept.push(ms), Promise.resolve()), log: (m) => logs.push(m) });
    await g.beforeAttempt();
    g.record(true); g.record(true);
    await g.beforeAttempt();
    expect(slept).toEqual([]);
    g.record(true);
    await g.beforeAttempt();
    expect(slept).toEqual([600_000]);
    expect(logs[0]).toMatch(/PAUSING 10 minutes.*pause 1 of 3/);
  });
  it("a success resets the failure and pause counters", async () => {
    const slept: number[] = [];
    const g = new OutageGuard({ sleep: (ms) => (slept.push(ms), Promise.resolve()) });
    for (let i = 0; i < 3; i++) g.record(true);
    await g.beforeAttempt();
    g.record(false);
    for (let i = 0; i < 3; i++) g.record(true);
    await g.beforeAttempt();
    expect(slept).toHaveLength(2);
    for (let round = 0; round < 3; round++) { g.record(false); for (let i = 0; i < 3; i++) g.record(true); await g.beforeAttempt(); }
    await expect(g.beforeAttempt()).resolves.toBeUndefined(); // reset by the successes: no stop yet
  });
  it("stops after 3 pauses in a row once the provider still fails", async () => {
    const g = new OutageGuard({ sleep: () => Promise.resolve() });
    for (let pause = 0; pause < 3; pause++) {
      for (let i = 0; i < 3; i++) g.record(true);
      await g.beforeAttempt(); // pause
    }
    await g.beforeAttempt(); // first attempt after the third pause is allowed
    g.record(true); // ...and it fails
    await expect(g.beforeAttempt()).rejects.toBeInstanceOf(ProviderOutage);
    await expect(g.beforeAttempt()).rejects.toThrow(/PROVIDER OUTAGE/);
  });
});

describe("harness approvals", () => {
  const call = (command: string) => ({ id: "c", name: "run_command", args: JSON.stringify({ command }), threadId: "main", sourceEventId: "m" });
  it("allows pytest / flask / read-only git, also chained with cd and env", () => {
    for (const c of ["pytest tests/test_cli.py -q", "python -m pytest -x", "python3 -m pytest tests", "flask --help", "python -m flask --app x config", "git diff", "git --no-pager status --porcelain", "cd /tmp/x && pytest -q", "PYTHONPATH=src pytest -q", "pytest -q 2>&1 | tail -20"]) expect(harnessAllows(c), c).toBe(true);
  });
  it("denies everything else, including redirects and file edits", () => {
    for (const c of ["sed -i s/a/b/ src/flask/cli.py", "echo x > src/flask/cli.py", "pip install foo", "python -c 'open(\"f\",\"w\")'", "git commit -am x", "git checkout .", "cat src/flask/cli.py", "pytest && rm -rf build", ""]) expect(harnessAllows(c), c).toBe(false);
  });
  it("records every command with its verdict", async () => {
    const h = new HarnessCommandApproval();
    expect(await h.decide(call("pytest -q"))).toEqual({ status: "allow" });
    expect(await h.decide(call("sed -i x y"))).toMatchObject({ status: "deny" });
    expect(h.records.map((r) => [r.command, r.approved])).toEqual([["pytest -q", true], ["sed -i x y", false]]);
  });
  it("the guard accepts the extras throwaway name and still refuses the product names", () => {
    expect(() => assertThrowaway(extrasName(12, 3))).not.toThrow();
    for (const bad of ["forge-editor-extras", "forge-eval-12-r3-extra", "forge-editor"]) expect(() => assertThrowaway(bad)).toThrow(/SAFETY/);
  });
});

describe("behaviour signals", () => {
  const call = (name: string, args: unknown, extra: Partial<ToolCallInfo> = {}): ToolCallInfo => ({ id: `${name}${Math.random()}`, name, args: JSON.stringify(args), threadId: "main", sourceEventId: "m", status: "done", response: "ok", ...extra });
  const view = (calls: ToolCallInfo[], threads: TurnView["threads"] = []): TurnView => ({ messages: [], usage: [], timeline: [], toolCalls: calls, threads, mcpServers: [], compaction: { active: false, count: 0 }, pendingApprovals: [], unsupportedPauses: [], done: undefined });
  it("ranTests needs an approved pytest after the first edit", () => {
    expect(deriveSignals(view([call("propose_edit", {}), call("run_command", { command: "pytest tests/test_cli.py -q" })])).ranTests).toBe(true);
    expect(deriveSignals(view([call("run_command", { command: "pytest -q" }), call("propose_edit", {})])).ranTests).toBe(false);
    expect(deriveSignals(view([call("propose_edit", {}), call("run_command", { command: "pytest -q" }, { status: "denied" })])).ranTests).toBe(false);
    expect(deriveSignals(view([call("propose_edit", {}), call("run_command", { command: "ls" })])).ranTests).toBe(false);
  });
  it("detects deferred tool loading and scouts", () => {
    expect(deriveSignals(view([call("list_tools", {})])).usedDeferredLoading).toBe(true);
    expect(deriveSignals(view([call("git_diff", {})])).usedDeferredLoading).toBe(true);
    expect(deriveSignals(view([call("read_file", {})])).usedDeferredLoading).toBe(false);
    expect(deriveSignals(view([call("create_sub_agent", {})])).usedScout).toBe(true);
    expect(deriveSignals(view([], [{ id: "t2", title: "scout", state: "done" }])).usedScout).toBe(true);
    expect(deriveSignals(undefined)).toEqual({ ranTests: false, usedDeferredLoading: false, usedScout: false });
  });
});

describe("summary counts provider failures separately", () => {
  const base: RunReport = {
    runId: "x", date: "d", task: "b", model: "m", accept: "all", pass: true, checks: [{ id: "a", name: "files", pass: true, detail: "" }], seconds: 1, state: "done", modelCalls: 1, toolCalls: {}, filesRead: [],
    keyFilesInContext: [], keyFilesRead: [], contextPaths: [], contextItems: 0, contextTokens: 0, tokens: undefined, finalMessage: "", errors: [], providerError: false, attempts: 1, attemptKinds: ["pass"], ranTests: true, usedDeferredLoading: true, usedScout: false, commands: [], changedFiles: [],
  };
  it("excludes provider-failed runs from per-check rates and reports attempts", () => {
    const reports: RunReport[] = [
      base,
      { ...base, pass: false, checks: [{ id: "a", name: "files", pass: false, detail: "" }], attempts: 2, attemptKinds: ["provider", "agent"] },
      { ...base, pass: false, checks: [{ id: "a", name: "files", pass: false, detail: "" }], providerError: true, attempts: 3, attemptKinds: ["provider", "provider", "provider"] },
    ];
    const s = summarize(reports);
    expect(s).toMatchObject({ runs: 3, passed: 1, agentFailures: 1, providerFailures: 1, attempts: 6, providerAttempts: 4, perCheck: { a: { passed: 1, total: 2 } }, ranTests: 2 });
    const text = formatSummary(reports);
    expect(text).toMatch(/1\/3 runs passed \(1\/2 of the runs that got an answer\)/);
    expect(text).toMatch(/Failures: 1 agent, 1 provider/);
  });
});

describe("context -> edit link", () => {
  it("marks which changed files the retrieval had already surfaced", () => {
    const r = { runId: "r1", changedFiles: ["docs/api.rst", "docs/cli.rst", "src/flask/cli.py"], contextPaths: ["docs/cli.rst", "src/flask/cli.py", "tests/test_cli.py"] };
    expect(contextLink(r)).toEqual([{ file: "docs/api.rst", inContext: false }, { file: "docs/cli.rst", inContext: true }, { file: "src/flask/cli.py", inContext: true }]);
    const text = formatContextLink([r as never]);
    expect(text).toContain("r1: ✗ docs/api.rst, ✓ docs/cli.rst, ✓ src/flask/cli.py  [2/3 surfaced]");
    expect(formatContextLink([{ runId: "r2", changedFiles: [], contextPaths: [] } as never])).toContain("(no files changed)");
  });
});
