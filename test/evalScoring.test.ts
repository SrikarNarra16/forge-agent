import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";
import { assertThrowaway, agentName, mcpName, snapshotDiff } from "../scripts/eval/guard";
import { autoPresenter, decide } from "../scripts/eval/diskEditor";
import { checkDocs, checkFiles, checkMasking, checkNewTest, checkUnrelated, formatScore, scoreTaskB } from "../scripts/eval/score-task-b";
import { PINNED_COMMIT, FIXTURE, FIXTURE_PYTHON, assertImportsFromCopy, createWorkspace, isInsideCopy, pythonEnv } from "../scripts/eval/workspace";
import { ReviewSession } from "../src/review/session";

const run = promisify(execFile);
const haveFixture = existsSync(join(FIXTURE, ".git")) && existsSync(FIXTURE_PYTHON);

describe("name guard", () => {
  it("allows only forge-eval-<pid>-r<n>-agent|mcp names", () => {
    expect(() => assertThrowaway(agentName(123, 2))).not.toThrow();
    expect(() => assertThrowaway(mcpName(123, 2))).not.toThrow();
    for (const bad of ["forge-agent", "forge-editor", "forge-inline", "forge-eval-agent", "forge-eval-1-agent", "forge-eval-1-r1-agentx", "xforge-eval-1-r1-mcp", "forge-inline-test", ""]) {
      expect(() => assertThrowaway(bad), bad).toThrow(/SAFETY/);
    }
  });
  it("reports exactly what differs between two TrueForge snapshots", () => {
    const a = { agents: ["forge-agent"], mcp: ["forge-editor"] };
    expect(snapshotDiff(a, { agents: ["forge-agent"], mcp: ["forge-editor"] })).toEqual([]);
    expect(snapshotDiff(a, { agents: ["forge-agent", "forge-eval-1-r1-agent"], mcp: [] })).toEqual(["+agents:forge-eval-1-r1-agent", "-mcp:forge-editor"]);
  });
});

