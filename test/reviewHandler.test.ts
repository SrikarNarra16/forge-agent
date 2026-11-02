import { beforeEach, describe, expect, it } from "vitest";
import type { PendingToolCall } from "../src/trueforge/agentController";
import { DecisionStore } from "../src/mcp/decisions";
import { HostError } from "../src/mcp/host";
import { keyForCall } from "../src/mcp/tools/editTools";
import { applyAccepted, type ApplyIo, type ApplyRequest } from "../src/review/applyCore";
import { CheckpointStore } from "../src/review/checkpoints";
import { applyRangedEdits } from "../src/review/hunks";
import { PathLocks, ReviewApprovalHandler, ReviewCancelled, type ReviewEditor, type ReviewHandle, type ReviewPresenter } from "../src/review/reviewHandler";
import type { ReviewSession } from "../src/review/session";
import { ReviewTracker } from "../src/review/tracker";
import { tick } from "./helpers/fakeClient";

const BASE = ["l1", "l2", "l3", "l4", "l5", "l6", "l7", "l8", "l9", "l10"].map((l) => `${l}\n`).join("");

class FakeEditor implements ReviewEditor {
  readonly files: Map<string, string>;
  readonly checkpoints = new CheckpointStore();
  readonly writes: string[] = [];
  applyError: Error | undefined;
  /** Runs right before apply reads the live text (lets a test simulate the user typing during review). */
  beforeApply: (() => void) | undefined;

  constructor(initial: Record<string, string>) {
    this.files = new Map(Object.entries(initial));
  }
  rootPath(): Promise<string> {
    return Promise.resolve("/work");
  }
  readText(path: string): Promise<string> {
    const text = this.files.get(path);
    if (text !== undefined) return Promise.resolve(text);
    const isDir = [...this.files.keys()].some((f) => f.startsWith(`${path}/`));
    return Promise.reject(new HostError(isDir ? "EISDIR" : "ENOENT", path));
  }
  apply(request: ApplyRequest): Promise<void> {
    this.beforeApply?.();
    if (this.applyError) return Promise.reject(this.applyError);
    const io: ApplyIo = {
      readLive: (p) => Promise.resolve(this.files.get(p)),
      write: (req) => {
        this.writes.push(req.path);
        this.files.set(req.path, req.kind === "create" ? req.newText : applyRangedEdits(this.files.get(req.path) ?? "", req.edits));
        return Promise.resolve();
      },
    };
    return applyAccepted(io, this.checkpoints, request);
  }
}

class FakePresenter implements ReviewPresenter {
  readonly sessions: ReviewSession[] = [];
  readonly autoOpen: boolean[] = [];
  closed = 0;
  failWith: Error | undefined;
  present(session: ReviewSession, options: { autoOpen: boolean }): ReviewHandle {
    if (this.failWith) throw this.failWith;
    this.sessions.push(session);
    this.autoOpen.push(options.autoOpen);
    return { close: () => void this.closed++ };
  }
  async session(n: number): Promise<ReviewSession> {
    for (let i = 0; i < 50 && this.sessions.length <= n; i++) await tick();
    const s = this.sessions[n];
    if (!s) throw new Error(`no review session #${n}`);
    return s;
  }
}

const call = (id: string, name: "propose_edit" | "create_file", args: unknown): PendingToolCall => ({ id, name, args: JSON.stringify(args), threadId: "main", sourceEventId: "m1" });
const edit = (path: string, edits: Array<[string, string]>, summary = "change"): PendingToolCall =>
  call(`call-${path}-${edits.map((e) => e[0]).join("")}`, "propose_edit", { path, edits: edits.map(([old_text, new_text]) => ({ old_text, new_text })), summary });

interface Rig {
  editor: FakeEditor;
  presenter: FakePresenter;
  decisions: DecisionStore;
  tracker: ReviewTracker;
  handler: ReviewApprovalHandler;
  signal: AbortSignal;
  abort: () => void;
}

function rig(files: Record<string, string> = { "src/a.py": BASE }): Rig {
  const editor = new FakeEditor(files);
  const presenter = new FakePresenter();
  const decisions = new DecisionStore();
  const tracker = new ReviewTracker();
  const ctrl = new AbortController();
  const handler = new ReviewApprovalHandler({ editor, presenter, decisions, tracker, getRunId: () => "run-1" });
  return { editor, presenter, decisions, tracker, handler, signal: ctrl.signal, abort: () => ctrl.abort() };
}

