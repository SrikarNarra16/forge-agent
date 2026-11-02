import { describe, expect, it } from "vitest";
import { TurnReducer } from "../src/trueforge/events";
import { Batcher, type Timers } from "../src/ui/batcher";
import { parseWebMessage } from "../src/ui/protocol";
import { Transcript, summarizeArgs } from "../src/ui/transcript";
import type { StreamEvent } from "../src/trueforge/events";

/** Applies an event, THEN snapshots the view (argument order matters: `view` must see the event). */
function step(t: Transcript, r: TurnReducer, e: StreamEvent) {
  const change = r.apply(e);
  return t.applyTurn(r.view, change);
}
import { delta, modelMessage, pausedOnApprovals, threadCreated, toolResponse, turnDone } from "./helpers/events";

describe("summarizeArgs", () => {
  it("renders JSON arguments as key=value pairs, clipping long values", () => {
    expect(summarizeArgs('{"path":"src/a.py","why":"check parsing"}')).toBe('path="src/a.py" why="check parsing"');
    expect(summarizeArgs(`{"why":"${"x".repeat(100)}"}`)).toMatch(/^why="x{47}…"$/);
    expect(summarizeArgs('{"start":4,"end":9}')).toBe("start=4 end=9");
  });
  it("falls back to raw text for partial or non-JSON arguments, and handles empty", () => {
    expect(summarizeArgs('{"path":"a.')).toBe('{"path":"a.');
    expect(summarizeArgs("")).toBe("");
  });
});

describe("Transcript", () => {
  it("shows streamed assistant text, skipping messages that only carry tool calls", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    const apply = (e: StreamEvent) => step(t, r, e);
    expect(apply(modelMessage({ id: "m1" }))).toEqual([]);
    apply(delta({ id: "m1", content: "Hel" }));
    const items = apply(delta({ id: "m1", content: "lo", finish: "stop" }));
    expect(items).toEqual([{ kind: "assistant", id: "m1", text: "Hello", streaming: false }]);
    expect(t.items).toHaveLength(1);
  });

  it("creates tool cards with summary, result preview and duration, in order", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    for (const e of [modelMessage({ id: "m1", content: "Let me look.", calls: [{ id: "c1", name: "read_file", args: '{"path":"a.py","why":"look at it"}' }], seconds: 1 }), toolResponse({ toolCallId: "c1", content: "1| x", seconds: 3 })]) {
      step(t, r, e);
    }
    expect(t.items.map((i) => i.kind)).toEqual(["assistant", "tool"]);
    expect(t.items[1]).toMatchObject({ kind: "tool", name: "read_file", argsSummary: 'path="a.py" why="look at it"', status: "done", resultPreview: "1| x", durationMs: 2000 });
  });

  it("tracks the approval lifecycle: pending -> allowed, and denied", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    r.apply(modelMessage({ id: "m1", calls: [{ id: "c1", name: "echo_write" }, { id: "c2", name: "echo_write" }] }));
    r.beginRound();
    for (const e of pausedOnApprovals([{ id: "c1", sourceEventId: "m1" }, { id: "c2", sourceEventId: "m1" }])) step(t, r, e);
    expect(t.items.map((i) => (i.kind === "tool" ? i.approval : undefined))).toEqual(["pending", "pending"]);
    const c1 = r.noteApproval("c1", { status: "allow" }, "2026-11-02T10:00:10.000Z");
    t.applyTurn(r.view, c1);
    const c2 = r.noteApproval("c2", { status: "deny", reason: "no" }, "2026-11-02T10:00:10.000Z");
    t.applyTurn(r.view, c2);
    expect(t.items.map((i) => (i.kind === "tool" ? [i.approval, i.status] : undefined))).toEqual([["allowed", "running"], ["denied", "denied"]]);
  });

  it("labels subagent items with the thread title", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    r.apply(threadCreated({ threadId: "t1", title: "Scout: find helpers" }));
    const items = step(t, r, modelMessage({ id: "ms", threadId: "t1", content: "found it", finish: "stop" }));
    expect(items[0]).toMatchObject({ kind: "assistant", subagent: "Scout: find helpers" });
  });

  it("keeps user messages and notices in order and can be cleared", () => {
    const t = new Transcript();
    t.addUser("hi");
    t.addNotice("error", "boom");
    t.addUser("again");
    expect(t.items.map((i) => i.kind)).toEqual(["user", "notice", "user"]);
    expect(new Set(t.items.map((i) => i.id)).size).toBe(3);
    t.clear();
    expect(t.items).toEqual([]);
  });

  it("the final done event adds nothing by itself", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    expect(step(t, r, turnDone({ status: "done" }))).toEqual([]);
  });
});

