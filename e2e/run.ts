/**
 * End-to-end runner (Layer 1): the REAL extension inside a REAL VS Code, driven from the extension host.
 *
 *   npm run test:e2e                 hermetic scenarios only (no model, no spend)
 *   E2E_LIVE=1 npm run test:e2e      also the live scenarios (real TrueForge + model; estimated spend printed)
 *   E2E_ONLY=3,10 npm run test:e2e   a subset;   VSCODE_EXE=/path/to/Code   another VS Code
 *
 * Isolation (e2e/env.ts): temp --user-data-dir and --extensions-dir (your VS Code profile is never read), a temp
 * `git clone --local` of fixtures/flask at the pinned commit as the workspace, TrueForge resources named
 * e2e-<pid>-forge-* (name guard, snapshot before/after, cleanup on every exit path). docs/e2e.md has the details.
 */
import { existsSync } from "node:fs";
import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runTests } from "@vscode/test-electron";
import * as esbuild from "esbuild";
import { snapshotDiff } from "../scripts/eval/guard";
import { DEFAULT_SPEND_LIMIT_USD, USD_PER_MILLION_TOKENS, appendLedger, checkLimits, estimatedSpendUsd, formatUsd, readLedger, totalsOf } from "../scripts/eval/ledger";
import { describeError } from "../src/trueforge/client";
import type { E2eConfig, ScenarioResult } from "./common";
import { BASE_URL, ROOT, createEnvironment, snapshotTrueForge, vscodeExecutable } from "./env";
import { fetchSessionDetails, type SessionDetail } from "./ui/usage";

const LIVE_BUDGET_USD = 0.6;
const ESTIMATED_LIVE_TOKENS = 1_500_000; // one full live pass: Task A x3-4 (~10k each) + Task B x3 (~0.5-1.4M each)

