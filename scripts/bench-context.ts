/**
 * Retrieval benchmark: builds the REAL context index over fixtures/flask on disk (read-only) and runs the
 * queries in test/context-bench.json through the REAL retrieval pipeline at the default 6000-token budget.
 *
 *   npx tsx scripts/bench-context.ts [--verbose] [--budget 6000]
 *
 * Prints index build time, chunk count, per-query hit/rank/latency, the top-3 hit rate (tuned and held-out
 * separately), whether Task B's cli.py, tests/test_cli.py and docs/cli.rst are all in the top 8, and retrieval
 * latency. Exit code 1 if a target is missed.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { ContextIndex } from "../src/context/indexer";
import { retrieve } from "../src/context/retrieval";
import { DiskHost } from "./diskHost";

interface Expect {
  path: string;
  symbol?: string;
}
interface BenchQuery {
  id: string;
  tuned: boolean;
  query: string;
  mode: "any-top3" | "all-in-top8";
  /** false = reported but not counted in the hit rate (a documented limitation). */
  countInRate?: boolean;
  expect: Expect[];
  note?: string;
}
interface Bench {
  targets: { buildMs: number; top3HitsOfTwelveEquivalent: number; retrievalMs: number };
  queries: BenchQuery[];
}

const FIXTURE = join(__dirname, "..", "..", "fixtures", "flask");

function matches(item: { path: string; symbol?: string | undefined }, e: Expect): boolean {
  if (item.path !== e.path) return false;
  if (!e.symbol) return true;
  const s = item.symbol ?? "";
  return s === e.symbol || s.startsWith(`${e.symbol}.`);
}

function percentile(sorted: number[], p: number): number {
  return sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))] ?? 0;
}

async function main(): Promise<void> {
  const verbose = process.argv.includes("--verbose");
  const brief = process.argv.includes("--brief"); // only misses and the summary
  const budgetArg = process.argv.indexOf("--budget");
  const budget = budgetArg >= 0 ? Number(process.argv[budgetArg + 1]) : 6000;
  const bench = JSON.parse(await readFile(join(__dirname, "..", "test", "context-bench.json"), "utf8")) as Bench;

  const host = new DiskHost(FIXTURE);
  const index = new ContextIndex();
  const stats = await index.build(host);
  const rebuilds: number[] = [];
  for (let i = 0; i < 2; i++) rebuilds.push((await new ContextIndex().build(host)).buildMs);
  console.log(`Index: ${stats.files} files, ${stats.chunks} chunks, ~${stats.tokens || [...index.allChunks()].reduce((n, c) => n + c.tokens, 0)} tokens of text`);
  console.log(`Index build: cold ${stats.buildMs.toFixed(0)} ms, warm rebuilds ${rebuilds.map((r) => r.toFixed(0)).join(" / ")} ms (target < ${bench.targets.buildMs} ms); skipped large ${stats.skippedLarge}, unreadable ${stats.skippedUnreadable}, truncated ${stats.truncated}\n`);

  const latencies: number[] = [];
  const results: Array<{ q: BenchQuery; hit: boolean; rank: number | undefined; ms: number; top: string[] }> = [];
  for (const q of bench.queries) {
    retrieve(index, { query: q.query, budgetTokens: budget }); // warm-up
    const runs = Array.from({ length: 5 }, () => retrieve(index, { query: q.query, budgetTokens: budget }));
    const ms = runs.map((r) => r.timing.totalMs).sort((a, b) => a - b)[2] ?? 0; // median of 5
    latencies.push(ms);
    const items = (runs[0]?.plan.items ?? []).filter((i) => i.source === "auto");
    const window = q.mode === "all-in-top8" ? items.slice(0, 8) : items.slice(0, 3);
    const hit = q.mode === "all-in-top8" ? q.expect.every((e) => window.some((i) => matches(i, e))) : window.some((i) => q.expect.some((e) => matches(i, e)));
    const rankIdx = items.findIndex((i) => q.expect.some((e) => matches(i, e)));
    results.push({ q, hit, rank: rankIdx >= 0 ? rankIdx + 1 : undefined, ms, top: items.slice(0, verbose ? 8 : 3).map((i) => `${i.path}${i.symbol ? `:${i.symbol}` : ""}`) });
  }

  for (const r of results.filter((x) => !brief || !x.hit)) {
    console.log(`${r.hit ? "HIT " : "MISS"} ${r.q.countInRate === false ? "known   " : r.q.tuned ? "tuned   " : "heldout "} ${r.q.id.padEnd(20)} first-match rank ${String(r.rank ?? "-").padStart(2)}  ${r.ms.toFixed(1).padStart(5)} ms`);
    console.log(`       "${r.q.query.slice(0, 90)}${r.q.query.length > 90 ? "…" : ""}"`);
    for (const t of r.top) console.log(`         - ${t}`);
  }

  const tuned = results.filter((r) => r.q.tuned && r.q.countInRate !== false);
  const held = results.filter((r) => !r.q.tuned);
  const tunedHits = tuned.filter((r) => r.hit).length;
  const heldHits = held.filter((r) => r.hit).length;
  const taskB = results.find((r) => r.q.id === "task-b");
  const sorted = [...latencies].sort((a, b) => a - b);
  const needed = Math.ceil((bench.targets.top3HitsOfTwelveEquivalent / 12) * tuned.length);

  console.log("\n==== SUMMARY ====");
  console.log(`index build (cold)      ${stats.buildMs.toFixed(0)} ms          target < ${bench.targets.buildMs} ms      ${stats.buildMs < bench.targets.buildMs ? "OK" : "MISSED"}`);
  console.log(`top-3 hit rate (tuned)  ${tunedHits}/${tuned.length}              target >= ${needed}/${tuned.length} (= 10/12)   ${tunedHits >= needed ? "OK" : "MISSED"}`);
  console.log(`top-3 hit rate (held out) ${heldHits}/${held.length}            (not used for tuning)`);
  console.log(`Task B cli.py + tests/test_cli.py + docs/cli.rst in top 8   ${taskB?.hit ? "OK" : "MISSED"}`);
  console.log(`retrieval latency       median ${percentile(sorted, 0.5).toFixed(1)} ms, p95 ${percentile(sorted, 0.95).toFixed(1)} ms, max ${(sorted.at(-1) ?? 0).toFixed(1)} ms   target < ${bench.targets.retrievalMs} ms   ${(sorted.at(-1) ?? 0) < bench.targets.retrievalMs ? "OK" : "MISSED"}`);

  const ok = stats.buildMs < bench.targets.buildMs && tunedHits >= needed && Boolean(taskB?.hit) && (sorted.at(-1) ?? 0) < bench.targets.retrievalMs;
  console.log(ok ? "\nALL TARGETS MET" : "\nTARGETS NOT MET");
  process.exitCode = ok ? 0 : 1;
}

main().catch((err: unknown) => {
  console.error(err);
  process.exit(1);
});
