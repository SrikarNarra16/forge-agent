import { mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Page } from "playwright-core";

/**
 * Frame capture for the submission video: Playwright's `page.screencast` delivers JPEG frames; each frame is written to disk
 * with the wall-clock time it arrived (the SAME clock the driver's event log uses, so a logged event maps to a frame time
 * without guessing). The frames are encoded to H.264 by scripts/video/assemble.swift (macOS AVFoundation, no ffmpeg).
 *
 * Captions are drawn INTO the page (a fixed, click-through overlay), so they are part of every captured frame.
 */
export interface Recorded {
  dir: string;
  /** Wall-clock ms of the first frame; all "source seconds" in the manifest are relative to this. */
  startedAt: number;
  frames: number;
  /** Wall-clock ms when the capture was stopped: the screencast sends no frames while the screen is static, so a clip ends HERE, not at its last frame. */
  endedAt: number;
}

export interface FrameRecorder {
  start(): Promise<void>;
  stop(): Promise<Recorded>;
  /** Source seconds (relative to the first frame) of a wall-clock time. */
  rel(epochMs: number): number;
  readonly dir: string;
}

export async function createRecorder(page: Page, dir: string, options: { fps?: number; quality?: number; size?: { width: number; height: number } } = {}): Promise<FrameRecorder> {
  await rm(dir, { recursive: true, force: true });
  await mkdir(dir, { recursive: true });
  const index: Array<{ f: string; t: number }> = [];
  let n = 0;
  let first: number | undefined;
  let pending = Promise.resolve();
  let handle: { dispose(): Promise<void> } | undefined;
  const size = options.size ?? { width: 1920, height: 1080 };
  return {
    dir,
    async start() {
      handle = (await page.screencast.start({
        fps: options.fps ?? 30,
        quality: options.quality ?? 85,
        size,
        onFrame: ({ data }) => {
          const now = Date.now();
          first ??= now;
          const name = `${String(++n).padStart(6, "0")}.jpg`;
          index.push({ f: name, t: (now - first) / 1000 });
          pending = pending.then(() => writeFile(join(dir, name), data));
        },
      })) as unknown as { dispose(): Promise<void> };
    },
    async stop() {
      await page.screencast.stop().catch(() => undefined);
      await handle?.dispose().catch(() => undefined);
      await pending;
      await writeFile(join(dir, "frames.json"), JSON.stringify(index), "utf8");
      return { dir, startedAt: first ?? Date.now(), frames: n, endedAt: Date.now() };
    },
    rel(epochMs) {
      return ((epochMs - (first ?? epochMs)) / 1000);
    },
  };
}

// ---- captions (in the page, so every frame carries them) --------------------------------------------------------------

const OVERLAY_ID = "forge-video-overlay";

/** Installs the overlay once; it survives until the page is reloaded (VS Code's window is never reloaded in a take). */
export async function installOverlay(page: Page): Promise<void> {
  await page.evaluate(`(() => {
    if (document.getElementById("${OVERLAY_ID}")) return;
    const root = document.createElement("div");
    root.id = "${OVERLAY_ID}";
    root.style.cssText = "position:fixed;left:0;right:0;bottom:0;top:0;pointer-events:none;z-index:2147483647;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Helvetica,Arial,sans-serif";
    const cap = document.createElement("div");
    cap.id = "${OVERLAY_ID}-cap";
    cap.style.cssText = "position:absolute;left:50%;bottom:34px;transform:translateX(-50%);max-width:80%;padding:12px 28px;border-radius:10px;background:rgba(27,22,18,.94);border:2px solid #e8a33d;color:#fff7ea;font-size:30px;font-weight:600;letter-spacing:.2px;line-height:1.25;text-align:center;box-shadow:0 6px 24px rgba(0,0,0,.5);display:none";
    const badge = document.createElement("div");
    badge.id = "${OVERLAY_ID}-speed";
    badge.textContent = "x3";
    badge.style.cssText = "position:absolute;right:28px;top:22px;padding:6px 18px;border-radius:8px;background:#e8a33d;color:#1b1612;font-size:34px;font-weight:800;display:none";
    const style = document.createElement("style");
    style.textContent = ".notifications-toasts, .notification-toast-container { display: none !important; }";
    document.head.appendChild(style);
    root.appendChild(cap);
    root.appendChild(badge);
    document.body.appendChild(root);
  })()`);
}

export async function setCaption(page: Page, text: string | undefined): Promise<void> {
  await page.evaluate(`(() => {
    const el = document.getElementById("${OVERLAY_ID}-cap");
    if (!el) return;
    const t = ${JSON.stringify(text ?? "")};
    el.textContent = t;
    el.style.display = t ? "block" : "none";
  })()`);
}

export async function setSpeedBadge(page: Page, on: boolean): Promise<void> {
  await page.evaluate(`(() => { const el = document.getElementById("${OVERLAY_ID}-speed"); if (el) el.style.display = ${on ? '"block"' : '"none"'}; })()`);
}

/** The recorded event log: names with wall-clock times, plus speed-up ranges (wall-clock). */
export class EventLog {
  readonly events: Array<{ name: string; at: number }> = [];
  readonly speeds: Array<{ from: number; to?: number }> = [];
  mark(name: string, at = Date.now()): void {
    this.events.push({ name, at });
    console.log(`  [event] ${name}`);
  }
  firstAt(name: string): number | undefined {
    return this.events.find((e) => e.name === name)?.at;
  }
  speedStart(at = Date.now()): void {
    if (this.speeds.length === 0 || this.speeds[this.speeds.length - 1]?.to !== undefined) this.speeds.push({ from: at });
  }
  speedEnd(at = Date.now()): void {
    const last = this.speeds[this.speeds.length - 1];
    if (last && last.to === undefined) last.to = at;
  }
  speedOpen(): boolean {
    const last = this.speeds[this.speeds.length - 1];
    return last !== undefined && last.to === undefined;
  }
}
