import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
const HEADINGS = ["Team", "Starting point", "Architecture on TrueForge", "How context is selected", "Model setup", "Scorecard with timestamps", "Tools used", "Known limitations"];

describe("write-up (docs/writeup/WRITEUP.md)", async () => {
  const md = await readFile(join(ROOT, "docs", "writeup", "WRITEUP.md"), "utf8");

  it("has exactly the 8 required headings, in order", () => {
    expect([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1])).toEqual(HEADINGS);
  });

  it("has placeholders only for the team, the video URL and the scorecard timestamps", () => {
    const allowed = /^\[\[(TEAM NAME|MEMBERS|VIDEO URL|m:ss|shown at m:ss, or "not shown")\]\]$/;
    const found = [...md.matchAll(/\[\[[^\]]+\]\]/g)].map((m) => m[0]);
    expect(found.length).toBeGreaterThan(0);
    expect(found.filter((p) => !allowed.test(p))).toEqual([]);
  });

  it("stays short enough for 3 pages (rendered: about 2.5 pages at 1,900 words)", () => {
    expect(md.split(/\s+/).length).toBeLessThan(2300);
  });

  it("contains no machine-specific path", () => {
    expect(md).not.toMatch(/\/Users\/|\/home\/[a-z]|C:\\Users/);
  });
});

describe("recording kit (docs/recording)", async () => {
  const dir = join(ROOT, "docs", "recording");
  const files = await readdir(dir);

  it("has the kit's files", () => {
    for (const f of ["preflight.sh", "reset.sh", "terminal-prep.sh", "estimate-timing.mjs", "shot-list.md", "recording-notes.md"]) expect(files, f).toContain(f);
  });

  it("contains no machine-specific path and no key-like text", async () => {
    for (const f of files.filter((name) => /\.(md|sh|mjs)$/.test(name))) {
      const text = await readFile(join(dir, f), "utf8");
      expect(text, f).not.toMatch(/\/Users\/|\/home\/[a-z]|C:\\Users/);
      expect(text, f).not.toMatch(/\bsk-[A-Za-z0-9_-]{16,}|\bgsk_[A-Za-z0-9]{10,}|\bAIza[0-9A-Za-z_-]{20,}/);
    }
  });

  it("preflight.sh is read-only: no rm and no git command that writes", async () => {
    const pre = await readFile(join(dir, "preflight.sh"), "utf8");
    expect(pre).not.toMatch(/\bgit\s+(checkout|clean|reset|commit|push|add)\b/);
    expect(pre).not.toMatch(/\brm\s/);
  });
});
