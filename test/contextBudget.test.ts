import { describe, expect, it } from "vitest";
import { AUTO_BODIES, CODE_SAFETY_FACTOR, PINNED_SHARE, budgetTokens, locationLine, numberedBody, packContext, type Candidate } from "../src/context/budget";

function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function makeCandidate(i: number, lineCount: number, source: "auto" | "mention", over: Partial<Candidate> = {}): Candidate {
  const text = Array.from({ length: lineCount }, (_, n) => `    value_${i}_${n} = compute(${n}, "some reasonably long literal ${n}")`).join("\n");
  return {
    path: `src/pkg${i % 7}/module_${i}.py`,
    startLine: 10 * i + 1,
    endLine: 10 * i + lineCount,
    symbol: `function_${i}`,
    kind: "function",
    signature: `def function_${i}(a, b, c=None) -> int:`,
    text,
    source,
    score: 100 - i,
    reason: source === "auto" ? "matches: alpha, beta" : `pinned by @module_${i}.py`,
    ...over,
  };
}

describe("budgetTokens", () => {
  it("is chars/4 times the 1.15 safety factor, rounded up", () => {
    expect(CODE_SAFETY_FACTOR).toBe(1.15);
    expect(budgetTokens("x".repeat(400))).toBe(Math.ceil(100 * 1.15));
    expect(budgetTokens("")).toBe(0);
    expect(budgetTokens("x".repeat(40))).toBeGreaterThan(10);
  });
});

describe("packContext: the budget is never exceeded (property test)", () => {
  it("holds for 400 random corpora, budgets, pinned sets and body counts", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = mulberry32(seed);
      const budget = Math.floor(80 + rand() * 12000);
      const pinned = Array.from({ length: Math.floor(rand() * 5) }, (_, i) => makeCandidate(100 + i, Math.floor(1 + rand() * 400), "mention", rand() < 0.3 ? { outline: ["1: def a():", "9: def b():"] } : {}));
      const auto = Array.from({ length: Math.floor(rand() * 40) }, (_, i) => makeCandidate(i, Math.floor(1 + rand() * 300), "auto"));
      const plan = packContext({ pinned, auto, budgetTokens: budget, autoBodies: Math.floor(rand() * 5) });
      const ctx = `seed ${seed} budget ${budget}`;
      expect(plan.usedTokens, ctx).toBeLessThanOrEqual(budget);
      expect(budgetTokens(plan.text), ctx).toBeLessThanOrEqual(budget);
      expect(plan.pinnedTokens, ctx).toBeLessThanOrEqual(Math.floor(budget * PINNED_SHARE));
      // deterministic
      expect(packContext({ pinned, auto, budgetTokens: budget, autoBodies: 2 }).text === packContext({ pinned, auto, budgetTokens: budget, autoBodies: 2 }).text, ctx).toBe(true);
      // every item's reported tokens are positive and the block mentions every item it reports
      for (const item of plan.items) {
        expect(item.tokens, ctx).toBeGreaterThan(0);
        expect(plan.text, ctx).toContain(`${item.path}:${item.startLine}-${item.endLine}`);
        if (item.form === "body") expect(plan.text, ctx).toContain(item.bodyText ?? "§missing§");
      }
    }
  });

  it("a budget too small for even the frame gives an empty plan and says why", () => {
    const plan = packContext({ pinned: [], auto: [makeCandidate(1, 3, "auto")], budgetTokens: 5 });
    expect(plan.items).toEqual([]);
    expect(plan.text).toBe("");
    expect(plan.warnings[0]).toMatch(/too small/);
  });
});

