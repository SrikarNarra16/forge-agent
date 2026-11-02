import { describe, expect, it } from "vitest";
import { CheckpointStore, type FileRestorer } from "../src/review/checkpoints";
import { ConflictError, applyAccepted, type ApplyIo, type ApplyRequest } from "../src/review/applyCore";
import { hashText } from "../src/review/hash";
import { applyRangedEdits } from "../src/review/hunks";

class FakeRestorer implements FileRestorer {
  readonly calls: string[] = [];
  readonly hashes: Array<string | undefined> = [];
  failOn = new Set<string>();
  constructor(readonly files: Map<string, string>) {}
  restoreText(path: string, text: string, expectedCurrentHash: string | undefined): Promise<void> {
    if (this.failOn.has(path)) return Promise.reject(new Error(`cannot restore ${path}`));
    this.calls.push(`restore ${path}`);
    this.hashes.push(expectedCurrentHash);
    this.files.set(path, text);
    return Promise.resolve();
  }
  deleteFile(path: string): Promise<void> {
    if (this.failOn.has(path)) return Promise.reject(new Error(`cannot delete ${path}`));
    this.calls.push(`delete ${path}`);
    this.files.delete(path);
    return Promise.resolve();
  }
}

describe("CheckpointStore", () => {
  it("first write wins per path within a run", () => {
    const c = new CheckpointStore();
    c.snapshot("r1", "a.py", { existed: true, text: "original" });
    c.snapshot("r1", "a.py", { existed: true, text: "after first edit" });
    expect(c.snapshotOf("r1", "a.py")).toEqual({ existed: true, text: "original" });
    expect(c.filesOf("r1")).toEqual(["a.py"]);
  });

  it("keeps runs isolated and tracks the last run that changed something", () => {
    const c = new CheckpointStore();
    expect(c.canUndo).toBe(false);
    c.snapshot("r1", "a.py", { existed: true, text: "1" });
    c.snapshot("r2", "b.py", { existed: false });
    expect(c.lastRunId()).toBe("r2");
    expect(c.has("r1")).toBe(true);
    expect(c.canUndo).toBe(true);
    expect(c.snapshotOf("r2", "a.py")).toBeUndefined();
  });

  it("rolls back a run: restores edited files, deletes created ones, newest first, and forgets the run", async () => {
    const files = new Map([["a.py", "edited a"], ["b.py", "edited b"], ["new.py", "created"]]);
    const restorer = new FakeRestorer(files);
    const c = new CheckpointStore();
    c.snapshot("r1", "a.py", { existed: true, text: "orig a" });
    c.snapshot("r1", "new.py", { existed: false });
    c.snapshot("r1", "b.py", { existed: true, text: "orig b" });
    c.recordApplied("r1", "a.py", "hash-of-a");
    const result = await c.rollbackRun("r1", restorer);
    expect(result).toEqual({ restored: ["b.py", "new.py", "a.py"], failed: [] });
    expect(restorer.calls).toEqual(["restore b.py", "delete new.py", "restore a.py"]);
    expect(restorer.hashes).toEqual([undefined, "hash-of-a"]);
    expect(Object.fromEntries(files)).toEqual({ "a.py": "orig a", "b.py": "orig b" });
    expect(c.has("r1")).toBe(false);
    expect(c.canUndo).toBe(false);
  });

  it("a file that cannot be restored is reported and kept for a retry; the others are still restored", async () => {
    const files = new Map([["a.py", "x"], ["b.py", "y"]]);
    const restorer = new FakeRestorer(files);
    restorer.failOn.add("a.py");
    const c = new CheckpointStore();
    c.snapshot("r1", "a.py", { existed: true, text: "orig a" });
    c.snapshot("r1", "b.py", { existed: true, text: "orig b" });
    const result = await c.rollbackRun("r1", restorer);
    expect(result.restored).toEqual(["b.py"]);
    expect(result.failed).toEqual([{ path: "a.py", error: "cannot restore a.py" }]);
    expect(c.filesOf("r1")).toEqual(["a.py"]);
    restorer.failOn.clear();
    expect((await c.rollbackRun("r1", restorer)).restored).toEqual(["a.py"]);
    expect(files.get("a.py")).toBe("orig a");
  });

  it("rolling back an unknown run does nothing", async () => {
    expect(await new CheckpointStore().rollbackRun("nope", new FakeRestorer(new Map()))).toEqual({ restored: [], failed: [] });
  });

  it("notifies listeners when the undoable state changes", async () => {
    const c = new CheckpointStore();
    let n = 0;
    c.onChange(() => n++);
    c.snapshot("r1", "a.py", { existed: false });
    await c.rollbackRun("r1", new FakeRestorer(new Map([["a.py", "x"]])));
    expect(n).toBe(2);
  });
});

