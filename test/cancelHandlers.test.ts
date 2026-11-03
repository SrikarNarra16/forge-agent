import { describe, expect, it } from "vitest";
import { NodeCommandRunner } from "../src/host/commandRunner";
import { DecisionStore } from "../src/mcp/decisions";
import { HostError } from "../src/mcp/host";
import { CommandTickets } from "../src/mcp/commandTickets";
import { createToolDeps } from "../src/mcp/tools/common";
import { keyForCall, runProposeEdit } from "../src/mcp/tools/editTools";
import { runRunCommand } from "../src/mcp/tools/runCommand";
import { applyAccepted, type ApplyIo, type ApplyRequest } from "../src/review/applyCore";
import { CheckpointStore, UserModifiedError, type FileRestorer } from "../src/review/checkpoints";
import { hashText } from "../src/review/hash";
import { applyRangedEdits } from "../src/review/hunks";
import { ReviewApprovalHandler, ReviewCancelled, type ReviewEditor, type ReviewHandle, type ReviewPresenter } from "../src/review/reviewHandler";
import type { ReviewSession } from "../src/review/session";
import { ReviewTracker } from "../src/review/tracker";
import { CommandApprovalHandler } from "../src/trueforge/commandApprovals";
import { RunRegistry } from "../src/trueforge/runRegistry";
import type { PendingToolCall } from "../src/trueforge/agentController";
import { FakeHost, makeRig } from "./helpers/fakeHost";
import { deferred, tick } from "./helpers/fakeClient";

const BASE = "l1\nl2\nl3\nl4\nl5\n";

class DiskLikeEditor implements ReviewEditor {
  readonly files = new Map<string, string>([["src/a.py", BASE]]);
  readonly checkpoints = new CheckpointStore();
  /** When set, apply waits for it (a slow, atomic write). */
  applyGate: Promise<void> | undefined;
  writes = 0;
  rootPath = () => Promise.resolve("/work");
  readText(path: string): Promise<string> {
    const t = this.files.get(path);
    return t === undefined ? Promise.reject(new HostError("ENOENT", path)) : Promise.resolve(t);
  }
  async apply(request: ApplyRequest): Promise<void> {
    const io: ApplyIo = {
      readLive: (p) => Promise.resolve(this.files.get(p)),
      write: async (req) => {
        await this.applyGate;
        this.writes++;
        this.files.set(req.path, req.kind === "create" ? req.newText : applyRangedEdits(this.files.get(req.path) ?? "", req.edits));
      },
    };
    await applyAccepted(io, this.checkpoints, request);
  }
}

class Presenter implements ReviewPresenter {
  sessions: ReviewSession[] = [];
  closed = 0;
  present(session: ReviewSession): ReviewHandle {
    this.sessions.push(session);
    return { close: () => void this.closed++ };
  }
  async session(n = 0): Promise<ReviewSession> {
    for (let i = 0; i < 50 && this.sessions.length <= n; i++) await tick();
    return this.sessions[n] as ReviewSession;
  }
}

const edit = (id = "c1"): PendingToolCall => ({ id, name: "propose_edit", args: JSON.stringify({ path: "src/a.py", edits: [{ old_text: "l2\n", new_text: "L2\n" }], summary: "x" }), threadId: "main", sourceEventId: "m" });

function setup() {
  const editor = new DiskLikeEditor();
  const presenter = new Presenter();
  const decisions = new DecisionStore();
  const tracker = new ReviewTracker();
  const registry = new RunRegistry();
  registry.begin("run-1");
  const handler = new ReviewApprovalHandler({ editor, presenter, decisions, tracker, getRunId: () => "run-1", registry });
  const ctrl = new AbortController();
  /** What the controller's Stop does to the handler: registry flag + abort signal. */
  const stop = (): void => {
    registry.cancel();
    ctrl.abort();
  };
  return { editor, presenter, decisions, tracker, registry, handler, signal: ctrl.signal, stop };
}

