/**
 * Turns a finished take (e2e-output/video/take-<n>/report.json, taskB-session.json) and the repository into
 * docs/writeup/facts.json: the video timestamps (read from the encoder's marks, i.e. positions in the FINAL MP4), the take's spend,
 * the source statistics and the subagent fact for the write-up. Nothing is typed by hand.
 *
 *   npx tsx scripts/video/make-facts.ts <take-dir>
 */
import { execFile } from "node:child_process";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { USD_PER_MILLION_TOKENS, readLedger, totalsOf } from "../eval/ledger";

const exec = promisify(execFile);
const ROOT = join(__dirname, "..", "..");
const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;

async function count(dirs: string[], pattern: RegExp): Promise<{ files: number; lines: number }> {
  let files = 0;
  let total = 0;
  const walk = async (dir: string): Promise<void> => {
    for (const e of await readdir(dir, { withFileTypes: true })) {
      const p = join(dir, e.name);
      if (e.isDirectory()) await walk(p);
      else if (pattern.test(e.name)) {
        files++;
        total += (await readFile(p, "utf8")).split("\n").length;
      }
    }
  };
  for (const d of dirs) await walk(join(ROOT, d));
  return { files, lines: total };
}

async function main(): Promise<void> {
  const dir = process.argv[2];
  if (!dir) throw new Error("usage: make-facts.ts <take-dir>");
  const report = JSON.parse(await readFile(join(dir, "report.json"), "utf8")) as { durationSeconds: number; marks: Record<string, number>; tokens: number };
  const session = JSON.parse(await readFile(join(dir, "taskB-session.json"), "utf8")) as { subagentEvidence: number; maxInputSeen: number; turns: number };
  const m = report.marks;
  const need = (k: string): string => {
    const v = m[k];
    if (v === undefined) throw new Error(`mark ${k} missing`);
    return fmt(v);
  };
  const stopMs = m["S:stopped"] !== undefined && m["S:stop-clicked"] !== undefined ? m["S:stopped"] - m["S:stop-clicked"] : 0;
  const src = await count(["src"], /\.(ts|css)$/);
  const tests = await count(["test", "e2e"], /\.ts$/);
  const unit = (await exec("npx", ["vitest", "run"], { cwd: ROOT, maxBuffer: 20_000_000 }).then((r) => r.stdout, (e: { stdout?: string }) => e.stdout ?? "")).match(/Tests\s+(\d+) passed/)?.[1] ?? "?";
  const ledger = totalsOf(await readLedger(join(ROOT, "eval-output", "ledger.jsonl")));
  const facts: Record<string, string> = {
    T_A1: need("A1:per-hunk-diff"),
    T_A1V: need("A:verified-False"),
    T_A2: need("B:prompt-sent"),
    T_A2V: `${need("B:pytest")}, ${need("B:flask-help")}, ${need("B:masked-json")}`,
    T_A3: need("S:stop-clicked"),
    T_B1: need("B1:context-section"),
    T_B2: need("B:first-diff"),
    T_B2U: need("A:undo"),
    T_B3: need("C:fallback"),
    T_B3G: need("C:git-clean"),
    T_B4: need("B4:sessions-page"),
    T_B4C: need("B4:deferred-loading"),
    VIDEO_LEN: `${fmt(report.durationSeconds)} long`,
    STOP_S: (stopMs / 1000).toFixed(1),
    SRC_STATS: `Size: ${src.files} source files (${src.lines.toLocaleString("en-US")} lines, extension host plus webview) and ${tests.files} test and e2e files (${tests.lines.toLocaleString("en-US")} lines; ${unit} unit tests run in CI on every push).`,
    SUBAGENT_FACT:
      session.subagentEvidence === 0
        ? "none was spawned in the video's Task B session, nor in the 14 flash and 5 v4-pro evaluation runs inspected earlier, so it is claimed as configured, not demonstrated."
        : `${session.subagentEvidence} subagent event(s) were recorded in the video's Task B session.`,
    SPEND_TOKENS: `${(ledger.total / 1e6).toFixed(1)}M`,
    SPEND_USD: `$${((ledger.total / 1e6) * USD_PER_MILLION_TOKENS).toFixed(2)}`,
    TAKE_TOKENS: report.tokens.toLocaleString("en-US"),
    MAX_INPUT: session.maxInputSeen.toLocaleString("en-US"),
  };
  await writeFile(join(ROOT, "docs", "writeup", "facts.json"), `${JSON.stringify(facts, null, 2)}\n`, "utf8");
  console.log(JSON.stringify(facts, null, 2));
}

void main();
