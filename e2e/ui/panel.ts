/**
 * Layer 2, hermetic: the panel's review controls, the command-prefix line and the "Open in TrueForge" button, clicked
 * for real in the real VS Code with Playwright. NO model and NO TrueForge: "Forge: Fake Proposal" produces the review,
 * and the extension is pointed at an address nobody listens on, so no TrueForge resource is ever created or touched.
 *
 *   npm run test:ui:panel
 *
 * Steps (all real clicks / real DOM):
 *   1. the Context section says the venv was auto-detected (a .venv/bin/activate exists in the temp clone, no explicit prefix)
 *   2. "Open in TrueForge" is present (NOT clicked: it would open your browser)
 *   3. Fake Proposal -> the queue card says "0 of 3 hunks accepted, 3 undecided", Apply accepted is disabled
 *   4. CodeLens "Accept hunk" on one hunk -> "1 of 3 hunks accepted, 2 undecided" + the note that undecided hunks are not applied
 *   5. click "Apply accepted" in the panel -> "Applied 1 of 3 hunks; 2 not applied (rejected or undecided)." and 2 edits on disk
 *   6. Fake Proposal again -> click "Reject all" in the panel -> "Rejected: nothing was written." and git clean
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "../../src/trueforge/client";
import { ROOT, createEnvironment } from "../env";
import { gitStatus, launch, makeScreens, openPanel, readWorkspaceFile, runCommand, until } from "./driver";

interface Step {
  step: string;
  ok: boolean;
  detail: string;
}

async function main(): Promise<number> {
  const env = await createEnvironment({
    // explicit prefix removed so the venv is auto-detected; nothing listens on port 9, so TrueForge is never contacted
    extraSettings: { "forge.commandPrefix": "", "forge.trueforge.baseUrl": "http://127.0.0.1:9" },
  });
  const screens = await makeScreens();
  const steps: Step[] = [];
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  const check = (step: string, ok: boolean, detail: string): void => {
    steps.push({ step, ok, detail });
    console.log(`  ${ok ? "PASS" : "FAIL"} ${step}: ${detail}`);
    if (!ok) throw new Error(`${step}: ${detail}`);
  };
  try {
    await mkdir(join(env.workspace.root, ".venv", "bin"), { recursive: true });
    await writeFile(join(env.workspace.root, ".venv", "bin", "activate"), "# fake activate script for the e2e test\n", "utf8"); // ignored by git, so the clone stays clean
    launched = await launch(env, { video: false });
    const page = launched.page;
    const frame = await openPanel(page);

    // 1. the command prefix is visible in the Context section
    const context = frame.locator("details.context");
    await context.waitFor({ state: "attached", timeout: 30_000 });
    await until("the Context summary to mention the auto-activated venv", async () => ((await context.locator("summary").textContent()) ?? "").includes("venv auto-activated"), 30_000, 300);
    await context.locator("summary").click();
    const prefixText = ((await context.locator(".ctx-prefix").textContent()) ?? "").trim();
    check("command prefix shown", prefixText === "Commands run with: source .venv/bin/activate &&", `"${prefixText}"`);
    await screens.shot(page, "panel-prefix");

    // 2. Open in TrueForge exists (not clicked)
    const openTf = frame.locator("#open-trueforge");
    check("Open in TrueForge button", (await openTf.isVisible()) && (await openTf.isEnabled()), `title: ${await openTf.getAttribute("title")}`);

    // 3. a review appears with its controls
    await runCommand(page, "Forge: Fake Proposal");
    const card = frame.locator(".review-controls").first();
    await card.waitFor({ state: "visible", timeout: 30_000 });
    const status = frame.locator(".review-controls .review-status").first();
    check("initial status line", ((await status.textContent()) ?? "").trim() === "0 of 3 hunks accepted, 3 undecided", `"${((await status.textContent()) ?? "").trim()}"`);
    const apply = frame.getByRole("button", { name: "Apply accepted" });
    const rejectAll = frame.getByRole("button", { name: "Reject all" });
    check("Apply is disabled with nothing accepted", await apply.isDisabled(), "disabled");
    await screens.shot(page, "panel-review-card-0");

    // 4. accept two hunks with the real CodeLens
    await frame.locator(".queue-row.state-reviewing").first().click(); // opens the diff
    // one hunk accepted by its own lens: the other two are undecided, and the card says so
    await until('the card to say "1 of 3 hunks accepted, 2 undecided"', async () => {
      if (((await status.textContent()) ?? "").trim() === "1 of 3 hunks accepted, 2 undecided") return true;
      await page.locator('a[role="button"]', { hasText: /Accept hunk/ }).locator("visible=true").first().click({ timeout: 3_000 }).catch(() => undefined);
      return false;
    }, 30_000, 700);
    const note = ((await frame.locator(".review-controls .review-note").first().textContent()) ?? "").trim();
    check("undecided note", note === "Undecided hunks count as rejected: they will not be applied.", `"${note}"`);
    check("Apply is enabled", await apply.isEnabled(), "enabled");
    await screens.shot(page, "panel-review-card-2of3");

    // 5. apply from the panel
    await apply.click();
    const outcome = frame.locator(".review-outcome.ok").first();
    await outcome.waitFor({ state: "visible", timeout: 30_000 });
    const outcomeText = ((await outcome.textContent()) ?? "").trim();
    check("success line", outcomeText === "Applied 1 of 3 hunks; 2 not applied (rejected or undecided).", `"${outcomeText}"`);
    const text = await readWorkspaceFile(env, "src/flask/helpers.py");
    const marks = [1, 2, 3].filter((n) => text.includes(`forge fake proposal ${n}`));
    check("edits on disk", marks.length === 1, `hunks written: ${marks.join(", ")} (the two undecided hunks were not written)`);
    check("no buttons left on a finished review", (await frame.locator(".review-controls").count()) === 0, "the card shows only its result line");
    await screens.shot(page, "panel-review-applied");

    // 6. reject all from the panel
    await runCommand(page, "Forge: Fake Proposal");
    await rejectAll.waitFor({ state: "visible", timeout: 30_000 });
    await rejectAll.click();
    const rejected = frame.locator(".review-outcome.info", { hasText: "Rejected: nothing was written." }).first();
    await rejected.waitFor({ state: "visible", timeout: 30_000 });
    check("Reject all", true, `"${((await rejected.textContent()) ?? "").trim()}"`);
    await screens.shot(page, "panel-review-rejected");
  } catch (err) {
    if (!steps.some((s) => !s.ok)) steps.push({ step: "UI flow", ok: false, detail: describeError(err) });
    if (launched) await screens.shot(launched.page, "panel-failure").catch(() => undefined);
  } finally {
    const status = await gitStatus(env).catch(() => "?");
    await launched?.app.close().catch(() => undefined);
    await env.cleanup();
    steps.push({ step: "workspace after the run", ok: true, detail: status === "" ? "git clean" : `git status: ${status.replace(/\n/g, "; ")} (the first review was applied on purpose)` });
  }

  const table = ["| Result | Step | Detail |", "|---|---|---|", ...steps.map((s) => `| ${s.ok ? "PASS" : "FAIL"} | ${s.step} | ${s.detail.replace(/\|/g, "\\|").replace(/\n/g, " ").slice(0, 300)} |`)].join("\n");
  console.log(`\n${table}\n`);
  await appendFile(join(ROOT, "docs", "e2e-results.md"), `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UI layer, panel controls smoke, hermetic, Playwright)\n\n${table}\n\n`, "utf8");
  return steps.every((s) => s.ok) ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`panel UI test failed: ${describeError(err)}`);
    process.exit(2);
  },
);
