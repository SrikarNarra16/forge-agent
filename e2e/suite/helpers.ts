import { execFile } from "node:child_process";
import * as vscode from "vscode";
import { promisify } from "node:util";
import type { E2eConfig } from "../common";

const exec = promisify(execFile);

/** Everything `forge.e2e.state` returns (see src/e2e/hooks.ts). */
export interface E2eState {
  runState: string;
  stateHistory: string[];
  statusLine: { state: string; model?: string; detail?: string };
  items: Array<Record<string, unknown> & { kind: string; id: string }>;
  review: Array<{ callId: string; path: string; state: string; hunks?: number; applied?: number; detail?: string }>;
  context: { plan?: { items: unknown[]; usedTokens: number; budgetTokens: number; note?: string }; reads: unknown[]; modelInputTokens?: number };
  chainNotice?: string;
  chainEvents: Array<{ kind: string; text: string; afterMs?: number }>;
  notices: Array<{ level: string; text: string }>;
  sessions: string[];
  models: string[];
  discards: number;
  usage: { input: number; output: number; calls: number };
  panelViewResolved: boolean;
  readyCount: number;
  resourcePrefix: string;
}

export const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

export async function state(): Promise<E2eState> {
  return (await vscode.commands.executeCommand("forge.e2e.state")) as E2eState;
}

/** Polls `pred` (no fixed sleeps in the scenarios: they wait for the condition they need). */
export async function waitFor<T>(what: string, pred: () => Promise<T | undefined | false> | T | undefined | false, timeoutMs = 30_000, everyMs = 100): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      const v = await pred();
      if (v) return v;
    } catch (err) {
      last = err;
    }
    await sleep(everyMs);
  }
  throw new Error(`timed out after ${timeoutMs} ms waiting for ${what}${last ? ` (last error: ${String(last)})` : ""}`);
}

export const idle = (s: E2eState): boolean => !["running", "awaitingApproval", "cancelling"].includes(s.runState);

export async function waitIdle(timeoutMs: number, what = "the run to end"): Promise<E2eState> {
  return waitFor(what, async () => {
    const s = await state();
    return idle(s) && s.stateHistory.length > 0 ? s : undefined;
  }, timeoutMs, 250);
}

export async function git(cfg: E2eConfig, ...args: string[]): Promise<string> {
  return (await exec("git", args, { cwd: cfg.workspace, maxBuffer: 20_000_000 })).stdout;
}

export async function dirty(cfg: E2eConfig): Promise<string> {
  return (await git(cfg, "status", "--porcelain", "-uall")).trim();
}

/** Closes editors and puts the temp Flask copy back to the pristine commit (test-harness housekeeping between scenarios). */
export async function resetWorkspace(cfg: E2eConfig): Promise<void> {
  // an unsaved buffer (e.g. after an undo) would block closing and later disagree with the disk: revert every dirty document first
  for (const doc of vscode.workspace.textDocuments.filter((d) => d.isDirty && d.uri.scheme === "file")) {
    await vscode.window.showTextDocument(doc);
    await vscode.commands.executeCommand("workbench.action.files.revert");
  }
  await vscode.commands.executeCommand("workbench.action.closeAllEditors");
  await exec("git", ["checkout", "-q", "--", "."], { cwd: cfg.workspace });
  await exec("git", ["clean", "-fdq"], { cwd: cfg.workspace });
  // VS Code keeps documents it has seen; wait until each one shows what is on disk again (otherwise the next scenario
  // would plan its edit against a stale buffer)
  const { readFile } = await import("node:fs/promises");
  for (const doc of vscode.workspace.textDocuments.filter((d) => d.uri.scheme === "file" && d.uri.fsPath.startsWith(cfg.workspace))) {
    await waitFor(`${doc.uri.fsPath} to match the disk`, async () => doc.getText() === (await readFile(doc.uri.fsPath, "utf8").catch(() => doc.getText())), 10_000, 100);
  }
}

export async function openFile(cfg: E2eConfig, rel: string): Promise<vscode.TextEditor> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${cfg.workspace}/${rel}`));
  return vscode.window.showTextDocument(doc);
}

export async function run(cfg: E2eConfig, command: string, args: string[], env: Record<string, string> = {}): Promise<{ code: number; out: string }> {
  try {
    const r = await exec(command, args, { cwd: cfg.workspace, env: { ...process.env, ...env }, maxBuffer: 20_000_000, timeout: 300_000 });
    return { code: 0, out: r.stdout + r.stderr };
  } catch (err) {
    const e = err as { code?: number; stdout?: string; stderr?: string; message: string };
    return { code: typeof e.code === "number" ? e.code : 1, out: (e.stdout ?? "") + (e.stderr ?? e.message) };
  }
}

/** scripts/verify-task-a.sh against the temp copy. */
export function verifyTaskA(cfg: E2eConfig): Promise<{ code: number; out: string }> {
  return run(cfg, "bash", [`${cfg.repoRoot}/scripts/verify-task-a.sh`], { FIXTURE_DIR: cfg.workspace, PYTHON: cfg.python });
}

/** scripts/verify-task-b.sh against the temp copy. */
export function verifyTaskB(cfg: E2eConfig): Promise<{ code: number; out: string }> {
  return run(cfg, "bash", [`${cfg.repoRoot}/scripts/verify-task-b.sh`, cfg.workspace]);
}

export const TASK_A_INSTRUCTION = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value";
export const TASK_B_PROMPT =
  'Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.';

/** Lines (1-based, inclusive) of `get_debug_flag` in src/flask/helpers.py. */
export async function getDebugFlagRange(cfg: E2eConfig): Promise<{ startLine: number; endLine: number }> {
  const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${cfg.workspace}/src/flask/helpers.py`));
  const lines = doc.getText().split("\n");
  const def = lines.findIndex((l) => l.startsWith("def get_debug_flag"));
  if (def < 0) throw new Error("get_debug_flag not found");
  let end = def;
  while (end + 1 < lines.length && lines[end + 1] !== "" && /^\s/.test(lines[end + 1] ?? "")) end++;
  return { startLine: def + 1, endLine: end + 1 };
}
