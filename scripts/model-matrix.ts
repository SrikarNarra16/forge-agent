/**
 * "Organisers choose the model" check: runs headless Task A (scripts/run-task-a-headless.ts, one run) once per model
 * registered in TrueForge, with an 8-minute limit each, and prints pass/fail, time, failure text and token spend.
 * Tokens are appended to the shared cost ledger (eval-output/ledger.jsonl) and the $3 cap is enforced before each model.
 * The fault-injection models (badkey-*, broken-endpoint/*) are skipped: they are the Task C test doubles, not catalog models.
 *
 *   npx tsx scripts/model-matrix.ts [--only a,b] [--limit-minutes 8]
 */
import { spawn } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { createClient } from "../src/trueforge/client";
import { appendLedger, checkLimits, DEFAULT_SPEND_LIMIT_USD, estimatedSpendUsd, formatUsd, readLedger, totalsOf } from "./eval/ledger";

const ROOT = join(__dirname, "..");
const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const arg = (n: string, d: string): string => {
  const i = process.argv.indexOf(n);
  return i >= 0 ? (process.argv[i + 1] ?? d) : d;
};

interface Row {
  model: string;
  pass: boolean;
  seconds: number;
  timedOut: boolean;
  failure: string;
  input: number;
  output: number;
}

function runOne(model: string, limitMs: number): Promise<{ out: string; timedOut: boolean; seconds: number }> {
  return new Promise((resolve) => {
    const started = Date.now();
    const child = spawn("npx", ["tsx", "scripts/run-task-a-headless.ts", "--runs", "1", "--model", model], { cwd: ROOT, env: process.env });
    let out = "";
    child.stdout.on("data", (d: Buffer) => (out += d.toString()));
    child.stderr.on("data", (d: Buffer) => (out += d.toString()));
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM"); // the runner cleans up its throwaway agent/MCP server on SIGTERM
    }, limitMs);
    child.on("close", () => {
      clearTimeout(timer);
      resolve({ out, timedOut, seconds: (Date.now() - started) / 1000 });
    });
  });
}

function failureText(out: string): string {
  const pick = out.split("\n").filter((l) => /run ended with:|notices:|failing checks:|ABORT|error:/i.test(l)).map((l) => l.trim());
  return pick.join(" | ").replace(/\s+/g, " ").slice(0, 500);
}

async function main(): Promise<void> {
  const limitMs = Number(arg("--limit-minutes", "8")) * 60_000;
  const only = arg("--only", "");
  const client = createClient(BASE_URL);
  const all = (await client.models.list()).data.map((m) => m.name);
  let models = all.filter((n) => !n.startsWith("badkey-") && !n.startsWith("broken-endpoint/"));
  if (only) models = models.filter((m) => only.split(",").includes(m));
  const ledgerFile = join(ROOT, "eval-output", "ledger.jsonl");
  const startTotal = totalsOf(await readLedger(ledgerFile)).total;
  const rows: Row[] = [];
  for (const model of models) {
    const gate = checkLimits(totalsOf(await readLedger(ledgerFile)), { usd: DEFAULT_SPEND_LIMIT_USD });
    if (!gate.ok) {
      console.log(gate.reason);
      break;
    }
    console.log(`\n=== ${model} ===`);
    const { out, timedOut, seconds } = await runOne(model, limitMs);
    const pass = /RESULT: 1\/1 runs passed/.test(out) && !timedOut;
    const tok = out.match(/TOKENS: input=(\d+) output=(\d+)/);
    const input = tok ? Number(tok[1]) : 0;
    const output = tok ? Number(tok[2]) : 0;
    const failure = pass ? "" : timedOut ? `TIMEOUT after ${limitMs / 60000} min` : failureText(out) || out.trim().split("\n").slice(-3).join(" | ").slice(0, 400);
    rows.push({ model, pass, seconds, timedOut, failure, input, output });
    await appendLedger(ledgerFile, { runId: `model-matrix-${process.pid}`, task: "model-matrix", model, attempt: 1, input, output, at: new Date().toISOString() });
    console.log(`${pass ? "PASS" : "FAIL"} ${model} ${seconds.toFixed(0)}s tokens ${input}/${output}${failure ? `\n  ${failure}` : ""}`);
  }
  const spent = rows.reduce((n, r) => n + r.input + r.output, 0);
  console.log("\n| Model | Result | Time | Tokens in/out | Failure |\n|---|---|---|---|---|");
  for (const r of rows) console.log(`| ${r.model} | ${r.pass ? "PASS" : "FAIL"} | ${r.seconds.toFixed(0)} s | ${r.input}/${r.output} | ${r.failure.replace(/\|/g, "/")} |`);
  console.log(`\nThis matrix: ${spent.toLocaleString("en-US")} tokens ~ ${formatUsd(estimatedSpendUsd(spent))}; ledger total now ${formatUsd(estimatedSpendUsd(startTotal + spent))} of $${DEFAULT_SPEND_LIMIT_USD}`);
  await mkdir(join(ROOT, "eval-output"), { recursive: true });
  await writeFile(join(ROOT, "eval-output", "model-matrix.json"), JSON.stringify({ at: new Date().toISOString(), rows }, null, 2));
}
void main();