describe("Batcher", () => {
  function fakeTimers(): Timers & { fire(): void; pendingCount(): number } {
    let next: (() => void) | undefined;
    return {
      setTimeout: (fn) => {
        next = fn;
        return 1;
      },
      clearTimeout: () => {
        next = undefined;
      },
      fire: () => {
        const fn = next;
        next = undefined;
        fn?.();
      },
      pendingCount: () => (next ? 1 : 0),
    };
  }

  it("coalesces by id (latest wins, first-seen order) and flushes once per interval", () => {
    const timers = fakeTimers();
    const flushes: Array<Array<{ id: string; v: number }>> = [];
    const b = new Batcher<{ id: string; v: number }>((items) => flushes.push(items), 30, timers);
    b.push({ id: "a", v: 1 });
    b.push({ id: "b", v: 1 });
    b.push({ id: "a", v: 2 });
    b.push({ id: "a", v: 3 });
    expect(flushes).toEqual([]);
    timers.fire();
    expect(flushes).toEqual([[{ id: "a", v: 3 }, { id: "b", v: 1 }]]);
    b.push({ id: "c", v: 1 });
    timers.fire();
    expect(flushes).toHaveLength(2);
  });

  it("schedules exactly one timer for many pushes, and nothing when empty", () => {
    const timers = fakeTimers();
    const b = new Batcher<{ id: string }>(() => undefined, 30, timers);
    b.flush();
    expect(timers.pendingCount()).toBe(0);
    for (let i = 0; i < 100; i++) b.push({ id: `x${i % 3}` });
    expect(timers.pendingCount()).toBe(1);
  });

  it("flush() sends immediately, clear() drops pending, dispose() stops accepting", () => {
    const timers = fakeTimers();
    const out: string[][] = [];
    const b = new Batcher<{ id: string }>((items) => out.push(items.map((i) => i.id)), 30, timers);
    b.push({ id: "a" });
    b.flush();
    b.push({ id: "b" });
    b.clear();
    timers.fire();
    b.push({ id: "c" });
    b.dispose();
    b.push({ id: "d" });
    timers.fire();
    expect(out).toEqual([["a"]]);
  });

  it("works with the real timers (flush within ~30 ms)", async () => {
    const out: string[][] = [];
    const b = new Batcher<{ id: string }>((items) => out.push(items.map((i) => i.id)), 30);
    b.push({ id: "a" });
    b.push({ id: "a" });
    await new Promise((r) => setTimeout(r, 80));
    expect(out).toEqual([["a"]]);
  });
});

describe("parseWebMessage (webview input is untrusted)", () => {
  it("accepts well-formed messages", () => {
    expect(parseWebMessage({ type: "ready" })).toEqual({ type: "ready" });
    expect(parseWebMessage({ type: "stop" })).toEqual({ type: "stop" });
    expect(parseWebMessage({ type: "newChat" })).toEqual({ type: "newChat" });
    expect(parseWebMessage({ type: "send", text: "hello" })).toEqual({ type: "send", text: "hello" });
    expect(parseWebMessage({ type: "approval", callId: "c1", decision: "allow" })).toEqual({ type: "approval", callId: "c1", decision: "allow" });
    expect(parseWebMessage({ type: "approval", callId: "c1", decision: "deny", reason: "no" })).toEqual({ type: "approval", callId: "c1", decision: "deny", reason: "no" });
  });

  it("rejects malformed, oversized and unknown messages", () => {
    for (const bad of [null, undefined, 5, "send", [], {}, { type: 3 }, { type: "nope" }, { type: "send" }, { type: "send", text: "  " }, { type: "send", text: 7 }, { type: "send", text: "x".repeat(60_000) },
      { type: "approval", callId: "", decision: "allow" }, { type: "approval", callId: "c", decision: "maybe" }, { type: "approval", callId: "c", decision: "deny", reason: 1 },
      { type: "approval", callId: "x".repeat(400), decision: "allow" }, { type: "approval", decision: "allow" }]) {
      expect(parseWebMessage(bad), JSON.stringify(bad)?.slice(0, 40)).toBeUndefined();
    }
  });

  it("drops unexpected extra fields", () => {
    expect(parseWebMessage({ type: "stop", extra: "x" })).toEqual({ type: "stop" });
  });
});

describe("review info on tool cards", () => {
  it("attaches review info to a tool card, whether it arrives before or after the card", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    const info = { path: "src/a.py", summary: "bump", kind: "edit" as const, state: "reviewing" as const, hunks: 3 };
    t.setReview("c1", info); // before the card exists
    step(t, r, modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit", args: '{"path":"src/a.py"}' }] }));
    expect(t.items.find((i) => i.id === "c1")).toMatchObject({ kind: "tool", review: info });
    const updated = t.setReview("c1", { ...info, state: "applied", applied: 2 });
    expect(updated).toMatchObject({ review: { state: "applied", applied: 2 } });
    expect(t.setReview("c1", undefined)).not.toHaveProperty("review");
    expect(t.setReview("nope", info)).toBeUndefined();
  });

  it("keeps the review info when the card is re-rendered by later events", () => {
    const t = new Transcript();
    const r = new TurnReducer();
    step(t, r, modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit" }] }));
    t.setReview("c1", { path: "a.py", summary: "s", kind: "edit", state: "reviewing" });
    const items = step(t, r, toolResponse({ toolCallId: "c1", content: "applied 1 of 1 hunks" }));
    expect(items[0]).toMatchObject({ review: { state: "reviewing" }, status: "done" });
  });
});

describe("parseWebMessage: review messages", () => {
  it("accepts undoRun and openReview, rejects a malformed openReview", () => {
    expect(parseWebMessage({ type: "undoRun" })).toEqual({ type: "undoRun" });
    expect(parseWebMessage({ type: "openReview", callId: "c1" })).toEqual({ type: "openReview", callId: "c1" });
    for (const bad of [{ type: "openReview" }, { type: "openReview", callId: "" }, { type: "openReview", callId: 5 }, { type: "openReview", callId: "x".repeat(400) }]) {
      expect(parseWebMessage(bad)).toBeUndefined();
    }
  });
});
