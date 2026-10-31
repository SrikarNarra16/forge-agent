import { describe, expect, it } from "vitest";
import { runListDir } from "../src/mcp/tools/listDir";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

function setup(files: Record<string, string> = FIXTURE_FILES, budgets = {}) {
  const host = new FakeHost(files, { gitignore: FIXTURE_GITIGNORE });
  return { host, ...makeRig(budgets) };
}

describe("list_dir", () => {
  it("lists the root, directories first, hiding gitignored and excluded entries", async () => {
    const { host, deps } = setup();
    expect(textOf(await runListDir(host, deps, {})).split("\n")).toEqual(["./ (depth 1)", "src/", "tests/", "README.md"]);
  });

  it("goes deeper with depth and indents children", async () => {
    const { host, deps } = setup();
    expect(textOf(await runListDir(host, deps, { path: "src", depth: 2 })).split("\n")).toEqual([
      "src/ (depth 2)",
      "app/",
      "  __init__.py",
      "  helpers.py",
      "  web.ts",
    ]);
  });

  it("caps entries with an omitted footer", async () => {
    const files = Object.fromEntries(Array.from({ length: 10 }, (_, i) => [`f${i}.txt`, "x"]));
    const { host, deps } = setup(files, { listDirMaxEntries: 4 });
    const lines = textOf(await runListDir(host, deps, {})).split("\n");
    expect(lines).toHaveLength(6);
    expect(lines[5]).toBe("[6 more entries omitted; list a subdirectory with path, or lower depth]");
  });

  it("teaches on bad input", async () => {
    const { host, deps } = setup();
    expect(textOf(await runListDir(host, deps, { depth: 4 }))).toMatch(/depth must be a whole number from 1 to 3/);
    expect(textOf(await runListDir(host, deps, { path: "nope" }))).toMatch(/Not found: nope.*list_dir/s);
    expect(textOf(await runListDir(host, deps, { path: "README.md" }))).toMatch(/is a file, not a directory.*read_file/s);
    expect((await runListDir(host, deps, { path: "../.." })).isError).toBe(true);
    expect((await runListDir(host, deps, { path: "node_modules" })).isError).toBe(true);
  });

  it("explains an empty directory", async () => {
    const { host, deps } = setup({ "build/a.txt": "x" });
    expect(textOf(await runListDir(host, deps, {}))).toMatch(/empty directory, or everything in it is gitignored/);
  });
});
