import { describe, expect, it } from "vitest";
import { runRepoMap } from "../src/mcp/tools/repoMap";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

function setup(files: Record<string, string> = FIXTURE_FILES, budgets = {}) {
  const host = new FakeHost(files, { gitignore: FIXTURE_GITIGNORE });
  return { host, ...makeRig(budgets) };
}

describe("repo_map", () => {
  it("lists top-level symbols with line numbers for py and ts files", async () => {
    const { host, deps } = setup();
    const text = textOf(await runRepoMap(host, deps, {}));
    expect(text.split("\n")).toEqual([
      "Repo map of . (4 files)",
      "src/app/__init__.py: (no top-level symbols)",
      "src/app/helpers.py: get_debug_flag:4, class Helper:10",
      "src/app/web.ts: render:1, handler:2, interface Props:3",
      "tests/test_helpers.py: test_flag:1",
    ]);
  });

  it("does not map excluded or non-source files", async () => {
    const { host, deps } = setup();
    const text = textOf(await runRepoMap(host, deps, {}));
    expect(text).not.toMatch(/node_modules|\.venv|README|build/);
  });

  it("scopes to a directory or a single file", async () => {
    const { host, deps } = setup();
    expect(textOf(await runRepoMap(host, deps, { path: "tests" }))).toBe("Repo map of tests (1 files)\ntests/test_helpers.py: test_flag:1");
    expect(textOf(await runRepoMap(host, deps, { path: "src/app/helpers.py" }))).toContain("src/app/helpers.py: get_debug_flag:4, class Helper:10");
  });

  it("falls back to directory summaries when over the token budget", async () => {
    const { host, deps } = setup(FIXTURE_FILES, { repoMapTokens: 30 });
    const text = textOf(await runRepoMap(host, deps, {}));
    expect(text).toMatch(/too large for a per-file outline, showing directory summaries/);
    expect(text).toMatch(/src\/app\/ \(3 files, 5 symbols\)/);
    expect(text).toContain("tests/ (1 files, 1 symbols)");
    expect(text).toMatch(/call repo_map with a narrower path/);
    expect(text).not.toContain("get_debug_flag:4");
  });

  it("stays within the budget on a large repo", async () => {
    const files = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`pkg${i % 10}/mod${i}.py`, `def f${i}():\n    pass\n\nclass C${i}:\n    pass\n`]));
    const { host, deps } = setup(files, { repoMapTokens: 200 });
    const text = textOf(await runRepoMap(host, deps, {}));
    expect(text).toContain("directory summaries");
    expect(text.length).toBeLessThan(200 * 4 + 400);
  });

  it("explains an empty result and a missing file", async () => {
    const { host, deps } = setup();
    expect(textOf(await runRepoMap(host, deps, { path: "docs" }))).toMatch(/No \.py\/\.ts.*source files found under docs.*list_dir/s);
    const r = await runRepoMap(host, deps, { path: "src/nope.py" });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Not found: src\/nope\.py/);
  });

  it("rejects unsafe paths and honours abort", async () => {
    const { host, deps } = setup();
    expect((await runRepoMap(host, deps, { path: "../x" })).isError).toBe(true);
    expect((await runRepoMap(host, deps, { path: ".git" })).isError).toBe(true);
    const ctrl = new AbortController();
    ctrl.abort();
    expect(textOf(await runRepoMap(host, deps, {}, ctrl.signal))).toBe("Cancelled.");
  });
});
