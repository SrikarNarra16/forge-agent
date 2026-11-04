/**
 * Install check of the packaged extension: installs the .vsix into a brand-new EMPTY VS Code profile (new user-data-dir
 * and extensions dir), starts that VS Code WITHOUT a development path (so it is the installed copy that runs), and
 * checks activation, the panel, the commands and the registration in TrueForge. No model is called.
 *
 *   TRUEFORGE_BASE_URL=http://localhost:8791 npm run test:vsix -- forge-agent-0.0.1.vsix
 *
 * SAFETY: the installed extension registers its resources under the DEFAULT names (forge-editor, forge-agent, ...), so
 * TRUEFORGE_BASE_URL must point at a SEPARATE TrueForge (own port, own database: README, Troubleshooting). The script
 * refuses to run against the default address, where your own forge-* resources live.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { _electron as electron } from "playwright-core";
import { describeError } from "../../src/trueforge/client";
import { BASE_URL, createEnvironment, snapshotTrueForge, vscodeExecutable } from "../env";
import { makeScreens, runCommand, until } from "./driver";

const exec = promisify(execFile);

function codeCli(): string {
  if (process.env["VSCODE_CLI"]) return process.env["VSCODE_CLI"];
  const bundled = resolve(vscodeExecutable(), "..", "..", "Resources", "app", "bin", "code"); // macOS layout
  return existsSync(bundled) ? bundled : "code";
}

async function main(): Promise<number> {
  const vsix = process.argv[2];
  if (!vsix || !existsSync(vsix)) throw new Error("usage: TRUEFORGE_BASE_URL=http://localhost:8791 npm run test:vsix -- <file.vsix>");
  if (!process.env["TRUEFORGE_BASE_URL"] || /^https?:\/\/(localhost|127\.0\.0\.1):8790\/?$/.test(BASE_URL)) {
    throw new Error("Refusing to run against the default TrueForge (port 8790): the installed extension registers forge-editor / forge-agent there. Start a separate one (npm run tf:start -- --port 8791 with its own SQLITE_PATH) and set TRUEFORGE_BASE_URL.");
  }
  const rows: Array<{ step: string; ok: boolean; detail: string }> = [];
  const check = (step: string, ok: boolean, detail: string): void => {
    rows.push({ step, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
    if (!ok) throw new Error(`${step}: ${detail}`);
  };

  // workspace + a fresh profile come from the shared isolation; its explicit prefix is removed so the DEFAULT names are used
  const env = await createEnvironment({ extraSettings: { "forge.trueforge.baseUrl": BASE_URL, "forge.resourcePrefix": "", "forge.commandPrefix": "" } });
  const screens = await makeScreens();
  const extDir = join(env.temp, "installed-extensions");
  let app: Awaited<ReturnType<typeof electron.launch>> | undefined;
  try {
    await mkdir(extDir, { recursive: true });
    const cli = codeCli();
    const base = ["--user-data-dir", env.userData, "--extensions-dir", extDir];
    const installed = await exec(cli, [...base, "--install-extension", resolve(vsix)], { timeout: 120_000 });
    check("install into an empty profile", /successfully installed/i.test(installed.stdout + installed.stderr), (installed.stdout + installed.stderr).trim().split("\n").pop() ?? "");
    const listed = (await exec(cli, [...base, "--list-extensions", "--show-versions"], { timeout: 60_000 })).stdout.trim();
    check("extension is listed", /forge-local\.forge-agent@/.test(listed), listed);

    // the same launch arguments as the other layers, but WITH extensions enabled and our installed-extensions dir, and no development path
    const args = env.launchArgs.filter((a) => a !== "--disable-extensions" && !a.startsWith("--extensions-dir=")).concat(`--extensions-dir=${extDir}`);
    app = await electron.launch({ executablePath: vscodeExecutable(), args, env: { ...(process.env as Record<string, string>) }, timeout: 90_000 });
    const page = await app.firstWindow({ timeout: 90_000 });
    await page.waitForSelector(".monaco-workbench", { timeout: 90_000 });

    await runCommand(page, "Forge: Open Agent");
    const frame = await until("the Forge panel", async () => {
      for (const f of page.frames()) if ((await f.locator('textarea[placeholder^="Ask Forge"]').count().catch(() => 0)) > 0) return f;
      return undefined;
    }, 60_000, 500);
    check("panel opens", true, "composer textarea found in the Forge webview");
    await until("the status bar to say TrueForge is connected", async () => (await page.locator(".statusbar-item", { hasText: "TrueForge: connected" }).count()) > 0, 60_000, 500);
    check("connected to TrueForge", true, `status bar: TrueForge: connected (${BASE_URL})`);

    // the commands exist
    await page.keyboard.press(process.platform === "darwin" ? "Meta+Shift+P" : "Control+Shift+P");
    const input = page.locator(".quick-input-widget input.input");
    await input.fill(">Forge:");
    await until("the Forge commands in the palette", async () => (await page.locator(".quick-input-list .monaco-list-row").count()) >= 10, 15_000, 250);
    const n = await page.locator(".quick-input-list .monaco-list-row", { hasText: "Forge:" }).count();
    check("commands registered", n >= 10, `${n} "Forge:" commands in the Command Palette`);
    await page.keyboard.press("Escape");

    // the review UI works without a model
    await runCommand(page, "Forge: Fake Proposal");
    await page.locator('a[role="button"]', { hasText: /Accept hunk/ }).locator("visible=true").first().waitFor({ state: "visible", timeout: 15_000 });
    check("review diff with CodeLens", true, "Accept hunk lens visible");
    await frame.getByRole("button", { name: "Reject all" }).click();
    await frame.locator(".review-outcome", { hasText: "Rejected: nothing was written." }).first().waitFor({ state: "visible", timeout: 15_000 });
    check("Reject all from the panel", true, "nothing was written");
    await screens.shot(page, "vsix-installed");

    // the installed extension registered itself in the (separate) TrueForge
    const snap = await snapshotTrueForge();
    check("registered in TrueForge", !!snap && ["forge-agent", "forge-inline"].every((a) => snap.agents.includes(a)) && ["forge-editor", "forge-editor-extras"].every((m) => snap.mcp.includes(m)), `agents: ${snap?.agents.join(", ")}; MCP servers: ${snap?.mcp.join(", ")}`);
  } catch (err) {
    if (!rows.some((r) => !r.ok)) rows.push({ step: "install check", ok: false, detail: describeError(err) });
  } finally {
    await app?.close().catch(() => undefined);
    await env.cleanup();
  }
  console.log(`\n| Result | Step | Detail |\n|---|---|---|\n${rows.map((r) => `| ${r.ok ? "PASS" : "FAIL"} | ${r.step} | ${r.detail.replace(/\|/g, "\\|").slice(0, 200)} |`).join("\n")}`);
  return rows.every((r) => r.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(describeError(err));
    process.exit(2);
  },
);
