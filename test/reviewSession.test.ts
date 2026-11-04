import { describe, expect, it } from "vitest";
import { ReviewSession, type ReviewInfo } from "../src/review/session";
import { ReviewTracker } from "../src/review/tracker";

const ORIGINAL = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((l) => `${l}\n`).join("");
const PROPOSED = ORIGINAL.replace("b\n", "B\n").replace("e\n", "E\n").replace("i\n", "I\n");
const info = (over: Partial<ReviewInfo> = {}): ReviewInfo => ({ callId: "c1", path: "src/x.py", kind: "edit", summary: "tweak", original: ORIGINAL, proposed: PROPOSED, ...over });

describe("ReviewSession", () => {
  it("starts with every hunk pending and nothing accepted", () => {
    const s = new ReviewSession(info());
    expect(s.hunks).toHaveLength(3);
    expect(s.count("pending")).toBe(3);
    expect(s.acceptedIds).toEqual([]);
    expect(s.composed()).toBe(ORIGINAL);
    expect(s.finished).toBe(false);
  });

  it("accept/reject change decisions, notify listeners and update the visible layout", () => {
    const s = new ReviewSession(info());
    let notified = 0;
    s.onChange(() => notified++);
    s.accept(0);
    s.reject(1);
    expect(s.decisionList).toEqual(["accepted", "rejected", "pending"]);
    expect(notified).toBe(2);
    expect(s.layout().text).toBe(ORIGINAL.replace("b\n", "B\n").replace("i\n", "I\n")); // rejected hunk 1 reverted, pending shown
    expect(s.composed()).toBe(ORIGINAL.replace("b\n", "B\n")); // only accepted applies
    s.accept(0); // no-op: unchanged
    expect(notified).toBe(2);
  });

  it("ignores unknown hunk ids", () => {
    const s = new ReviewSession(info());
    s.accept(99);
    s.reject(-1);
    expect(s.decisionList).toEqual(["pending", "pending", "pending"]);
  });

  it("apply resolves with the accepted ids; undecided hunks are NOT applied", async () => {
    const s = new ReviewSession(info());
    s.accept(0);
    s.accept(2);
    s.apply();
    await expect(s.done).resolves.toEqual({ kind: "apply", accepted: [0, 2] });
    expect(s.composed()).toBe(ORIGINAL.replace("b\n", "B\n").replace("i\n", "I\n"));
    expect(s.acceptedStats()).toEqual({ added: 2, removed: 2 });
  });

  it("apply with nothing accepted is a rejection of everything", async () => {
    const s = new ReviewSession(info());
    s.reject(0);
    s.apply();
    await expect(s.done).resolves.toEqual({ kind: "rejected-all" });
  });

  it("acceptAll marks everything accepted but does not finish; apply then writes all", async () => {
    const s = new ReviewSession(info());
    s.acceptAll();
    expect(s.finished).toBe(false);
    expect(s.composed()).toBe(PROPOSED);
    s.apply();
    await expect(s.done).resolves.toEqual({ kind: "apply", accepted: [0, 1, 2] });
  });

  it("rejectAll rejects every hunk and finishes", async () => {
    const s = new ReviewSession(info());
    s.accept(1);
    s.rejectAll();
    await expect(s.done).resolves.toEqual({ kind: "rejected-all" });
    expect(s.decisionList).toEqual(["rejected", "rejected", "rejected"]);
    expect(s.layout().text).toBe(ORIGINAL);
  });

  it("cancel resolves cancelled; nothing can change afterwards", async () => {
    const s = new ReviewSession(info());
    s.cancel();
    await expect(s.done).resolves.toEqual({ kind: "cancelled" });
    s.accept(0);
    s.apply();
    s.rejectAll();
    expect(s.decisionList).toEqual(["pending", "pending", "pending"]);
    await expect(s.done).resolves.toEqual({ kind: "cancelled" });
  });

  it("resolves only once", async () => {
    const s = new ReviewSession(info());
    s.accept(0);
    s.apply();
    s.cancel();
    s.rejectAll();
    await expect(s.done).resolves.toEqual({ kind: "apply", accepted: [0] });
  });

  it("a create_file review has a single hunk for the whole file", () => {
    const s = new ReviewSession(info({ kind: "create", original: "", proposed: "x = 1\ny = 2\n" }));
    expect(s.hunks).toHaveLength(1);
    s.accept(0);
    expect(s.composed()).toBe("x = 1\ny = 2\n");
  });

  it("a proposal identical to the original has no hunks", () => {
    expect(new ReviewSession(info({ proposed: ORIGINAL })).hunks).toEqual([]);
  });
});

describe("ReviewTracker", () => {
  const entry = { callId: "c1", path: "a.py", kind: "edit" as const, summary: "s", state: "queued" as const };

  it("adds, updates, lists and notifies", () => {
    const t = new ReviewTracker();
    const seen: string[][] = [];
    const off = t.onChange((es) => seen.push(es.map((e) => `${e.callId}:${e.state}`)));
    t.add(entry);
    t.add({ ...entry, callId: "c2", path: "b.py" });
    t.update("c1", { state: "reviewing", hunks: 3 });
    t.update("missing", { state: "failed" });
    expect(t.get("c1")).toMatchObject({ state: "reviewing", hunks: 3 });
    expect(seen.at(-1)).toEqual(["c1:reviewing", "c2:queued"]);
    off();
    t.update("c2", { state: "applied", applied: 1 });
    expect(seen).toHaveLength(3);
  });

  it("clearFinished keeps queued and reviewing entries", () => {
    const t = new ReviewTracker();
    t.add(entry);
    t.add({ ...entry, callId: "c2", state: "applied" });
    t.add({ ...entry, callId: "c3", state: "reviewing" });
    t.add({ ...entry, callId: "c4", state: "rejected" });
    t.clearFinished();
    expect(t.list().map((e) => e.callId)).toEqual(["c1", "c3"]);
  });
});

describe("ReviewSession.acceptPending (the panel's 'Accept all and apply')", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j", "k", "l"].map((l) => `${l}\n`).join("");
  const proposed = original.replace("b\n", "B\n").replace("f\n", "F\n").replace("k\n", "K\n");
  const make = (): ReviewSession => new ReviewSession({ callId: "c", path: "x.py", kind: "edit", summary: "s", original, proposed });

  it("accepts every undecided hunk and leaves rejected ones rejected", () => {
    const s = make();
    expect(s.hunks).toHaveLength(3);
    s.reject(0);
    s.accept(1);
    s.acceptPending();
    expect(s.decisionList).toEqual(["rejected", "accepted", "accepted"]);
    s.apply();
    expect(s.finished).toBe(true);
  });

  it("applies the same way as accepting the rest by hand (one apply path)", async () => {
    const s = make();
    s.acceptPending();
    s.apply();
    expect(await s.done).toEqual({ kind: "apply", accepted: [0, 1, 2] });
  });

  it("does nothing on a finished review", () => {
    const s = make();
    s.rejectAll();
    s.acceptPending();
    expect(s.decisionList).toEqual(["rejected", "rejected", "rejected"]);
  });
});
