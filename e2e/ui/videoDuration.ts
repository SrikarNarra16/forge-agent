/**
 * Prints the duration of video files without ffmpeg: headless Chrome loads each file and reads its duration. Works for the
 * .webm files Playwright records (macOS Spotlight / `mdls` cannot read those) and for .mp4 / .mov that Chrome can play.
 *
 *   npm run video:duration -- e2e-output/video/backup-take-rehearsal-2026-11-08-10-59.webm [more files...]
 *
 * For your exported .mp4 / .mov, `mdls -name kMDItemDurationSeconds -raw <file>` also works (see docs/recording/recording-notes.md).
 */
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { chromium } from "playwright-core";

export async function videoDurationSeconds(files: readonly string[]): Promise<Array<{ file: string; seconds?: number; error?: string }>> {
  const browser = await chromium.launch({ channel: "chrome" });
  const out: Array<{ file: string; seconds?: number; error?: string }> = [];
  try {
    for (const file of files) {
      const page = await browser.newPage();
      try {
        await page.goto(pathToFileURL(resolve(file)).href, { waitUntil: "load" });
        // evaluated in the page; a recorded WebM can report Infinity until it is seeked far past its end
        const seconds = (await page.evaluate(`new Promise((resolveDuration, reject) => {
          const v = document.querySelector("video");
          if (!v) return reject(new Error("the browser did not open this file as a video"));
          const done = () => { if (Number.isFinite(v.duration)) resolveDuration(v.duration); };
          v.addEventListener("loadedmetadata", () => { if (v.duration === Infinity) { v.currentTime = 1e7; v.addEventListener("durationchange", done); v.addEventListener("timeupdate", done); } else done(); });
          if (v.readyState >= 1) { if (v.duration === Infinity) { v.currentTime = 1e7; v.addEventListener("timeupdate", done); } else done(); }
          setTimeout(() => reject(new Error("timed out reading the duration")), 20000);
        })`)) as number;
        out.push({ file, seconds });
      } catch (err) {
        out.push({ file, error: err instanceof Error ? err.message.split("\n")[0] : String(err) });
      } finally {
        await page.close();
      }
    }
  } finally {
    await browser.close();
  }
  return out;
}

export const formatDuration = (s: number): string => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, "0")}.${String(Math.round((s % 1) * 10)).padStart(1, "0")} (${s.toFixed(1)} s)`;

if (process.argv[1]?.endsWith("videoDuration.ts")) {
  const files = process.argv.slice(2);
  if (files.length === 0) {
    console.error("usage: npm run video:duration -- <video file> [more files]");
    process.exit(2);
  }
  void videoDurationSeconds(files).then((rows) => {
    for (const r of rows) console.log(r.seconds !== undefined ? `${formatDuration(r.seconds)}  ${r.file}` : `ERROR ${r.error}  ${r.file}`);
    process.exit(rows.every((r) => r.seconds !== undefined) ? 0 : 1);
  });
}
