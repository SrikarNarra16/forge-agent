/**
 * Re-scores recorded Task B reports (eval-output/*-b.json) with the CURRENT checks (f) and (g):
 *   - (g) from the recorded changedFiles;
 *   - (f) from the docs/cli.rst edits the agent made, reconstructed from the recorded stream events
 *     (eval-output/<run>.events.jsonl): every propose_edit to docs/cli.rst whose tool response says "applied",
 *     added lines = the lines of new_text that are not in old_text.
 * Also re-evaluates the OLD (f) rule on the same reconstruction, to show the reconstruction agrees with what was recorded.
 *   npx tsx scripts/eval/rescore.ts
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { RunReport } from "./report";
import { checkDocs, checkUnrelated } from "./score-task-b";

interface Rec {
  event?: { type?: string; toolCalls?: Array<{ id?: string; function?: { name?: string; arguments?: string } }>; toolCallId?: string; content?: string };
}

/** The old rule (frozen until 4 Nov 2026), kept only to compare. */
const OLD_RULE = /flask config|``config``|`config`/i;
const oldCheck = (added: string[]): boolean => added.some((l) => OLD_RULE.test(l)) && added.filter((l) => l.trim() !== "").length >= 2;

export async function reconstructDocsAdded(eventsFile: string): Promise<string[] | undefined> {
  let text: string;
  try {
    text = await readFile(eventsFile, "utf8");
  } catch {
    return undefined;
  }
  const names = new Map<string, string>();
  const args = new Map<string, string>();
  const responses = new Map<string, string>();
  let last: string | undefined;
  for (const line of text.split("\n")) {
    if (!line.includes('"event"')) continue;
    let rec: Rec;
    try {
      rec = JSON.parse(line) as Rec;
    } catch {
      continue;
    }
    const e = rec.event;
    if (!e) continue;
    if (e.type === "model.message.delta") {
      for (const tc of e.toolCalls ?? []) {
        if (tc.id) {
          last = tc.id;
          names.set(tc.id, tc.function?.name ?? "");
          args.set(tc.id, tc.function?.arguments ?? "");
        } else if (last) args.set(last, (args.get(last) ?? "") + (tc.function?.arguments ?? ""));
      }
    }
    if (e.type === "tool.response" && e.toolCallId) responses.set(e.toolCallId, e.content ?? "");
  }
  const added: string[] = [];
  for (const [id, name] of names) {
    if (name !== "propose_edit" || !(responses.get(id) ?? "").startsWith("applied")) continue;
    let parsed: { path?: string; edits?: Array<{ old_text: string; new_text: string }> };
    try {
      parsed = JSON.parse(args.get(id) ?? "") as typeof parsed;
    } catch {
      continue;
    }
    if (parsed.path !== "docs/cli.rst") continue;
    for (const edit of parsed.edits ?? []) {
      const old = new Set(edit.old_text.split("\n"));
      added.push(...edit.new_text.split("\n").filter((l) => !old.has(l) || l.trim() === ""));
    }
  }
  return added;
}

async function main(): Promise<void> {
  const dir = join(__dirname, "..", "..", "eval-output");
  const rows: string[] = [];
  let before = 0;
  let after = 0;
  let total = 0;
  for (const name of (await readdir(dir)).filter((f) => f.endsWith("-b.json")).sort()) {
    const r = JSON.parse(await readFile(join(dir, name), "utf8")) as RunReport;
    if (r.checks.length !== 7) continue; // died before scoring, or a cancel-mode run
    const added = await reconstructDocsAdded(join(dir, name.replace(/-b\.json$/, ".events.jsonl")));
    const fBefore = r.checks.find((c) => c.id === "f")?.pass ?? false;
    const gAfter = checkUnrelated(r.changedFiles).pass;
    const fAfter = added === undefined ? fBefore : checkDocs(added.map((l) => `+${l}`).join("\n")).pass;
    const others = r.checks.filter((c) => c.id !== "f" && c.id !== "g").every((c) => c.pass);
    const passAfter = others && gAfter && fAfter;
    const consistent = added === undefined ? "no events" : oldCheck(added) === fBefore ? "ok" : "MISMATCH";
    total++;
    if (r.pass) before++;
    if (passAfter) after++;
    rows.push(`| ${r.runId} | ${r.model} | f ${fBefore ? "PASS" : "FAIL"} -> ${fAfter ? "PASS" : "FAIL"} | ${r.pass ? "PASS" : "FAIL"} -> ${passAfter ? "PASS" : "FAIL"} | ${consistent} |`);
  }
  console.log("| Run | Model | Check (f) before -> after | Overall before -> after | Reconstruction vs recorded (old rule) |\n|---|---|---|---|---|");
  console.log(rows.join("\n"));
  console.log(`\nOverall pass: ${before}/${total} before, ${after}/${total} after`);
}

if (require.main === module) void main();
