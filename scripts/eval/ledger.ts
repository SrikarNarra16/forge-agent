import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Cost guard: every eval attempt appends its token usage here (eval-output/ledger.jsonl, gitignored), so the
 * running total survives across invocations. The runner stops when a limit would be exceeded.
 */
export const DEFAULT_TOKEN_LIMIT = 4_000_000;
export const DEFAULT_RUN_LIMIT = 40;

export interface LedgerEntry {
  runId: string;
  task: string;
  model: string;
  attempt: number;
  input: number;
  output: number;
  at: string;
}

export interface LedgerTotals {
  attempts: number;
  input: number;
  output: number;
  total: number;
}

export function totalsOf(entries: readonly LedgerEntry[]): LedgerTotals {
  const input = entries.reduce((n, e) => n + e.input, 0);
  const output = entries.reduce((n, e) => n + e.output, 0);
  return { attempts: entries.length, input, output, total: input + output };
}

export async function readLedger(file: string): Promise<LedgerEntry[]> {
  let text = "";
  try {
    text = await readFile(file, "utf8");
  } catch {
    return [];
  }
  return text.split("\n").filter(Boolean).flatMap((line) => {
    try {
      return [JSON.parse(line) as LedgerEntry];
    } catch {
      return [];
    }
  });
}

export async function appendLedger(file: string, entry: LedgerEntry): Promise<void> {
  await mkdir(dirname(file), { recursive: true });
  await appendFile(file, `${JSON.stringify(entry)}\n`, "utf8");
}

export type LimitCheck = { ok: true } | { ok: false; reason: string };

/** Whether another attempt may start. */
export function checkLimits(totals: LedgerTotals, limits: { tokens: number; runs: number }): LimitCheck {
  if (totals.total >= limits.tokens) return { ok: false, reason: `TOKEN LIMIT: ${totals.total.toLocaleString("en-US")} tokens used so far (limit ${limits.tokens.toLocaleString("en-US")}). Stop and ask before continuing.` };
  if (totals.attempts >= limits.runs) return { ok: false, reason: `RUN LIMIT: ${totals.attempts} eval attempts so far (limit ${limits.runs}). Stop and ask before continuing.` };
  return { ok: true };
}
