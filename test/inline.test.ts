import { describe, expect, it } from "vitest";
import { CONTEXT_LINES, MAX_HISTORY, MAX_SELECTED_LINES, buildInlineMessage, inlineDisplayText, pushHistory, snapshotSelection, splitDocumentLines, type SelectionInput } from "../src/inline/message";
import { describeInlineOutcome, runInlineEdit, type InlineController, type InlineUi } from "../src/inline/runner";
import type { SendOptions, SendResult } from "../src/trueforge/agentController";
import { TurnReducer } from "../src/trueforge/events";
import { modelMessage, toolResponse } from "./helpers/events";

const doc = (n: number, eol = "\n", trailing = true): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join(eol) + (trailing ? eol : "");
const sel = (text: string, sl: number, sc: number, el: number, ec: number, extra: Partial<SelectionInput> = {}): SelectionInput => ({
  text, start: { line: sl, character: sc }, end: { line: el, character: ec }, path: "src/a.py", languageId: "python", ...extra,
});
const snap = (input: SelectionInput) => {
  const r = snapshotSelection(input);
  if (!r.ok) throw new Error("expected a selection");
  return r.snapshot;
};

describe("splitDocumentLines", () => {
  it("handles LF, CRLF, lone CR, and a trailing newline", () => {
    expect(splitDocumentLines("a\nb\n")).toEqual(["a", "b"]);
    expect(splitDocumentLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitDocumentLines("a\rb")).toEqual(["a", "b"]);
    expect(splitDocumentLines("a\n\n")).toEqual(["a", ""]);
    expect(splitDocumentLines("")).toEqual([]);
    expect(splitDocumentLines("\n")).toEqual([""]);
  });
});

describe("snapshotSelection", () => {
  it("returns 1-based lines, the selected lines and 20 lines of context on each side", () => {
    const s = snap(sel(doc(100), 49, 0, 52, 4)); // 0-based lines 49..52 -> 50..53
    expect(s).toMatchObject({ startLine: 50, endLine: 53, totalLines: 100, path: "src/a.py", languageId: "python" });
    expect(s.selected).toEqual(["line 50", "line 51", "line 52", "line 53"]);
    expect(s.before).toMatchObject({ startLine: 50 - CONTEXT_LINES });
    expect(s.before.lines).toHaveLength(CONTEXT_LINES);
    expect(s.before.lines[0]).toBe("line 30");
    expect(s.after.startLine).toBe(54);
    expect(s.after.lines).toHaveLength(CONTEXT_LINES);
    expect(s.after.lines.at(-1)).toBe("line 73");
  });

  it("selection at the very start of the file has no 'before' context", () => {
    const s = snap(sel(doc(50), 0, 0, 1, 3));
    expect(s).toMatchObject({ startLine: 1, endLine: 2 });
    expect(s.before.lines).toEqual([]);
    expect(s.after.lines).toHaveLength(CONTEXT_LINES);
  });

  it("selection at the very end of the file has no 'after' context, with or without a trailing newline", () => {
    for (const trailing of [true, false]) {
      const s = snap(sel(doc(30, "\n", trailing), 28, 0, 29, 6));
      expect(s, `trailing=${trailing}`).toMatchObject({ startLine: 29, endLine: 30, totalLines: 30 });
      expect(s.after.lines).toEqual([]);
      expect(s.before.lines).toHaveLength(CONTEXT_LINES);
    }
  });

  it("a selection that runs onto the phantom empty line after a trailing newline is clamped to the last real line", () => {
    const s = snap(sel(doc(10), 8, 0, 10, 0)); // ends at (10,0): the phantom line
    expect(s).toMatchObject({ startLine: 9, endLine: 10, totalLines: 10 });
  });

  it("a full-line selection ending at column 0 of the next line does not include that line", () => {
    const s = snap(sel(doc(20), 4, 0, 7, 0));
    expect(s).toMatchObject({ startLine: 5, endLine: 7 });
    expect(s.selected).toEqual(["line 5", "line 6", "line 7"]);
  });

  it("a partial-line selection covers the whole line", () => {
    const s = snap(sel(doc(20), 4, 3, 4, 6));
    expect(s).toMatchObject({ startLine: 5, endLine: 5, selected: ["line 5"] });
  });

  it("works on CRLF documents (no stray \\r in any line)", () => {
    const s = snap(sel(doc(30, "\r\n"), 9, 0, 11, 2));
    expect([...s.selected, ...s.before.lines, ...s.after.lines].some((l) => l.includes("\r"))).toBe(false);
    expect(s.selected).toEqual(["line 10", "line 11", "line 12"]);
  });

  it("uses the live (unsaved) buffer text it is given, not any file on disk", () => {
    const buffer = "def f():\n    return 'UNSAVED EDIT'\n";
    const s = snap(sel(buffer, 1, 4, 1, 10));
    expect(s.selected).toEqual(["    return 'UNSAVED EDIT'"]);
  });

  it("an empty selection (or an empty document) is not a selection", () => {
    expect(snapshotSelection(sel(doc(5), 2, 3, 2, 3))).toEqual({ ok: false, reason: "empty" });
    expect(snapshotSelection(sel("", 0, 0, 0, 1))).toEqual({ ok: false, reason: "empty" });
  });

  it("out-of-range positions are clamped instead of throwing", () => {
    const s = snap(sel(doc(5), 3, 0, 99, 0));
    expect(s).toMatchObject({ startLine: 4, endLine: 5 });
  });
});

