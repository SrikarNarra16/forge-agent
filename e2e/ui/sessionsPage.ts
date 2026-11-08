/**
 * Rehearses the closing shot of the video: the TrueForge Sessions page for the Task B session. Headless Chrome walks the
 * click path below and saves screenshots, so you can see what each step shows before you record it.
 *
 *   TRUEFORGE_BASE_URL=http://localhost:8790 npm run rehearse:sessions          (needs Google Chrome; read-only)
 *
 * Click path (the same one you do by hand):
 *   1. open <TrueForge>/sessions: the list of sessions on the left (the Task B session is the one with 11 or so turns,
 *      its title starts with "<context> Relevant locations")
 *   2. click that row: the detail pane opens on the right: stats (turns, tokens, tool calls, errors), the timeline of the turns
 *   2b. optional: the Agents filter (top right, "All") -> forge-agent hides sessions of throwaway test agents (e2e-...)
 *   3. scroll down: each "Approved" pill is one approval pause (propose_edit / run_command wait for the user)
 *   4. scroll to the turn near the end (Turn 10 of 11 in the rehearsed run): in its "Agent steps" the three deferred-loading calls:
 *      "Listing tools · <server>" (list_tools), "get_tool_info: git_diff (<server>)", "call_tool: git_diff (<server>)"
 */