const THREE: Array<[string, string]> = [["l2\n", "L2\n"], ["l5\n", "L5\n"], ["l9\n", "L9\n"]];

describe("ReviewApprovalHandler: one file", () => {
  let r: Rig;
  beforeEach(() => {
    r = rig();
  });

  it("partial accept: writes exactly the accepted hunks, records the decision, allows", async () => {
    const c = edit("src/a.py", THREE, "tweak three lines");
    const pending = r.handler.decide(c, r.signal);
    const s = await r.presenter.session(0);
    expect(s.hunks).toHaveLength(3);
    expect(s.info).toMatchObject({ path: "src/a.py", kind: "edit", summary: "tweak three lines", original: BASE });
    s.accept(0);
    s.reject(1);
    s.accept(2);
    s.apply();
    expect(await pending).toEqual({ status: "allow" });
    expect(r.editor.files.get("src/a.py")).toBe(BASE.replace("l2\n", "L2\n").replace("l9\n", "L9\n"));
    expect(r.decisions.take(keyForCall("propose_edit", c.args)!)).toEqual({
      path: "src/a.py", kind: "edit", applied: 2, total: 3, added: 2, removed: 2, rejected: ["hunk 2 (line 5): + L5"],
    });
    expect(r.tracker.get(c.id)).toMatchObject({ state: "applied", applied: 2, hunks: 3 });
    expect(r.presenter.closed).toBe(1);
  });

  it("snapshots a checkpoint of the original under the current run id", async () => {
    const pending = r.handler.decide(edit("src/a.py", THREE), r.signal);
    const s = await r.presenter.session(0);
    s.acceptAll();
    s.apply();
    await pending;
    expect(r.editor.checkpoints.snapshotOf("run-1", "src/a.py")).toEqual({ existed: true, text: BASE });
  });

  it("hunks left undecided are NOT written and are reported as undecided", async () => {
    const c = edit("src/a.py", THREE);
    const pending = r.handler.decide(c, r.signal);
    const s = await r.presenter.session(0);
    s.accept(1);
    s.apply();
    await pending;
    expect(r.editor.files.get("src/a.py")).toBe(BASE.replace("l5\n", "L5\n"));
    expect(r.decisions.take(keyForCall("propose_edit", c.args)!)?.rejected).toEqual(["hunk 1 (line 2): + L2 (undecided)", "hunk 3 (line 9): + L9 (undecided)"]);
  });

  it("everything rejected: deny 'User rejected all changes to <file>', nothing written, no decision, no checkpoint", async () => {
    const c = edit("src/a.py", THREE);
    const pending = r.handler.decide(c, r.signal);
    (await r.presenter.session(0)).rejectAll();
    expect(await pending).toEqual({ status: "deny", reason: "User rejected all changes to src/a.py" });
    expect(r.editor.files.get("src/a.py")).toBe(BASE);
    expect(r.editor.writes).toEqual([]);
    expect(r.decisions.size).toBe(0);
    expect(r.editor.checkpoints.canUndo).toBe(false);
    expect(r.tracker.get(c.id)?.state).toBe("rejected");
  });

  it("Apply with nothing accepted is also a rejection", async () => {
    const pending = r.handler.decide(edit("src/a.py", THREE), r.signal);
    (await r.presenter.session(0)).apply();
    expect(await pending).toMatchObject({ status: "deny", reason: "User rejected all changes to src/a.py" });
  });

  it("a file that changed during the review is a conflict: deny, nothing written, no checkpoint", async () => {
    const pending = r.handler.decide(edit("src/a.py", THREE), r.signal);
    const s = await r.presenter.session(0);
    r.editor.files.set("src/a.py", `${BASE}USER TYPED THIS\n`);
    s.acceptAll();
    s.apply();
    const decision = await pending;
    expect(decision).toMatchObject({ status: "deny", reason: expect.stringContaining("changed while you were reviewing") });
    expect(decision).toMatchObject({ reason: expect.stringContaining("propose the change again") });
    expect(r.editor.files.get("src/a.py")).toBe(`${BASE}USER TYPED THIS\n`);
    expect(r.editor.writes).toEqual([]);
    expect(r.editor.checkpoints.canUndo).toBe(false);
    expect(r.decisions.size).toBe(0);
    expect(r.tracker.get("call-src/a.py-l2\nl5\nl9\n")?.state).toBe("failed");
  });

  it("a conflict that appears at the last moment (during apply) is still caught", async () => {
    r.editor.beforeApply = () => r.editor.files.set("src/a.py", "something else entirely\n");
    const pending = r.handler.decide(edit("src/a.py", THREE), r.signal);
    const s = await r.presenter.session(0);
    s.acceptAll();
    s.apply();
    expect(await pending).toMatchObject({ status: "deny", reason: expect.stringContaining("changed while you were reviewing") });
    expect(r.editor.files.get("src/a.py")).toBe("something else entirely\n");
  });

  it("abort (Stop) during the review changes nothing, closes the review and rejects", async () => {
    const c = edit("src/a.py", THREE);
    const pending = r.handler.decide(c, r.signal);
    const s = await r.presenter.session(0);
    s.accept(0);
    r.abort();
    await expect(pending).rejects.toBeInstanceOf(ReviewCancelled);
    expect(r.editor.files.get("src/a.py")).toBe(BASE);
    expect(r.editor.writes).toEqual([]);
    expect(r.decisions.size).toBe(0);
    expect(r.presenter.closed).toBe(1);
    expect(r.tracker.get(c.id)?.state).toBe("cancelled");
  });

  it("an already-aborted signal never opens a review", async () => {
    r.abort();
    await expect(r.handler.decide(edit("src/a.py", THREE), r.signal)).rejects.toBeInstanceOf(ReviewCancelled);
    expect(r.presenter.sessions).toEqual([]);
  });

  it("a write failure denies with the reason and records nothing", async () => {
    r.editor.applyError = new Error("disk full");
    const pending = r.handler.decide(edit("src/a.py", THREE), r.signal);
    const s = await r.presenter.session(0);
    s.acceptAll();
    s.apply();
    expect(await pending).toMatchObject({ status: "deny", reason: expect.stringContaining("disk full") });
    expect(r.decisions.size).toBe(0);
  });

  it("a presenter that fails to open is a teaching deny", async () => {
    r.presenter.failWith = new Error("no window");
    expect(await r.handler.decide(edit("src/a.py", THREE), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("Could not open the review: no window") });
  });
});

