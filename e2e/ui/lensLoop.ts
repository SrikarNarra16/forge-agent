/**
 * Layer 2, hermetic: does the review diff always show its CodeLens? Opens the Fake Proposal diff N times in the real
 * VS Code (default 30), the way Task A does it (src/flask/helpers.py already open in an editor), and records for each
 * round whether the "Accept all" and "Accept hunk" lens text appears within 5 s and how long it took. No model, no TrueForge.
 *
 *   npm run test:ui:lens                       (LENS_ROUNDS=30 by default)
 *   LENS_REOPEN=1 npm run test:ui:lens         also clicks the panel's queue row right after the diff opened, as the rehearsal
 *                                              driver does (the diff is then opened a second time while it may still be opening)
 *
 * Time is measured from the moment the Fake Proposal command was submitted (Enter in the palette) to the first moment
 * the text is visible; the palette typing before it is not counted.
 */
import { appendFile, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describeError } from "../../src/trueforge/client";
import { ROOT, createEnvironment } from "../env";
import { launch, makeScreens, openPanel, runCommand, until, MOD } from "./driver";

const ROUNDS = Number(process.env["LENS_ROUNDS"] ?? 30);
const LIMIT_MS = 5000;
const REOPEN = process.env["LENS_REOPEN"] === "1";
/** LENS_PROPOSAL=task-a: Fake Proposal shows the edit a model makes for Task A (a pure-insertion docstring hunk + a code hunk) instead of its marker edits (src/review/fakeProposal.ts, only with FORGE_E2E=1). */
const TASK_A = process.env["LENS_PROPOSAL"] === "task-a";

interface Round {
  round: number;
  /** "Accept hunk" sits above the first hunk, which the diff is scrolled to, so it is the lens that must be visible at once. ("Accept all" is on line 1, off-screen until the user scrolls up; not part of the criterion.) */
  acceptHunkMs?: number;
  ok: boolean;
}

const stats = (xs: number[]): string => (xs.length === 0 ? "n/a" : `min ${Math.min(...xs)} ms / median ${[...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)]} ms / max ${Math.max(...xs)} ms`);

async function main(): Promise<number> {
  const env = await createEnvironment({ extraSettings: { "forge.commandPrefix": "", "forge.trueforge.baseUrl": "http://127.0.0.1:9" } });
  const screens = await makeScreens();
  const rounds: Round[] = [];
  let launched: Awaited<ReturnType<typeof launch>> | undefined;
  try {
    launched = await launch(env, { video: false, ...(TASK_A ? { extraEnv: { FORGE_E2E: "1", FORGE_E2E_PROPOSAL: "task-a" } } : {}) });
    const page = launched.page;
    const frame = await openPanel(page);
    // like Task A: helpers.py open in an editor with the cursor in it
    await page.keyboard.press(`${MOD}+P`);
    const input = page.locator(".quick-input-widget input.input");
    await input.waitFor({ state: "visible" });
    await input.fill("src/flask/helpers.py:28");
    await page.locator(".quick-input-list .monaco-list-row", { hasText: "helpers.py" }).first().waitFor({ state: "visible" });
    await page.keyboard.press("Enter");
    await page.locator(".tab.active", { hasText: "helpers.py" }).waitFor({ state: "visible" });

    for (let i = 1; i <= ROUNDS; i++) {
      await runCommand(page, "Forge: Fake Proposal");
      const t0 = Date.now();
      const r: Round = { round: i, ok: false };
      if (REOPEN) await frame.locator(".queue-row.state-reviewing").first().click({ timeout: 10_000 }).catch(() => undefined); // like the driver: "Review diff" from the queue
      const seen = async (re: RegExp): Promise<boolean> => page.locator('a[role="button"]', { hasText: re }).locator("visible=true").first().isVisible().catch(() => false);
      while (Date.now() - t0 < LIMIT_MS && r.acceptHunkMs === undefined) {
        if (await seen(/Accept hunk/)) r.acceptHunkMs = Date.now() - t0;
        await new Promise((res) => setTimeout(res, 25));
      }
      r.ok = r.acceptHunkMs !== undefined;
      rounds.push(r);
      console.log(`  round ${String(i).padStart(2)}: Accept hunk lens ${r.acceptHunkMs ?? "MISSING"} ms`);
      if (!r.ok) await screens.shot(page, `round-${i}-missing-lens`);
      // finish the review from the panel (closes the diff) and wait until the diff tab is gone
      await frame.getByRole("button", { name: "Reject all" }).click({ timeout: 10_000 }).catch(() => undefined);
      await until("the diff to close", async () => (await page.locator(".tab", { hasText: "Forge: src/flask/helpers.py" }).count()) === 0, 10_000, 100).catch(() => undefined);
    }
  } catch (err) {
    console.error(`loop stopped: ${describeError(err)}`);
    if (launched) await screens.shot(launched.page, "loop-failure").catch(() => undefined);
  } finally {
    await launched?.app.close().catch(() => undefined);
    await env.cleanup();
  }
  const failures = rounds.filter((r) => !r.ok);
  const hunk = rounds.flatMap((r) => (r.acceptHunkMs !== undefined ? [r.acceptHunkMs] : []));
  const summary = `${TASK_A ? "Task A proposal (pure-insertion hunk + code hunk)" : "Fake Proposal markers"}, ${REOPEN ? "queue row clicked right after the diff opened (driver-like double open)" : "plain open"}: ${rounds.length} of ${ROUNDS} rounds run, ${failures.length} failure(s) ("Accept hunk" lens not visible within ${LIMIT_MS / 1000} s)${failures.length ? `: rounds ${failures.map((f) => f.round).join(", ")}` : ""}\n- "Accept hunk" lens: ${stats(hunk)}`;
  console.log(`\n${summary}`);
  await mkdir(join(ROOT, "e2e-output"), { recursive: true });
  await writeFile(join(ROOT, "e2e-output", "lens-loop.json"), JSON.stringify({ at: new Date().toISOString(), rounds }, null, 2), "utf8");
  await appendFile(join(ROOT, "docs", "e2e-results.md"), `## ${new Date().toISOString().slice(0, 16).replace("T", " ")} (UI layer, CodeLens loop${TASK_A ? ", Task A proposal" : ""}${REOPEN ? ", double open" : ""}, hermetic, Playwright)\n\n${summary}\n\n`, "utf8");
  return rounds.length === ROUNDS && failures.length === 0 ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(`lens loop failed: ${describeError(err)}`);
    process.exit(2);
  },
);