describe("buildInlineMessage", () => {
  const snapshot = snap(sel(doc(60), 27, 0, 29, 8));
  const message = buildInlineMessage(snapshot, "  treat 'off' and 'n' as false too  ");

  it("includes the path, the language, the exact selected lines with 1-based numbers, context and the instruction", () => {
    expect(message).toContain("src/a.py (python)");
    expect(message).toContain("Selected code (lines 28-30), exactly as it is now:");
    expect(message).toContain("28| line 28\n29| line 29\n30| line 30");
    expect(message).toContain("Lines before the selection (lines 8-27):");
    expect(message).toContain(" 8| line 8");
    expect(message).toContain("Lines after the selection (lines 31-50):");
    expect(message).toContain("50| line 50");
    expect(message.endsWith("Instruction: treat 'off' and 'n' as false too")).toBe(true);
  });

  it("pads line numbers to the widest number shown so the code lines up", () => {
    const wide = buildInlineMessage(snap(sel(doc(120), 97, 0, 98, 0)), "x"); // selects line 98; context runs 78..118
    expect(wide).toContain("\n 98| line 98\n");
    expect(wide).toContain("\n 78| line 78\n");
    expect(wide).toContain("\n118| line 118");
    const narrow = buildInlineMessage(snap(sel(doc(120), 7, 0, 8, 0)), "x"); // numbers only reach 28
    expect(narrow).toContain("\n 8| line 8\n");
  });

  it("omits empty context sections", () => {
    const m = buildInlineMessage(snap(sel(doc(3), 0, 0, 2, 4)), "x");
    expect(m).not.toContain("Lines before");
    expect(m).not.toContain("Lines after");
    expect(m).toContain("Selected code (lines 1-3)");
  });

  it("truncates a huge selection and tells the agent how to get the rest", () => {
    const m = buildInlineMessage(snap(sel(doc(900), 10, 0, 700, 1)), "x");
    expect(m).toContain(`The selection has 691 lines; only the first ${MAX_SELECTED_LINES} are shown. Use read_file for the rest.`);
    expect(m).not.toContain("| line 600\n");
  });

  it("is model-agnostic: plain text, no model names or provider-specific markup", () => {
    expect(message).not.toMatch(/deepseek|gpt|claude|groq|<\/?[a-z_]+>|```/i);
  });
});

describe("inlineDisplayText / pushHistory", () => {
  it("summarises the edit for the transcript", () => {
    expect(inlineDisplayText(snap(sel(doc(30), 4, 0, 6, 3)), " rename x ")).toBe("Edit src/a.py:5-7: rename x");
    expect(inlineDisplayText(snap(sel(doc(30), 4, 0, 4, 3)), "x")).toBe("Edit src/a.py:5: x");
  });

  it("keeps the 20 most recent distinct instructions, newest first", () => {
    let h: string[] = [];
    for (let i = 1; i <= 25; i++) h = pushHistory(h, `instruction ${i}`);
    expect(h).toHaveLength(MAX_HISTORY);
    expect(h[0]).toBe("instruction 25");
    expect(h.at(-1)).toBe("instruction 6");
    h = pushHistory(h, "  instruction 10 ");
    expect(h[0]).toBe("instruction 10");
    expect(h.filter((x) => x === "instruction 10")).toHaveLength(1);
    expect(pushHistory(h, "   ")).toEqual(h);
  });
});

// --- runner --------------------------------------------------------------------------------------------

function viewOf(events: Parameters<TurnReducer["apply"]>[0][]) {
  const r = new TurnReducer();
  for (const e of events) r.apply(e);
  return r.view;
}

const okResult = (state: "done" | "error" | "cancelled", events: Parameters<TurnReducer["apply"]>[0][] = [], detail?: string): SendResult => ({ ok: true, state, view: viewOf(events), ...(detail !== undefined ? { detail } : {}) });
const editCall = [modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit", args: '{"path":"src/a.py"}' }], finish: "tool_calls" })];
const answer = (text: string) => modelMessage({ id: "m2", content: text, finish: "stop" });

describe("describeInlineOutcome", () => {
  it("applied: reports what the tool said", () => {
    const r = describeInlineOutcome(okResult("done", [...editCall, toolResponse({ toolCallId: "c1", content: "applied 1 of 1 hunks (+2 -1 lines) to src/a.py" }), answer("Done.")]) as Extract<SendResult, { ok: true }>);
    expect(r).toEqual({ kind: "applied", message: "applied 1 of 1 hunks (+2 -1 lines) to src/a.py" });
  });
  it("rejected: the call was denied", () => {
    const view = viewOf([...editCall, toolResponse({ toolCallId: "c1", content: '{"error":"User denied tool call: User rejected all changes to src/a.py"}' }), answer("OK")]);
    expect(describeInlineOutcome({ ok: true, state: "done", view })).toEqual({ kind: "rejected" });
  });
  it("no edit: returns the agent's own text so the user learns why nothing happened", () => {
    const view = viewOf([answer("I could not find the code you selected.")]);
    expect(describeInlineOutcome({ ok: true, state: "done", view })).toEqual({ kind: "no-edit", text: "I could not find the code you selected." });
    expect(describeInlineOutcome({ ok: true, state: "done", view: viewOf([]) })).toEqual({ kind: "no-edit", text: "" });
  });
  it("error and cancelled", () => {
    expect(describeInlineOutcome({ ok: true, state: "error", detail: "[Model Error] boom", view: viewOf([]) })).toEqual({ kind: "error", message: "[Model Error] boom" });
    expect(describeInlineOutcome({ ok: true, state: "error", view: viewOf([]) })).toMatchObject({ kind: "error" });
    expect(describeInlineOutcome({ ok: true, state: "cancelled", view: viewOf([]) })).toEqual({ kind: "cancelled" });
  });
  it("a tool failure that is not a rejection is an error with the tool's words", () => {
    const view = viewOf([...editCall, toolResponse({ toolCallId: "c1", content: "not approved: nothing was changed" })]);
    expect(describeInlineOutcome({ ok: true, state: "done", view })).toEqual({ kind: "error", message: "The edit could not be applied: not approved: nothing was changed" });
  });
  it("if several propose_edit calls ran, any applied one counts", () => {
    const view = viewOf([
      modelMessage({ id: "m1", calls: [{ id: "c1", name: "propose_edit" }, { id: "c2", name: "propose_edit" }], finish: "tool_calls" }),
      toolResponse({ toolCallId: "c1", content: "User denied" }),
      toolResponse({ toolCallId: "c2", content: "applied 1 of 1 hunks (+1 -1 lines) to a.py" }),
    ]);
    expect(describeInlineOutcome({ ok: true, state: "done", view })).toMatchObject({ kind: "applied" });
  });
});

class FakeUi implements InlineUi {
  readonly log: string[] = [];
  busy(): void { this.log.push("busy"); }
  running(): () => void { this.log.push("running"); return () => void this.log.push("hide"); }
  applied(m: string): void { this.log.push(`applied:${m}`); }
  info(m: string): void { this.log.push(`info:${m}`); }
  error(m: string): void { this.log.push(`error:${m}`); }
}

function fakeController(result: SendResult | (() => Promise<SendResult>), busy = false): InlineController & { sent: Array<{ text: string; options: SendOptions }> } {
  const sent: Array<{ text: string; options: SendOptions }> = [];
  return { runState: { busy }, sent, send: async (text, options) => (sent.push({ text, options }), typeof result === "function" ? result() : result) };
}

describe("runInlineEdit", () => {
  const request = { snapshot: snap(sel(doc(40), 9, 0, 11, 5)), instruction: "make it better" };

  it("is blocked by the single run lock: says busy, shows no indicator, sends nothing", async () => {
    const ui = new FakeUi();
    const controller = fakeController(okResult("done"), true);
    expect(await runInlineEdit({ controller, ui, agentName: "forge-inline" }, request)).toEqual({ kind: "busy" });
    expect(ui.log).toEqual(["busy"]);
    expect(controller.sent).toEqual([]);
  });

  it("also handles losing the race after the check (send itself reports busy)", async () => {
    const ui = new FakeUi();
    const controller = fakeController({ ok: false, reason: "busy" });
    expect(await runInlineEdit({ controller, ui, agentName: "forge-inline" }, request)).toEqual({ kind: "busy" });
    expect(ui.log).toEqual(["running", "hide", "busy"]);
  });

  it("runs on the inline agent in a fresh session with the model override, display text and the built message", async () => {
    const ui = new FakeUi();
    const controller = fakeController(okResult("done", [answer("ok")]));
    await runInlineEdit({ controller, ui, agentName: "forge-inline", model: "groq/gpt-oss-120b" }, request);
    expect(controller.sent).toHaveLength(1);
    expect(controller.sent[0]?.options).toEqual({ freshSession: true, agentName: "forge-inline", model: "groq/gpt-oss-120b", display: "Edit src/a.py:10-12: make it better", purpose: "inline-edit" });
    expect(controller.sent[0]?.text).toBe(buildInlineMessage(request.snapshot, "make it better"));
    const noModel = fakeController(okResult("done", [answer("ok")]));
    await runInlineEdit({ controller: noModel, ui: new FakeUi(), agentName: "forge-inline" }, request);
    expect(noModel.sent[0]?.options).not.toHaveProperty("model");
  });

  it("removes the indicator BEFORE the single result message, and never blocks on that message", async () => {
    const ui = new FakeUi();
    const controller = fakeController(okResult("done", [...editCall, toolResponse({ toolCallId: "c1", content: "applied 1 of 1 hunks (+1 -1 lines) to src/a.py" })]));
    await runInlineEdit({ controller, ui, agentName: "forge-inline" }, request);
    expect(ui.log).toEqual(["running", "hide", "applied:Forge: applied 1 of 1 hunks (+1 -1 lines) to src/a.py"]);
  });

  it("shows exactly one message per outcome", async () => {
    const cases: Array<[SendResult, RegExp]> = [
      [okResult("done", [answer("Nothing to change here.")]), /^info:Forge made no edit\. It said: Nothing to change here\.$/],
      [okResult("done", [...editCall, toolResponse({ toolCallId: "c1", content: "User denied tool call: x" })]), /^info:Forge: no changes were applied/],
      [okResult("cancelled"), /^info:Forge: the edit was stopped\.$/],
      [okResult("error", [], "[Model Error] Cannot connect"), /^error:Forge: \[Model Error\] Cannot connect$/],
    ];
    for (const [result, expected] of cases) {
      const ui = new FakeUi();
      await runInlineEdit({ controller: fakeController(result), ui, agentName: "forge-inline" }, request);
      expect(ui.log).toHaveLength(3);
      expect(ui.log[2]).toMatch(expected);
    }
  });

  it("removes the indicator even if the run throws", async () => {
    const ui = new FakeUi();
    const controller = fakeController(() => Promise.reject(new Error("boom")));
    await expect(runInlineEdit({ controller, ui, agentName: "forge-inline" }, request)).rejects.toThrow("boom");
    expect(ui.log).toEqual(["running", "hide"]);
  });
});