/** Restorer over the in-memory editor, like VscodeRestorer(non-interactive). */
const restorer = (editor: DiskLikeEditor): FileRestorer => ({
  restoreText: (p, text, expected) => {
    const current = editor.files.get(p) ?? "";
    if (expected !== undefined && hashText(current) !== expected) return Promise.reject(new UserModifiedError(p));
    editor.files.set(p, text);
    return Promise.resolve();
  },
  deleteFile: (p, expected) => {
    const current = editor.files.get(p);
    if (current !== undefined && expected !== undefined && hashText(current) !== expected) return Promise.reject(new UserModifiedError(p));
    editor.files.delete(p);
    return Promise.resolve();
  },
});

describe("cancel while a diff is open", () => {
  it("closes the diff, marks the entry cancelled and writes nothing", async () => {
    const s = setup();
    const pending = s.handler.decide(edit(), s.signal);
    await s.presenter.session();
    s.stop();
    await expect(pending).rejects.toBeInstanceOf(ReviewCancelled);
    expect(s.presenter.closed).toBe(1);
    expect(s.tracker.get("c1")?.state).toBe("cancelled");
    expect(s.editor.files.get("src/a.py")).toBe(BASE);
    expect(s.editor.writes).toBe(0);
  });
  it("a cancelled run is not even shown a new diff", async () => {
    const s = setup();
    s.registry.cancel();
    await expect(s.handler.decide(edit("c2"), new AbortController().signal)).rejects.toBeInstanceOf(ReviewCancelled);
    expect(s.presenter.sessions).toHaveLength(0);
  });
});

describe("cancel between approve and apply", () => {
  it("before the write starts: nothing is applied", async () => {
    const s = setup();
    const pending = s.handler.decide(edit(), s.signal);
    const session = await s.presenter.session();
    s.stop(); // Stop first...
    session.acceptAll(); // ...then the (late) click on Apply
    session.apply();
    await expect(pending).rejects.toBeInstanceOf(ReviewCancelled);
    expect(s.editor.writes).toBe(0);
    expect(s.editor.files.get("src/a.py")).toBe(BASE);
  });

  it("while the write is in flight: the atomic apply finishes, idle() waits for it, no decision is recorded, then rollback restores the file", async () => {
    const s = setup();
    const gate = deferred();
    s.editor.applyGate = gate.promise;
    const c = edit();
    const pending = s.handler.decide(c, s.signal);
    const session = await s.presenter.session();
    session.acceptAll();
    session.apply();
    await tick(); // apply is now waiting inside write()
    s.stop();
    let idle = false;
    void s.handler.idle().then(() => (idle = true));
    await tick();
    expect(idle).toBe(false); // Stop waits for the apply
    gate.resolve();
    await expect(pending).rejects.toBeInstanceOf(ReviewCancelled);
    await s.handler.idle();
    expect(idle).toBe(true);
    expect(s.editor.files.get("src/a.py")).toBe(BASE.replace("l2\n", "L2\n")); // the apply completed atomically
    expect(s.decisions.take(keyForCall("propose_edit", c.args)!)).toBeUndefined(); // the agent is told nothing
    const result = await s.editor.checkpoints.rollbackRun("run-1", restorer(s.editor));
    expect(result).toEqual({ restored: ["src/a.py"], skipped: [], failed: [] });
    expect(s.editor.files.get("src/a.py")).toBe(BASE); // identical to before
  });
});

describe("rollback after an edit applied earlier in the same run", () => {
  async function applyOne(s: ReturnType<typeof setup>): Promise<void> {
    const pending = s.handler.decide(edit(), s.signal);
    const session = await s.presenter.session();
    session.acceptAll();
    session.apply();
    await pending;
  }
  it("restores the exact original text and deletes files the run created", async () => {
    const s = setup();
    await applyOne(s);
    // a created file in the same run
    s.editor.checkpoints.snapshot("run-1", "docs/new.rst", { existed: false });
    s.editor.files.set("docs/new.rst", "x");
    s.editor.checkpoints.recordApplied("run-1", "docs/new.rst", hashText("x"));
    const r = await s.editor.checkpoints.rollbackRun("run-1", restorer(s.editor));
    expect([...r.restored].sort()).toEqual(["docs/new.rst", "src/a.py"]);
    expect(s.editor.files.get("src/a.py")).toBe(BASE);
    expect(s.editor.files.has("docs/new.rst")).toBe(false);
  });
  it("leaves a file alone when the user edited it after Forge wrote it (skipped, not overwritten, not failed)", async () => {
    const s = setup();
    await applyOne(s);
    s.editor.files.set("src/a.py", `${s.editor.files.get("src/a.py")}my own line\n`);
    const r = await s.editor.checkpoints.rollbackRun("run-1", restorer(s.editor));
    expect(r).toEqual({ restored: [], skipped: ["src/a.py"], failed: [] });
    expect(s.editor.files.get("src/a.py")).toContain("my own line");
  });
});

