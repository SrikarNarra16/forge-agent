/**
 * End-to-end runner (Layer 1): the REAL extension inside a REAL VS Code, driven from the extension host.
 *
 *   npm run test:e2e                 hermetic scenarios only (no model, no spend)
 *   E2E_LIVE=1 npm run test:e2e      also the live scenarios (real TrueForge + model; estimated spend printed)
 *   E2E_ONLY=3,10 npm run test:e2e   a subset;   VSCODE_EXE=/path/to/Code   another VS Code
 *
 * Isolation: temp --user-data-dir and --extensions-dir (your VS Code profile is never read), a temp `git clone --local`
 * of fixtures/flask at the pinned commit as the workspace, TrueForge resources named e2e-<pid>-forge-* (name guard,
 * snapshot before/after, cleanup on every exit path). docs/e2e.md has the details.
 */
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import * as esbuild from "esbuild";
import { runTests } from "@vscode/test-electron";
import { createClient, describeError } from "../src/trueforge/client";
import { assertThrowaway, snapshotDiff, type Snapshot } from "../scripts/eval/guard";
import { DEFAULT_SPEND_LIMIT_USD, USD_PER_MILLION_TOKENS, appendLedger, checkLimits, estimatedSpendUsd, formatUsd, readLedger, totalsOf } from "../scripts/eval/ledger";
import { createWorkspace, type Workspace } from "../scripts/eval/workspace";
import { resourceNames } from "../src/trueforge/resourceNames";
import type { E2eConfig, ScenarioResult } from "./common";

const ROOT = resolve(__dirname, "..");
const DEFAULT_VSCODE = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const LIVE_BUDGET_USD = 0.6;
const ESTIMATED_LIVE_TOKENS = 1_500_000; // one full live pass: Task A x3-4 (~10k each) + Task B x3 (~500k each)

/**
 * The runner may itself be started from a VS Code terminal or extension host. Their environment must not leak into the
 * VS Code we launch: ELECTRON_RUN_AS_NODE would make it run as plain Node, and VSCODE_IPC_HOOK & co. could attach it to
 * (and so disturb) the user's running window.
 */
export function scrubEnvironment(env: NodeJS.ProcessEnv = process.env): string[] {
  const removed: string[] = [];
  for (const key of Object.keys(env)) {
    if (key === "ELECTRON_RUN_AS_NODE" || key.startsWith("VSCODE_") || key === "ELECTRON_NO_ATTACH_CONSOLE") {
      delete env[key];
      removed.push(key);
    }
  }
  return removed;
}

function vscodeExecutable(): string {
  const exe = process.env["VSCODE_EXE"] ?? DEFAULT_VSCODE;
  if (!existsSync(exe)) throw new Error(`VS Code executable not found at ${exe}. Set VSCODE_EXE to your installation's binary (macOS: .../Contents/MacOS/Code).`);
  return exe;
}

async function snapshotTrueForge(): Promise<Snapshot | undefined> {
  const client = createClient(BASE_URL);
  try {
    const agents: string[] = [];
    for await (const a of await client.agents.list({ limit: 100 })) agents.push(a.name);
    return { agents: agents.sort(), mcp: (await client.settings.mcpServers.list()).data.map((m) => m.name).sort() };
  } catch {
    return undefined;
  }
}

/** Deletes every e2e-<pid>- agent, MCP server and session (name guard: nothing else can be touched). */
async function cleanupTrueForge(prefix: string, sessions: readonly string[]): Promise<string[]> {
  const log: string[] = [];
  const client = createClient(BASE_URL);
  const names = resourceNames(prefix);
  try {
    for (const id of sessions) await client.sessions.delete(id).catch(() => undefined);
    for (const agent of [names.agent, names.inline]) {
      assertThrowaway(agent);
      for await (const a of await client.agents.list({ agentName: agent, limit: 100 })) if (a.name === agent) await client.agents.delete(a.id).then(() => log.push(`deleted agent ${agent}`), (e: unknown) => log.push(`could not delete ${agent}: ${describeError(e)}`));
    }
    for (const server of [names.editor, names.extras]) {
      assertThrowaway(server);
      await client.settings.mcpServers.delete(server).then(() => log.push(`deleted MCP server ${server}`), () => undefined);
    }
  } catch (err) {
    log.push(`cleanup problem: ${describeError(err)}`);
  }
  return log;
}

