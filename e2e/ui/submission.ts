/**
 * The submission video: ONE automated take of the real extension in a real VS Code, with captions and no narration.
 *
 *   npm run video:take            one take (live: costs a few hundred thousand tokens, guarded by the $3 ledger cap)
 *
 * Clips (each recorded as JPEG screencast frames, then encoded to H.264 by scripts/video/assemble.swift):
 *   title card -> Task A (inline edit, per-hunk review, verify False, Cmd+Z once, redo)
 *              -> Task B (panel, no files named, Context section, per-hunk review, run_command approval, pytest, flask --help,
 *                         masked JSON) -> TrueForge Sessions page for THIS run (Agent steps open)
 *              -> Task C (unreachable endpoint -> automatic fallback, git status clean, switch model back)
 *              -> Stop clip (Stop mid-stream, stopped within a second or two, git status clean)
 * Waiting AFTER the first diff of Task B may be shown at x3 (always labelled "x3" on screen); nothing between an instruction and its first
 * diff is ever shortened. Timestamps come from the driver's own event log mapped through the encoder, never from guesses.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { copyFile, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { chromium, type Frame, type Page } from "playwright-core";
import { DEFAULT_SPEND_LIMIT_USD, appendLedger, checkLimits, estimatedSpendUsd, formatUsd, readLedger, totalsOf } from "../../scripts/eval/ledger";
import { describeError } from "../../src/trueforge/client";
import { BASE_URL, ROOT, createEnvironment, snapshotTrueForge, type E2eEnvironment } from "../env";
import { EventLog, createRecorder, installOverlay, setCaption, setSpeedBadge, type FrameRecorder } from "./screencast";
import { MOD, gitStatus, launch, openPanel, panelFrame, runCommand, sendPrompt, statusText, until, verify, verifySummary, type Launched } from "./driver";
import { scrollToListingTools } from "./sessionsPage";
import { fetchSessionDetails, fetchSessionUsage } from "./usage";
import { formatDuration, videoDurationSeconds } from "./videoDuration";

const exec = promisify(execFile);
const TASK_A_INSTRUCTION = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value";
const TASK_B_PROMPT =
  'Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.';
const VERIFY_CMD = `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"`;
const ESTIMATED_TOKENS = 700_000;
const MAX_TOTAL_SECONDS = 235; // the hard cap is 3:55
const GOOD_TOTAL_SECONDS = 225; // a take at or under 3:45 stops the retry loop

interface ClipOut {
  name: string;
  kind: "still" | "frames";
  file?: string;
  seconds?: number;
  dir?: string;
  rec?: FrameRecorder;
  speeds: Array<{ from: number; to: number }>;
  /** Wall-clock ms the capture stopped (the clip's real end). */
  endedAt?: number;
  marks: Array<{ name: string; at: number }>;
}

class Take {
  readonly clips: ClipOut[] = [];
  readonly log = new EventLog();
  current: { clip: ClipOut; rec: FrameRecorder } | undefined;
  constructor(readonly page: Page, readonly root: string) {}

  async begin(name: string): Promise<void> {
    const dir = join(this.root, name);
    const rec = await createRecorder(this.page, dir);
    await rec.start();
    const clip: ClipOut = { name, kind: "frames", dir, rec, speeds: [], marks: [] };
    this.clips.push(clip);
    this.current = { clip, rec };
    // the first caption of a clip is set by the caller; give the screencast a moment so the first frame exists
    await this.page.waitForTimeout(300);
  }

  async end(): Promise<void> {
    if (!this.current) return;
    await setSpeedBadge(this.page, false);
    await setCaption(this.page, undefined);
    await this.page.waitForTimeout(300);
    if (this.log.speedOpen()) this.log.speedEnd();
    this.current.clip.endedAt = (await this.current.rec.stop()).endedAt;
    for (const s of this.log.speeds) if (s.to !== undefined) this.current.clip.speeds.push({ from: s.from, to: s.to });
    this.log.speeds.length = 0;
    this.current = undefined;
  }

  mark(name: string): void {
    this.log.mark(name);
    this.current?.clip.marks.push({ name, at: Date.now() });
  }

  async caption(text: string | undefined): Promise<void> {
    await setCaption(this.page, text);
  }

  async hold(ms: number): Promise<void> {
    await this.page.waitForTimeout(ms);
  }

  /** x3 region: the badge goes on first, the encoder compresses from just after it is visible. */
  async fastForward(on: boolean): Promise<void> {
    if (on && !this.log.speedOpen()) {
      await setSpeedBadge(this.page, true);
      await this.page.waitForTimeout(350);
      this.log.speedStart();
    } else if (!on && this.log.speedOpen()) {
      this.log.speedEnd();
      await setSpeedBadge(this.page, false);
    }
  }
}

// ---- small UI helpers ------------------------------------------------------------------------------------------------

/** The panel status line starts with the state; a stopped or failed run appends its detail ("Stopped: Cancelled. Nothing had been changed."). */
const FINAL = /^(Done|Error|Stopped)/;
const lens = (page: Page, re: RegExp) => page.locator('a[role="button"]', { hasText: re }).locator("visible=true");