describe("ReviewApprovalHandler: validation (nothing is presented, nothing is written)", () => {
  it("applyEdits failures deny with the teaching error", async () => {
    const r = rig();
    const d = await r.handler.decide(edit("src/a.py", [["nope", "x"]]), r.signal);
    expect(d).toEqual({ status: "deny", reason: "old_text matched 0 times in src/a.py. Re-read the file and include more surrounding context so old_text matches exactly once." });
    expect(r.presenter.sessions).toEqual([]);
  });

  it("an ambiguous anchor is rejected", async () => {
    const r = rig({ "a.py": "x\nx\n" });
    expect(await r.handler.decide(edit("a.py", [["x", "y"]]), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("matched 2 times") });
  });

  it("unsafe paths are denied before anything happens", async () => {
    const r = rig({ "src/a.py": BASE, ".git/config": "x", "node_modules/p/i.js": "x", ".venv/l.py": "x" });
    for (const path of ["../outside.py", "/etc/passwd", ".git/config", "node_modules/p/i.js", ".venv/l.py", "src/../../x"]) {
      const d = await r.handler.decide(call(`c-${path}`, "propose_edit", { path, edits: [{ old_text: "x", new_text: "y" }], summary: "s" }), r.signal);
      expect(d.status, path).toBe("deny");
    }
    for (const path of ["../new.py", ".git/hooks/x", "/tmp/x.py"]) {
      expect((await r.handler.decide(call(`n-${path}`, "create_file", { path, content: "x", summary: "s" }), r.signal)).status, path).toBe("deny");
    }
    expect(r.presenter.sessions).toEqual([]);
    expect(r.editor.writes).toEqual([]);
  });

  it("malformed arguments, missing files and directories get teaching denies", async () => {
    const r = rig({ "src/a.py": BASE });
    expect(await r.handler.decide({ id: "x", name: "propose_edit", args: "{not json", threadId: "main", sourceEventId: "m" }, r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("not valid JSON") });
    expect(await r.handler.decide(call("y", "propose_edit", { path: "src/a.py" }), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("Invalid arguments") });
    expect(await r.handler.decide(edit("src/missing.py", [["a", "b"]]), r.signal)).toMatchObject({ status: "deny", reason: expect.stringMatching(/File not found: src\/missing\.py.*create_file/s) });
    expect(await r.handler.decide(edit("src", [["a", "b"]]), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("is a directory") });
  });

  it("another tool name is refused", async () => {
    const r = rig();
    expect(await r.handler.decide({ id: "z", name: "run_command", args: "{}", threadId: "main", sourceEventId: "m" }, r.signal)).toMatchObject({ status: "deny" });
  });

  it("a huge file is refused instead of blocking on the diff", async () => {
    const big = "x\n".repeat(25_000);
    const r = rig({ "big.txt": big });
    expect(await r.handler.decide(edit("big.txt", [["x\nx\nx\n", "y\n"]]), r.signal)).toMatchObject({ status: "deny" });
  });
});

