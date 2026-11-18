/**
 * Looks at the FINAL MP4 instead of trusting the event log: decodes it in headless Chrome, reports size/duration/codec support
 * and saves a PNG at each requested time, so the timestamps in the write-up can be checked against the actual picture.
 *
 *   npx tsx scripts/video/inspect.ts <file.mp4> <outDir> <seconds> [<seconds> ...]
 */
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright-core";

async function main(): Promise<void> {
  const [file, outDir, ...times] = process.argv.slice(2);
  if (!file || !outDir || times.length === 0) throw new Error("usage: inspect.ts <file.mp4> <outDir> <seconds>...");
  await mkdir(outDir, { recursive: true });
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    const page = await browser.newPage({ viewport: { width: 1920, height: 1080 } });
    await page.goto(`file://${file}`);
    await page.waitForFunction("document.querySelector('video') && document.querySelector('video').readyState >= 1");
    const info = (await page.evaluate("(() => { const v = document.querySelector('video'); return { w: v.videoWidth, h: v.videoHeight, d: v.duration }; })()")) as { w: number; h: number; d: number };
    console.log(`video: ${info.w}x${info.h}, duration ${info.d.toFixed(2)} s`);
    for (const t of times) {
      await page.evaluate(`new Promise((res) => { const v = document.querySelector('video'); v.onseeked = () => res(true); v.currentTime = ${Number(t)}; })`);
      await page.waitForTimeout(150);
      const out = join(outDir, `t-${String(Math.round(Number(t) * 10)).padStart(5, "0")}.png`);
      await page.locator("video").screenshot({ path: out });
      console.log(out);
    }
  } finally {
    await browser.close();
  }
}

void main();
