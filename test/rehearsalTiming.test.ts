import { describe, expect, it } from "vitest";
import { autoAllowedInWindow, formatTimingTable, parseForgeLog, timingRow } from "../e2e/ui/timing";

const LOG = [
  "2026-11-04T11:00:00.000Z [info] > Add a built-in CLI command",
  "2026-11-04T11:00:05.000Z [info]   tool call read_file({\"path\":\"src/flask/cli.py\"})",
  "2026-11-04T11:00:06.100Z [info] run_command auto-allowed (tier 1: read-only, git status): git status",
  "2026-11-04T11:00:20.000Z [info] run_command auto-allowed (tier 2: tests, pytest): pytest -q",
  "2026-11-04T11:05:00.000Z [info] run_command auto-allowed (tier 1: read-only, ls): ls", // a later task
  "not a log line",
].join("\n");

describe("rehearsal timing report", () => {
  const lines = parseForgeLog(LOG);

  it("parses only well-formed log lines", () => {
    expect(lines).toHaveLength(5);
    expect(lines[0]).toEqual({ at: Date.parse("2026-11-04T11:00:00.000Z"), msg: "> Add a built-in CLI command" });
  });

  it("counts auto-allowed commands inside a task window only", () => {
    expect(autoAllowedInWindow(lines, Date.parse("2026-11-04T10:59:58.000Z"), Date.parse("2026-11-04T11:01:00.000Z"))).toBe(2);
    expect(autoAllowedInWindow(lines, Date.parse("2026-11-04T11:04:00.000Z"), Date.parse("2026-11-04T11:06:00.000Z"))).toBe(1);
  });

  it("derives the two gaps and the totals", () => {
    const sentAt = Date.parse("2026-11-04T11:00:00.000Z");
    const row = timingRow("Task B", { sentAt, firstDiffAt: sentAt + 42_000, verifiedAt: sentAt + 100_000, verifyMs: 8_000 }, { modelCalls: 5, toolCalls: 3, tokens: 5250, autoAllowed: 1 }, 2);
    expect(row).toMatchObject({ task: "Task B", toDiff: 42, diffToVerified: 58, verify: 8, total: 100, modelCalls: 5, toolCalls: 3, tokens: 5250, autoAllowed: 1, clicks: 2, lensRetries: 0 });
    expect(timingRow("Task B", { sentAt, verifiedAt: sentAt + 1000, verifyMs: 0 }, { modelCalls: 0, toolCalls: 0, tokens: 0, autoAllowed: 0 }, 0, 1).lensRetries).toBe(1);
  });

  it("says n/a, not a made-up number, when no diff was ever seen", () => {
    const row = timingRow("Task X", { sentAt: 0, verifiedAt: 5_000, verifyMs: 1_000 }, { modelCalls: 0, toolCalls: 0, tokens: 0, autoAllowed: 0 }, 0);
    expect(row.toDiff).toBeUndefined();
    expect(formatTimingTable([row])).toContain("n/a");
  });

  it("sums the rows, so the 'uncuttable' total is the sum of the instruction->diff gaps", () => {
    const mk = (task: string, gap: number, rest: number) => timingRow(task, { sentAt: 0, firstDiffAt: gap * 1000, verifiedAt: (gap + rest) * 1000, verifyMs: 1000 }, { modelCalls: 1, toolCalls: 2, tokens: 15, autoAllowed: 0 }, 0);
    const table = formatTimingTable([mk("A", 5, 10), mk("B", 40, 60), mk("C", 8, 4)]);
    expect(table).toContain("| **A+B+C** | **53.0 s** | **74.0 s** |");
    expect(table).toContain("**127.0 s**");
  });
});

import { sumUsage } from "../e2e/ui/usage";