describe("ReviewApprovalHandler: create_file", () => {
  it("shows one hunk for the whole file; accepting creates it, with a 'did not exist' checkpoint", async () => {
    const r = rig();
    const c = call("n1", "create_file", { path: "src/new.py", content: "x = 1\ny = 2\n", summary: "new module" });
    const pending = r.handler.decide(c, r.signal);
    const s = await r.presenter.session(0);
    expect(s.info).toMatchObject({ kind: "create", original: "", proposed: "x = 1\ny = 2\n" });
    expect(s.hunks).toHaveLength(1);
    s.accept(0);
    s.apply();
    expect(await pending).toEqual({ status: "allow" });
    expect(r.editor.files.get("src/new.py")).toBe("x = 1\ny = 2\n");
    expect(r.editor.checkpoints.snapshotOf("run-1", "src/new.py")).toEqual({ existed: false });
    expect(r.decisions.take(keyForCall("create_file", c.args)!)).toMatchObject({ kind: "create", path: "src/new.py", added: 2, applied: 1, total: 1 });
  });

  it("rejecting it creates nothing", async () => {
    const r = rig();
    const pending = r.handler.decide(call("n1", "create_file", { path: "src/new.py", content: "x\n", summary: "s" }), r.signal);
    (await r.presenter.session(0)).rejectAll();
    expect(await pending).toMatchObject({ status: "deny", reason: "User rejected all changes to src/new.py" });
    expect(r.editor.files.has("src/new.py")).toBe(false);
  });

  it("an existing file is refused with a pointer to propose_edit; empty content is refused", async () => {
    const r = rig();
    expect(await r.handler.decide(call("n1", "create_file", { path: "src/a.py", content: "x", summary: "s" }), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("already exists") });
    expect(await r.handler.decide(call("n2", "create_file", { path: "src/e.py", content: "", summary: "s" }), r.signal)).toMatchObject({ status: "deny", reason: expect.stringContaining("non-empty") });
    expect(r.presenter.sessions).toEqual([]);
  });
});

