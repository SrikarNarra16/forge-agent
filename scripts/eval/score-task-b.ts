/**
 * Scores Task B on any Flask checkout (a clean git checkout of 3.1.3 plus the agent's changes):
 *
 *   npx tsx scripts/eval/score-task-b.ts [--root <flask checkout>] [--python <python with pytest>] [--json]
 *   scripts/verify-task-b.sh [flask checkout]
 *
 * Checks (a)-(g) are described in CHECKS below. The checkout is only READ and run (pytest, flask); the generated
 * test app lives in a temp dir outside it. Nothing here talks to TrueForge.
 */
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { FIXTURE, FIXTURE_PYTHON, assertImportsFromCopy, pythonEnv } from "./workspace";

const exec = promisify(execFile);

export const REQUIRED_FILES = ["src/flask/cli.py", "tests/test_cli.py", "docs/cli.rst"] as const;
/** (g) fails only when a file outside these top-level folders is modified, or when any file is deleted. */
export const ALLOWED_ROOTS = ["src/", "tests/", "docs/"] as const;
export const SENSITIVE = /secret|password|token|key/i;

export interface CheckResult {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

export interface ScoreResult {
  checks: CheckResult[];
  pass: boolean;
  changedFiles: string[];
}

// --- pure helpers (unit-tested) -----------------------------------------------------------------------------------

export function checkFiles(changed: readonly string[]): CheckResult {
  const missing = REQUIRED_FILES.filter((f) => !changed.includes(f));
  const pass = changed.length >= 3 && missing.length === 0;
  return { id: "a", name: "diff touches >= 3 files incl. cli.py, test_cli.py, cli.rst", pass, detail: pass ? changed.join(", ") : `changed ${changed.length} file(s)${missing.length ? `; missing ${missing.join(", ")}` : ""}` };
}

/**
 * (g): FAIL if a file outside src/, tests/ and docs/ was changed, or any file was deleted. Other touched files
 * (e.g. docs/api.rst) are only an informational note: the competition rule just asks for >= 3 files changed.
 * (Corrected 3 Nov 2026: it used to fail on every file other than the three required ones.)
 */
export function checkUnrelated(changed: readonly string[], deleted: readonly string[] = []): CheckResult {
  const outside = changed.filter((f) => !ALLOWED_ROOTS.some((root) => f.startsWith(root)));
  const also = changed.filter((f) => !(REQUIRED_FILES as readonly string[]).includes(f) && !outside.includes(f));
  const note = also.length > 0 ? `also touched: ${also.join(", ")}` : "";
  const problems = [...(outside.length ? [`modified outside src/tests/docs: ${outside.join(", ")}`] : []), ...(deleted.length ? [`deleted: ${deleted.join(", ")}`] : [])];
  const pass = problems.length === 0;
  return { id: "g", name: "no file outside src/tests/docs modified, nothing deleted", pass, detail: pass ? (note || "ok") : [...problems, note].filter(Boolean).join("; ") };
}

/** Added lines (without the leading +) of a unified diff, headers excluded. */
export function addedLines(diff: string): string[] {
  return diff.split("\n").filter((l) => l.startsWith("+") && !l.startsWith("+++")).map((l) => l.slice(1));
}

export function checkNewTest(testsDiff: string): CheckResult {
  const added = addedLines(testsDiff);
  const newTests = added.filter((l) => /^\s*def test\w*\(/.test(l));
  const refs = added.some((l) => /["']config["']|config_command|flask config/i.test(l));
  const pass = newTests.length > 0 && refs;
  return { id: "e", name: "new test referencing the config command in tests/test_cli.py", pass, detail: pass ? newTests.map((l) => l.trim()).join("; ") : newTests.length === 0 ? "no new test function" : "new tests do not reference the config command" };
}

/**
 * How an entry for the command is recognised in the added lines of docs/cli.rst (the file where the other built-in
 * commands are documented). Corrected on 4 Nov 2026 after a human review of the failing runs: the repo's own docs
 * write commands as `flask --app hello shell` and :func:`shell <cli.shell_command>`, so those spellings count.
 * Frozen since then.
 */
export const DOCS_ENTRY_PATTERNS: readonly RegExp[] = [
  /\bflask(?: --app \S+)? config\b/, // `flask config`, `$ flask --app hello config`
  /``config``/, // the command named in prose
  /:func:`[^`]*config_command[^`]*`/, // a role pointing at the command function
];

export function checkDocs(docsDiff: string): CheckResult {
  const added = addedLines(docsDiff);
  const substantive = added.filter((l) => l.trim() !== "").length;
  const mentions = added.some((l) => DOCS_ENTRY_PATTERNS.some((p) => p.test(l)));
  const pass = mentions && substantive >= 2;
  // The failure detail says what the diff did contain, so "docs untouched" is distinguishable from "docs changed, no entry".
  const failDetail =
    substantive === 0
      ? "docs/cli.rst gained no section/entry for `flask config` (the file was not changed)"
      : substantive < 2
        ? "docs/cli.rst gained fewer than 2 non-blank lines"
        : `docs/cli.rst WAS changed (${substantive} non-blank line(s) added) but no added line names the command (expected \`flask config\`, \`flask --app <app> config\`, \`\`config\`\` or a :func: role naming config_command)`;
  return { id: "f", name: "docs/cli.rst documents `flask config`", pass, detail: pass ? `${added.length} line(s) added` : failDetail };
}

export interface ExpectedEntry {
  /** JSON-native value (exact comparison) or undefined when the value is not JSON-serialisable (presence only). */
  native: boolean;
  value: unknown;
}

/** Compares the command's JSON with the config: sensitive keys must be "***", native values unchanged, same key set. */
export function checkMasking(expected: Record<string, ExpectedEntry>, actual: unknown): CheckResult {
  const name = 'output is valid JSON; SECRET/PASSWORD/TOKEN/KEY keys are "***", others unchanged';
  if (typeof actual !== "object" || actual === null || Array.isArray(actual)) return { id: "d", name, pass: false, detail: "output is not a JSON object" };
  const got = actual as Record<string, unknown>;
  const problems: string[] = [];
  for (const [key, entry] of Object.entries(expected)) {
    if (!(key in got)) problems.push(`missing key ${key}`);
    else if (SENSITIVE.test(key)) {
      if (got[key] !== "***") problems.push(`${key} not masked (${JSON.stringify(got[key])})`);
    } else if (entry.native && JSON.stringify(got[key]) !== JSON.stringify(entry.value)) problems.push(`${key} changed (${JSON.stringify(got[key])} != ${JSON.stringify(entry.value)})`);
  }
  for (const key of Object.keys(got)) if (!(key in expected)) problems.push(`unexpected key ${key}`);
  return { id: "d", name, pass: problems.length === 0, detail: problems.length === 0 ? `${Object.keys(got).length} keys ok` : problems.slice(0, 6).join("; ") };
}

const APP_SOURCE = `from datetime import timedelta
from flask import Flask

app = Flask(__name__)
app.config.update(
    SECRET_KEY="s3cr3t-value",
    DB_PASSWORD="hunter2",
    API_TOKEN="tok-123",
    MY_KEY="key-456",
    lower_secret_thing="x",
    APP_NAME="demo",
    MAX_ITEMS=5,
    FEATURE_ON=True,
    RATIO=0.5,
    TAGS=["a", "b"],
    RETRY_DELAY=timedelta(seconds=30),
)
`;

const DUMP_SOURCE = `import json, sys
sys.path.insert(0, ".")
from evalapp import app

out = {}
for k, v in app.config.items():
    try:
        json.dumps(v)
        out[k] = {"native": True, "value": v}
    except TypeError:
        out[k] = {"native": False, "value": None}
print(json.dumps(out))
`;

// --- running the checkout ----------------------------------------------------------------------------------------

async function git(root: string, args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: root, maxBuffer: 20_000_000 })).stdout;
}

/** Changed files relative to HEAD, including new untracked ones (ignored files such as caches are excluded). */
export async function changedFiles(root: string): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain", "-uall", "--no-renames"]);
  return out.split("\n").filter((l) => l.length > 3).map((l) => l.slice(3).trim()).sort();
}

