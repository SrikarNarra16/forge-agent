/**
 * Layer 2: UI smoke test / rehearsal with Playwright against the real VS Code (best effort, clearly separate from Layer 1).
 *
 *   npm run test:ui            Task B through the Forge panel, with real clicks, then scripts/verify-task-b.sh
 *   npm run e2e:rehearsal      Tasks A (inline), B (panel) and C (fallback) in order; saves video + screenshots
 *
 * AUTOMATED: opening the Forge view, typing the prompt, Enter, waiting for streamed text, Allow on command cards, "Review diff"
 * on each queue entry, asserting the "Accept hunk" CodeLens text in the real diff editor, the "Accept all" lens, Cmd+Enter,
 * waiting for "Done", the verify script. For Task A: Quick Open, Go to Line, the keyboard selection, Cmd+Alt+K, typing the
 * instruction. NOT automated: nothing the script cannot see (see docs/e2e.md for the known limits).
 * Output: e2e-output/screens/*.png and e2e-output/video/*.webm (1920x1080). Costs real tokens (estimated and guarded).
 */
import { appendFile, readdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { DEFAULT_SPEND_LIMIT_USD, appendLedger, checkLimits, estimatedSpendUsd, formatUsd, readLedger, totalsOf } from "../../scripts/eval/ledger";
import { describeError } from "../../src/trueforge/client";
import { ROOT, createEnvironment, snapshotTrueForge, type E2eEnvironment } from "../env";
import { MOD, drive, gitStatus, launch, makeScreens, openPanel, panelFrame, readWorkspaceFile, sendPrompt, statusText, until, verify, type Launched, type Screens } from "./driver";

const exec = promisify(execFile);
const TASK_A_INSTRUCTION = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value";
const TASK_B_PROMPT =
  'Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.';
const ESTIMATED_TOKENS = { b: 1_000_000, rehearsal: 1_100_000 } as const;

interface StepResult {
  step: string;
  ok: boolean;
  detail: string;
  seconds: number;
}

async function selectGetDebugFlag(page: Launched["page"], env: E2eEnvironment): Promise<void> {
  const text = await readWorkspaceFile(env, "src/flask/helpers.py");
  const lines = text.split("\n");
  const def = lines.findIndex((l) => l.startsWith("def get_debug_flag"));
  let end = def;
  while (end + 1 < lines.length && lines[end + 1] !== "" && /^\s/.test(lines[end + 1] ?? "")) end++;
  // Quick Open understands `file:line`, so one step opens the file with the cursor on the `def` line
  await page.keyboard.press(`${MOD}+P`);
  const input = page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible" });
  await input.fill(`src/flask/helpers.py:${def + 1}`);
  await page.locator(".quick-input-list .monaco-list-row", { hasText: "helpers.py" }).first().waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
  await page.locator(".quick-input-widget").waitFor({ state: "hidden" });
  await page.locator(".tab.active", { hasText: "helpers.py" }).waitFor({ state: "visible" });
  await page.locator(".monaco-editor .current-line").first().waitFor({ state: "visible" });
  await page.keyboard.press("Home");
  for (let i = 0; i < end - def; i++) await page.keyboard.press("Shift+ArrowDown");
  await page.keyboard.press("Shift+End");
}

async function inlineTaskA(page: Launched["page"], env: E2eEnvironment, frame: Awaited<ReturnType<typeof panelFrame>>, screens: Screens, tag: string): Promise<void> {
  await selectGetDebugFlag(page, env);
  await screens.shot(page, `${tag}-selection`);
  await page.keyboard.press(`${MOD}+Alt+K`);
  const input = page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible" });
  await input.fill(TASK_A_INSTRUCTION);
  await page.keyboard.press("Enter");
  void frame;
}

async function resetWorkspace(env: E2eEnvironment): Promise<void> {
  await exec("git", ["checkout", "-q", "--", "."], { cwd: env.workspace.root });
  await exec("git", ["clean", "-fdq"], { cwd: env.workspace.root });
}

async function taskB(l: Launched, env: E2eEnvironment, screens: Screens, results: StepResult[]): Promise<void> {
  const t0 = Date.now();
  const frame = await openPanel(l.page);
  await screens.shot(l.page, "B-panel-open");
  await sendPrompt(frame, TASK_B_PROMPT);
  await frame.locator(".item.assistant").first().waitFor({ state: "visible", timeout: 120_000 });
  await screens.shot(l.page, "B-streaming");
  const log = await drive(l.page, frame, screens, { timeoutMs: 600_000 });
  await screens.shot(l.page, "B-done");
  const v = await verify("task-b", env);
  results.push({ step: "Task B (panel)", ok: v.pass && log.lensSeen, detail: `${log.commandsAllowed} command card(s) allowed, ${log.reviewsApplied} review(s) applied (${log.appliedWithPanelButton} with the panel's "Apply accepted" button, the rest with ${MOD}+Enter), CodeLens text seen: ${log.lensSeen}; verify-task-b ${v.pass ? "PASS" : `FAIL\n${v.out.slice(-600)}`}`, seconds: (Date.now() - t0) / 1000 });
}

async function main(): Promise<number> {
  const mode = process.argv[2] === "rehearsal" ? "rehearsal" : "b";
  const ledgerFile = join(ROOT, "eval-output", "ledger.jsonl");
  const totals = totalsOf(await readLedger(ledgerFile));
  const estimate = ESTIMATED_TOKENS[mode];
  console.log(`UI ${mode === "b" ? "smoke test (Task B)" : "rehearsal (Tasks A, B, C)"}: estimated cost about ${estimate.toLocaleString("en-US")} tokens = ${formatUsd(estimatedSpendUsd(estimate))}; running total ${formatUsd(estimatedSpendUsd(totals.total))} of ${formatUsd(DEFAULT_SPEND_LIMIT_USD)}`);
  const gate = checkLimits(totals, { usd: DEFAULT_SPEND_LIMIT_USD });
  if (!gate.ok) {
    console.error(gate.reason);
    return 4;
  }
  if (!(await snapshotTrueForge())) throw new Error("TrueForge is not reachable; start it with npm run tf:start");

  const env = await createEnvironment();
  const screens = await makeScreens();
  const results: StepResult[] = [];
  let launched: Launched | undefined;
  try {
    launched = await launch(env, { video: true });
    const l = launched;
    await screens.shot(l.page, "start");

    if (mode === "rehearsal") {
      // --- Task A (inline edit) ---
      let t0 = Date.now();
      const frame = await openPanel(l.page);
      await inlineTaskA(l.page, env, frame, screens, "A");
      const logA = await drive(l.page, frame, screens, { timeoutMs: 180_000 });
      const vA = await verify("task-a", env);
      results.push({ step: "Task A (inline)", ok: vA.pass && logA.lensSeen, detail: `${logA.reviewsApplied} review(s) applied (${logA.appliedWithPanelButton} with the panel button); verify-task-a ${vA.pass ? "PASS" : `FAIL\n${vA.out.slice(-500)}`}`, seconds: (Date.now() - t0) / 1000 });
      await screens.shot(l.page, "A-done");
      await resetWorkspace(env);

      // --- Task B (panel) ---
      await taskB(l, env, screens, results);
      await resetWorkspace(env);

      // --- Task C (broken primary -> automatic fallback) ---
      t0 = Date.now();
      await env.updateSettings({ "forge.models": ["broken-endpoint/broken", "deepseek/flash"] });
      await until("VS Code to pick up the new forge.models", async () => true, 1000);
      const frameC = await panelFrame(l.page);
      await inlineTaskA(l.page, env, frameC, screens, "C");
      await frameC.getByText(/switched to deepseek\/flash/).first().waitFor({ state: "visible", timeout: 120_000 }); // the fallback notice in the panel
      await screens.shot(l.page, "C-fallback-notice");
      await frameC.locator(".queue-row.state-reviewing").first().waitFor({ state: "visible", timeout: 120_000 });
      const pristine = await gitStatus(env);
      const logC = await drive(l.page, frameC, screens, { timeoutMs: 180_000 });
      const vC = await verify("task-a", env);
      results.push({ step: "Task C (fallback)", ok: pristine === "" && vC.pass, detail: `fallback notice shown; workspace ${pristine === "" ? "pristine before the first apply" : `NOT pristine: ${pristine}`}; ${logC.reviewsApplied} review(s) applied; verify-task-a ${vC.pass ? "PASS" : "FAIL"}`, seconds: (Date.now() - t0) / 1000 });
      await screens.shot(l.page, "C-done");
    } else {
      await taskB(l, env, screens, results);
    }
    void statusText;
  } catch (err) {
    results.push({ step: "UI flow", ok: false, detail: `stopped: ${describeError(err)}`, seconds: 0 });
    if (launched) await screens.shot(launched.page, "failure").catch(() => undefined);
  } finally {
    await launched?.app.close().catch(() => undefined); // finalises the video
    const videoDir = join(ROOT, "e2e-output", "video");
    const stamp = new Date().toISOString().slice(0, 19).replace(/[:T]/g, "-");
    for (const f of await readdir(videoDir).catch(() => [] as string[])) if (f.endsWith(".webm") && !f.startsWith("ui-")) await rename(join(videoDir, f), join(videoDir, `ui-${mode}-${stamp}.webm`)).catch(() => undefined);
    await env.cleanup();
  }

  await appendLedger(ledgerFile, { runId: `ui-${mode}-${process.pid}`, task: "ui", model: "deepseek/*", attempt: 1, input: estimate, output: 0, at: new Date().toISOString() });
  const rows = results.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.step} | ${r.seconds.toFixed(0)} s | ${r.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 400)} |`);
  const table = ["| Result | Step | Time | Detail |", "|---|---|---|---|", ...rows].join("\n");
  console.log(`\n${table}\n\nScreenshots: e2e-output/screens/   Video: e2e-output/video/ (1920x1080)`);
  await appendFile(join(ROOT, "docs", "e2e-results.md"), `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UI layer, ${mode === "b" ? "Task B smoke test" : "rehearsal A+B+C"}, Playwright)\n\n${table}\n\n`, "utf8");
  return results.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`UI test failed: ${describeError(err)}`);
    process.exit(2);
  },
);
