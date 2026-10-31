import { describe, expect, it } from "vitest";
import { runReadFile } from "../src/mcp/tools/readFile";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

const WHY = "check how get_debug_flag parses values";

function setup(files: Record<string, string> = FIXTURE_FILES, budgets = {}) {
  const host = new FakeHost(files, { gitignore: FIXTURE_GITIGNORE });
  return { host, ...makeRig(budgets) };
}

describe("read_file", () => {
  it("returns line-numbered text with a header", async () => {
    const { host, deps } = setup();
    const r = await runReadFile(host, deps, { path: "src/app/helpers.py", why: WHY });
    expect(r.isError).toBeFalsy();
    const text = textOf(r);
    expect(text.split("\n")[0]).toBe("src/app/helpers.py (lines 1-12 of 12)");
    expect(text).toContain(" 4| def get_debug_flag() -> bool:");
    expect(text).toContain("12|         pass");
    expect(text).not.toContain("truncated");
  });

  it("returns an inclusive 1-based range", async () => {
    const { host, deps } = setup();
    const text = textOf(await runReadFile(host, deps, { path: "src/app/helpers.py", start: 4, end: 7, why: WHY }));
    expect(text.split("\n")).toEqual([
      "src/app/helpers.py (lines 4-7 of 12)",
      '4| def get_debug_flag() -> bool:',
      '5|     """Get whether debug mode should be enabled."""',
      '6|     val = os.environ.get("FLASK_DEBUG")',
      '7|     return bool(val and val.lower() not in {"0", "false", "no"})',
    ]);
  });

  it("caps a call at 400 lines and tells the model how to continue", async () => {
    const big = Array.from({ length: 1000 }, (_, i) => `line ${i + 1}`).join("\n");
    const { host, deps } = setup({ "big.txt": big });
    const first = textOf(await runReadFile(host, deps, { path: "big.txt", why: WHY }));
    expect(first).toContain("big.txt (lines 1-400 of 1000)");
    expect(first).toContain("[file has 1000 lines; call read_file with start=401 to continue]");
    expect(first).not.toContain("line 401");

    const explicit = textOf(await runReadFile(host, deps, { path: "big.txt", start: 1, end: 1200, why: WHY }));
    expect(explicit).toContain("big.txt (lines 1-400 of 1000)");
    expect(explicit).toContain("[truncated: lines 401-1000 omitted; call read_file with start/end]");

    const next = textOf(await runReadFile(host, deps, { path: "big.txt", start: 401, end: 800, why: WHY }));
    expect(next).toContain("(lines 401-800 of 1000)");
    expect(next).not.toContain("truncated");
  });

  it("clamps an end past the file and keeps the first line of a range intact", async () => {
    const { host, deps } = setup();
    const text = textOf(await runReadFile(host, deps, { path: "src/app/__init__.py", start: 1, end: 50, why: WHY }));
    expect(text).toBe("src/app/__init__.py (lines 1-1 of 1)\n1| from .helpers import get_debug_flag");
  });

  it("requires `why` (at least 5 characters) and does not read the file without it", async () => {
    const { host, deps, reads } = setup();
    for (const why of ["", "   ", "abc"]) {
      const r = await runReadFile(host, deps, { path: "src/app/helpers.py", why });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toMatch(/`why` is required.*one sentence/s);
    }
    expect(host.readCalls).toEqual([]);
    expect(reads).toEqual([]);
  });

  it("emits context:read with path, range, why and tokens only on success", async () => {
    const { host, deps, reads } = setup();
    await runReadFile(host, deps, { path: "src/app/helpers.py", start: 4, end: 7, why: WHY });
    expect(reads).toHaveLength(1);
    expect(reads[0]).toMatchObject({ path: "src/app/helpers.py", start: 4, end: 7, why: WHY });
    expect(reads[0]?.tokens).toBeGreaterThan(10);
    await runReadFile(host, deps, { path: "missing.py", why: WHY });
    expect(reads).toHaveLength(1);
  });

  it("teaches on a missing file, a directory and a binary file", async () => {
    const { host, deps } = setup();
    const missing = await runReadFile(host, deps, { path: "src/app/nope.py", why: WHY });
    expect(missing.isError).toBe(true);
    expect(textOf(missing)).toMatch(/Not found: src\/app\/nope\.py.*list_dir.*search_code with kind=path/s);
    const dir = await runReadFile(host, deps, { path: "src/app", why: WHY });
    expect(textOf(dir)).toMatch(/is a directory.*list_dir/s);
    const bin = await runReadFile(host, deps, { path: "logo.png", why: WHY });
    expect(textOf(bin)).toMatch(/binary/);
  });

  it("teaches on bad ranges", async () => {
    const { host, deps } = setup();
    expect(textOf(await runReadFile(host, deps, { path: "src/app/helpers.py", start: 0, why: WHY }))).toMatch(/start must be a whole number >= 1/);
    expect(textOf(await runReadFile(host, deps, { path: "src/app/helpers.py", start: 9, end: 3, why: WHY }))).toMatch(/end must be .* >= start/);
    expect(textOf(await runReadFile(host, deps, { path: "src/app/helpers.py", start: 99, why: WHY }))).toMatch(/has 12 lines but start=99 is past the end/);
  });

  it("reports an empty file", async () => {
    const { host, deps } = setup({ "empty.txt": "" });
    expect(textOf(await runReadFile(host, deps, { path: "empty.txt", why: WHY }))).toBe("empty.txt (empty file)");
  });

  it("refuses unsafe paths without touching the host", async () => {
    const { host, deps } = setup();
    for (const path of ["../etc/passwd", "/etc/passwd", ".git/config", "node_modules/pkg/index.js", ".venv/lib/x.py"]) {
      const r = await runReadFile(host, deps, { path, why: WHY });
      expect(r.isError, path).toBe(true);
    }
    expect(host.readCalls).toEqual([]);
  });

  it("honours an already-aborted signal", async () => {
    const { host, deps } = setup();
    const ctrl = new AbortController();
    ctrl.abort();
    const r = await runReadFile(host, deps, { path: "src/app/helpers.py", why: WHY }, ctrl.signal);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("Cancelled.");
    expect(host.readCalls).toEqual([]);
  });

  it("logs tool name, duration and an argument summary but never file contents", async () => {
    const { host, deps, logs } = setup();
    await runReadFile(host, deps, { path: "src/app/helpers.py", start: 4, end: 7, why: WHY });
    expect(logs).toHaveLength(1);
    expect(logs[0]).toMatch(/^tool read_file \d+ms ok path="src\/app\/helpers\.py" start=4 end=7 why=/);
    expect(logs[0]).not.toContain("os.environ");
  });

  it("never throws: an unexpected host failure becomes an isError result", async () => {
    const { deps } = setup();
    const broken = new FakeHost({});
    broken.readText = () => Promise.reject(new Error("disk exploded"));
    const r = await runReadFile(broken, deps, { path: "a.py", why: WHY });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/Unexpected error in read_file: disk exploded/);
  });
});
