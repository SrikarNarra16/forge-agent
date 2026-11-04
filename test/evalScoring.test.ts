import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, rm, mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { readFileSync } from "node:fs";
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
    expect(checkUnrelated(three)).toMatchObject({ pass: true, detail: "ok" });
    // corrected (g): an extra file under src/ tests/ docs/ passes and is only a note
    expect(checkUnrelated([...three, "docs/api.rst"])).toMatchObject({ pass: true, detail: "also touched: docs/api.rst" });
    expect(checkUnrelated([...three, "src/flask/app.py", "tests/test_basic.py"])).toMatchObject({ pass: true });
    // ...but a modified file outside those folders fails, as does any deletion
    expect(checkUnrelated([...three, "CHANGES.rst"])).toMatchObject({ pass: false });
    expect(checkUnrelated([...three, "pyproject.toml"]).detail).toMatch(/modified outside src\/tests\/docs: pyproject\.toml/);
    expect(checkUnrelated(three, ["tests/test_old.py"])).toMatchObject({ pass: false, detail: "deleted: tests/test_old.py" });
    expect(checkUnrelated([...three, "docs/api.rst", "setup.cfg"]).detail).toMatch(/setup\.cfg.*also touched: docs\/api\.rst/);
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


import { formatSummary, isProviderError, summarize, tableRow, type RunReport } from "../scripts/eval/report";

describe("eval report", () => {
  const base: RunReport = {
    runId: "2026-11-03-1-r1", date: "2026-11-03", task: "b", model: "deepseek/flash", accept: "all", pass: false,
    checks: [{ id: "a", name: "files", pass: true, detail: "" }, { id: "b", name: "pytest", pass: false, detail: "1 failed | x" }],
    seconds: 61.2, state: "done", modelCalls: 7, toolCalls: { read_file: 3, propose_edit: 3 }, filesRead: [], keyFilesInContext: ["src/flask/cli.py"], keyFilesRead: [],
    contextPaths: [], contextItems: 8, contextTokens: 3000, tokens: { input: 1000, output: 200, calls: 7 }, finalMessage: "", errors: [], providerError: false, attempts: 1, attemptKinds: ["pass"], ranTests: true, usedDeferredLoading: false, usedScout: false, commands: [], changedFiles: [],
  };
  it("renders a markdown row that cannot break the table", () => {
    const row = tableRow(base);
    expect(row.startsWith("| 2026-11-03-1-r1 | 2026-11-03 | B | deepseek/flash | FAIL | a✓ b✗ | 1000/200 |")).toBe(true);
    expect(row).toContain("key files in context 1/3, read 0/3");
    expect(row).toContain("1 failed \\| x");
    expect(row.trim().split("\n")).toHaveLength(1);
  });
  it("recognises provider errors", () => {
    expect(isProviderError(["[Model Error] Request failed (503): Service is too busy."])).toBe(true);
    expect(isProviderError(["client-cancelled"])).toBe(true);
    expect(isProviderError(["propose_edit: old_text not found"])).toBe(false);
  });
  it("summarises pass rate per check and overall", () => {
    const s = summarize([base, { ...base, pass: true, checks: base.checks.map((c) => ({ ...c, pass: true })) }]);
    expect(s).toEqual(expect.objectContaining({ runs: 2, passed: 1, providerFailures: 0, agentFailures: 1, perCheck: { a: { passed: 2, total: 2 }, b: { passed: 1, total: 2 } } }));
    expect(formatSummary([base])).toMatch(/Overall: 0\/1 runs passed/);
    expect(formatSummary([base])).toMatch(/Failures: 1 agent, 0 provider/);
  });
});


describe("check (f), corrected after human review of the failing runs (4 Nov 2026)", () => {
  const fixture = (name: string): string => readFileSync(join(__dirname, "fixtures", "task-b", "docs-added", `${name}.diff`), "utf8");

  // REAL added texts of the four runs the old rule failed although they documented the command in the file's own style
  it.each(["baseline-r1", "baseline-r3", "iter1-r3", "iter1-r5"])("passes the real docs entry of run %s", (name) => {
    const r = checkDocs(fixture(name));
    expect(r.pass, r.detail).toBe(true);
  });

  it("the three accepted spellings, each with >= 2 non-blank added lines", () => {
    expect(checkDocs("+Show the Config\n+Run ``flask config`` to print it.\n").pass).toBe(true); // flask config
    expect(checkDocs("+Show the Config\n+    $ flask --app hello config\n").pass).toBe(true); // flask --app <app> config
    expect(checkDocs("+Show the Config\n+The ``config`` command prints it.\n").pass).toBe(true); // ``config``
    expect(checkDocs("+Show the Config\n+The :func:`config <cli.config_command>` command prints it.\n").pass).toBe(true); // :func: role
  });

  it("fails an unrelated docs change", () => {
    const r = checkDocs("+Use the new theme.\n+It looks better.\n");
    expect(r.pass).toBe(false);
    expect(r.detail).toMatch(/WAS changed .* but no added line names the command/);
  });
  it("fails a one-line or whitespace-only change", () => {
    expect(checkDocs("+``flask config``\n").pass).toBe(false); // names it, but only one line
    expect(checkDocs("+\n+   \n+\n").pass).toBe(false);
    expect(checkDocs("+\n").detail).toMatch(/not changed/);
    expect(checkDocs("").pass).toBe(false);
  });
  it("fails a mention of 'config' in an unrelated context", () => {
    for (const text of ["+Read app.config['SECRET_KEY'] in your view.\n+Use the config object for settings.\n", "+The config file is read at startup.\n+Edit config.py first.\n", "+See :class:`Config` and :meth:`Config.from_object`.\n+More text.\n"]) {
      expect(checkDocs(text).pass, text).toBe(false);
    }
  });
});

describe.skipIf(!haveFixture)("check (f) only reads docs/cli.rst", () => {
  it("documenting the command in a DIFFERENT docs file does not pass (f)", async () => {
    const ws = await createWorkspace();
    try {
      await run("git", ["apply", join(__dirname, "fixtures", "task-b", "docs-other-file.patch")], { cwd: ws.root });
      const r = await scoreTaskB({ root: ws.root, python: ws.python });
      const f = r.checks.find((c) => c.id === "f");
      expect(f?.pass).toBe(false);
      expect(f?.detail).toMatch(/not changed/);
      expect(r.checks.find((c) => c.id === "a")?.pass).toBe(false); // cli.rst is also one of the three required files
    } finally {
      await ws.dispose();
    }
  }, 120_000);
});
