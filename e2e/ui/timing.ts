/**
 * Timing report of the rehearsal (pure, so it is unit-tested): the driver records WHEN things happened (instruction
 * sent, first diff visible, result verified); the Forge output log says WHAT happened in between (model calls, tool
 * calls, tokens, commands that were auto-allowed). Log lines are `<ISO time> [level] message` (src/util/log.ts).
 */
export interface LogLine {
  at: number;
  msg: string;
}

export function parseForgeLog(text: string): LogLine[] {
  const out: LogLine[] = [];
  for (const line of text.split("\n")) {
    const m = /^(\d{4}-\d{2}-\d{2}T[\d:.]+Z) \[\w+\] (.*)$/.exec(line);
    if (m) out.push({ at: Date.parse(m[1] as string), msg: m[2] as string });
  }
  return out;
}

export interface LogCounts {
  modelCalls: number;
  toolCalls: number;
  inputTokens: number;
  outputTokens: number;
  autoAllowed: number;
}

/** Counts what the log says happened in [from, to] (epoch ms, inclusive). */
export function countInWindow(lines: readonly LogLine[], from: number, to: number): LogCounts {
  const c: LogCounts = { modelCalls: 0, toolCalls: 0, inputTokens: 0, outputTokens: 0, autoAllowed: 0 };
  for (const { at, msg } of lines) {
    if (at < from || at > to) continue;
    if (msg.startsWith("  tool call ")) c.toolCalls++;
    else if (msg.startsWith("run_command auto-allowed (tier")) c.autoAllowed++;
    else {
      const u = /^ {2}usage: (\d+) model call\(s\), (\d+) input tokens, (\d+) output tokens$/.exec(msg);
      if (u) {
        c.modelCalls += Number(u[1]);
        c.inputTokens += Number(u[2]);
        c.outputTokens += Number(u[3]);
      }
    }
  }
  return c;
}

export interface TaskTimes {
  sentAt: number;
  firstDiffAt?: number;
  verifiedAt: number;
  verifyMs: number;
}

export interface TimingRow {
  task: string;
  /** Instruction submitted -> first diff visible (seconds); undefined when no diff was ever seen. */
  toDiff?: number;
  /** First diff visible -> result verified (seconds); includes the driver's clicks and the verify script. */
  diffToVerified?: number;
  verify: number;
  total: number;
  modelCalls: number;
  toolCalls: number;
  tokens: number;
  autoAllowed: number;
  clicks: number;
}

export function timingRow(task: string, t: TaskTimes, counts: LogCounts, commandClicks: number): TimingRow {
  return {
    task,
    ...(t.firstDiffAt !== undefined ? { toDiff: (t.firstDiffAt - t.sentAt) / 1000, diffToVerified: (t.verifiedAt - t.firstDiffAt) / 1000 } : {}),
    verify: t.verifyMs / 1000,
    total: (t.verifiedAt - t.sentAt) / 1000,
    modelCalls: counts.modelCalls,
    toolCalls: counts.toolCalls,
    tokens: counts.inputTokens + counts.outputTokens,
    autoAllowed: counts.autoAllowed,
    clicks: commandClicks,
  };
}

const s = (n: number | undefined): string => (n === undefined ? "n/a" : `${n.toFixed(1)} s`);

export function formatTimingTable(rows: readonly TimingRow[]): string {
  const sum = (f: (r: TimingRow) => number | undefined): number => rows.reduce((n, r) => n + (f(r) ?? 0), 0);
  const body = rows.map((r) => `| ${r.task} | ${s(r.toDiff)} | ${s(r.diffToVerified)} | ${s(r.verify)} | ${s(r.total)} | ${r.modelCalls} | ${r.toolCalls} | ${r.tokens.toLocaleString("en-US")} | ${r.autoAllowed} | ${r.clicks} |`);
  const total = `| **A+B+C** | **${s(sum((r) => r.toDiff))}** | **${s(sum((r) => r.diffToVerified))}** | ${s(sum((r) => r.verify))} | **${s(sum((r) => r.total))}** | ${sum((r) => r.modelCalls)} | ${sum((r) => r.toolCalls)} | ${sum((r) => r.tokens).toLocaleString("en-US")} | ${sum((r) => r.autoAllowed)} | ${sum((r) => r.clicks)} |`;
  return [
    "| Task | Instruction -> first diff | First diff -> verified | (of which verify script) | Instruction -> verified | Model calls | Tool calls | Tokens | Commands auto-allowed | Allow clicks |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...body,
    total,
  ].join("\n");
}
