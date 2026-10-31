import { afterEach, describe, expect, it, vi } from "vitest";
import { runSearchCode } from "../src/mcp/tools/searchCode";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

function setup(files: Record<string, string> = FIXTURE_FILES, budgets = {}, onRead?: (n: number) => void) {
  const host = new FakeHost(files, { gitignore: FIXTURE_GITIGNORE, ...(onRead ? { onRead } : {}) });
  return { host, ...makeRig(budgets) };
}

afterEach(() => vi.restoreAllMocks());

describe("search_code kind=text", () => {
  it("finds case-insensitive matches as path:line: text and skips excluded files", async () => {
    const { host, deps } = setup();
    const text = textOf(await runSearchCode(host, deps, { query: "GET_debug_FLAG" }));
    expect(text.split("\n")).toEqual([
      "README.md:2: get_debug_flag docs",
      "src/app/__init__.py:1: from .helpers import get_debug_flag",
      "src/app/helpers.py:4: def get_debug_flag() -> bool:",
      "tests/test_helpers.py:2: assert get_debug_flag() is False",
    ]);
    // node_modules, .venv, .git, gitignored build/ and the binary png are never scanned.
    expect(host.readCalls.some((p) => /node_modules|\.venv|\.git|build|png/.test(p))).toBe(false);
  });

  it("tells the model what to try when nothing matches", async () => {
    const { host, deps } = setup();
    const r = await runSearchCode(host, deps, { query: "zzz_not_there" });
    expect(r.isError).toBeFalsy();
    expect(textOf(r)).toMatch(/No matches for 'zzz_not_there' \(kind=text, scanned \d+ files\).*kind=symbol.*kind=path/s);
  });

  it("caps results at max and says more exist", async () => {
    const files = { "a.txt": Array.from({ length: 30 }, (_, i) => `needle ${i}`).join("\n") };
    const { host, deps } = setup(files);
    const text = textOf(await runSearchCode(host, deps, { query: "needle" }));
    const lines = text.split("\n");
    expect(lines).toHaveLength(21);
    expect(lines[19]).toBe("a.txt:20: needle 19");
    expect(lines[20]).toBe("[showing the first 20 matches; more exist. Narrow the query or raise max (up to 100)]");
    expect(textOf(await runSearchCode(host, deps, { query: "needle", max: 3 })).split("\n")).toHaveLength(4);
  });

  it("truncates to the token budget with a clear footer", async () => {
    const files = { "a.txt": Array.from({ length: 50 }, (_, i) => `needle ${i} ${"x".repeat(40)}`).join("\n") };
    const { host, deps } = setup(files, { searchCodeTokens: 60 });
    const text = textOf(await runSearchCode(host, deps, { query: "needle", max: 50 }));
    const lines = text.split("\n");
    const footer = lines[lines.length - 1] ?? "";
    expect(footer).toMatch(/^\[truncated at the 60-token output budget: showing \d+ of 50 matches; narrow the query\]$/);
    expect(lines.length).toBeLessThan(15);
    expect(lines.slice(0, -1).join("\n").length).toBeLessThanOrEqual(60 * 4);
  });

  it("truncates very long matching lines in the preview", async () => {
    const { host, deps } = setup({ "min.js": `var a=${"x".repeat(5000)}needle` });
    const text = textOf(await runSearchCode(host, deps, { query: "var a" }));
    expect(text.length).toBeLessThan(300);
  });
});

describe("search_code kind=symbol", () => {
  it("matches function and class names only", async () => {
    const { host, deps } = setup();
    expect(textOf(await runSearchCode(host, deps, { query: "debug", kind: "symbol" }))).toBe("src/app/helpers.py:4: def get_debug_flag() -> bool:");
    expect(textOf(await runSearchCode(host, deps, { query: "helper", kind: "symbol" }))).toBe("src/app/helpers.py:10: class Helper:");
    expect(textOf(await runSearchCode(host, deps, { query: "render", kind: "symbol" }))).toBe("src/app/web.ts:1: export function render(x: number) {}");
  });

  it("does not match text that is only mentioned in docs or calls", async () => {
    const { host, deps } = setup();
    const text = textOf(await runSearchCode(host, deps, { query: "FLASK_DEBUG", kind: "symbol" }));
    expect(text).toMatch(/^No matches/);
  });
});

describe("search_code kind=path", () => {
  it("matches file paths, basename matches first, without reading any file", async () => {
    const { host, deps } = setup();
    const text = textOf(await runSearchCode(host, deps, { query: "helpers", kind: "path" }));
    expect(text.split("\n")).toEqual(["src/app/helpers.py", "tests/test_helpers.py"]);
    expect(textOf(await runSearchCode(host, deps, { query: "app/", kind: "path" }))).toContain("src/app/web.ts");
    expect(host.readCalls).toEqual([]);
  });
});

describe("search_code validation and cancellation", () => {
  it("teaches on bad arguments", async () => {
    const { host, deps } = setup();
    expect(textOf(await runSearchCode(host, deps, { query: "  " }))).toMatch(/query is required/);
    expect(textOf(await runSearchCode(host, deps, { query: "x", max: 0 }))).toMatch(/max must be a whole number from 1 to 100/);
    expect(textOf(await runSearchCode(host, deps, { query: "x", max: 101 }))).toMatch(/max must be a whole number from 1 to 100/);
    // @ts-expect-error deliberately invalid kind, as a model might send
    expect(textOf(await runSearchCode(host, deps, { query: "x", kind: "regex" }))).toMatch(/kind must be one of text, symbol, path/);
  });

  it("stops scanning when the signal is aborted mid-scan", async () => {
    const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.txt`, "nothing here"]));
    const ctrl = new AbortController();
    const { host, deps } = setup(files, {}, (n) => {
      if (n === 5) ctrl.abort();
    });
    const r = await runSearchCode(host, deps, { query: "needle" }, ctrl.signal);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Cancelled.");
    expect(host.readCalls.length).toBeLessThan(10);
  });

  it("returns Cancelled immediately for a pre-aborted signal", async () => {
    const { host, deps } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    expect(textOf(await runSearchCode(host, deps, { query: "x" }, ctrl.signal))).toBe("Cancelled.");
    expect(host.readCalls).toEqual([]);
  });

  it("yields to the event loop while scanning many files", async () => {
    const spy = vi.spyOn(globalThis, "setImmediate");
    const files = Object.fromEntries(Array.from({ length: 160 }, (_, i) => [`f${i}.txt`, "nothing"]));
    const { host, deps } = setup(files);
    await runSearchCode(host, deps, { query: "needle" });
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(3);
  });
});