import { mkdir, rename } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = (process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790").replace(/\/+$/, "");
const OUT = process.env["SESSIONS_OUT"] ?? join(__dirname, "..", "..", "docs", "recording");

async function shot(page: Page, name: string, outDir = OUT): Promise<void> {
  await page.screenshot({ path: join(outDir, name) });
  console.log(`  screenshot ${name}`);
}


/**
 * Finds the deferred tool loading ("Listing tools", get_tool_info, call_tool) in the session detail:
 *  1. the detail pane renders turns lazily and the page itself does not scroll: scroll the inner pane down in steps;
 *  2. at the bottom, the LAST turn's "Agent steps" group is collapsed by default (the agent often loads the deferred tools in
 *     its final turn): click the last group headers until the "Listing tools" step appears (a click on an open group would
 *     close it, so a header that did not help is clicked again to restore it).
 * Returns whether the step is now in the page and scrolled into view.
 */
async function scrollToListingTools(page: Page, stepMs = 450): Promise<boolean> {
  const listing = page.getByText(/Listing tools/).first();
  const scrollDown = async (): Promise<boolean> =>
    (await page.evaluate(`(() => {
      const turn = [...document.querySelectorAll("*")].find((e) => /^Turn \\d+$/.test((e.textContent || "").trim()) && e.children.length === 0);
      let el = turn ? turn.parentElement : null;
      while (el && el.scrollHeight <= el.clientHeight + 4) el = el.parentElement;
      if (!el) return false;
      const before = el.scrollTop;
      el.scrollBy(0, 700);
      return el.scrollTop > before;
    })()`)) as boolean;
  for (let i = 0; i < 60; i++) {
    if ((await listing.count()) > 0) break;
    if (!(await scrollDown())) break; // reached the bottom
    await page.waitForTimeout(stepMs);
  }
  if ((await listing.count()) === 0) {
    const headers = page.getByText(/^Agent steps/);
    const n = await headers.count();
    for (let k = n - 1; k >= Math.max(0, n - 3); k--) {
      await headers.nth(k).click().catch(() => undefined);
      await page.waitForTimeout(700);
      if ((await listing.count()) > 0) break;
      await headers.nth(k).click().catch(() => undefined); // it was open: put it back
    }
  }
  if ((await listing.count()) === 0) return false;
  await listing.scrollIntoViewIfNeeded();
  return true;
}

/**
 * A short video clip of the closing shot for the automated backup take (no narration): opens THIS session's detail view,
 * holds on the stats and timeline, then on an approval pause, then on the deferred-loading steps. 1920x1080, Chrome.
 */
export async function recordSessionsClip(options: { baseUrl: string; sessionId: string; videoDir: string; name: string; holdMs?: number }): Promise<{ file?: string; ok: boolean; detail: string }> {
  const hold = options.holdMs ?? 4000;
  await mkdir(options.videoDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const context = await browser.newContext({ viewport: { width: 1920, height: 1080 }, recordVideo: { dir: options.videoDir, size: { width: 1920, height: 1080 } } });
    const page = await context.newPage();
    await page.goto(`${options.baseUrl.replace(/\/+$/, "")}/sessions`, { waitUntil: "load" });
    await page.waitForSelector("#root > *", { timeout: 30_000 });
    await page.waitForTimeout(2500); // the list of sessions
    await page.goto(`${options.baseUrl.replace(/\/+$/, "")}/sessions?sessionId=${encodeURIComponent(options.sessionId)}`, { waitUntil: "load" });
    await page.getByText("EVENT TYPES").first().waitFor({ timeout: 30_000 });
    await page.waitForTimeout(hold); // stats + timeline
    const approved = page.getByText("Approved", { exact: true });
    const pills = await approved.count();
    if (pills > 0) {
      await approved.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(hold);
    }
    const found = await scrollToListingTools(page); // scrolls down through the turns on camera
    if (found) {
      await page.mouse.wheel(0, 0);
      await page.waitForTimeout(hold + 2000); // the three deferred-loading steps
    }
    const tmp = await page.video()?.path();
    await context.close(); // finalises the video
    let file: string | undefined;
    if (tmp) {
      file = join(options.videoDir, options.name);
      await rename(tmp, file);
    }
    return { file, ok: found && pills > 0, detail: `${pills} approval pause(s) shown, deferred-loading steps ${found ? "shown" : "NOT found"}` };
  } catch (err) {
    return { ok: false, detail: `sessions clip failed: ${err instanceof Error ? err.message.split("\n")[0] : String(err)}` };
  } finally {
    await browser.close();
  }
}

async function main(): Promise<number> {
  await mkdir(OUT, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`${BASE}/sessions`, { waitUntil: "load" });
    await page.waitForSelector("#root > *", { timeout: 30_000 }).catch(() => {
      throw new Error(`the Sessions page at ${BASE} is blank: its script did not load (TrueForge's files were replaced while it ran; restart it with npm run tf:start)`);
    });
    await page.waitForTimeout(2000);
    await shot(page, "sessions-1-list.png");

    // Task B sessions are the ones whose title starts with the <context> block; walk them newest first (the list is newest first)
    // and use the first whose steps show the deferred tool loading
    const rows = page.getByText(/^<context>\s+Relevant locations/);
    const rowCount = await rows.count();
    console.log(`  Task B style sessions in the list: ${rowCount}`);
    let chosen = -1;
    for (let i = 0; i < Math.min(rowCount, 6) && chosen < 0; i++) {
      await rows.nth(i).click();
      await page.getByText("EVENT TYPES").first().waitFor({ timeout: 20_000 });
      await page.waitForTimeout(2000);
      if (await scrollToListingTools(page, 150)) chosen = i;
    }
    if (chosen < 0) throw new Error("none of the newest Task B sessions shows 'Listing tools' (the agent did not load the deferred tools)");
    console.log(`  using session #${chosen + 1} from the top of the list: ${(await page.locator("body").innerText()).match(/01[a-z0-9]{24}/)?.[0] ?? "?"}`);
    await shot(page, "sessions-2-detail-timeline.png");

    // approval pauses: the "Approved" pills
    const approved = page.getByText("Approved", { exact: true });
    const pills = await approved.count();
    console.log(`  "Approved" pills (approval pauses) found: ${pills}`);
    if (pills > 0) {
      await approved.first().scrollIntoViewIfNeeded();
      await page.waitForTimeout(500);
      await shot(page, "sessions-3-approvals.png");
    }

    // deferred loading: the "Listing tools" step header (list_tools), near the end of the session
    const listing = page.getByText(/Listing tools/).first();
    const found = await scrollToListingTools(page, 150);
    console.log(`  "Listing tools" step found: ${found}`);
    if (found) {
      await listing.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 120); // a little context above
      await page.waitForTimeout(700);
      await shot(page, "sessions-4-deferred-loading-steps.png");
      // expand the three deferred-loading steps (their Request / Response)
      for (const re of [/Listing tools/, /get_tool_info: git_diff/, /call_tool: git_diff/]) {
        const header = page.getByText(re).first();
        await header.click({ timeout: 3000 }).catch(() => undefined);
      }
      await page.waitForTimeout(800);
      await listing.scrollIntoViewIfNeeded();
      await shot(page, "sessions-5-deferred-loading-expanded.png");
    }
    // the list also shows sessions of throwaway test agents (e2e-...); the Agents filter (top right) narrows it to the real ones
    try {
      await page.getByRole("combobox").first().click({ timeout: 5000 });
      await page.getByRole("option", { name: /^forge-agent$/ }).first().click({ timeout: 5000 });
      await page.waitForTimeout(2000);
      await shot(page, "sessions-6-agent-filter.png");
    } catch {
      console.log("  (the Agents filter could not be applied; not required)");
    }
    return found ? 0 : 1;
  } finally {
    await browser.close();
  }
}

if (process.argv[1]?.endsWith("sessionsPage.ts")) main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
