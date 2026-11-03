import { describe, expect, it } from "vitest";
import { compareUsage, describeUsage } from "../src/context/usageLog";

describe("usage comparison", () => {
  const message = "x".repeat(4000);
  it("compares the chars/4 estimate with the reported message tokens", () => {
    const c = compareUsage({ message, blockTokens: 900, inputTokens: 2500, messageTokens: 1100, priorMessageTokens: 0 });
    expect(c.rawEstimate).toBe(1000);
    expect(c.budgetEstimate).toBe(1150);
    expect(c.ratio).toBeCloseTo(1.1);
    expect(c.exact).toBe(true);
  });
  it("subtracts history on later turns and says it is approximate", () => {
    const c = compareUsage({ message, blockTokens: 900, inputTokens: 5000, messageTokens: 2600, priorMessageTokens: 1500 });
    expect(c.actualMessageTokens).toBe(1100);
    expect(c.exact).toBe(false);
    expect(describeUsage({ message, blockTokens: 900, inputTokens: 5000, messageTokens: 2600, priorMessageTokens: 1500 })).toMatch(/approx: history included/);
  });
  it("copes with a missing breakdown", () => {
    expect(compareUsage({ message, blockTokens: 1, inputTokens: 9, priorMessageTokens: 0 }).ratio).toBeUndefined();
    expect(describeUsage({ message, blockTokens: 1, inputTokens: 9, priorMessageTokens: 0 })).toMatch(/message tokens n\/a/);
  });
});

import { TurnReducer } from "../src/trueforge/events";

describe("TurnReducer usage", () => {
  it("exposes the input-token usage TrueForge reports on model messages", () => {
    const r = new TurnReducer();
    r.apply({
      type: "model.message",
      id: "m1",
      threadId: "main",
      createdAt: "2026-11-02T00:00:00Z",
      model: { name: "deepseek/flash" },
      content: "hi",
      finishReason: "stop",
      usage: { inputTokens: 1193, outputTokens: 47, inputTokensBreakdown: { harness: 768, messages: 258 } },
    } as never);
    expect(r.view.usage).toEqual([{ messageId: "m1", threadId: "main", inputTokens: 1193, outputTokens: 47, messageTokens: 258 }]);
  });
});
