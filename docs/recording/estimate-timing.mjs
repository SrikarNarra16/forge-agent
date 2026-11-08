#!/usr/bin/env node
// Projects the HUMAN running time of the video from the measured driver times plus realistic human pauses.
//   node docs/recording/estimate-timing.mjs [--type]     (--type: prompts and commands TYPED at 40 wpm instead of pasted / run from the helpers)
// Narration is read from shot-list.md (column 4 of each timeline row, text in quotes) at 150 words per minute, so editing
// a narration line there changes the estimate. The measured driver times come from docs/e2e-results.md (8 Nov 2026 run).
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const TYPED = process.argv.includes("--type");
const WPM_NARRATION = 150;
const CHARS_PER_SECOND_TYPING = (40 * 5) / 60; // 40 words per minute, 5 characters per word = 3.3 characters per second
const BREATH = 1.0; // a pause before and after a narration line
const READ_DIFF = 8; // seconds a viewer needs to read a diff (asked for: 8 s)

// measured by the driver (docs/e2e-results.md, "Final verification" and the recording-prep run): instruction -> first diff, first diff -> verified.
// Task B varies a lot between runs (three measured takes: gap 36.3 / 43.6 / 46.1 s, first diff -> verified 65.9 / 74.4 / 115.6 s), so the default
// plans for the MEDIAN take and the sensitivity table at the end shows the fast and the slow one. Override with BGAP, BAFTER, SPEEDUP.
const M = { aGap: 3.5, aAfter: 1.6, bGap: Number(process.env.BGAP ?? 46) /* median of the three measured takes (36.3 / 43.6 / 46.1 s), rounded up */, bAfter: Number(process.env.BAFTER ?? 74.4) /* median of 65.9 / 74.4 / 115.6 s */, cGap: 2.7, cAfter: 1.7 };
const SPEEDUP = Number(process.env.SPEEDUP ?? 2); // how much the edit speeds up the model waits AFTER the first diff of Task B (allowed: not the instruction->diff gap)

const rows = readFileSync(join(HERE, "shot-list.md"), "utf8").split("\n").filter((l) => /^\| (\*\*)?\d+:\d+(-\d+:\d+)?(\*\*)? \|/.test(l));
const narration = (key) => {
  const row = rows.find((r) => r.startsWith(`| ${key} |`) || r.startsWith(`| **${key}** |`));
  if (!row) throw new Error(`no shot-list row starting with ${key}`);
  const cell = row.split("|")[4] ?? "";
  const quoted = [...cell.matchAll(/"([^"]+)"/g)].map((m) => m[1]).join(" ");
  const words = quoted.split(/\s+/).filter(Boolean).length;
  return { words, seconds: words === 0 ? 0 : (words / WPM_NARRATION) * 60 + 2 * BREATH };
};
const type = (chars) => chars / CHARS_PER_SECOND_TYPING;

const A_INSTR = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value".length;
const B_PROMPT = 'Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.'.length;
const entry = (paste, chars) => (TYPED ? type(chars) : paste); // paste a prompt: 3 s; typed: by length
const cmd = (short, chars) => (TYPED ? type(chars) : short); // a helper like `vA`: 2 s; the full command typed: by length

// A GROUP is a stretch of continuous action with its narration spoken over it: duration = max(time of the doing, time of the narration).
// Each item: { action: human seconds of doing, wait: measured model wait (uncuttable), read: viewer reading time, speed: how much the edit may speed it up }
const groups = [
  { label: "Title + pitch", keys: ["0:00-0:10"], items: [{ action: 0 }] },
  { label: "Task A: instruct, wait, read the diff", keys: ["0:10-0:18", "0:18-0:22", "0:22-0:30"], items: [{ action: 5 + 1.5 + entry(3, A_INSTR) + 0.5, speed: TYPED ? 2 : 1 }, { wait: M.aGap }, { read: READ_DIFF }] },
  { label: "Task A: accept, apply, verify, undo", keys: ["0:30-0:34", "0:34-0:44", "0:44-0:50"], items: [{ action: 4 }, { action: cmd(2, 135) + 3, wait: M.aAfter, read: 3 }, { action: 5 }] },
  { label: "reset", keys: ["0:50-0:54"], items: [{ action: cmd(1.5, 40) + 1 }] },
  // after Enter the model works for up to M.bGap seconds (uncuttable); Context section, tool cards and the first diff are narrated inside it
  { label: "Task B: prompt, Enter -> first diff (uncuttable wait)", keys: ["0:54-1:00", "1:00-1:12", "1:12-1:36", "1:36-1:42"], items: [{ action: 1 + entry(3, B_PROMPT) + 0.5, speed: TYPED ? 2 : 1 }, { wait: M.bGap }] },
  // after the first diff the driver needed M.bAfter seconds in total (model calls between the approvals, the clicks, the tests); a human
  // reads the first diff for 8 s (uncut) and 4 more diffs for 2 s each (the panel and the queue already say what each one is); the remaining waiting is sped up in the edit
  { label: "Task B: review, approve, more diffs", keys: ["1:42-1:52", "1:52-2:02", "2:02-2:20"], items: [{ action: 3 + READ_DIFF + 3 }, { read: 4 * 2 }, { wait: M.bAfter - 1.1 - 10, speed: SPEEDUP }] },
  { label: "Task B: own test run + verification", keys: ["2:20-2:26", "2:26-2:44"], items: [{ read: 4 }, { action: cmd(2, 90) + cmd(2, 110) + 4, wait: 1.1, read: 5 }] },
  { label: "reset", keys: ["2:44-2:48"], items: [{ action: cmd(1.5, 40) + 1 }] },
  { label: "Task C: broken model, instruct, notice, diff, git status", keys: ["2:48-2:52", "2:52-3:00", "3:00-3:03", "3:03-3:10"], items: [{ action: 3 }, { action: 5 + 1.5 + entry(3, A_INSTR) + 0.5, speed: TYPED ? 2 : 1 }, { wait: M.cGap }, { action: cmd(2, 10) + 2, read: 2 }] },
  { label: "Task C: accept, apply, verify", keys: ["3:10-3:20"], items: [{ action: 4 + cmd(2, 50) + 2, wait: M.cAfter, read: 2 }] },
  { label: "Closing: TrueForge Sessions", keys: ["3:40-3:55"], items: [{ action: 5, read: 6 }] },
];

