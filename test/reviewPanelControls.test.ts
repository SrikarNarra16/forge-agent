import { describe, expect, it } from "vitest";
import { reviewDecisions, reviewOutcomeLine, reviewStatusLine, reviewUndecidedNote } from "../src/ui/webview/format";
import { parseWebMessage } from "../src/ui/protocol";
import { runPrefixLabel, contextSummary, hasContext } from "../src/ui/webview/contextModel";
import { ContextPanelState } from "../src/ui/contextState";
import { sessionUrl, trueForgeLink } from "../src/trueforge/client";

describe("review card: status line and the undecided note", () => {
  it("says how many hunks are accepted and how many are undecided", () => {
    expect(reviewStatusLine({ hunks: 3, accepted: 2, rejected: 0 })).toBe("2 of 3 hunks accepted, 1 undecided");
    expect(reviewStatusLine({ hunks: 3, accepted: 0, rejected: 0 })).toBe("0 of 3 hunks accepted, 3 undecided");
    expect(reviewStatusLine({ hunks: 3, accepted: 3, rejected: 0 })).toBe("3 of 3 hunks accepted");
    expect(reviewStatusLine({ hunks: 3, accepted: 1, rejected: 1 })).toBe("1 of 3 hunks accepted, 1 rejected, 1 undecided");
    expect(reviewStatusLine({ hunks: 1, accepted: 1, rejected: 0 })).toBe("1 of 1 hunk accepted");
  });

  it("never reports nonsense for missing or out-of-range counts", () => {
    expect(reviewDecisions({})).toEqual({ hunks: 0, accepted: 0, rejected: 0, undecided: 0 });
    expect(reviewDecisions({ hunks: 2, accepted: 5, rejected: 5 })).toEqual({ hunks: 2, accepted: 2, rejected: 0, undecided: 0 });
  });

  it("states that undecided hunks count as rejected on Apply, and only when there are some", () => {
    expect(reviewUndecidedNote({ hunks: 3, accepted: 2, rejected: 0 })).toBe("The undecided hunk counts as rejected: it will not be applied.");
    expect(reviewUndecidedNote({ hunks: 3, accepted: 1, rejected: 0 })).toBe("Undecided hunks count as rejected: they will not be applied.");
    expect(reviewUndecidedNote({ hunks: 3, accepted: 2, rejected: 1 })).toBe("");
  });
});

describe("review card: outcome lines", () => {
  it("shows progress, success and failure", () => {
    expect(reviewOutcomeLine({ state: "reviewing" })).toBeUndefined();
    expect(reviewOutcomeLine({ state: "queued" })).toBeUndefined();
    expect(reviewOutcomeLine({ state: "applying" })).toEqual({ text: "Applying the accepted hunks…", tone: "info" });
    expect(reviewOutcomeLine({ state: "applied", applied: 2, hunks: 3 })).toEqual({ text: "Applied 2 of 3 hunks; 1 not applied (rejected or undecided).", tone: "ok" });
    expect(reviewOutcomeLine({ state: "applied", applied: 3, hunks: 3 })).toEqual({ text: "Applied 3 of 3 hunks.", tone: "ok" });
    expect(reviewOutcomeLine({ state: "failed", detail: "Could not write the change to a.py: disk full. Nothing was applied." })).toEqual({
      text: "Not applied: nothing was written. Could not write the change to a.py: disk full. Nothing was applied.",
      tone: "error",
    });
    expect(reviewOutcomeLine({ state: "rejected" })?.tone).toBe("info");
    expect(reviewOutcomeLine({ state: "cancelled" })?.text).toContain("nothing was written");
  });
});

describe("webview messages for the new buttons", () => {
  it("accepts reviewApply / reviewRejectAll with a call id and openTrueForge without payload", () => {
    expect(parseWebMessage({ type: "reviewApply", callId: "c1" })).toEqual({ type: "reviewApply", callId: "c1" });
    expect(parseWebMessage({ type: "reviewRejectAll", callId: "c1" })).toEqual({ type: "reviewRejectAll", callId: "c1" });
    expect(parseWebMessage({ type: "reviewAcceptAllApply", callId: "c1" })).toEqual({ type: "reviewAcceptAllApply", callId: "c1" });
    expect(parseWebMessage({ type: "openTrueForge" })).toEqual({ type: "openTrueForge" });
  });
  it("rejects malformed ones", () => {
    for (const bad of [{ type: "reviewApply" }, { type: "reviewApply", callId: "" }, { type: "reviewRejectAll", callId: 7 }, { type: "reviewAcceptAllApply" }, { type: "reviewApply", callId: "x".repeat(301) }]) {
      expect(parseWebMessage(bad)).toBeUndefined();
    }
  });
});

describe("Open in TrueForge", () => {
  it("opens the session in the Sessions page (detail pane), or the Sessions list when there is no session yet", () => {
    expect(trueForgeLink("http://localhost:8790/", "01abc")).toBe("http://localhost:8790/sessions?sessionId=01abc");
    expect(trueForgeLink("http://localhost:8790", undefined)).toBe("http://localhost:8790/sessions");
    expect(trueForgeLink("http://tf.example:9000///", "s 1")).toBe("http://tf.example:9000/sessions?sessionId=s%201");
  });
  it("the logged session URL stays the chat view of the session", () => {
    expect(sessionUrl("http://localhost:8790", "01abc")).toBe("http://localhost:8790/sessions/01abc");
  });
});

describe("the effective command prefix in the Context section", () => {
  it("is shown whatever its source, and survives a chat reset", () => {
    const state = new ContextPanelState();
    expect(hasContext(state.snapshot())).toBe(false);
    state.setRun({ prefix: ". .venv/bin/activate &&", source: "auto" });
    expect(hasContext(state.snapshot())).toBe(true);
    expect(contextSummary(state.snapshot())).toBe("venv auto-activated");
    state.clear();
    expect(state.snapshot().run).toEqual({ prefix: ". .venv/bin/activate &&", source: "auto" });
  });
  it("labels each source", () => {
    expect(runPrefixLabel({ prefix: ". .venv/bin/activate &&", source: "auto" })).toMatchObject({ text: "Commands run with: . .venv/bin/activate &&", hint: expect.stringContaining("auto-detected") });
    expect(runPrefixLabel({ prefix: "make env &&", source: "setting" }).hint).toContain("forge.commandPrefix");
    expect(runPrefixLabel({ prefix: "", source: "none" }).text).toBe("Commands run without a prefix");
    expect(contextSummary({ reads: [], expand: false, run: { prefix: "x &&", source: "setting" } })).toBe("custom command prefix");
  });
});
