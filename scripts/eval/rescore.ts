/**
 * Re-scores recorded Task B reports (eval-output/*-b.json) with the CURRENT check (g) from their recorded
 * changedFiles (deletions were not recorded before the correction, so they cannot be re-checked).
 *   npx tsx scripts/eval/rescore.ts
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "./report";
import { classifyFailure } from "./retry";
import { checkUnrelated } from "./score-task-b";

async function main(): Promise<void> {
  const dir = join(__dirname, "..", "..", "eval-output");
  const rows: string[] = [];
  for (const name of (await readdir(dir)).filter((f) => f.endsWith("-b.json")).sort()) {
    const r = JSON.parse(await readFile(join(dir, name), "utf8")) as RunReport;
    if (r.checks.length === 0) continue; // run died before scoring
    const before = r.checks.find((c) => c.id === "g");
    const after = checkUnrelated(r.changedFiles);
    const passAfter = r.checks.filter((c) => c.id !== "g").every((c) => c.pass) && after.pass;
    rows.push(`| ${r.runId} | ${r.model} | g ${before?.pass ? "PASS" : "FAIL"} -> g ${after.pass ? "PASS" : "FAIL"} (${after.detail}) | ${r.pass ? "PASS" : "FAIL"} -> ${passAfter ? "PASS" : "FAIL"} | ${r.providerError ? "provider error" : ""}${!r.pass && classifyFailure(r.errors) === "provider" && !r.providerError ? "reclassified: provider (stream dropped)" : ""} |`);
  }
  console.log("| Run | Model | Check (g) before -> after | Overall before -> after | Note |\n|---|---|---|---|---|");
  console.log(rows.join("\n"));
}

void main();