describe("packContext: packing rules", () => {
  it("gives full bodies to the top 2 auto items and locations only to the rest, in rank order", () => {
    const auto = [0, 1, 2, 3, 4].map((i) => makeCandidate(i, 5, "auto"));
    const plan = packContext({ pinned: [], auto, budgetTokens: 6000 });
    expect(plan.items.map((i) => [i.symbol, i.form])).toEqual([["function_0", "body"], ["function_1", "body"], ["function_2", "signature"], ["function_3", "signature"], ["function_4", "signature"]]);
    expect(AUTO_BODIES).toBe(2);
    expect(plan.text).toContain("Relevant locations (auto-retrieved, budget 6000 tokens):");
    expect(plan.text).toContain("More can be fetched with read_file (line ranges), search_code and repo_map.");
    expect(plan.text.startsWith("<context>")).toBe(true);
    expect(plan.text.endsWith("</context>")).toBe(true);
  });

  it("downgrades a body that does not fit to its signature, and keeps going", () => {
    const plan = packContext({ pinned: [], auto: [makeCandidate(0, 400, "auto"), makeCandidate(1, 3, "auto")], budgetTokens: 600 });
    expect(plan.items.map((i) => [i.symbol, i.form])).toEqual([["function_0", "signature"], ["function_1", "body"]]);
  });

  it("stops adding items when the budget is exhausted, keeping the best-ranked ones", () => {
    const auto = Array.from({ length: 200 }, (_, i) => makeCandidate(i, 2, "auto"));
    const plan = packContext({ pinned: [], auto, budgetTokens: 700 });
    expect(plan.items.length).toBeGreaterThan(3);
    expect(plan.items.length).toBeLessThan(200);
    expect(plan.items.map((i) => i.symbol)).toEqual(auto.slice(0, plan.items.length).map((c) => c.symbol));
    expect(plan.usedTokens).toBeLessThanOrEqual(700);
  });

  it("pinned items come first with their bodies and a Pinned section", () => {
    const plan = packContext({ pinned: [makeCandidate(50, 6, "mention")], auto: [makeCandidate(0, 6, "auto")], budgetTokens: 4000 });
    expect(plan.items.map((i) => [i.source, i.form])).toEqual([["mention", "body"], ["auto", "body"]]);
    expect(plan.text).toContain("Pinned by the user (@mentions):");
    expect(plan.text.indexOf("Pinned by the user")).toBeLessThan(plan.text.indexOf("Relevant locations"));
  });

  it("pinned items may use at most 50% of the budget: those that do not fit as bodies are downgraded or omitted, with a visible warning", () => {
    const pinned = [makeCandidate(50, 30, "mention"), makeCandidate(51, 30, "mention"), makeCandidate(52, 30, "mention")];
    const plan = packContext({ pinned, auto: [makeCandidate(0, 5, "auto")], budgetTokens: 2000 });
    const pinnedItems = plan.items.filter((i) => i.source === "mention");
    expect(plan.pinnedTokens).toBeLessThanOrEqual(1000);
    expect(pinnedItems.some((i) => i.form === "body")).toBe(true); // the first one still gets its body
    expect(pinnedItems.length < 3 || pinnedItems.some((i) => i.form === "signature")).toBe(true); // the rest were downgraded or dropped
    expect(plan.warnings.length).toBeGreaterThan(0);
    expect(plan.items.some((i) => i.source === "auto")).toBe(true); // the other half is still available to retrieval
  });

  it("a pinned item that cannot fit even as a location is omitted and the user is told", () => {
    const huge = makeCandidate(70, 2000, "mention", { signature: "x".repeat(900), symbol: "s".repeat(900) });
    const plan = packContext({ pinned: [huge], auto: [], budgetTokens: 300 });
    expect(plan.items).toEqual([]);
    expect(plan.warnings.join(" ")).toMatch(/does not fit the pinned share/);
  });

  it("a pinned whole file that is too big falls back to its outline", () => {
    const bigFile = makeCandidate(60, 800, "mention", { kind: "module", symbol: undefined, signature: undefined, outline: ["12: def routes_command(sort)", "80: class FlaskGroup(AppGroup):"] });
    const plan = packContext({ pinned: [bigFile], auto: [], budgetTokens: 3000 });
    const item = plan.items[0];
    expect(item?.form).toBe("signature");
    expect(plan.text).toContain("    12: def routes_command(sort)");
    expect(plan.warnings.join(" ")).toMatch(/only its outline is included/);
  });

  it("a pinned item without text (unreadable file) shows just its outline", () => {
    const plan = packContext({ pinned: [makeCandidate(61, 0, "mention", { text: "", kind: "module", outline: ["1: def a()"] })], auto: [], budgetTokens: 2000 });
    expect(plan.items[0]?.form).toBe("signature");
    expect(plan.text).toContain("    1: def a()");
  });

  it("no auto candidates still yields a valid block", () => {
    const plan = packContext({ pinned: [], auto: [], budgetTokens: 1000 });
    expect(plan.text).toContain("- (none found)");
    expect(plan.items).toEqual([]);
  });
});

describe("rendering helpers", () => {
  it("location lines show path:lines, symbol - signature and the reason (auto only)", () => {
    expect(locationLine({ path: "src/a.py", startLine: 3, endLine: 9, symbol: "run", signature: "def run(x):", kind: "function", reason: "matches: run, x", source: "auto" })).toBe("- src/a.py:3-9  run - def run(x):  [matches: run, x]");
    expect(locationLine({ path: "docs/x.rst", startLine: 1, endLine: 4, kind: "doc", reason: "matches: a", source: "auto" })).toBe("- docs/x.rst:1-4  (doc)  [matches: a]");
    expect(locationLine({ path: "a.py", startLine: 1, endLine: 2, symbol: "f", kind: "function", reason: "pinned by @f", source: "mention" })).toBe("- a.py:1-2  f");
  });

  it("bodies are numbered like read_file with a right-aligned width", () => {
    expect(numberedBody({ path: "a.py", startLine: 8, endLine: 10, text: "x\ny\nz", symbol: "f" })).toBe("--- a.py:8-10 (f) ---\n 8| x\n 9| y\n10| z");
  });
});
