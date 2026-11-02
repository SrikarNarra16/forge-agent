import { describe, expect, it } from "vitest";
import { ContextIndex } from "../src/context/indexer";
import { createToolDeps } from "../src/mcp/tools/common";
import { runRepoMap } from "../src/mcp/tools/repoMap";
import { runSearchCode } from "../src/mcp/tools/searchCode";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

async function setup(files: Record<string, string> = FIXTURE_FILES, budgets = {}) {
  const host = new FakeHost(files, { gitignore: FIXTURE_GITIGNORE });
  const index = new ContextIndex();
  await index.build(host);
  const rig = makeRig(budgets);
  const deps = createToolDeps({ log: () => undefined, events: rig.deps.events, budgets, index });
  return { host, index, deps };
}

describe("search_code / repo_map served from the index", () => {
  it("text search gives the same lines as the scan, without reading files", async () => {
    const { host, deps } = await setup();
    host.readCalls.length = 0;
    const text = textOf(await runSearchCode(host, deps, { query: "GET_debug_FLAG" }));
    expect(text.split("\n")).toEqual([
      "README.md:2: get_debug_flag docs",
      "src/app/__init__.py:1: from .helpers import get_debug_flag",
      "src/app/helpers.py:4: def get_debug_flag() -> bool:",
      "tests/test_helpers.py:2: assert get_debug_flag() is False",
    ]);
    expect(host.readCalls).toEqual([]);
  });

  it("sees unsaved edits after an index update", async () => {
    const { host, index, deps } = await setup();
    host.files["src/app/helpers.py"] += "\nTOTALLY_NEW_NAME = 1\n";
    await index.update(host, "src/app/helpers.py");
    expect(textOf(await runSearchCode(host, deps, { query: "totally_new_name" }))).toMatch(/^src\/app\/helpers\.py:\d+: TOTALLY_NEW_NAME = 1$/);
  });

  it("text search with no literal match falls back to ranked chunks with reasons", async () => {
    const { host, deps } = await setup();
    const text = textOf(await runSearchCode(host, deps, { query: "debug mode enabled" }));
    expect(text).toMatch(/^No literal matches for 'debug mode enabled'/);
    expect(text).toMatch(/src\/app\/helpers\.py:\d+-\d+ get_debug_flag \[matches: .*debug/);
    expect(textOf(await runSearchCode(host, deps, { query: "zzqxj" }))).toMatch(/^No matches for 'zzqxj'/);
  });

  it("symbol search: name matches in the old format, else ranked symbols with reasons", async () => {
    const { host, deps } = await setup();
    expect(textOf(await runSearchCode(host, deps, { query: "debug", kind: "symbol" }))).toBe("src/app/helpers.py:4: def get_debug_flag() -> bool:");
    const ranked = textOf(await runSearchCode(host, deps, { query: "whether debug mode enabled", kind: "symbol" }));
    expect(ranked).toMatch(/^No symbol name contains/);
    expect(ranked).toMatch(/get_debug_flag \[matches:/);
  });

  it("docs search ranks documentation sections", async () => {
    const { host, deps } = await setup({ "docs/cli.rst": "Command Line\n============\n\nThe flask command runs the server.\n\nShell\n-----\n\nOpen an interactive shell.\n" });
    const text = textOf(await runSearchCode(host, deps, { query: "interactive shell", kind: "docs" }));
    expect(text).toMatch(/docs\/cli\.rst:\d+-\d+ Shell \[matches: .*shell/);
  });

  it("respects the 4000-token style cap", async () => {
    const files = { "a.txt": Array.from({ length: 50 }, (_, i) => `needle ${i} ${"x".repeat(40)}`).join("\n") };
    const { host, deps } = await setup(files, { searchCodeTokens: 60 });
    expect(textOf(await runSearchCode(host, deps, { query: "needle", max: 50 }))).toMatch(/\[truncated at the 60-token output budget/);
  });

  it("repo_map from the index equals the scanned map", async () => {
    const { host, deps } = await setup();
    const scanned = textOf(await runRepoMap(host, makeRig().deps, {}));
    expect(textOf(await runRepoMap(host, deps, {}))).toBe(scanned);
    expect(textOf(await runRepoMap(host, deps, { path: "tests" }))).toBe("Repo map of tests (1 files)\ntests/test_helpers.py: test_flag:1");
  });

  it("uses the scanning code while the index is still empty or building", async () => {
    const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
    const deps = createToolDeps({ log: () => undefined, events: makeRig().deps.events, index: new ContextIndex() });
    expect(textOf(await runSearchCode(host, deps, { query: "get_debug_flag" }))).toMatch(/helpers\.py:4/);
    expect(host.readCalls.length).toBeGreaterThan(0);
  });
});
