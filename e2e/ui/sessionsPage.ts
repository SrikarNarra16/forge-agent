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
 *   3. scroll down: each "Approved" pill is one approval pause (propose_edit / run_command wait for the user)
 *   4. scroll to the turn near the end (Turn 10 of 11 in the rehearsed run): in its "Agent steps" the three deferred-loading calls:
 *      "Listing tools · <server>" (list_tools), "get_tool_info: git_diff (<server>)", "call_tool: git_diff (<server>)"
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium, type Page } from "playwright-core";

const BASE = (process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790").replace(/\/+$/, "");
const OUT = process.env["SESSIONS_OUT"] ?? join(__dirname, "..", "..", "docs", "recording");

async function shot(page: Page, name: string): Promise<void> {
  await page.screenshot({ path: join(OUT, name) });
  console.log(`  screenshot ${name}`);
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

    // the most recent session whose agent is a Forge agent (the list is newest first)
    const row = page.locator("div, a, li").filter({ hasText: /forge-agent/ }).filter({ hasText: /\bturns\b/ }).last();
    await row.click();
    await page.getByText("EVENT TYPES").first().waitFor({ timeout: 20_000 });
    await page.waitForTimeout(2500);
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
    const found = (await listing.count()) > 0;
    console.log(`  "Listing tools" step found: ${found}`);
    if (found) {
      await listing.scrollIntoViewIfNeeded();
      await page.mouse.wheel(0, 120); // a little context above
      await page.waitForTimeout(700);
      await shot(page, "sessions-4-deferred-loading-collapsed.png");
      // expand the three deferred-loading steps (their Request / Response)
      for (const re of [/Listing tools/, /get_tool_info: git_diff/, /call_tool: git_diff/]) {
        const header = page.getByText(re).first();
        await header.click({ timeout: 3000 }).catch(() => undefined);
      }
      await page.waitForTimeout(800);
      await listing.scrollIntoViewIfNeeded();
      await shot(page, "sessions-5-deferred-loading-expanded.png");
    }
    return found ? 0 : 1;
  } finally {
    await browser.close();
  }
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