describe("token count from TrueForge session records", () => {
  it("sums only the sessions of this run's agent prefix, including a turn that never finished its work", () => {
    const sessions = [
      { id: "s1", agent: { name: "e2e-39134-forge-inline" } },
      { id: "s2", agent: { name: "e2e-39134-forge-agent" } },
      { id: "s3", agent: { name: "forge-agent" } }, // the user's own resources: never counted
      { id: "s4", agent: { name: "e2e-1-forge-agent" } }, // another run
    ];
    const turns = new Map([
      ["s1", [{ state: { metrics: { total_input_tokens: 2689, total_output_tokens: 382 } } }]],
      ["s2", [{ state: { metrics: { total_input_tokens: 1000, total_output_tokens: 100 } } }, { state: {} }]],
      ["s3", [{ state: { metrics: { total_input_tokens: 999999, total_output_tokens: 1 } } }]],
    ]);
    expect(sumUsage(sessions, "e2e-39134-", turns)).toEqual({ sessions: 2, turns: 3, input: 3689, output: 482 });
  });
});

import { commandReport, commandsInWindow } from "../e2e/ui/timing";

describe("which commands asked, and why", () => {
  const log = parseForgeLog(
    [
      '2026-11-04T11:00:01.000Z [info]   tool call run_command({"command":"git status"})',
      "2026-11-04T11:00:01.100Z [info] run_command auto-allowed (tier 1: read-only, git status): git status",
      '2026-11-04T11:00:02.000Z [info]   tool call run_command({"command":"python -m pytest tests/test_cli.py -q 2>&1 | tail -10"})',
      '2026-11-04T11:00:03.000Z [info]   tool call run_command({"command":"python -m pytest tests/test_cli.py -q"})',
      "2026-11-04T11:00:03.100Z [info] run_command auto-allowed (tier 2: tests, pytest): python -m pytest tests/test_cli.py -q",
      '2026-11-04T11:00:04.000Z [info]   tool call run_command({"command":"flask --help"})',
    ].join("\n"),
  );
  it("marks each run_command call auto-allowed or not", () => {
    const records = commandsInWindow(log, 0, Date.parse("2026-11-04T12:00:00Z"));
    expect(records.map((r) => [r.command, r.auto])).toEqual([
      ["git status", true],
      ["python -m pytest tests/test_cli.py -q 2>&1 | tail -10", false],
      ["python -m pytest tests/test_cli.py -q", true],
      ["flask --help", false],
    ]);
  });
  it("explains why the others asked, without changing any rule", () => {
    const records = commandsInWindow(log, 0, Date.parse("2026-11-04T12:00:00Z"));
    const text = commandReport(records, () => false);
    expect(text).toBe("4 run_command call(s): 2 auto-allowed, 2 asked (50%) - why they asked: 1 x pipe or redirect (e.g. `2>&1 | tail`); 1 x program, option or path not on the allow-list");
  });
});

import { sessionsInWindow, summarizeEvents } from "../e2e/ui/usage";

describe("what TrueForge's events say", () => {
  it("counts model messages and tool responses, and extracts the commands of run_command calls only", () => {
    const sum = summarizeEvents([
      { type: "turn.created" },
      { type: "model.message", tool_calls: [{ function: { name: "read_file", arguments: '{"path":"a.py"}' } }, { function: { name: "run_command", arguments: '{"command": "pytest -q 2>&1 | tail -5", "timeout_s": 300}' } }] },
      { type: "tool.response" },
      { type: "tool.response" },
      { type: "model.message", tool_calls: [{ function: { name: "run_command", arguments: "not json" } }] },
      { type: "model.message" },
    ]);
    expect(sum).toEqual({ modelMessages: 3, toolResponses: 2, commands: ["pytest -q 2>&1 | tail -5"] });
  });

  it("assigns a session to the task during which it was created", () => {
    const d = (id: string, at: string) => ({ id, agent: "x", createdAt: Date.parse(at), turns: 1, input: 1, output: 1, modelMessages: 0, toolResponses: 0, commands: [] });
    const all = [d("a", "2026-11-04T11:49:56Z"), d("b", "2026-11-04T11:50:02Z"), d("c", "2026-11-04T11:52:00Z")];
    const ids = (from: string, to: string) => sessionsInWindow(all, Date.parse(from), Date.parse(to)).map((x) => x.id);
    expect(ids("2026-11-04T11:49:55Z", "2026-11-04T11:50:00Z")).toEqual(["a"]);
    expect(ids("2026-11-04T11:50:01Z", "2026-11-04T11:51:59Z")).toEqual(["b"]);
    expect(ids("2026-11-04T11:51:59Z", "2026-11-04T11:52:10Z")).toEqual(["c"]);
  });
});