describe("import-path check", () => {
  it("recognises files inside the copy's src/ only", () => {
    expect(isInsideCopy("/tmp/x/flask", "/tmp/x/flask/src/flask/__init__.py")).toBe(true);
    expect(isInsideCopy("/tmp/x/flask", "/tmp/x/flask/src2/flask/__init__.py")).toBe(false);
    expect(isInsideCopy("/tmp/x/flask", "/Users/me/fixtures/flask/src/flask/__init__.py")).toBe(false);
    expect(pythonEnv("/tmp/x/flask")["PYTHONPATH"]).toBe("/tmp/x/flask/src");
  });
  it.skipIf(!haveFixture)("aborts loudly when flask resolves outside the copy", async () => {
    const dir = await mkdtemp(join(tmpdir(), "forge-eval-test-"));
    try {
      await mkdir(join(dir, "src"), { recursive: true }); // no flask in this "copy": the venv's editable install (the real fixture) wins
      await expect(assertImportsFromCopy(dir, FIXTURE_PYTHON)).rejects.toThrow(/ABORT/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("auto-accept presenter", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((l) => `${l}\n`).join("");
  const proposed = original.replace("a\n", "A\n").replace("l\n", "L\n"); // two separate hunks
  const session = (): ReviewSession => new ReviewSession({ path: "f.txt", kind: "edit", summary: "x", original, proposed } as never);
  it("accepts every hunk in mode all", async () => {
    const s = session();
    expect(s.hunks.length).toBe(2);
    decide(s, "all");
    await expect(s.done).resolves.toEqual({ kind: "apply", accepted: [0, 1] });
  });
  it("accepts only the first hunk in mode first-only", async () => {
    const s = session();
    decide(s, "first-only");
    await expect(s.done).resolves.toEqual({ kind: "apply", accepted: [0] });
    expect(s.composed()).toContain("A\n");
    expect(s.composed()).toContain("l\n");
  });
  it("decides asynchronously through the presenter and can be closed", async () => {
    const s = session();
    const handle = autoPresenter("all").present(s, { autoOpen: true });
    expect(s.finished).toBe(false);
    await expect(s.done).resolves.toMatchObject({ kind: "apply" });
    handle.close();
    const s2 = session();
    autoPresenter("all").present(s2, { autoOpen: true }).close();
    await new Promise((r) => setTimeout(r, 30));
    expect(s2.finished).toBe(false);
  });
});

describe("scorer building blocks", () => {
  const three = ["docs/cli.rst", "src/flask/cli.py", "tests/test_cli.py"];
  it("checkFiles / checkUnrelated", () => {
    expect(checkFiles(three).pass).toBe(true);
    expect(checkFiles(["src/flask/cli.py", "tests/test_cli.py"]).pass).toBe(false);
    expect(checkFiles([...three.slice(1), "README.md"]).pass).toBe(false);
    expect(checkUnrelated([...three, "CHANGES.rst"]).pass).toBe(true);
    expect(checkUnrelated([...three, "src/flask/app.py"]).detail).toMatch(/src\/flask\/app\.py/);
  });
  it("checkNewTest / checkDocs read added lines only", () => {
    expect(checkNewTest("+def test_config_command(runner):\n+    runner.invoke(cli, ['config'])\n").pass).toBe(true);
    expect(checkNewTest("+def test_other():\n+    pass\n").pass).toBe(false);
    expect(checkNewTest("-def test_config_old():\n context\n").pass).toBe(false);
    expect(checkDocs("+Show the Config\n+``flask config`` prints it.\n").pass).toBe(true);
    expect(checkDocs("+``flask config``\n").pass).toBe(false);
    expect(checkDocs(" flask config already here\n+unrelated\n+lines\n").pass).toBe(false);
  });
  it("checkMasking: exact masked set, native values unchanged, non-serialisable present", () => {
    const expected = { SECRET_KEY: { native: true, value: "s" }, name: { native: true, value: "x" }, delay: { native: false, value: null }, Api_Token: { native: true, value: 1 } };
    expect(checkMasking(expected, { SECRET_KEY: "***", name: "x", delay: "0:00:30", Api_Token: "***" }).pass).toBe(true);
    expect(checkMasking(expected, { SECRET_KEY: "s", name: "x", delay: "d", Api_Token: "***" }).detail).toMatch(/SECRET_KEY not masked/);
    expect(checkMasking(expected, { SECRET_KEY: "***", name: "***", delay: "d", Api_Token: "***" }).detail).toMatch(/name changed/);
    expect(checkMasking(expected, { SECRET_KEY: "***", name: "x", Api_Token: "***" }).detail).toMatch(/missing key delay/);
    expect(checkMasking(expected, [1]).pass).toBe(false);
    expect(checkMasking(expected, { SECRET_KEY: "***", name: "x", delay: "d", Api_Token: "***", extra: 1 }).detail).toMatch(/unexpected key extra/);
  });
});

describe.skipIf(!haveFixture)("scorer on real Flask copies", () => {
  async function scored(patch: string | undefined) {
    const ws = await createWorkspace();
    try {
      if (patch) await run("git", ["apply", join(__dirname, "fixtures", "task-b", patch)], { cwd: ws.root });
      return await scoreTaskB({ root: ws.root, python: ws.python });
    } finally {
      await ws.dispose();
    }
  }
  const verdict = (r: Awaited<ReturnType<typeof scored>>): Record<string, boolean> => Object.fromEntries(r.checks.map((c) => [c.id, c.pass]));

  it("a clean checkout out of the box is pinned at the expected commit", async () => {
    const ws = await createWorkspace();
    try {
      expect((await run("git", ["rev-parse", "HEAD"], { cwd: ws.root })).stdout.startsWith(PINNED_COMMIT)).toBe(true);
      expect((await run("git", ["status", "--porcelain"], { cwd: ws.root })).stdout).toBe("");
    } finally {
      await ws.dispose();
    }
  }, 60_000);

  it("passes a correct solution on every check", async () => {
    const r = await scored("correct.patch");
    expect(r.pass, formatScore(r)).toBe(true);
    expect(r.checks).toHaveLength(7);
  }, 120_000);

  it("fails an untouched checkout", async () => {
    const r = await scored(undefined);
    expect(verdict(r)).toMatchObject({ a: false, c: false, d: false, e: false, f: false });
    expect(r.pass).toBe(false);
  }, 120_000);

  it("fails a solution that does not mask", async () => {
    const r = await scored("no-mask.patch");
    expect(verdict(r)).toMatchObject({ a: true, c: true, d: false });
    expect(r.checks.find((c) => c.id === "d")?.detail).toMatch(/not masked/);
    expect(verdict(r)["b"]).toBe(false); // its own test asserts masking
  }, 120_000);

  it("fails a code-only change", async () => {
    const r = await scored("code-only.patch");
    expect(verdict(r)).toMatchObject({ a: false, b: true, c: true, d: true, e: false, f: false });
  }, 120_000);
});