function table(results: readonly ScenarioResult[]): string {
  const rows = results.map((r) => `| ${r.id} | ${r.status} | ${r.live ? "live" : "hermetic"} | ${(r.ms / 1000).toFixed(1)} s | ${r.name} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 260)} |`);
  return ["| # | Result | Kind | Time | Scenario | Detail |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

async function main(): Promise<number> {
  const live = process.env["E2E_LIVE"] === "1";
  const exe = vscodeExecutable();
  const out = join(ROOT, "e2e-output");
  await mkdir(join(out, "scenarios"), { recursive: true });
  let env: Awaited<ReturnType<typeof createEnvironment>> | undefined;

  try {
    if (live) {
      const totals = totalsOf(await readLedger(join(ROOT, "eval-output", "ledger.jsonl")));
      const gate = checkLimits(totals, { usd: DEFAULT_SPEND_LIMIT_USD });
      console.log(
        `Live pass: estimated cost about ${ESTIMATED_LIVE_TOKENS.toLocaleString("en-US")} tokens = ${formatUsd(estimatedSpendUsd(ESTIMATED_LIVE_TOKENS))} (limit for one pass ${formatUsd(LIVE_BUDGET_USD)}; running total so far ${formatUsd(estimatedSpendUsd(totals.total))} of ${formatUsd(DEFAULT_SPEND_LIMIT_USD)}, $${USD_PER_MILLION_TOKENS}/M tokens)`,
      );
      if (!gate.ok) {
        console.error(gate.reason);
        return 4;
      }
    }
    const before = live ? await snapshotTrueForge() : undefined;
    if (live && !before) throw new Error(`TrueForge is not reachable at ${BASE_URL}; start it with npm run tf:start`);

    env = await createEnvironment();
    const current = env;
    const prefix = current.prefix;
    const ws = current.workspace;

    // bundle the suite for the extension host
    const suiteFile = join(current.temp, "suite.js");
    await esbuild.build({ entryPoints: [join(ROOT, "e2e", "suite", "index.ts")], bundle: true, platform: "node", format: "cjs", external: ["vscode"], outfile: suiteFile, logLevel: "silent" });

    const runSuite = async (suite: E2eConfig["suite"], hooks: boolean): Promise<ScenarioResult[]> => {
      const resultFile = join(current.temp, `result-${suite}.json`);
      const cfg: E2eConfig = { workspace: ws.root, python: ws.python, repoRoot: ROOT, prefix, live, only: process.env["E2E_ONLY"], resultFile, outDir: out, baseUrl: BASE_URL, userDataDir: current.userData, liveBudgetUsd: LIVE_BUDGET_USD, suite };
      const cfgFile = join(current.temp, `config-${suite}.json`);
      await writeFile(cfgFile, JSON.stringify(cfg), "utf8");
      const testEnv: Record<string, string> = { E2E_CONFIG: cfgFile, FORGE_RESOURCE_PREFIX: prefix };
      if (hooks) testEnv["FORGE_E2E"] = "1";
      try {
        await runTests({ vscodeExecutablePath: exe, extensionDevelopmentPath: ROOT, extensionTestsPath: suiteFile, launchArgs: current.launchArgs, extensionTestsEnv: testEnv });
      } catch (err) {
        console.error(`VS Code exited with a failure (${describeError(err)}); reading whatever results were written`);
      }
      try {
        return JSON.parse(await readFile(resultFile, "utf8")) as ScenarioResult[];
      } catch {
        return [{ id: suite === "nohooks" ? "0" : "-", name: `${suite} suite`, live: false, status: "FAIL", ms: 0, detail: "no result file was written (VS Code did not start the suite)" }];
      }
    };

    const results: ScenarioResult[] = [...(await runSuite("nohooks", false)), ...(await runSuite("scenarios", true))];

    // token cost of the live scenarios -> the shared ledger and the per-pass dollar guard. TrueForge's own session records of this
    // run's resources are the source of truth and are used when readable; the scenarios' recorder numbers are kept as a cross-check
    // (they agreed exactly on 8 Nov 2026: 604,057 tokens both ways).
    let records: SessionDetail[] = [];
    if (live) records = await fetchSessionDetails(BASE_URL, prefix).catch((err: unknown) => (console.error(`could not read TrueForge's session records: ${describeError(err)}`), []));
    const recorded = records.reduce((n, d) => n + d.input + d.output, 0);
    const reported = results.filter((r) => r.live && r.status !== "SKIP").reduce((n, r) => n + (typeof r.data?.["tokens"] === "number" ? (r.data["tokens"] as number) : 0), 0);
    const liveTokens = records.length > 0 ? recorded : reported;
    if (live && records.length > 0) {
      const sum = (f: (d: SessionDetail) => number): number => records.reduce((n, d) => n + f(d), 0);
      console.log(`TrueForge records of this live pass: ${records.length} session(s), ${sum((d) => d.turns)} turn(s), ${sum((d) => d.modelMessages)} model message(s), ${sum((d) => d.toolResponses)} tool call(s), ${recorded.toLocaleString("en-US")} tokens (the scenarios' own recorder reported ${reported.toLocaleString("en-US")})`);
      await writeFile(join(out, "layer1-live-records.json"), JSON.stringify(records, null, 2), "utf8");
    }
    if (liveTokens > 0) await appendLedger(join(ROOT, "eval-output", "ledger.jsonl"), { runId: `e2e-${process.pid}`, task: "e2e", model: "deepseek/*", attempt: 1, input: liveTokens, output: 0, at: new Date().toISOString() });

    if (live) {
      const after = await snapshotTrueForge();
      if (after) {
        const leftovers = snapshotDiff(before!, after);
        const unexpected = leftovers.filter((d) => !d.includes(`:${prefix}`));
        console.log(unexpected.length > 0 ? `WARNING: TrueForge resources changed outside the ${prefix} prefix: ${unexpected.join(", ")}` : `Only ${prefix}-prefixed resources were added (${leftovers.length}); they are deleted next.`);
      }
    }

    for (const r of results) await writeFile(join(out, "scenarios", `${r.id}.json`), JSON.stringify(r, null, 2), "utf8");
    await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2), "utf8");
    console.log(`\n${table(results)}\n`);
    if (live) console.log(`Estimated spend of this live pass: ${formatUsd(estimatedSpendUsd(liveTokens))} (${liveTokens.toLocaleString("en-US")} tokens counted)`);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const header = existsSync(join(ROOT, "docs", "e2e-results.md")) ? "" : "# End-to-end results\n\nOne block per run of `npm run test:e2e` (docs/e2e.md). Hermetic = no model; live = real TrueForge + model.\n\n";
    await appendFile(join(ROOT, "docs", "e2e-results.md"), `${header}## ${stamp} (${live ? "live" : "hermetic"} run, pid ${process.pid})\n\n${table(results)}\n\n`, "utf8");
    return results.some((r) => r.status === "FAIL") ? 1 : 0;
  } finally {
    await env?.cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`e2e runner failed: ${describeError(err)}`);
    process.exit(2);
  },
);
