import { describe, expect, it } from "vitest";
import { DEFAULT_SPEND_LIMIT_USD, USD_PER_MILLION_TOKENS, checkLimits, estimatedSpendUsd, formatUsd, totalsOf } from "../scripts/eval/ledger";

describe("dollar-based cost guard", () => {
  it("assumes 8 cents per million tokens and stops at an estimated $3 (about 37.5M tokens)", () => {
    expect(USD_PER_MILLION_TOKENS).toBe(0.08);
    expect(DEFAULT_SPEND_LIMIT_USD).toBe(3);
    expect(estimatedSpendUsd(4_256_514)).toBeCloseTo(0.34, 2);
    expect(formatUsd(estimatedSpendUsd(4_256_514))).toBe("$0.34");
    const at = (tokens: number) => totalsOf([{ runId: "r", task: "b", model: "m", attempt: 1, input: tokens, output: 0, at: "" }]);
    const limits = { usd: DEFAULT_SPEND_LIMIT_USD };
    expect(checkLimits(at(30_000_000), limits)).toEqual({ ok: true });
    const stop = checkLimits(at(37_500_000), limits);
    expect(stop).toMatchObject({ ok: false, reason: expect.stringMatching(/SPEND LIMIT: estimated \$3\.00.*Stop and ask/) });
  });
  it("the old token and run caps are off unless asked for", () => {
    const totals = totalsOf(Array.from({ length: 60 }, () => ({ runId: "r", task: "b", model: "m", attempt: 1, input: 100_000, output: 1000, at: "" })));
    expect(checkLimits(totals, { usd: 3 })).toEqual({ ok: true });
    expect(checkLimits(totals, { usd: 3, runs: 40 })).toMatchObject({ ok: false });
    expect(checkLimits(totals, { usd: 3, tokens: 1_000_000 })).toMatchObject({ ok: false, reason: expect.stringMatching(/TOKEN LIMIT/) });
  });
});