function table(results: readonly ScenarioResult[]): string {
  const rows = results.map((r) => `| ${r.id} | ${r.status} | ${r.live ? "live" : "hermetic"} | ${(r.ms / 1000).toFixed(1)} s | ${r.name} | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 260)} |`);
  return ["| # | Result | Kind | Time | Scenario | Detail |", "|---|---|---|---|---|---|", ...rows].join("\n");
}

async function main(): Promise<number> {
  const scrubbed = scrubEnvironment();
  if (scrubbed.length > 0) console.log(`Removed ${scrubbed.length} inherited VS Code/Electron environment variable(s) so the test instance is fully separate: ${scrubbed.join(", ")}`);
  const live = process.env["E2E_LIVE"] === "1";
  const exe = vscodeExecutable();
  const prefix = `e2e-${process.pid}-`;
  const out = join(ROOT, "e2e-output");
  await mkdir(join(out, "scenarios"), { recursive: true });
  const temp = await mkdtemp(join(tmpdir(), "forge-e2e-"));
  const userData = join(temp, "user-data");
  const extensions = join(temp, "extensions");
  let ws: Workspace | undefined;
  let cleaned = false;
  const sessions: string[] = [];

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const line of await cleanupTrueForge(prefix, sessions)) console.log(`cleanup: ${line}`);
    await ws?.dispose();
    await rm(temp, { recursive: true, force: true });
  };
  const bail = (what: string) => (): void => {
    console.error(`${what}: cleaning up e2e resources`);
    void cleanup().finally(() => process.exit(130));
  };
  process.once("SIGINT", bail("interrupted"));
  process.once("SIGTERM", bail("terminated"));

  try {
    if (live) {
      const ledger = join(out, "..", "eval-output", "ledger.jsonl");
      const totals = totalsOf(await readLedger(ledger));
      const gate = checkLimits(totals, { usd: DEFAULT_SPEND_LIMIT_USD });
      console.log(`Live pass: estimated cost about ${ESTIMATED_LIVE_TOKENS.toLocaleString("en-US")} tokens = ${formatUsd(estimatedSpendUsd(ESTIMATED_LIVE_TOKENS))} (limit for one pass ${formatUsd(LIVE_BUDGET_USD)}; running total so far ${formatUsd(estimatedSpendUsd(totals.total))} of ${formatUsd(DEFAULT_SPEND_LIMIT_USD)}, $${USD_PER_MILLION_TOKENS}/M tokens)`);
      if (!gate.ok) {
        console.error(gate.reason);
        return 4;
      }
    }
    const before = live ? await snapshotTrueForge() : undefined;
    if (live && !before) throw new Error(`TrueForge is not reachable at ${BASE_URL}; start it with npm run tf:start`);

    ws = await createWorkspace(); // clean clone at the pinned commit; `import flask` verified to resolve into the copy
    console.log(`Workspace: ${ws.root}`);
    await mkdir(join(userData, "User"), { recursive: true });
    const venvBin = join(ws.python, "..");
    const settings = {
      "forge.models": ["deepseek/flash", "deepseek/v4-pro"],
      "forge.commandPrefix": `export PATH='${venvBin}':"$PATH" PYTHONPATH='${join(ws.root, "src")}' PYTHONDONTWRITEBYTECODE=1 &&`,
      "forge.resourcePrefix": prefix,
      "forge.rollbackOnCancel": true,
      "forge.trueforge.baseUrl": BASE_URL,
      "telemetry.telemetryLevel": "off",
      "update.mode": "none",
      "extensions.autoUpdate": false,
      "extensions.autoCheckUpdates": false,
      "security.workspace.trust.enabled": false,
      "workbench.startupEditor": "none",
      "workbench.tips.enabled": false,
      "chat.disableAIFeatures": true,
      "window.restoreWindows": "none",
      "files.autoSave": "off",
    };
    await writeFile(join(userData, "User", "settings.json"), JSON.stringify(settings, null, 2), "utf8");

    // bundle the suite for the extension host
    const suiteFile = join(temp, "suite.js");
    await esbuild.build({ entryPoints: [join(ROOT, "e2e", "suite", "index.ts")], bundle: true, platform: "node", format: "cjs", external: ["vscode"], outfile: suiteFile, logLevel: "silent" });

    const runSuite = async (suite: E2eConfig["suite"], hooks: boolean): Promise<ScenarioResult[]> => {
      const resultFile = join(temp, `result-${suite}.json`);
      const cfg: E2eConfig = { workspace: ws!.root, python: ws!.python, repoRoot: ROOT, prefix, live, only: process.env["E2E_ONLY"], resultFile, outDir: out, baseUrl: BASE_URL, liveBudgetUsd: LIVE_BUDGET_USD, suite };
      const cfgFile = join(temp, `config-${suite}.json`);
      await writeFile(cfgFile, JSON.stringify(cfg), "utf8");
      const env: Record<string, string> = { E2E_CONFIG: cfgFile, FORGE_RESOURCE_PREFIX: prefix };
      if (hooks) env["FORGE_E2E"] = "1";
      try {
        await runTests({
          vscodeExecutablePath: exe,
          extensionDevelopmentPath: ROOT,
          extensionTestsPath: suiteFile,
          launchArgs: [ws!.root, `--user-data-dir=${userData}`, `--extensions-dir=${extensions}`, "--disable-extensions", "--skip-welcome", "--skip-release-notes", "--disable-workspace-trust"],
          extensionTestsEnv: env,
        });
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

    // token cost of the live scenarios -> the shared ledger and the per-pass dollar guard
    const liveTokens = results.filter((r) => r.live && r.status !== "SKIP").reduce((n, r) => n + (typeof r.data?.["tokens"] === "number" ? (r.data["tokens"] as number) : 0), 0);
    if (liveTokens > 0) await appendLedger(join(ROOT, "eval-output", "ledger.jsonl"), { runId: `e2e-${process.pid}`, task: "e2e", model: "deepseek/*", attempt: 1, input: liveTokens, output: 0, at: new Date().toISOString() });

    if (live) {
      const after = await snapshotTrueForge();
      if (after) {
        const leftovers = snapshotDiff(before!, after);
        console.log(leftovers.length === 0 ? "TrueForge resources identical before/after." : `WARNING: TrueForge resources differ: ${leftovers.join(", ")} (cleanup runs next)`);
      }
    }

    for (const r of results) await writeFile(join(out, "scenarios", `${r.id}.json`, ), JSON.stringify(r, null, 2), "utf8");
    await writeFile(join(out, "summary.json"), JSON.stringify(results, null, 2), "utf8");
    console.log(`\n${table(results)}\n`);
    if (live) console.log(`Estimated spend of this live pass: ${formatUsd(estimatedSpendUsd(liveTokens))} (${liveTokens.toLocaleString("en-US")} tokens counted)`);
    const stamp = new Date().toISOString().slice(0, 16).replace("T", " ");
    const head = existsSync(join(ROOT, "docs", "e2e-results.md")) ? "" : "# End-to-end results\n\nOne block per run of `npm run test:e2e` (docs/e2e.md). Hermetic = no model; live = real TrueForge + model.\n\n";
    await appendFile(join(ROOT, "docs", "e2e-results.md"), `${head}## ${stamp} (${live ? "live" : "hermetic"} run, pid ${process.pid})\n\n${table(results)}\n\n`, "utf8");
    return results.some((r) => r.status === "FAIL") ? 1 : 0;
  } finally {
    await cleanup();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`e2e runner failed: ${describeError(err)}`);
    process.exit(2);
  },
);
