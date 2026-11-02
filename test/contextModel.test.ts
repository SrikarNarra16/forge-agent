import { describe, expect, it } from "vitest";
import { budgetLabel, budgetPercent, contextSummary, groupContext, hasContext, locationLabel, retrievalLabel } from "../src/ui/webview/contextModel";
import type { ContextViewState } from "../src/ui/protocol";

const state: ContextViewState = {
  expand: true,
  plan: {
    budgetTokens: 6000,
    usedTokens: 4812,
    warnings: [],
    retrievalMs: 12,
    items: [
      { path: "src/flask/cli.py", startLine: 590, endLine: 640, symbol: "FlaskGroup.__init__", source: "auto", reason: "matches: cli, command", tokens: 300, form: "body" },
      { path: "src/flask/helpers.py", startLine: 1, endLine: 80, source: "mention", reason: "pinned by @mention", tokens: 700, form: "body" },
    ],
  },
  reads: [{ path: "docs/cli.rst", startLine: 5, endLine: 5, why: "a very long reason that must stay complete ".repeat(5), tokens: 20 }],
};

describe("context view model", () => {
  it("formats the budget bar, locations and retrieval timing", () => {
    expect(budgetLabel(state.plan!)).toBe("4,812 / 6,000 tokens");
    expect(budgetPercent(state.plan!)).toBe(80);
    expect(budgetPercent({ usedTokens: 5, budgetTokens: 0 })).toBe(0);
    expect(budgetPercent({ usedTokens: 9, budgetTokens: 4 })).toBe(100);
    expect(locationLabel(state.plan!.items[0]!)).toBe("src/flask/cli.py:590-640");
    expect(locationLabel(state.reads[0]!)).toBe("docs/cli.rst:5");
    expect(retrievalLabel(12.4)).toBe("retrieved in 12 ms");
    expect(retrievalLabel(0.3)).toBe("retrieved in <1 ms");
  });
  it("groups pinned, auto and agent reads and keeps the full reason", () => {
    const g = groupContext(state);
    expect(g.pinned.map((i) => i.path)).toEqual(["src/flask/helpers.py"]);
    expect(g.auto.map((i) => i.path)).toEqual(["src/flask/cli.py"]);
    expect(g.reads[0]?.why).toBe(state.reads[0]?.why);
    expect(contextSummary(state)).toBe("1 pinned · 1 auto · 1 read");
  });
  it("summarises the not-ready case and an empty state", () => {
    expect(contextSummary({ expand: false, reads: [], plan: { budgetTokens: 6000, usedTokens: 0, items: [], warnings: [], note: "Index still building: no auto context this turn" } })).toBe("no auto context");
    expect(contextSummary({ expand: false, reads: [] })).toBe("nothing yet");
    expect(hasContext({ expand: false, reads: [] })).toBe(false);
    expect(hasContext(state)).toBe(true);
  });
});
