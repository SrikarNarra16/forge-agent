import { appendFile, mkdir, readFile } from "node:fs/promises";
import { dirname } from "node:path";

/**
 * Cost guard: every eval attempt appends its token usage here (eval-output/ledger.jsonl, gitignored), so the
 * running total survives across invocations. The runner stops when a limit would be exceeded.
 */

/** Dollar-based guard (the user's DeepSeek bill: about 7 cents per million tokens; we assume 8 to stay on the safe side). */
export const USD_PER_MILLION_TOKENS = 0.08;
export const DEFAULT_SPEND_LIMIT_USD = 3;
/** No attempt or token cap by default (the iteration and run counts are set by the task); --run-limit / --token-limit add one. */
export const DEFAULT_RUN_LIMIT = Number.POSITIVE_INFINITY;
export const DEFAULT_TOKEN_LIMIT = Number.POSITIVE_INFINITY;

export function estimatedSpendUsd(totalTokens: number, pricePerMillion = USD_PER_MILLION_TOKENS): number {
  return (totalTokens / 1_000_000) * pricePerMillion;
}

export const formatUsd = (usd: number): string => `$${usd.toFixed(2)}`;

export interface LedgerEntry {
  runId: string;
  task: string;
  model: string;
  attempt: number;
  input: number;
  output: number;
  at: string;
  /** Why an entry was corrected after the fact (the ledger is otherwise append-only). */
  note?: string;
}

export interface LedgerTotals {
  /** Attempts that got a real model answer (used tokens). Provider failures with no tokens do not count. */
  attempts: number;
  /** Attempts that failed on the provider without using any tokens (logged, not counted against the cap). */
  providerFailures: number;
  input: number;
  output: number;
  total: number;
}

export function totalsOf(entries: readonly LedgerEntry[]): LedgerTotals {
  const input = entries.reduce((n, e) => n + e.input, 0);
  const output = entries.reduce((n, e) => n + e.output, 0);
  const real = entries.filter((e) => e.input + e.output > 0);
  return { attempts: real.length, providerFailures: entries.length - real.length, input, output, total: input + output };
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
export function checkLimits(totals: LedgerTotals, limits: { tokens?: number; runs?: number; usd?: number }): LimitCheck {
  const spend = estimatedSpendUsd(totals.total);
  if (limits.usd !== undefined && spend >= limits.usd) {
    return { ok: false, reason: `SPEND LIMIT: estimated ${formatUsd(spend)} spent so far (${totals.total.toLocaleString("en-US")} tokens at ${formatUsd(USD_PER_MILLION_TOKENS)} per million; limit ${formatUsd(limits.usd)}). Stop and ask before continuing.` };
  }
  if (limits.tokens !== undefined && totals.total >= limits.tokens) return { ok: false, reason: `TOKEN LIMIT: ${totals.total.toLocaleString("en-US")} tokens used so far (limit ${limits.tokens.toLocaleString("en-US")}). Stop and ask before continuing.` };
  if (limits.runs !== undefined && totals.attempts >= limits.runs) return { ok: false, reason: `RUN LIMIT: ${totals.attempts} eval attempts so far (limit ${limits.runs}). Stop and ask before continuing.` };
  return { ok: true };
}
