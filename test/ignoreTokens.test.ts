import { describe, expect, it } from "vitest";
import { createGlobMatcher, createIgnoreMatcher } from "../src/mcp/ignore";
import { fitToBudget } from "../src/util/tokens";

describe("createIgnoreMatcher", () => {
  const m = createIgnoreMatcher("build/\n*.log\n!keep.log\n/secret.txt\n");

  it("always hides the hard excludes at any depth, including their contents", () => {
    for (const p of [".git", "node_modules", ".venv", "__pycache__", "dist", "out", ".pytest_cache", ".mypy_cache", "a/node_modules", "pkg/__pycache__"]) {
      expect(m.isIgnored(p, true), p).toBe(true);
    }
    expect(m.isIgnored("node_modules/x/y.js", false)).toBe(true);
    expect(m.isIgnored(".git/config", false)).toBe(true);
  });

  it("hides binary extensions", () => {
    expect(m.isIgnored("img/logo.png", false)).toBe(true);
    expect(m.isIgnored("lib/x.pyc", false)).toBe(true);
  });

  it("applies .gitignore rules including negation and anchoring", () => {
    expect(m.isIgnored("build", true)).toBe(true);
    expect(m.isIgnored("build/out.txt", false)).toBe(true);
    expect(m.isIgnored("a.log", false)).toBe(true);
    expect(m.isIgnored("keep.log", false)).toBe(false);
    expect(m.isIgnored("secret.txt", false)).toBe(true);
    expect(m.isIgnored("sub/secret.txt", false)).toBe(false);
  });

  it("keeps ordinary files and the root", () => {
    expect(m.isIgnored("src/app.py", false)).toBe(false);
    expect(m.isIgnored("", true)).toBe(false);
  });

  it("supports extra exclude patterns", () => {
    expect(createIgnoreMatcher(undefined, ["docs/"]).isIgnored("docs/a.md", false)).toBe(true);
  });
});

describe("createGlobMatcher", () => {
  it("matches by extension at any depth and includes everything for no globs", () => {
    const py = createGlobMatcher(["*.py", "*.ts"]);
    expect(py("a/b/c.py")).toBe(true);
    expect(py("x.ts")).toBe(true);
    expect(py("x.md")).toBe(false);
    expect(createGlobMatcher([])("anything")).toBe(true);
  });
});

describe("fitToBudget", () => {
  it("includes whole lines within the token budget", () => {
    const lines = Array.from({ length: 10 }, () => "x".repeat(39)); // 10 tokens + 1 newline each
    const r = fitToBudget(lines, 33);
    expect(r.shown).toBe(3);
    expect(r.truncated).toBe(true);
    expect(fitToBudget(lines, 1000)).toMatchObject({ shown: 10, truncated: false });
  });

  it("always returns at least one line, cut to fit", () => {
    const r = fitToBudget(["y".repeat(1000)], 10);
    expect(r.shown).toBe(1);
    expect(r.text.length).toBeLessThanOrEqual(40);
  });

  it("handles no lines", () => {
    expect(fitToBudget([], 10)).toEqual({ text: "", shown: 0, truncated: false });
  });
});