/** Files removed from the working tree (porcelain status D in either column). */
export async function deletedFiles(root: string): Promise<string[]> {
  const out = await git(root, ["status", "--porcelain", "-uall", "--no-renames"]);
  return out.split("\n").filter((l) => l.length > 3 && /D/.test(l.slice(0, 2))).map((l) => l.slice(3).trim()).sort();
}

async function fileDiff(root: string, path: string): Promise<string> {
  const tracked = await git(root, ["diff", "HEAD", "--", path]);
  if (tracked) return tracked;
  // A tracked file without changes has no added lines. Only a file git does not know yet counts as entirely added.
  const isTracked = await git(root, ["ls-files", "--error-unmatch", "--", path]).then(
    () => true,
    () => false,
  );
  if (isTracked) return "";
  try {
    const { stdout } = await exec("git", ["diff", "--no-index", "--", "/dev/null", path], { cwd: root, maxBuffer: 20_000_000 });
    return stdout;
  } catch (err) {
    return (err as { stdout?: string }).stdout ?? ""; // git diff --no-index exits 1 when files differ
  }
}

async function run(cmd: string, args: string[], options: { cwd: string; env: NodeJS.ProcessEnv; timeoutMs?: number }): Promise<{ code: number; stdout: string; stderr: string }> {
  try {
    const { stdout, stderr } = await exec(cmd, args, { ...options, timeout: options.timeoutMs ?? 300_000, maxBuffer: 20_000_000 });
    return { code: 0, stdout, stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return { code: typeof e.code === "number" ? e.code : 1, stdout: e.stdout ?? "", stderr: e.stderr ?? e.message };
  }
}

export async function scoreTaskB(options: { root: string; python: string }): Promise<ScoreResult> {
  const root = resolve(options.root);
  const env = pythonEnv(root);
  await assertImportsFromCopy(root, options.python);
  const changed = await changedFiles(root);
  const checks: CheckResult[] = [checkFiles(changed)];

  const pytest = await run(options.python, ["-m", "pytest", "tests/test_cli.py", "-q", "-p", "no:cacheprovider"], { cwd: root, env });
  const summary = pytest.stdout.trim().split("\n").filter(Boolean).at(-1) ?? pytest.stderr.slice(0, 200);
  checks.push({ id: "b", name: "pytest tests/test_cli.py -q passes", pass: pytest.code === 0, detail: summary });

  const help = await run(options.python, ["-m", "flask", "--help"], { cwd: root, env });
  const listed = /^\s+config(\s|$)/m.test(help.stdout);
  checks.push({ id: "c", name: "`flask --help` lists config", pass: help.code === 0 && listed, detail: help.code !== 0 ? `exit ${help.code}: ${help.stderr.slice(0, 160)}` : listed ? "listed" : "config not in the command list" });

  const appDir = await mkdtemp(join(tmpdir(), "forge-eval-app-"));
  try {
    await writeFile(join(appDir, "evalapp.py"), APP_SOURCE, "utf8");
    await writeFile(join(appDir, "dump.py"), DUMP_SOURCE, "utf8");
    const dump = await run(options.python, ["dump.py"], { cwd: appDir, env });
    if (dump.code !== 0) {
      checks.push({ id: "d", name: "masked JSON output", pass: false, detail: `could not load the test app: ${dump.stderr.slice(0, 200)}` });
    } else {
      const expected = JSON.parse(dump.stdout) as Record<string, ExpectedEntry>;
      const result = await run(options.python, ["-m", "flask", "--app", "evalapp", "config"], { cwd: appDir, env });
      if (result.code !== 0) checks.push({ id: "d", name: "masked JSON output", pass: false, detail: `flask config exited ${result.code}: ${(result.stderr || result.stdout).trim().split("\n").at(-1)?.slice(0, 200) ?? ""}` });
      else {
        let parsed: unknown;
        try {
          parsed = JSON.parse(result.stdout);
        } catch {
          parsed = undefined;
        }
        checks.push(parsed === undefined ? { id: "d", name: "masked JSON output", pass: false, detail: `stdout is not valid JSON: ${result.stdout.slice(0, 120)}` } : checkMasking(expected, parsed));
      }
    }
  } finally {
    await rm(appDir, { recursive: true, force: true });
  }

  checks.push(checkNewTest(await fileDiff(root, "tests/test_cli.py")));
  checks.push(checkDocs(await fileDiff(root, "docs/cli.rst")));
  checks.push(checkUnrelated(changed, await deletedFiles(root)));
  checks.sort((a, b) => a.id.localeCompare(b.id));
  return { checks, pass: checks.every((c) => c.pass), changedFiles: changed };
}

export function formatScore(result: ScoreResult): string {
  const lines = result.checks.map((c) => `${c.pass ? "PASS" : "FAIL"}  (${c.id}) ${c.name}${c.detail ? `  [${c.detail}]` : ""}`);
  lines.push(`RESULT: ${result.pass ? "PASS" : "FAIL"} (${result.checks.filter((c) => c.pass).length}/${result.checks.length} checks)`);
  return lines.join("\n");
}

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

if (require.main === module) {
  scoreTaskB({ root: arg("--root") ?? FIXTURE, python: arg("--python") ?? process.env["FLASK_PYTHON"] ?? FIXTURE_PYTHON }).then(
    (result) => {
      console.log(process.argv.includes("--json") ? JSON.stringify(result, null, 2) : formatScore(result));
      process.exit(result.pass ? 0 : 1);
    },
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