async function selectGetDebugFlag(page: Page, env: E2eEnvironment): Promise<void> {
  const text = await readFile(join(env.workspace.root, "src/flask/helpers.py"), "utf8");
  const lines = text.split("\n");
  const def = lines.findIndex((l) => l.startsWith("def get_debug_flag"));
  let end = def;
  while (end + 1 < lines.length && lines[end + 1] !== "" && /^\s/.test(lines[end + 1] ?? "")) end++;
  await page.keyboard.press(`${MOD}+P`);
  const input = page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible" });
  await input.pressSequentially(`src/flask/helpers.py:${def + 1}`, { delay: 30 });
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "helpers.py" }).first().waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
  await page.locator(".quick-input-widget").waitFor({ state: "hidden" });
  await page.locator(".tab.active", { hasText: "helpers.py" }).waitFor({ state: "visible" });
  await page.locator(".monaco-editor .current-line").first().waitFor({ state: "visible" });
  await page.keyboard.press("Home");
  for (let i = 0; i < end - def; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
}

async function newChat(frame: Frame): Promise<void> {
  await frame.getByRole("button", { name: "New chat" }).click({ timeout: 8_000 }).catch(() => undefined);
  await frame.locator(".item").first().waitFor({ state: "detached", timeout: 5_000 }).catch(() => undefined);
}

async function resetWorkspace(env: E2eEnvironment): Promise<void> {
  await exec("git", ["checkout", "-q", "--", "."], { cwd: env.workspace.root });
  await exec("git", ["clean", "-fdq"], { cwd: env.workspace.root });
}

async function terminalVisible(page: Page): Promise<boolean> {
  return (await page.locator(".terminal-wrap:visible, .xterm:visible").count()) > 0;
}

async function openTerminal(page: Page): Promise<void> {
  if (!(await terminalVisible(page))) {
    await runCommand(page, "View: Toggle Terminal");
    await until("the terminal", async () => terminalVisible(page), 20_000, 200);
  }
  await page.locator(".xterm").first().click(); // focus (the terminal is the only thing under the click)
}

async function closeTerminal(page: Page): Promise<void> {
  if (await terminalVisible(page)) await runCommand(page, "View: Toggle Terminal");
  await until("the terminal to close", async () => !(await terminalVisible(page)), 10_000, 200);
}

async function terminalText(page: Page): Promise<string> {
  return (await page.locator(".xterm-rows").first().innerText().catch(() => "")) ?? "";
}

/** Types a command in the terminal (visible typing), waits for its output to match, returns the terminal text. */
async function runInTerminal(page: Page, command: string, expect: RegExp, timeoutMs = 120_000): Promise<string> {
  await openTerminal(page);
  await page.keyboard.press("Control+L"); // clear: only this command's output on screen
  await page.waitForTimeout(250);
  await page.keyboard.type(command, { delay: 22 });
  await page.keyboard.press("Enter");
  return until(`terminal output ${expect}`, async () => {
    const t = await terminalText(page);
    return expect.test(t) ? t : undefined;
  }, timeoutMs, 300);
}

async function waitDiffClosed(page: Page, frame: Frame): Promise<void> {
  await until("the review to finish", async () => (await frame.locator(".queue-row.state-reviewing").count()) === 0 && (await page.locator(".tab", { hasText: /^Forge: / }).count()) === 0, 30_000, 200).catch(() => undefined);
}

async function applyFromPanel(page: Page, frame: Frame): Promise<void> {
  const applyButton = frame.getByRole("button", { name: "Apply accepted" }).locator("visible=true").first();
  if (!(await applyButton.click({ timeout: 8_000 }).then(() => true, () => false))) await page.keyboard.press(`${MOD}+Enter`);
}

/** Accepts the hunks one by one with their own CodeLens ("Accept hunk" lens number i), then makes sure none is left undecided. */
async function acceptHunksOneByOne(t: Take, count = 2): Promise<void> {
  for (let i = 0; i < count; i++) {
    const lenses = lens(t.page, /Accept hunk/);
    const n = await lenses.count();
    if (n === 0) break;
    await lenses.nth(Math.min(i, n - 1)).click({ timeout: 8_000 }).catch(() => undefined);
    await t.hold(900);
  }
}

/** The panel's "Accept all and apply": undecided hunks are accepted, hunks already accepted or rejected keep their decision. */
async function applyAll(page: Page, frame: Frame): Promise<void> {
  const b = frame.getByRole("button", { name: "Accept all and apply" }).locator("visible=true").first();
  if (await b.click({ timeout: 8_000 }).then(() => true, () => false)) return;
  await acceptAllLens(page);
  await applyFromPanel(page, frame);
}

async function acceptAllLens(page: Page): Promise<void> {
  await page.keyboard.press(`${MOD}+ArrowUp`);
  const all = lens(page, /^Accept all$/).first();
  if (await all.isVisible().catch(() => false)) await all.click({ timeout: 10_000 }).catch(() => undefined);
}

async function diffLensOrReopen(page: Page, row: ReturnType<Frame["locator"]>): Promise<void> {
  const l = page.getByText("Accept hunk").first();
  if (await l.waitFor({ state: "visible", timeout: 12_000 }).then(() => true, () => false)) return;
  console.log("  (no Accept hunk lens within 12 s: closing and reopening the diff once)");
  await page.keyboard.press(`${MOD}+W`);
  await row.click({ timeout: 10_000 });
  await l.waitFor({ state: "visible", timeout: 12_000 });
}

// ---- the flows -------------------------------------------------------------------------------------------------------

