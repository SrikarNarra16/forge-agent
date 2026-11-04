import { execFile } from "node:child_process";
import { existsSync, readdirSync, unlinkSync } from "node:fs";
import { mkdir, readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { _electron as electron, type ElectronApplication, type Frame, type Page } from "playwright-core";
import { ROOT, vscodeExecutable, type E2eEnvironment } from "../env";

/**
 * Layer 2 helpers: drive the real VS Code workbench with Playwright. The Forge panel is a webview, i.e. a nested iframe,
 * so it is found by traversing frames (the one that contains the composer textarea), and every wait is a condition
 * (locator auto-waiting or `until`), never a fixed sleep. Only the REAL UI is used: no test hooks (FORGE_E2E is not set).
 */
const exec = promisify(execFile);
export const MOD = process.platform === "darwin" ? "Meta" : "Control";

export interface Screens {
  dir: string;
  shot(page: Page, name: string): Promise<void>;
}

export async function makeScreens(): Promise<Screens> {
  const dir = join(ROOT, "e2e-output", "screens");
  await mkdir(dir, { recursive: true });
  for (const f of readdirSync(dir)) if (f.endsWith(".png")) unlinkSync(join(dir, f)); // only this run's screenshots in the folder
  let n = 0;
  return {
    dir,
    async shot(page, name) {
      n++;
      await page.screenshot({ path: join(dir, `${String(n).padStart(2, "0")}-${name}.png`) });
      console.log(`  screenshot ${String(n).padStart(2, "0")}-${name}.png`);
    },
  };
}

export interface Launched {
  app: ElectronApplication;
  page: Page;
}

/** Playwright records video with its own ffmpeg build; without it launching with recordVideo hangs VS Code's window. */
export function assertFfmpeg(): void {
  const cache = process.env["PLAYWRIGHT_BROWSERS_PATH"] ?? join(homedir(), process.platform === "darwin" ? "Library/Caches/ms-playwright" : ".cache/ms-playwright");
  const found = existsSync(cache) && readdirSync(cache).some((d) => d.startsWith("ffmpeg"));
  if (!found) throw new Error("Playwright's ffmpeg is missing (needed for video). Run once: npx playwright-core install ffmpeg");
}

export async function launch(env: E2eEnvironment, options: { video: boolean }): Promise<Launched> {
  if (options.video) assertFfmpeg();
  const videoDir = join(ROOT, "e2e-output", "video");
  await mkdir(videoDir, { recursive: true });
  const app = await electron.launch({
    executablePath: vscodeExecutable(),
    args: [...env.launchArgs, `--extensionDevelopmentPath=${ROOT}`],
    env: { ...(process.env as Record<string, string>), FORGE_RESOURCE_PREFIX: env.prefix },
    timeout: 90_000,
    ...(options.video ? { recordVideo: { dir: videoDir, size: { width: 1920, height: 1080 } } } : {}),
  });
  const page = await app.firstWindow({ timeout: 90_000 });
  await app.evaluate(({ BrowserWindow }) => {
    const w = BrowserWindow.getAllWindows()[0];
    w?.setSize(1920, 1080);
    w?.center();
  });
  await page.waitForSelector(".monaco-workbench", { timeout: 90_000 });
  return { app, page };
}

export async function until<T>(what: string, fn: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 60_000, everyMs = 250): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const v = await fn();
    if (v) return v;
    await new Promise((r) => setTimeout(r, everyMs));
  }
  throw new Error(`timed out after ${timeoutMs / 1000} s waiting for ${what}`);
}

export async function runCommand(page: Page, title: string): Promise<void> {
  await page.keyboard.press(`${MOD}+Shift+P`);
  const input = page.locator(".quick-input-widget input.input");
  await input.waitFor({ state: "visible" });
  await input.fill(`>${title}`);
  await page.locator(".quick-input-list .monaco-list-row", { hasText: title }).first().waitFor({ state: "visible" });
  await page.keyboard.press("Enter");
}

/** The webview frame that holds the Forge panel (found by its composer textarea). */
export async function panelFrame(page: Page): Promise<Frame> {
  return until("the Forge panel webview", async () => {
    for (const frame of page.frames()) {
      if ((await frame.locator('textarea[placeholder^="Ask Forge"]').count().catch(() => 0)) > 0) return frame;
    }
    return undefined;
  }, 60_000, 500);
}

export async function openPanel(page: Page): Promise<Frame> {
  await runCommand(page, "Forge: Open Agent");
  return panelFrame(page);
}

export async function sendPrompt(frame: Frame, prompt: string): Promise<void> {
  const box = frame.locator('textarea[placeholder^="Ask Forge"]');
  await box.fill(prompt);
  await box.press("Enter");
}

