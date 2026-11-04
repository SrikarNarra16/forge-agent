import { describe, expect, it } from "vitest";
import { countInWindow, formatTimingTable, parseForgeLog, timingRow } from "../e2e/ui/timing";

const LOG = [
  "2026-11-04T11:00:00.000Z [info] > Add a built-in CLI command",
  "2026-11-04T11:00:05.000Z [info]   tool call read_file({\"path\":\"src/flask/cli.py\"})",
  "2026-11-04T11:00:06.000Z [info]   tool call run_command({\"command\":\"git status\"})",
  "2026-11-04T11:00:06.100Z [info] run_command auto-allowed (tier 1: read-only, git status): git status",
  "2026-11-04T11:00:09.000Z [info]   usage: 2 model call(s), 1,000 input tokens, 50 output tokens", // not matching: the real line has no thousands separator
  "2026-11-04T11:00:09.500Z [info]   usage: 2 model call(s), 1000 input tokens, 50 output tokens",
  "2026-11-04T11:00:20.000Z [info]   tool call propose_edit({\"path\":\"a.py\"})",
  "2026-11-04T11:00:30.000Z [info]   usage: 3 model call(s), 4000 input tokens, 200 output tokens",
  "2026-11-04T11:05:00.000Z [info]   tool call read_file({})", // a later task
  "not a log line",
].join("\n");

describe("rehearsal timing report", () => {
  const lines = parseForgeLog(LOG);

  it("parses only well-formed log lines", () => {
    expect(lines).toHaveLength(9);
    expect(lines[0]).toEqual({ at: Date.parse("2026-11-04T11:00:00.000Z"), msg: "> Add a built-in CLI command" });
  });

  it("counts model calls, tool calls, tokens and auto-allowed commands inside a task window only", () => {
    const c = countInWindow(lines, Date.parse("2026-11-04T10:59:58.000Z"), Date.parse("2026-11-04T11:01:00.000Z"));
    expect(c).toEqual({ modelCalls: 5, toolCalls: 3, inputTokens: 5000, outputTokens: 250, autoAllowed: 1 });
    const later = countInWindow(lines, Date.parse("2026-11-04T11:04:00.000Z"), Date.parse("2026-11-04T11:06:00.000Z"));
    expect(later.toolCalls).toBe(1);
  });

  it("derives the two gaps and the totals", () => {
    const sentAt = Date.parse("2026-11-04T11:00:00.000Z");
    const row = timingRow("Task B", { sentAt, firstDiffAt: sentAt + 42_000, verifiedAt: sentAt + 100_000, verifyMs: 8_000 }, { modelCalls: 5, toolCalls: 3, inputTokens: 5000, outputTokens: 250, autoAllowed: 1 }, 2);
    expect(row).toMatchObject({ task: "Task B", toDiff: 42, diffToVerified: 58, verify: 8, total: 100, modelCalls: 5, toolCalls: 3, tokens: 5250, autoAllowed: 1, clicks: 2 });
  });

  it("says n/a, not a made-up number, when no diff was ever seen", () => {
    const row = timingRow("Task X", { sentAt: 0, verifiedAt: 5_000, verifyMs: 1_000 }, { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, autoAllowed: 0 }, 0);
    expect(row.toDiff).toBeUndefined();
    expect(formatTimingTable([row])).toContain("n/a");
  });

  it("sums the rows, so the 'uncuttable' total is the sum of the instruction->diff gaps", () => {
    const mk = (task: string, gap: number, rest: number) => timingRow(task, { sentAt: 0, firstDiffAt: gap * 1000, verifiedAt: (gap + rest) * 1000, verifyMs: 1000 }, { modelCalls: 1, toolCalls: 2, inputTokens: 10, outputTokens: 5, autoAllowed: 0 }, 0);
    const table = formatTimingTable([mk("A", 5, 10), mk("B", 40, 60), mk("C", 8, 4)]);
    expect(table).toContain("| **A+B+C** | **53.0 s** | **74.0 s** |");
    expect(table).toContain("**127.0 s**");
  });
});