describe("ReviewApprovalHandler: several proposals at once", () => {
  it("different files: all are reviewable at the same time; only the first auto-opens", async () => {
    const r = rig({ "a.py": BASE, "b.py": BASE, "c.py": BASE });
    const results = ["a.py", "b.py", "c.py"].map((p) => r.handler.decide(edit(p, [["l2\n", "L2\n"]]), r.signal));
    const [sa, sb, sc] = [await r.presenter.session(0), await r.presenter.session(1), await r.presenter.session(2)];
    expect(r.presenter.autoOpen).toEqual([true, false, false]);
    expect(r.tracker.list().map((e) => e.state)).toEqual(["reviewing", "reviewing", "reviewing"]);
    sc.acceptAll();
    sc.apply();
    sa.rejectAll();
    sb.acceptAll();
    sb.apply();
    expect(await Promise.all(results)).toEqual([{ status: "deny", reason: "User rejected all changes to a.py" }, { status: "allow" }, { status: "allow" }]);
    expect(r.editor.files.get("a.py")).toBe(BASE);
    expect(r.editor.files.get("b.py")).toBe(BASE.replace("l2\n", "L2\n"));
    expect(r.editor.files.get("c.py")).toBe(BASE.replace("l2\n", "L2\n"));
  });

  it("the same file is serialised and the second proposal is computed against the text after the first was applied", async () => {
    const r = rig();
    const first = r.handler.decide(edit("src/a.py", [["l2\n", "L2\n"]]), r.signal);
    const second = r.handler.decide(edit("src/a.py", [["l8\n", "L8\n"]]), r.signal);
    const s1 = await r.presenter.session(0);
    await tick();
    await tick();
    expect(r.presenter.sessions).toHaveLength(1); // the second review has not even started
    expect(r.tracker.list().map((e) => e.state)).toEqual(["reviewing", "queued"]);
    s1.acceptAll();
    s1.apply();
    expect(await first).toEqual({ status: "allow" });
    const s2 = await r.presenter.session(1);
    expect(s2.info.original).toBe(BASE.replace("l2\n", "L2\n")); // includes the first change
    expect(s2.info.proposed).toBe(BASE.replace("l2\n", "L2\n").replace("l8\n", "L8\n"));
    s2.acceptAll();
    s2.apply();
    expect(await second).toEqual({ status: "allow" });
    expect(r.editor.files.get("src/a.py")).toBe(BASE.replace("l2\n", "L2\n").replace("l8\n", "L8\n"));
  });

  it("a queued second proposal whose anchor no longer exists after the first is denied with the teaching error", async () => {
    const r = rig();
    const first = r.handler.decide(edit("src/a.py", [["l2\n", "L2\n"]]), r.signal);
    const second = r.handler.decide(edit("src/a.py", [["l2\n", "TWO\n"]]), r.signal);
    const s1 = await r.presenter.session(0);
    s1.acceptAll();
    s1.apply();
    await first;
    expect(await second).toMatchObject({ status: "deny", reason: expect.stringContaining("matched 0 times in src/a.py") });
    expect(r.presenter.sessions).toHaveLength(1);
  });

  it("aborting while queued behind another review cancels without touching the file", async () => {
    const r = rig();
    const a = new AbortController();
    const first = r.handler.decide(edit("src/a.py", [["l2\n", "L2\n"]]), r.signal);
    const second = r.handler.decide(edit("src/a.py", [["l8\n", "L8\n"]]), a.signal);
    await r.presenter.session(0);
    a.abort();
    await expect(second).rejects.toBeInstanceOf(ReviewCancelled);
    const s1 = r.presenter.sessions[0]!;
    s1.acceptAll();
    s1.apply();
    await first;
    expect(r.presenter.sessions).toHaveLength(1);
    expect(r.editor.files.get("src/a.py")).toBe(BASE.replace("l2\n", "L2\n"));
  });

  it("records exactly one decision per applied call", async () => {
    const r = rig({ "a.py": "x\n" });
    const c = call("same", "create_file", { path: "n.py", content: "q\n", summary: "s" });
    const p1 = r.handler.decide(c, r.signal);
    (await r.presenter.session(0)).acceptAll();
    r.presenter.sessions[0]!.apply();
    await p1;
    expect(r.decisions.size).toBe(1);
  });
});

describe("PathLocks", () => {
  it("grants in FIFO order per path and independently across paths", async () => {
    const locks = new PathLocks();
    const ctrl = new AbortController();
    const order: string[] = [];
    const r1 = await locks.acquire("a", ctrl.signal);
    const p2 = locks.acquire("a", ctrl.signal).then((release) => {
      order.push("a2");
      return release;
    });
    const p3 = locks.acquire("a", ctrl.signal).then((release) => {
      order.push("a3");
      return release;
    });
    const other = await locks.acquire("b", ctrl.signal);
    order.push("b1");
    expect(order).toEqual(["b1"]);
    r1();
    (await p2)();
    (await p3)();
    other();
    expect(order).toEqual(["b1", "a2", "a3"]);
  });

  it("a waiter that is aborted leaves the queue and does not block the others", async () => {
    const locks = new PathLocks();
    const ctrl = new AbortController();
    const waiterCtrl = new AbortController();
    const r1 = await locks.acquire("a", ctrl.signal);
    const abandoned = locks.acquire("a", waiterCtrl.signal);
    const last = locks.acquire("a", ctrl.signal);
    waiterCtrl.abort();
    await expect(abandoned).rejects.toBeInstanceOf(ReviewCancelled);
    r1();
    (await last)();
  });
});