export const statusText = async (frame: Frame): Promise<string> => ((await frame.locator(".status-text").first().textContent().catch(() => "")) ?? "").trim();

export interface DriveLog {
  commandsAllowed: number;
  reviewsApplied: number;
  /** How many of those were applied with the panel's "Apply accepted" button (the rest with Cmd/Ctrl+Enter, the fallback). */
  appliedWithPanelButton: number;
  lensSeen: boolean;
}

/**
 * Drives a run to its end with real clicks: Allow on command cards, "Review diff" on each queue entry, then the
 * CodeLens "Accept all" in the diff and the panel's "Apply accepted" button (Cmd+Enter only as a fallback). Returns when the panel says Done / Error / Stopped.
 */
export async function drive(page: Page, frame: Frame, screens: Screens, options: { timeoutMs: number; prefix?: string }): Promise<DriveLog> {
  const log: DriveLog = { commandsAllowed: 0, reviewsApplied: 0, appliedWithPanelButton: 0, lensSeen: false };
  const deadline = Date.now() + options.timeoutMs;
  let shotCommand = false;
  while (Date.now() < deadline) {
    const status = await statusText(frame);
    if (["Done", "Error", "Stopped"].includes(status) && (await frame.locator(".queue-row.state-reviewing").count()) === 0) return log;

    const allow = frame.locator(".approval button.primary:not([disabled])", { hasText: "Allow" }).first(); // a decided card keeps its (disabled) buttons
    if (await allow.isVisible().catch(() => false)) {
      if (!shotCommand) {
        shotCommand = true;
        await screens.shot(page, "command-approval-card");
      }
      // the card may have been decided by the time we click; count only clicks that happened
      if (await allow.click({ timeout: 10_000 }).then(() => true, () => false)) log.commandsAllowed++;
      continue;
    }

    const row = frame.locator(".queue-row.state-reviewing").first();
    if (await row.isVisible().catch(() => false)) {
      await row.click(); // "Review diff" from the queue
      const lens = page.getByText("Accept hunk").first();
      await lens.waitFor({ state: "visible", timeout: 30_000 }); // CodeLens rendered in the real diff editor
      if (!log.lensSeen) {
        log.lensSeen = true;
        await screens.shot(page, "diff-with-codelens");
      }
      // the "Accept all" lens sits on the first line of the proposal; the diff is revealed at the first hunk, so go to the top
      await page.keyboard.press(`${MOD}+ArrowUp`);
      const acceptAll = page.locator('a[role="button"]', { hasText: /^Accept all$/ }).locator("visible=true").first();
      await acceptAll.click({ timeout: 15_000 });
      // Apply with the panel's own button (the same command as Cmd/Ctrl+Enter); the keyboard stays as a fallback
      const applyButton = frame.getByRole("button", { name: "Apply accepted" }).locator("visible=true").first();
      if (await applyButton.click({ timeout: 8_000 }).then(() => true, () => false)) log.appliedWithPanelButton++;
      else await page.keyboard.press(`${MOD}+Enter`); // forge.reviewApply
      log.reviewsApplied++;
      await until("the review to finish", async () => (await frame.locator(".queue-row.state-reviewing").count()) === 0 || (await statusText(frame)) !== "Waiting for your approval", 30_000, 200).catch(() => undefined);
      continue;
    }
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error(`the run did not finish within ${options.timeoutMs / 1000} s (panel status: ${await statusText(frame)})`);
}

export async function verify(script: "task-a" | "task-b", env: E2eEnvironment): Promise<{ pass: boolean; out: string }> {
  const args = script === "task-a" ? [join(ROOT, "scripts", "verify-task-a.sh")] : [join(ROOT, "scripts", "verify-task-b.sh"), env.workspace.root];
  try {
    const r = await exec("bash", args, { env: { ...process.env, FIXTURE_DIR: env.workspace.root, PYTHON: env.workspace.python }, maxBuffer: 20_000_000, timeout: 300_000 });
    return { pass: true, out: r.stdout };
  } catch (err) {
    const e = err as { stdout?: string; stderr?: string; message: string };
    return { pass: false, out: (e.stdout ?? "") + (e.stderr ?? e.message) };
  }
}

export async function gitStatus(env: E2eEnvironment): Promise<string> {
  return (await exec("git", ["status", "--porcelain", "-uall"], { cwd: env.workspace.root })).stdout.trim();
}

export async function readWorkspaceFile(env: E2eEnvironment, rel: string): Promise<string> {
  return readFile(join(env.workspace.root, rel), "utf8");
}