describe("late calls after Stop never act", () => {
  it("propose_edit/create_file return an error for a cancelled run and look up no decision", async () => {
    const registry = new RunRegistry();
    registry.begin("run-1");
    const decisions = new DecisionStore();
    const c = edit();
    decisions.put(keyForCall("propose_edit", c.args)!, { path: "src/a.py", kind: "edit", applied: 1, total: 1, added: 1, removed: 1, rejected: [] });
    const deps = createToolDeps({ log: () => undefined, events: makeRig().deps.events, decisions, run: { isCancelled: () => registry.isCancelled(), signal: () => registry.signal } });
    registry.cancel();
    const r = await runProposeEdit(deps, JSON.parse(c.args));
    expect(r.isError).toBe(true);
    expect((r.content as Array<{ text: string }>)[0]?.text).toMatch(/cancelled by the user.*nothing was changed/);
  });

  it("run_command refuses a command nobody approved, and a cancelled run", async () => {
    const tickets = new CommandTickets();
    const registry = new RunRegistry();
    registry.begin("run-1");
    let ran = 0;
    const runner = { run: () => (ran++, Promise.resolve({ exitCode: 0, output: "", timedOut: false, aborted: false, durationMs: 1 })) };
    const deps = createToolDeps({ log: () => undefined, events: makeRig().deps.events, commands: runner, tickets, run: { isCancelled: () => registry.isCancelled(), signal: () => registry.signal } });
    const host = new FakeHost({});
    expect((await runRunCommand(host, deps, { command: "pytest -q" })).isError).toBe(true); // no ticket
    tickets.issue("pytest -q");
    expect((await runRunCommand(host, deps, { command: "pytest -q" })).isError).toBeFalsy();
    expect(ran).toBe(1);
    tickets.issue("pytest -q");
    registry.cancel();
    expect((await runRunCommand(host, deps, { command: "pytest -q" })).isError).toBe(true); // cancelled run
    expect(ran).toBe(1);
  });

  it("the command approval handler denies after Stop and issues no ticket", async () => {
    const tickets = new CommandTickets();
    const registry = new RunRegistry();
    registry.begin("run-1");
    const inner = deferred<{ status: "allow" }>();
    const handler = new CommandApprovalHandler({ inner: { decide: () => inner.promise }, getRunId: () => "run-1", getRoot: () => Promise.resolve("/work"), tickets, registry });
    const pending = handler.decide({ id: "c", name: "run_command", args: '{"command":"pytest"}', threadId: "main", sourceEventId: "m" }, new AbortController().signal);
    await tick();
    registry.cancel();
    inner.resolve({ status: "allow" }); // the user clicked Allow a moment too late
    expect(await pending).toMatchObject({ status: "deny" });
    expect(tickets.size).toBe(0);
  });
});

describe("cancel while run_command is running (real processes)", () => {
  it("kills the whole process group, including a backgrounded child", async () => {
    const runner = new NodeCommandRunner();
    const marker = `forge-cancel-${process.pid}-${Date.now()}`;
    const started = Date.now();
    const running = runner.run(`(sleep 31 ; echo ${marker}) & sleep 32`, { cwd: process.cwd(), timeoutMs: 60_000 });
    await new Promise((r) => setTimeout(r, 300));
    runner.cancelAll(); // what Stop's cancelWork does
    const result = await running;
    expect(result.aborted).toBe(true);
    expect(Date.now() - started).toBeLessThan(8000);
    await new Promise((r) => setTimeout(r, 300));
    const { execFileSync } = await import("node:child_process");
    const alive = execFileSync("ps", ["-axo", "command"], { encoding: "utf8" }).split("\n").filter((l) => l.includes("sleep 31") || l.includes("sleep 32"));
    expect(alive).toEqual([]);
  }, 20_000);

  it("cancelAll with nothing running is harmless", () => {
    new NodeCommandRunner().cancelAll();
  });
});