/** Task A (or C): select get_debug_flag, shortcut, instruction; returns when the first hunk lens is visible. */
async function inlineEditToDiff(t: Take, env: E2eEnvironment, tag: "A" | "C"): Promise<void> {
  await selectGetDebugFlag(t.page, env);
  await t.hold(900); // the selection is visible
  t.mark(`${tag}:shortcut`);
  await t.page.keyboard.press(`${MOD}+Alt+K`);
  const input = t.page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible" });
  await input.pressSequentially(TASK_A_INSTRUCTION, { delay: 22 });
  await t.hold(600);
  await t.page.keyboard.press("Enter");
  t.mark(`${tag}:instruction-sent`);
}

async function taskA(t: Take, env: E2eEnvironment, frame: Frame): Promise<{ undoOk: boolean; redoOk: boolean; verified: string }> {
  await t.caption("Task A: inline edit — select get_debug_flag, Cmd+Alt+K, type the instruction");
  await inlineEditToDiff(t, env, "A");
  await lens(t.page, /Accept hunk/).first().waitFor({ state: "visible", timeout: 120_000 });
  t.mark("A1:per-hunk-diff");
  await t.caption("Task A: per-hunk review — CodeLens “Accept hunk / Reject hunk” above each change");
  await t.hold(4800);
  await acceptHunksOneByOne(t);
  await t.caption("Task A: both hunks accepted, then Apply");
  await t.hold(900);
  await applyAll(t.page, frame); // anything still undecided is accepted by this button
  await waitDiffClosed(t.page, frame);
  await until("Done", async () => FINAL.test(await statusText(frame)), 30_000, 200);
  t.mark("A:applied");
  await t.caption("Task A: verify — FLASK_DEBUG=off → False");
  await runInTerminal(t.page, VERIFY_CMD, /^False\s*$/m, 60_000);
  t.mark("A:verified-False");
  await t.hold(2800);
  await closeTerminal(t.page);

  // one Cmd+Z restores the file; then redo re-applies it
  await runCommand(t.page, "View: Focus First Editor Group");
  const editorText = async (): Promise<string> => (await t.page.locator(".monaco-editor .view-lines").first().innerText().catch(() => "")) ?? "";
  const applied = await editorText();
  await t.caption("Undo: one step (Cmd+Z once)");
  await t.hold(1200);
  await t.page.keyboard.press(`${MOD}+Z`);
  t.mark("A:undo");
  const undone = await until("the editor text to change after Cmd+Z", async () => {
    const x = await editorText();
    return x !== applied ? x : undefined;
  }, 8_000, 150).catch(() => undefined);
  await t.hold(2600);
  await t.caption("Redo: the same edit comes back (Cmd+Shift+Z)");
  await t.page.keyboard.press(`${MOD}+Shift+Z`);
  t.mark("A:redo");
  // after redo the buffer is back at the saved state (the applier saved the edit), so the tab is no longer dirty
  const redone = await until("the edit to come back after redo", async () => ((await t.page.locator(".tab.active.dirty").count()) === 0 && (await editorText()) !== undone ? true : undefined), 8_000, 150).catch(() => undefined);
  await t.hold(2200);
  return { undoOk: undone !== undefined, redoOk: redone === true, verified: "ok" };
}

async function taskB(t: Take, env: E2eEnvironment, frame: Frame): Promise<{ commandsAllowed: number; reviews: number; contextShown: boolean }> {
  await t.caption("Task B: agent mode, no files named");
  await t.hold(1200);
  await sendPrompt(frame, TASK_B_PROMPT);
  t.mark("B:prompt-sent");
  await until("the run to start", async () => {
    const st = await statusText(frame);
    return st !== "" && !/^(Done|Error|Stopped|Ready)/.test(st);
  }, 60_000, 100);
  let firstDiff = false;
  let commandsAllowed = 0;
  let reviews = 0;
  let contextShown = false;
  const deadline = Date.now() + 600_000;
  while (Date.now() < deadline) {
    const status = await statusText(frame);
    if (FINAL.test(status) && (await frame.locator(".queue-row.state-reviewing").count()) === 0) break;

    const allow = frame.locator(".approval button.primary:not([disabled])", { hasText: "Allow" }).first();
    if (await allow.isVisible().catch(() => false)) {
      await t.fastForward(false);
      if (commandsAllowed === 0) {
        t.mark("B:run_command-approval");
        await t.caption("Task B: run_command needs your approval — Allow");
        await t.hold(2600);
      }
      if (await allow.click({ timeout: 10_000 }).then(() => true, () => false)) commandsAllowed++;
      continue;
    }

    const row = frame.locator(".queue-row.state-reviewing").first();
    if (await row.isVisible().catch(() => false)) {
      await t.fastForward(false);
      await row.click();
      await diffLensOrReopen(t.page, row);
      if (!firstDiff) {
        firstDiff = true;
        t.mark("B:first-diff");
        await t.caption("Task B: the first diff — per-hunk review");
        await t.hold(2600);
        // Context section (chosen files + reasons), after the first diff appears
        const ctx = frame.locator("details.context").first();
        if ((await ctx.count()) > 0) {
          if (!(await ctx.evaluate((e) => (e as unknown as { open: boolean }).open).catch(() => false))) await ctx.locator("summary").click({ timeout: 5000 }).catch(() => undefined);
          contextShown = (await frame.locator(".ctx-reason").count().catch(() => 0)) > 0;
          t.mark("B1:context-section");
          await t.caption("Task B: Context — the files chosen and why, with the token budget");
          await t.hold(6500);
          await ctx.locator("summary").click({ timeout: 5000 }).catch(() => undefined); // collapse again so the queue stays visible
        }
        await t.page.keyboard.press(`${MOD}+ArrowUp`).catch(() => undefined);
        await t.caption("Task B: accepting the first hunk on its own (CodeLens), then the rest");
        await acceptHunksOneByOne(t, 1);
        await t.hold(900);
      }
      await applyAll(t.page, frame);
      reviews++;
      await waitDiffClosed(t.page, frame);
      await t.caption("Task B: working… (waiting is shown at x3 from here)");
      continue;
    }

    // the agent is working: after the first diff, show the waiting at x3
    if (firstDiff) await t.fastForward(true);
    await new Promise((r) => setTimeout(r, 300));
  }
  await t.fastForward(false);
  await until("Done", async () => FINAL.test(await statusText(frame)), 30_000, 200).catch(() => undefined);
  t.mark("B:done");
  return { commandsAllowed, reviews, contextShown };
}

