import { execFile } from "node:child_process";
import { appendFile, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export const PINNED_COMMIT = "22d92470";
export const FIXTURE = resolve(__dirname, "..", "..", "..", "fixtures", "flask");
export const FIXTURE_PYTHON = join(FIXTURE, ".venv", "bin", "python");

export interface Workspace {
  root: string;
  python: string;
  env: NodeJS.ProcessEnv;
  dispose(): Promise<void>;
}

/** Environment that makes `import flask` resolve to the copy's src/ (the fixture's venv python, PYTHONPATH first). */
export function pythonEnv(root: string): NodeJS.ProcessEnv {
  return { ...process.env, PYTHONPATH: join(root, "src"), PYTHONDONTWRITEBYTECODE: "1" };
}

/** True when `file` (flask.__file__) is inside `<root>/src`. */
export function isInsideCopy(root: string, file: string): boolean {
  const src = resolve(root, "src") + sep;
  return resolve(file).startsWith(src);
}

/** Aborts loudly unless `import flask` resolves into the copy. */
export async function assertImportsFromCopy(root: string, python: string): Promise<string> {
  const { stdout } = await run(python, ["-c", "import flask; print(flask.__file__)"], { env: pythonEnv(root), cwd: root });
  const file = stdout.trim();
  if (!isInsideCopy(root, file)) throw new Error(`ABORT: flask imports from ${file}, not from the temp copy ${root}/src. Refusing to run (it could test the real fixture).`);
  return file;
}

/** A clean `git clone --local` of the pinned fixture in a fresh temp dir. The fixture itself is only read. */
export async function createWorkspace(options: { fixture?: string; python?: string; /** Build a real `.venv` inside the copy (`python -m venv` + `pip install -e . pytest`), like scripts/setup-fixture.sh, so the auto-detected `. .venv/bin/activate &&` prefix works. */ realVenv?: boolean } = {}): Promise<Workspace> {
  const fixture = options.fixture ?? FIXTURE;
  const python = options.python ?? FIXTURE_PYTHON;
  const parent = await mkdtemp(join(tmpdir(), "forge-eval-"));
  const root = join(parent, "flask");
  const dispose = (): Promise<void> => rm(parent, { recursive: true, force: true });
  try {
    await run("git", ["clone", "--local", "--quiet", fixture, root]);
    const head = (await run("git", ["rev-parse", "HEAD"], { cwd: root })).stdout.trim();
    if (!head.startsWith(PINNED_COMMIT)) throw new Error(`ABORT: fixture is at ${head}, expected ${PINNED_COMMIT}`);
    const status = (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
    if (status !== "") throw new Error(`ABORT: fresh clone is not clean:\n${status}`);
    let interpreter = python;
    if (options.realVenv) {
      // `.venv/` must be ignored in the copy (a clone does not carry the fixture's .git/info/exclude), or git status would not be clean
      await appendFile(join(root, ".git", "info", "exclude"), ".venv/\n", "utf8");
      await run(python, ["-m", "venv", join(root, ".venv")]);
      interpreter = join(root, ".venv", "bin", "python");
      await run(interpreter, ["-m", "pip", "install", "--quiet", "--upgrade", "pip"], { cwd: root });
      await run(interpreter, ["-m", "pip", "install", "--quiet", "-e", root, "pytest"], { cwd: root, maxBuffer: 20_000_000 });
      const after = (await run("git", ["status", "--porcelain"], { cwd: root })).stdout.trim();
      if (after !== "") throw new Error(`ABORT: the copy is not clean after creating its virtualenv:\n${after}`);
    }
    await assertImportsFromCopy(root, interpreter);
    return { root, python: interpreter, env: pythonEnv(root), dispose };
  } catch (err) {
    await dispose();
    throw err;
  }
}
