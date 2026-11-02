import { describe, expect, it } from "vitest";
import { parseWebMessage } from "../src/ui/protocol";
import { ContextPanelState } from "../src/ui/contextState";
import { findMentionTrigger } from "../src/ui/webview/mention";

describe("findMentionTrigger", () => {
  it("finds @ at the caret and classifies file vs symbol", () => {
    expect(findMentionTrigger("look at @cli", 12)).toEqual({ start: 8, kind: "file", query: "cli" });
    expect(findMentionTrigger("@", 1)).toEqual({ start: 0, kind: "file", query: "" });
    expect(findMentionTrigger("see @#get_debug", 15)).toEqual({ start: 4, kind: "symbol", query: "get_debug" });
    expect(findMentionTrigger("see @symbol:Flask", 17)).toEqual({ start: 4, kind: "symbol", query: "Flask" });
    expect(findMentionTrigger("src/flask/cli.py", 5)).toBeUndefined();
  });
  it("ignores emails, words after a space and carets before the @", () => {
    expect(findMentionTrigger("me@example.com", 14)).toBeUndefined();
    expect(findMentionTrigger("@cli done", 9)).toBeUndefined();
    expect(findMentionTrigger("a @cli", 2)).toBeUndefined();
  });
});

describe("protocol validation for context messages", () => {
  it("accepts send with valid mentions and rejects malformed ones", () => {
    expect(parseWebMessage({ type: "send", text: "hi", mentions: [{ kind: "file", value: "a.py" }] })).toEqual({ type: "send", text: "hi", mentions: [{ kind: "file", value: "a.py" }] });
    expect(parseWebMessage({ type: "send", text: "hi" })).toEqual({ type: "send", text: "hi" });
    expect(parseWebMessage({ type: "send", text: "hi", mentions: [{ kind: "dir", value: "a" }] })).toBeUndefined();
    expect(parseWebMessage({ type: "send", text: "hi", mentions: "a.py" })).toBeUndefined();
    expect(parseWebMessage({ type: "send", text: "hi", mentions: Array.from({ length: 21 }, () => ({ kind: "file", value: "a" })) })).toBeUndefined();
    expect(parseWebMessage({ type: "send", text: "hi", mentions: [{ kind: "file", value: "" }] })).toBeUndefined();
  });
  it("validates mentionQuery", () => {
    expect(parseWebMessage({ type: "mentionQuery", id: 3, kind: "symbol", query: "x" })).toEqual({ type: "mentionQuery", id: 3, kind: "symbol", query: "x" });
    expect(parseWebMessage({ type: "mentionQuery", id: -1, kind: "file", query: "x" })).toBeUndefined();
    expect(parseWebMessage({ type: "mentionQuery", id: 1, kind: "other", query: "x" })).toBeUndefined();
    expect(parseWebMessage({ type: "mentionQuery", id: 1, kind: "file", query: "x".repeat(201) })).toBeUndefined();
    expect(parseWebMessage({ type: "mentionQuery", id: 1.5, kind: "file", query: "x" })).toBeUndefined();
  });
});

describe("ContextPanelState", () => {
  const plan = { budgetTokens: 6000, usedTokens: 100, items: [], warnings: [] };
  it("replaces the plan per run, accumulates reads, keeps the first model input count and clears on reset", () => {
    const s = new ContextPanelState();
    s.beginRun(plan);
    expect(s.snapshot().expand).toBe(true);
    s.addRead({ path: "a.py", start: 1, end: 5, why: "because the whole reason is long and complete", tokens: 10 });
    expect(s.snapshot().expand).toBe(false);
    expect(s.setModelInputTokens(1500)).toBe(true);
    expect(s.setModelInputTokens(9999)).toBe(false);
    s.beginRun({ ...plan, usedTokens: 5 });
    const snap = s.snapshot();
    expect(snap.plan?.usedTokens).toBe(5);
    expect(snap.reads).toHaveLength(1);
    expect(snap.reads[0]?.why).toBe("because the whole reason is long and complete");
    expect(snap.modelInputTokens).toBeUndefined();
    s.clear();
    expect(s.snapshot()).toEqual({ reads: [], expand: false });
  });
});