async function taskBVerification(t: Take, env: E2eEnvironment): Promise<{ tests: string; help: string; json: string }> {
  await t.caption("Task B: pytest tests/test_cli.py -q");
  const tests = await runInTerminal(t.page, "pytest tests/test_cli.py -q", /\d+ passed|\d+ failed|error/i, 240_000);
  t.mark("B:pytest");
  await t.hold(3200);
  await t.caption("Task B: flask --help lists the new config command");
  const help = await runInTerminal(t.page, "flask --help | tail -n 10", /^\s*config\b/m, 60_000);
  t.mark("B:flask-help");
  await t.hold(3200);
  await t.caption("Task B: flask config on a demo app — secrets masked as \"***\"");
  const json = await runInTerminal(t.page, `flask config | python -m json.tool | grep -E "SECRET|TOKEN|PASSWORD|KEY|APP_NAME"`, /\*\*\*/, 60_000);
  t.mark("B:masked-json");
  await t.hold(4200);
  await closeTerminal(t.page);
  void env;
  return { tests: /\d+ passed/.test(tests) && !/failed/.test(tests) ? "passed" : "FAILED", help: /^\s*config\b/m.test(help) ? "lists config" : "MISSING", json: /"(SECRET_KEY|DB_PASSWORD|API_TOKEN|SERVICE_KEY)": "\*\*\*"/.test(json) ? "masked" : "NOT MASKED" };
}

async function taskC(t: Take, env: E2eEnvironment, frame: Frame): Promise<{ fallback: boolean; pristine: boolean }> {
  await t.caption("Task C: unreachable endpoint → automatic fallback");
  await env.updateSettings({ "forge.models": ["broken-endpoint/broken", "deepseek/flash"] });
  await t.hold(1500);
  await inlineEditToDiff(t, env, "C");
  await t.caption("Task C: the first model's endpoint is unreachable — the editor stays responsive");
  // the editor is not blocked: scroll it while the run retries
  for (let i = 0; i < 6; i++) {
    await t.page.mouse.wheel(0, 90);
    await t.hold(250);
  }
  await frame.getByText(/switched to deepseek\/flash/).first().waitFor({ state: "visible", timeout: 120_000 });
  t.mark("C:fallback");
  await t.caption("Task C: fallback notice — continued on deepseek/flash (still through TrueForge)");
  await t.hold(3500);
  await frame.locator(".queue-row.state-reviewing").first().waitFor({ state: "visible", timeout: 120_000 });
  const status = await gitStatus(env);
  await t.caption("git status: clean — nothing written before the diff is accepted");
  await runInTerminal(t.page, "git status", /nothing to commit, working tree clean/, 30_000);
  t.mark("C:git-clean");
  await t.hold(3200);
  await closeTerminal(t.page);
  // accept the diff (same path as Task A) and verify
  const row = frame.locator(".queue-row.state-reviewing").first();
  if (!(await lens(t.page, /Accept hunk/).first().isVisible().catch(() => false))) {
    await row.click().catch(() => undefined); // the diff is open already (it opens by itself); only reopen if it is not
    await diffLensOrReopen(t.page, row).catch(() => undefined);
  }
  await t.caption("Task C: review and apply on the fallback model");
  await t.hold(1000);
  await applyAll(t.page, frame);
  await waitDiffClosed(t.page, frame);
  await until("Done", async () => FINAL.test(await statusText(frame)), 30_000, 200).catch(() => undefined);
  await t.caption("Task C: verify — FLASK_DEBUG=off → False");
  await runInTerminal(t.page, VERIFY_CMD, /^False\s*$/m, 60_000);
  t.mark("C:verified-False");
  await t.hold(2400);
  await closeTerminal(t.page);
  // switch the chain back to deepseek/flash (Forge: Switch Model)
  await t.caption("Switch the chain back: Forge: Switch Model → deepseek/flash");
  await runCommand(t.page, "Forge: Switch Model");
  const pick = t.page.locator(".quick-input-widget input.input");
  await pick.waitFor({ state: "visible" });
  await t.page.locator(".quick-input-list .monaco-list-row", { hasText: "broken-endpoint/broken" }).first().waitFor({ state: "visible", timeout: 20_000 });
  await pick.pressSequentially("deepseek/flash", { delay: 40 });
  await t.hold(900);
  await t.page.keyboard.press("Enter");
  t.mark("C:switch-back");
  await t.hold(2200);
  await runCommand(t.page, "Notifications: Clear All Notifications").catch(() => undefined);
  return { fallback: true, pristine: status === "" };
}

