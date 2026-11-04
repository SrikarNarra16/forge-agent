/** Entry point loaded by VS Code's extension host (bundled by e2e/run.ts). Runs the scenarios in order and writes a JSON result file. */
import { readFile, writeFile } from "node:fs/promises";
import * as vscode from "vscode";
import type { E2eConfig, ScenarioResult } from "../common";
import { resetWorkspace, sleep, state, waitFor } from "./helpers";
import { SCENARIOS } from "./scenarios";

const DEFAULT_MODELS = ["deepseek/flash", "deepseek/v4-pro"];

async function noHooksSuite(): Promise<ScenarioResult[]> {
  const t0 = Date.now();
  const commands = await vscode.commands.getCommands(true);
  const e2e = commands.filter((c) => c.startsWith("forge.e2e."));
  const forge = commands.filter((c) => c.startsWith("forge."));
  const ok = e2e.length === 0 && forge.includes("forge.openAgent");
  return [{ id: "0", name: "Normal activation (no FORGE_E2E) registers no forge.e2e.* command", live: false, status: ok ? "PASS" : "FAIL", ms: Date.now() - t0, detail: ok ? `${forge.length} forge.* commands, none of them forge.e2e.*` : `e2e commands: ${e2e.join(", ") || "none"}; forge.openAgent present: ${forge.includes("forge.openAgent")}` }];
}

export async function run(): Promise<void> {
  const cfg = JSON.parse(await readFile(process.env["E2E_CONFIG"] ?? "", "utf8")) as E2eConfig;
  const results: ScenarioResult[] = [];
  const write = (): Promise<void> => writeFile(cfg.resultFile, JSON.stringify(results, null, 2), "utf8");

  // wait for the extension to be active (activation event: onStartupFinished)
  await waitFor("the Forge extension to activate", async () => (await vscode.commands.getCommands(true)).includes("forge.openAgent"), 60_000, 250);

  if (cfg.suite === "nohooks") {
    results.push(...(await noHooksSuite()));
    await write();
    return;
  }

  await waitFor("the e2e hooks", async () => (await state()).resourcePrefix === cfg.prefix, 30_000, 250);
  const only = cfg.only ? new Set(cfg.only.split(",").map((s) => s.trim())) : undefined;
  for (const scenario of SCENARIOS) {
    if (only && !only.has(scenario.id)) continue;
    if (scenario.live && !cfg.live) {
      results.push({ id: scenario.id, name: scenario.name, live: true, status: "SKIP", ms: 0, detail: "needs E2E_LIVE=1 (real model)" });
      continue;
    }
    await resetWorkspace(cfg);
    await vscode.workspace.getConfiguration("forge").update("models", DEFAULT_MODELS, vscode.ConfigurationTarget.Global);
    await vscode.commands.executeCommand("forge.e2e.decide", { policy: "stop" });
    const t0 = Date.now();
    try {
      // a hung scenario must never hang the whole run
      const limit = scenario.live ? 600_000 : 90_000;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const outcome = await Promise.race([
        scenario.run(cfg),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => reject(new Error(`scenario timed out after ${limit / 1000} s`)), limit);
        }),
      ]).finally(() => clearTimeout(timer));
      results.push({ id: scenario.id, name: scenario.name, live: scenario.live, status: "PASS", ms: Date.now() - t0, detail: outcome.detail, ...(outcome.data ? { data: outcome.data } : {}) });
    } catch (err) {
      results.push({ id: scenario.id, name: scenario.name, live: scenario.live, status: "FAIL", ms: Date.now() - t0, detail: err instanceof Error ? err.message : String(err) });
    }
    await vscode.commands.executeCommand("forge.e2e.decide", { policy: "stop" });
    await vscode.commands.executeCommand("forge.stop"); // never leave a run behind for the next scenario
    if (scenario.live) {
      // failed scenarios spent tokens too: count what the last run reported
      const last = results[results.length - 1];
      const usage = (await state()).usage;
      if (last && last.data?.["tokens"] === undefined) last.data = { ...last.data, tokens: usage.input + usage.output };
    }
    await sleep(300);
    await write();
  }
  await write();
}
