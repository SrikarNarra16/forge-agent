import { describe, expect, it } from "vitest";
import { analyse } from "../scripts/eval/timing";
import { BROKEN_MODEL, expectsExhaustion, parseChainArgs } from "../scripts/eval/chainArgs";

const rec = (t: number, event: object): string => JSON.stringify({ turn: 1, t, event });

describe("stall timing analysis", () => {
  it("measures time to first token and the longest silence, ignoring time with a tool in flight", () => {
    const lines = [
      rec(0, { type: "turn.created" }),
      rec(10, { type: "model.message", model: { name: "deepseek/v4-pro" } }), // the instant message start is not a token
      rec(4200, { type: "model.message.delta", content: "a" }), // first token after 4.2 s
      rec(4300, { type: "model.message.delta", content: "b" }),
      rec(4400, { type: "model.message", toolCalls: [{ id: "c1" }], finishReason: "tool_calls" }),
      rec(64400, { type: "tool.response" }), // a 60 s tool: NOT a silence
      rec(70000, { type: "model.message.delta", content: "c" }), // 5.6 s of model silence after the tool
      rec(70100, { type: "turn.done", state: { status: "done" } }),
    ];
    const r = analyse(lines);
    expect(r).toMatchObject({ model: "deepseek/v4-pro", success: true, firstTokenMs: [4200], events: 8 });
    expect(r?.maxGapMs).toBe(5600); // the larger of the first-token wait (4.2 s) and the post-tool silence (5.6 s); the 60 s tool is not counted
  });
  it("flags failed runs and returns undefined for recordings without timestamps", () => {
    expect(analyse([rec(0, { type: "turn.created" }), rec(5, { type: "turn.done", state: { status: "error" } })])?.success).toBe(false);
    expect(analyse([JSON.stringify({ turn: 1, event: { type: "turn.created" } })])).toBeUndefined();
  });
});

describe("--chain / --fail-primary parsing", () => {
  const base = { failPrimary: false, defaultModel: "deepseek/flash" };
  it("no flags: no chain", () => expect(parseChainArgs({ ...base, chain: undefined })).toBeUndefined());
  it("--chain uses the list as given (deduplicated)", () => {
    expect(parseChainArgs({ ...base, chain: "a/x, b/y ,a/x" })).toEqual(["a/x", "b/y"]);
    expect(() => parseChainArgs({ ...base, chain: " , " })).toThrow(/comma-separated/);
  });
  it("--fail-primary prepends the broken endpoint to the model or the chain, once", () => {
    expect(parseChainArgs({ ...base, failPrimary: true, chain: undefined })).toEqual([BROKEN_MODEL, "deepseek/flash"]);
    expect(parseChainArgs({ ...base, failPrimary: true, chain: undefined, model: "deepseek/v4-pro" })).toEqual([BROKEN_MODEL, "deepseek/v4-pro"]);
    expect(parseChainArgs({ ...base, failPrimary: true, chain: "a/x,b/y" })).toEqual([BROKEN_MODEL, "a/x", "b/y"]);
    expect(parseChainArgs({ ...base, failPrimary: true, chain: `${BROKEN_MODEL},a/x` })).toEqual([BROKEN_MODEL, "a/x"]);
  });
  it("a chain made only of demo failures expects an exhausted chain", () => {
    expect(expectsExhaustion([BROKEN_MODEL])).toBe(true);
    expect(expectsExhaustion([BROKEN_MODEL, "badkey-deepseek/flash"])).toBe(true);
    expect(expectsExhaustion([BROKEN_MODEL, "deepseek/flash"])).toBe(false);
    expect(expectsExhaustion(undefined)).toBe(false);
  });
});