async function stopClip(t: Take, env: E2eEnvironment, frame: Frame): Promise<{ stoppedMs: number; clean: boolean }> {
  await t.caption("Stop: a run in progress…");
  await sendPrompt(frame, TASK_B_PROMPT);
  t.mark("S:prompt-sent");
  await until("the run to start", async () => {
    const st = await statusText(frame);
    return st !== "" && !/^(Done|Error|Stopped|Ready)/.test(st);
  }, 60_000, 100);
  await until("streamed output", async () => (await frame.locator(".item.assistant, .item.tool").count()) > 0, 90_000, 150);
  await t.hold(1800);
  await t.caption("Stop: click Stop");
  const stop = frame.getByRole("button", { name: "Stop" });
  const clickedAt = Date.now();
  await stop.click({ timeout: 10_000 });
  t.mark("S:stop-clicked");
  await until("the Stopped state", async () => /^Stopped/.test(await statusText(frame)), 20_000, 50);
  const stoppedMs = Date.now() - clickedAt;
  t.mark("S:stopped");
  await t.caption(`Stop: immediate (${(stoppedMs / 1000).toFixed(1)} s), nothing half-applied`);
  await t.hold(1800);
  await runInTerminal(t.page, "git status", /nothing to commit, working tree clean/, 30_000);
  t.mark("S:git-clean");
  await t.hold(3000);
  await closeTerminal(t.page);
  return { stoppedMs, clean: (await gitStatus(env)) === "" };
}

// ---- Sessions page clip (headless Chrome, frames) -----------------------------------------------------------------------

async function sessionsClip(take: Take, sessionId: string): Promise<{ ok: boolean; detail: string }> {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 } });
    const page = await context.newPage();
    const url = `${BASE_URL.replace(/\/+$/, "")}/sessions?sessionId=${encodeURIComponent(sessionId)}`;
    await page.goto(url, { waitUntil: "load" });
    await page.getByText("EVENT TYPES").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(800);
    const clipDir = join(take.root, "sessions");
    const rec = await createRecorder(page, clipDir);
    const clip: ClipOut = { name: "sessions", kind: "frames", dir: clipDir, rec, speeds: [], marks: [] };
    await rec.start();
    await installOverlay(page);
    const mark = (name: string): void => {
      take.log.mark(name);
      clip.marks.push({ name, at: Date.now() });
    };
    await setCaption(page, "TrueForge Sessions: this run's turns and tool calls");
    mark("B4:sessions-page");
    await page.waitForTimeout(2800);
    const approved = page.getByText("Approved", { exact: true });
    const pills = await approved.count();
    if (pills > 0) {
      await approved.first().scrollIntoViewIfNeeded();
      await setCaption(page, "Approval pauses: each “Approved” is a propose_edit / run_command wait");
      mark("B4:approval-pauses");
      await page.waitForTimeout(2600);
    }
    await setCaption(page, "Agent steps: list_tools → get_tool_info → call_tool (deferred tool loading)");
    const found = await scrollToListingTools(page, 90);
    if (found) {
      for (const re of [/Listing tools/, /get_tool_info: git_diff/, /call_tool: git_diff/]) await page.getByText(re).first().click({ timeout: 2500 }).catch(() => undefined);
      await page.waitForTimeout(500);
      await page.getByText(/Listing tools/).first().scrollIntoViewIfNeeded().catch(() => undefined);
      mark("B4:deferred-loading");
      await page.waitForTimeout(3800);
    }
    clip.endedAt = (await rec.stop()).endedAt;
    take.clips.push(clip);
    await context.close();
    return { ok: found && pills > 0, detail: `${pills} approval pause(s), deferred-loading steps ${found ? "shown" : "NOT found"}` };
  } finally {
    await browser.close();
  }
}

// ---- title card ------------------------------------------------------------------------------------------------------

async function titleCard(file: string): Promise<void> {
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.setContent(`<!doctype html><html><body style="margin:0;width:1920px;height:1080px;background:#1b1612;color:#fff7ea;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center">
      <div style="font-size:150px;font-weight:800;letter-spacing:2px;color:#e8a33d">Forge</div>
      <div style="font-size:44px;margin-top:10px">A coding agent for VS Code, running on TrueForge</div>
      <div style="width:220px;height:4px;background:#e8a33d;margin:46px 0"></div>
      <div style="font-size:54px;font-weight:700">Team Monarch</div>
      <div style="font-size:30px;margin-top:14px;color:#d9c9ad">TrueFoundry Forge-a-thon · Techfest 2026-27 · Team ID TM-2C05ECD8CA7</div>
      <div style="font-size:26px;margin-top:70px;color:#b8a78a;max-width:1400px;line-height:1.4">An automated, scripted run of the real extension — captions only, no narration.<br>Task A inline edit · Task B agent mode · Task C unreachable endpoint → fallback · Stop</div>
      <div style="font-size:26px;margin-top:40px;color:#e8a33d">#TrueForge  #Forgeathon  #Monarch</div></body></html>`);
    await page.screenshot({ path: file, type: "jpeg", quality: 95 });
  } finally {
    await browser.close();
  }
}

// ---- main ------------------------------------------------------------------------------------------------------------------

async function ensureEncoder(): Promise<string> {
  const bin = join(ROOT, "e2e-output", "video", "bin", "assemble");
  if (!existsSync(bin)) {
    await mkdir(join(ROOT, "e2e-output", "video", "bin"), { recursive: true });
    await exec("swiftc", ["-O", join(ROOT, "scripts", "video", "assemble.swift"), "-o", bin], { timeout: 300_000 });
  }
  return bin;
}

