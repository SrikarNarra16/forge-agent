import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(__dirname, "..");
import { HEADINGS } from "../scripts/render-writeup";

describe("write-up (docs/writeup/WRITEUP.md)", async () => {
  const md = await readFile(join(ROOT, "docs", "writeup", "WRITEUP.md"), "utf8");

  it("has exactly the 8 required headings, in order", () => {
    expect([...md.matchAll(/^#{1,6} (.+)$/gm)].map((m) => m[1])).toEqual(HEADINGS);
  });

  it("has no placeholder except the video URL; every {{TOKEN}} is a known team fact or a take fact", async () => {
    const team = JSON.parse(await readFile(join(ROOT, "docs", "writeup", "team.json"), "utf8")) as Record<string, string>;
    const facts = JSON.parse(await readFile(join(ROOT, "docs", "writeup", "facts.json"), "utf8")) as Record<string, string>;
    const known = new Set(["TEAM", "TEAM_ID", "COMPETITION_ID", "MEMBER", "GITHUB", "COLLEGE", "REPO", ...Object.keys(facts)]);
    const tokens = [...md.matchAll(/\{\{([A-Z_0-9]+)\}\}/g)].map((m) => m[1] as string);
    expect(tokens.filter((t) => !known.has(t))).toEqual([]);
    expect(md).not.toMatch(/\[\[[^\]]+\]\]/);
    expect(md).toContain("<VIDEO_URL>");
    expect(team["teamId"]).toBe("TM-2C05ECD8CA7");
    expect(JSON.stringify(team) + md).not.toMatch(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/); // no e-mail address anywhere in the write-up
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