describe("applyAccepted (the ordering rules of an apply)", () => {
  function setup(initial: Record<string, string>) {
    const files = new Map(Object.entries(initial));
    const log: string[] = [];
    const checkpoints = new CheckpointStore();
    const io: ApplyIo = {
      readLive: (p) => Promise.resolve(files.get(p)),
      write: (req: ApplyRequest) => {
        // by the time we write, the checkpoint must already exist
        log.push(`write(checkpoint=${checkpoints.has(req.runId)})`);
        files.set(req.path, req.kind === "create" ? req.newText : applyRangedEdits(files.get(req.path) ?? "", req.edits));
        return Promise.resolve();
      },
    };
    return { files, log, checkpoints, io };
  }
  const edit = (over: Partial<ApplyRequest> = {}): ApplyRequest => ({ runId: "r1", path: "a.py", kind: "edit", baseHash: hashText("a\nb\n"), newText: "a\nB\n", edits: [{ startLine: 1, endLine: 2, text: "B\n" }], ...over });

  it("verifies the base, snapshots BEFORE writing, writes, then records the applied hash", async () => {
    const { files, log, checkpoints, io } = setup({ "a.py": "a\nb\n" });
    await applyAccepted(io, checkpoints, edit());
    expect(log).toEqual(["write(checkpoint=true)"]);
    expect(files.get("a.py")).toBe("a\nB\n");
    expect(checkpoints.snapshotOf("r1", "a.py")).toEqual({ existed: true, text: "a\nb\n" });
    const restorer = new FakeRestorer(files);
    await checkpoints.rollbackRun("r1", restorer);
    expect(restorer.hashes).toEqual([hashText("a\nB\n")]);
    expect(files.get("a.py")).toBe("a\nb\n");
  });

  it("a changed file is a ConflictError: nothing is written and no checkpoint is taken", async () => {
    const { files, log, checkpoints, io } = setup({ "a.py": "a\nb\nTYPED BY USER\n" });
    await expect(applyAccepted(io, checkpoints, edit())).rejects.toBeInstanceOf(ConflictError);
    expect(log).toEqual([]);
    expect(files.get("a.py")).toBe("a\nb\nTYPED BY USER\n");
    expect(checkpoints.has("r1")).toBe(false);
  });

  it("an edit to a file that disappeared, or an edit without a base hash, is a conflict", async () => {
    const { checkpoints, io } = setup({});
    await expect(applyAccepted(io, checkpoints, edit())).rejects.toBeInstanceOf(ConflictError);
    const s2 = setup({ "a.py": "a\nb\n" });
    await expect(applyAccepted(s2.io, s2.checkpoints, edit({ baseHash: undefined as unknown as string }))).rejects.toBeInstanceOf(ConflictError);
  });

  it("create: snapshots 'did not exist', writes, and rolls back by deleting", async () => {
    const { files, checkpoints, io } = setup({});
    await applyAccepted(io, checkpoints, { runId: "r1", path: "new.py", kind: "create", newText: "x = 1\n", edits: [] });
    expect(files.get("new.py")).toBe("x = 1\n");
    expect(checkpoints.snapshotOf("r1", "new.py")).toEqual({ existed: false });
    await checkpoints.rollbackRun("r1", new FakeRestorer(files));
    expect(files.has("new.py")).toBe(false);
  });

  it("create over a file that now exists is a conflict and writes nothing", async () => {
    const { files, log, checkpoints, io } = setup({ "new.py": "someone made it" });
    await expect(applyAccepted(io, checkpoints, { runId: "r1", path: "new.py", kind: "create", newText: "x", edits: [] })).rejects.toBeInstanceOf(ConflictError);
    expect(log).toEqual([]);
    expect(files.get("new.py")).toBe("someone made it");
  });

  it("a failing write leaves the checkpoint (so the user can still undo a partial write)", async () => {
    const { checkpoints, io } = setup({ "a.py": "a\nb\n" });
    io.write = () => Promise.reject(new Error("disk full"));
    await expect(applyAccepted(io, checkpoints, edit())).rejects.toThrow("disk full");
    expect(checkpoints.has("r1")).toBe(true);
  });
});