interface Row {
  rubric: string;
  what: string;
  mark: string;
}
const TIMESTAMPS: Row[] = [
  { rubric: "A1", what: "Task A: per-hunk diff shown (Accept hunk / Reject hunk)", mark: "A1:per-hunk-diff" },
  { rubric: "A1", what: "Task A: verified, FLASK_DEBUG=off prints False", mark: "A:verified-False" },
  { rubric: "B2", what: "Undo shown: one Cmd+Z", mark: "A:undo" },
  { rubric: "A2", what: "Task B: prompt sent (no files named)", mark: "B:prompt-sent" },
  { rubric: "B1", what: "Task B: Context section with reasons", mark: "B1:context-section" },
  { rubric: "B2", what: "Task B: first diff review", mark: "B:first-diff" },
  { rubric: "A2", what: "Task B: run_command approval card", mark: "B:run_command-approval" },
  { rubric: "A2", what: "Task B: pytest tests/test_cli.py -q", mark: "B:pytest" },
  { rubric: "A2", what: "Task B: flask --help lists config", mark: "B:flask-help" },
  { rubric: "A2", what: "Task B: masked JSON from a demo app", mark: "B:masked-json" },
  { rubric: "B4", what: "TrueForge Sessions page (turns, tool calls)", mark: "B4:sessions-page" },
  { rubric: "B4", what: "Sessions: approval pauses", mark: "B4:approval-pauses" },
  { rubric: "B4", what: "Sessions: Agent steps open (list_tools / get_tool_info / call_tool)", mark: "B4:deferred-loading" },
  { rubric: "B3", what: "Task C: automatic fallback notice", mark: "C:fallback" },
  { rubric: "B3", what: "Task C: git status clean", mark: "C:git-clean" },
  { rubric: "A3", what: "Stop clicked mid-stream", mark: "S:stop-clicked" },
  { rubric: "A3", what: "Stopped state shown", mark: "S:stopped" },
  { rubric: "A3", what: "Stop: git status clean", mark: "S:git-clean" },
];