let total = 0;
const lines = [];
for (const g of groups) {
  const doing = g.items.reduce((sum, i) => sum + ((i.action ?? 0) + (i.wait ?? 0) + (i.read ?? 0)) / (i.speed ?? 1), 0);
  const nar = g.keys.map(narration);
  const words = nar.reduce((a, n) => a + n.words, 0);
  const narSeconds = nar.reduce((a, n) => a + n.seconds, 0);
  const final = Math.max(doing, narSeconds);
  total += final;
  lines.push([g.keys[0], g.label, words, narSeconds.toFixed(1), doing.toFixed(1), final.toFixed(1), narSeconds > doing + 0.5 ? "narration is the limit" : ""]);
}
const pad = (v, n) => String(v).padEnd(n);
console.log(`Projected HUMAN timing (${TYPED ? "prompts and commands TYPED at 40 wpm" : "prompts pasted, commands from the terminal helpers"}; narration ${WPM_NARRATION} wpm + breaths; diff reading ${READ_DIFF} s; model waits as measured, Task B planned at ${M.bGap} s)`);
console.log(`${pad("from", 10)} ${pad("stretch", 58)} ${pad("words", 6)} ${pad("narr s", 7)} ${pad("doing s", 8)} ${pad("final s", 8)} note`);
for (const l of lines) console.log(`${pad(l[0], 10)} ${pad(l[1], 58)} ${pad(l[2], 6)} ${pad(l[3], 7)} ${pad(l[4], 8)} ${pad(l[5], 8)} ${l[6]}`);
const mm = (x) => `${Math.floor(x / 60)}:${String(Math.round(x % 60)).padStart(2, "0")}`;
const buffer = 4; // transitions between the tasks
const projected = total + buffer;
const title = lines[0];
console.log(`\nTitle + pitch: ${title[5]} s (limit 10 s)`);
console.log(`Projected total: ${mm(projected)} (${projected.toFixed(0)} s, including ${buffer} s of transitions)  ->  ${projected <= 230 ? "UNDER" : "OVER"} the 3:50 target (3:55 plan, 4:00 limit)`);

// sensitivity: the same projection for the fast and the slow Task B take, at three edit speed-ups (this script run again with other inputs)
if (!process.env.NO_SENSITIVITY) {
  const { execFileSync } = await import("node:child_process");
  const cases = [["fast take (36 s / 66 s)", "37", "65.9"], ["median take (46 s / 74 s)", "46", "74.4"], ["slow take (46 s / 116 s)", "47", "115.6"]];
  console.log("\nSensitivity (Task B: instruction -> first diff / first diff -> verified; speed-up of the waits after the first diff):");
  console.log(`${"".padEnd(28)} 2x      3x      4x`);
  for (const [label, g, a] of cases) {
    const row = [2, 3, 4].map((sp) => {
      const out = execFileSync(process.execPath, [fileURLToPath(import.meta.url), ...(TYPED ? ["--type"] : [])], { env: { ...process.env, NO_SENSITIVITY: "1", BGAP: g, BAFTER: a, SPEEDUP: String(sp) }, encoding: "utf8" });
      return (/Projected total: (\d+:\d+)/.exec(out)?.[1] ?? "?").padEnd(7);
    });
    console.log(`${label.padEnd(28)} ${row.join(" ")}`);
  }
}