async function main(): Promise<number> {
  const takeNo = process.env["TAKE"] ?? String(Date.now());
  const videoDir = join(ROOT, "e2e-output", "video");
  const root = join(videoDir, `take-${takeNo}`);
  await rm(root, { recursive: true, force: true });
  await mkdir(root, { recursive: true });
  const ledgerFile = join(ROOT, "eval-output", "ledger.jsonl");
  const totals = totalsOf(await readLedger(ledgerFile));
  console.log(`Video take ${takeNo}: estimated cost about ${ESTIMATED_TOKENS.toLocaleString("en-US")} tokens = ${formatUsd(estimatedSpendUsd(ESTIMATED_TOKENS))}; running total ${formatUsd(estimatedSpendUsd(totals.total))} of ${formatUsd(DEFAULT_SPEND_LIMIT_USD)}`);
  const gate = checkLimits(totals, { usd: DEFAULT_SPEND_LIMIT_USD });
  if (!gate.ok) {
    console.error(gate.reason);
    return 4;
  }
  if (!(await snapshotTrueForge())) throw new Error("TrueForge is not reachable; start it with npm run tf:start");
  const encoder = await ensureEncoder();
  const title = join(root, "title.jpg");
  await titleCard(title);

  const env = await createEnvironment({ defaultSettings: true });
  // a demo app for `flask config` (outside the Flask checkout, so git status stays clean) and a plain `$ ` terminal
  const demoDir = join(env.temp, "demo");
  await mkdir(demoDir, { recursive: true });
  await writeFile(join(demoDir, "demo_app.py"), 'from flask import Flask\n\napp = Flask(__name__)\napp.config.update(SECRET_KEY="s3cr3t-demo", API_TOKEN="tok-demo-123", DB_PASSWORD="hunter2", SERVICE_KEY="key-demo-999", APP_NAME="forge-demo")\n', "utf8");
  await env.updateSettings({
    "terminal.integrated.defaultProfile.osx": "forge-demo",
    "terminal.integrated.shellIntegration.enabled": false,
    "terminal.integrated.gpuAcceleration": "off",
    "terminal.integrated.fontSize": 15,
    "terminal.integrated.profiles.osx": {
      "forge-demo": {
        path: "/bin/zsh",
        args: ["-f"],
        env: {
          PS1: "$ ",
          PATH: `${join(env.workspace.root, ".venv", "bin")}:/usr/bin:/bin:/usr/sbin:/sbin:/opt/homebrew/bin`,
          PYTHONPATH: `${join(env.workspace.root, "src")}:${demoDir}`,
          FLASK_APP: "demo_app",
          PYTHONDONTWRITEBYTECODE: "1",
        },
      },
    },
    "window.zoomLevel": 1,
    "editor.codeLensFontSize": 15, // the per-hunk Accept/Reject lenses must be readable at 1080p after video compression
    "editor.minimap.enabled": false,
    "workbench.colorTheme": "Default Dark Modern",
    "workbench.statusBar.visible": true,
    "workbench.layoutControl.enabled": false,
    "window.title": "Forge — Flask 3.1.3",
    "git.blame.statusBarItem.enabled": false,
    "git.blame.editorDecoration.enabled": false,
    "git.openRepositoryInParentFolders": "never",
  });
  const checks: Array<{ name: string; ok: boolean; detail: string }> = [];
  const check = (name: string, ok: boolean, detail: string): void => {
    checks.push({ name, ok, detail });
    console.log(`  CHECK ${ok ? "PASS" : "FAIL"} ${name}: ${detail}`);
  };
  let launched: Launched | undefined;
  let take: Take | undefined;
  let tokens = 0;
  let sessionsDetail = "";
  let failure = "";
  try {
    // the INSTALLED build (the .vsix), not the development path: no "Extension Development Host" title, no "extensions disabled" banner
    const code = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
    const vsix = join(ROOT, "forge-agent-0.0.1.vsix");
    await exec(code, ["--install-extension", vsix, "--force", `--extensions-dir=${env.extensions}`, `--user-data-dir=${env.userData}`], { timeout: 120_000 });
    launched = await launch(env, { video: false, installed: true });
    const page = launched.page;
    await page.setViewportSize({ width: 1920, height: 1080 }); // the window is clamped to the screen height; emulate a true 1080p viewport
    take = new Take(page, root);
    await installOverlay(page);
    await runCommand(page, "Notifications: Clear All Notifications").catch(() => undefined);
    let frame = await openPanel(page);
    // a wider Forge panel (the default side bar is narrow at 120% zoom): focus the side bar and grow it
    await runCommand(page, "View: Focus Side Bar").catch(() => undefined);
    for (let i = 0; i < 3; i++) await runCommand(page, "View: Increase Current View Size").catch(() => undefined);
    take.clips.push({ name: "title", kind: "still", file: title, seconds: 3.5, speeds: [], marks: [] });

    // ---- Task A ----
    await take.begin("taskA");
    const a = await taskA(take, env, frame);
    await take.end();
    check("Task A: verify-task-a", (await verify("task-a", env)).pass, "scripts/verify-task-a.sh");
    check("Task A: Cmd+Z once changed the editor", a.undoOk, a.undoOk ? "the text changed after one undo" : "no change after Cmd+Z");
    check("Task A: redo restored it", a.redoOk, a.redoOk ? "the tab is clean again after redo" : "text differs after redo");
    await resetWorkspace(env);
    await page.waitForTimeout(800);

    // ---- Task B ----
    frame = await panelFrame(page);
    await newChat(frame);
    await take.begin("taskB");
    const b = await taskB(take, env, frame);
    const bv = await taskBVerification(take, env);
    await take.end();
    const vb = await verify("task-b", env);
    check("Task B: verify-task-b", vb.pass, await verifySummary("task-b", vb.out));
    check("Task B: pytest in the terminal", bv.tests === "passed", bv.tests);
    check("Task B: flask --help lists config", bv.help === "lists config", bv.help);
    check("Task B: masked JSON", bv.json === "masked", bv.json);
    check("Task B: Context section shown with reasons", b.contextShown, `${b.reviews} review(s), ${b.commandsAllowed} command card(s) allowed`);

    // ---- Sessions page for this run ----
    const details = await fetchSessionDetails(BASE_URL, env.prefix);
    const bSession = [...details].reverse().find((d) => d.agent.endsWith("forge-agent"));
    if (!bSession) throw new Error("no Task B session found in TrueForge");
    // what the Task B session really did (for the write-up: claim only what happened)
    {
      const get = async <T>(path: string): Promise<T> => (await fetch(`${BASE_URL}/api/v1${path}`)).json() as Promise<T>;
      const turns = (await get<{ data: Array<{ id: string }> }>(`/sessions/${bSession.id}/turns`)).data;
      const types: Record<string, number> = {};
      const toolNames: Record<string, number> = {};
      let subagentEvidence = 0;
      let maxInput = 0;
      for (const tr of turns) {
        for (const e of (await get<{ data: Array<{ type: string; tool_calls?: Array<{ function?: { name?: string } }>; usage?: { prompt_tokens?: number; input_tokens?: number } }> }>(`/sessions/${bSession.id}/turns/${tr.id}/events`)).data) {
          types[e.type] = (types[e.type] ?? 0) + 1;
          for (const c of e.tool_calls ?? []) toolNames[c.function?.name ?? "?"] = (toolNames[c.function?.name ?? "?"] ?? 0) + 1;
          if (/subagent|sub_agent|spawn/i.test(e.type) || (e.tool_calls ?? []).some((c) => /spawn|subagent/i.test(c.function?.name ?? ""))) subagentEvidence++;
          maxInput = Math.max(maxInput, e.usage?.prompt_tokens ?? e.usage?.input_tokens ?? 0);
        }
      }
      await writeFile(join(root, "taskB-session.json"), JSON.stringify({ sessionId: bSession.id, turns: turns.length, tokensIn: bSession.input, tokensOut: bSession.output, eventTypes: types, toolCalls: toolNames, subagentEvidence, maxInputSeen: maxInput }, null, 2), "utf8");
      console.log(`  Task B session: ${turns.length} turns, ${bSession.input + bSession.output} tokens, tool calls ${JSON.stringify(toolNames)}, subagent evidence: ${subagentEvidence}`);
    }
    const s = await sessionsClip(take, bSession.id);
    sessionsDetail = s.detail;
    check("Sessions page: approval pauses and deferred loading visible", s.ok, s.detail);

    // ---- Task C ----
    await resetWorkspace(env);
    await page.waitForTimeout(800);
    frame = await panelFrame(page);
    await take.begin("taskC");
    const c = await taskC(take, env, frame);
    await take.end();
    check("Task C: fallback notice shown", c.fallback, "switched to deepseek/flash");
    check("Task C: git status clean before apply", c.pristine, c.pristine ? "clean" : "NOT clean");
    check("Task C: verify-task-a on the fallback model", (await verify("task-a", env)).pass, "scripts/verify-task-a.sh");

    // ---- Stop ----
    await resetWorkspace(env);
    await page.waitForTimeout(800);
    frame = await panelFrame(page);
    await newChat(frame);
    await take.begin("stop");
    const st = await stopClip(take, env, frame);
    await take.end();
    check("Stop: stopped state within 2 s", st.stoppedMs <= 2000, `${(st.stoppedMs / 1000).toFixed(2)} s`);
    check("Stop: git status clean", st.clean, st.clean ? "clean" : "NOT clean");
    await page.screenshot({ path: join(root, "last-frame.png") }).catch(() => undefined);
  } catch (err) {
    failure = describeError(err);
    console.error(`TAKE FAILED: ${failure}`);
    if (launched) await launched.page.screenshot({ path: join(root, "failure.png") }).catch(() => undefined);
    await take?.end().catch(() => undefined);
  } finally {
    await launched?.app.close().catch(() => undefined);
    const usage = await fetchSessionUsage(BASE_URL, env.prefix).catch(() => undefined);
    tokens = usage ? usage.input + usage.output : ESTIMATED_TOKENS;
    await env.cleanup();
  }
  await appendLedger(ledgerFile, { runId: `video-take-${takeNo}`, task: "video", model: "deepseek/*", attempt: 1, input: tokens, output: 0, at: new Date().toISOString() });
  console.log(`\nSpend of this take: ${tokens.toLocaleString("en-US")} tokens = ${formatUsd(estimatedSpendUsd(tokens))} (from TrueForge session records)`);
  if (!take) return 2;

  // ---- encode ----
  const manifestClips = take.clips.map((c) =>
    c.kind === "still"
      ? { kind: "still", name: c.name, file: c.file, seconds: c.seconds }
      : (() => {
          const rec = c.rec as FrameRecorder;
          return {
            kind: "frames",
            name: c.name,
            index: join(c.dir as string, "frames.json"),
            ...(c.endedAt !== undefined ? { trimEnd: rec.rel(c.endedAt) } : {}),
            dir: c.dir,
            speeds: c.speeds.map((s) => ({ t0: rec.rel(s.from), t1: rec.rel(s.to), factor: 3 })),
            marks: c.marks.map((m) => ({ name: m.name, t: rec.rel(m.at) })),
          };
        })(),
  );
  const out = join(root, "forge-round1-submission.mp4");
  const marksFile = join(root, "marks.json");
  await writeFile(join(root, "manifest.json"), JSON.stringify({ out, marksOut: marksFile, width: 1920, height: 1080, fps: 30, clips: manifestClips }, null, 2), "utf8");
  await writeFile(join(root, "events.json"), JSON.stringify({ events: take.log.events }, null, 2), "utf8");
  const enc = await exec(encoder, [join(root, "manifest.json")], { maxBuffer: 20_000_000, timeout: 900_000 }).catch((e: { stderr?: string; message: string }) => ({ stdout: "", stderr: e.stderr ?? e.message }));
  console.log(enc.stdout.trim() || `ENCODER FAILED: ${enc.stderr}`);
  if (!existsSync(out)) return 3;
  const dur = (await videoDurationSeconds([out]).catch(() => []))[0];
  const marks = JSON.parse(await readFile(marksFile, "utf8")) as { duration: number; marks: Record<string, number> };
  const fmt = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}`;
  const rows = TIMESTAMPS.map((r) => ({ ...r, at: marks.marks[r.mark] }));
  const table = ["| Rubric | What is on screen | Time in the MP4 |", "|---|---|---|", ...rows.map((r) => `| ${r.rubric} | ${r.what} | ${r.at !== undefined ? fmt(r.at) : "NOT RECORDED"} |`)].join("\n");
  const total = dur?.seconds ?? marks.duration;
  const allMarks = rows.every((r) => r.at !== undefined);
  check("all timestamps recorded", allMarks, allMarks ? "yes" : rows.filter((r) => r.at === undefined).map((r) => r.mark).join(", "));
  check(`duration under 3:55`, total < MAX_TOTAL_SECONDS, formatDuration(total));
  const pass = checks.every((c) => c.ok) && failure === "";
  const report = { take: takeNo, pass, durationSeconds: total, file: out, failure, checks, marks: marks.marks, speeds: take.clips.map((c) => ({ clip: c.name, speedups: c.speeds.length })), sessions: sessionsDetail, tokens, table };
  await writeFile(join(root, "report.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\nTAKE ${takeNo}: ${pass ? "PASS" : "FAIL"}   duration ${formatDuration(total)} (${total.toFixed(1)} s)   file ${out}\n\n${table}\n\nChecks:\n${checks.map((c) => `- ${c.ok ? "PASS" : "FAIL"} ${c.name}: ${c.detail}`).join("\n")}`);
  // keep the frames only for a failed take (to inspect); a passing take keeps the mp4 + reports
  if (pass) {
    if (process.env["KEEP_FRAMES"] !== "1") for (const c of take.clips) if (c.kind === "frames" && c.dir) await rm(c.dir, { recursive: true, force: true });
    await copyFile(out, join(videoDir, `candidate-take-${takeNo}.mp4`));
    if (total <= GOOD_TOTAL_SECONDS) console.log(`This take is under ${formatDuration(GOOD_TOTAL_SECONDS)}: good enough, stop here.`);
  }
  void rename;
  return pass ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`video take failed: ${describeError(err)}`);
    process.exit(2);
  },
);
