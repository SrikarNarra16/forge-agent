import { describe, expect, it } from "vitest";
import { Bm25Index } from "../src/context/bm25";
import {
  CHANGELOG_PENALTY,
  EXACT_SYMBOL_BOOST,
  WINDOW_PENALTY,
  chunkAdjustment,
  fuseRankings,
  splitClauses,
  withoutIntentWords,
} from "../src/context/retrieval";
import type { IndexHit } from "../src/context/indexer";
import { stem, tokenize, weightedQuery } from "../src/context/tokenize";

const hit = (id: number, score = 1): IndexHit =>
  ({ chunk: { id, path: `f${id}.py`, startLine: 1, endLine: 2, kind: "function", text: "", tokens: 1 }, score, terms: [] }) as unknown as IndexHit;

describe("stem", () => {
  it("conflates inflections but leaves short words and identifiers alone", () => {
    expect(stem("pushed")).toBe(stem("push"));
    expect(stem("routes")).toBe(stem("route"));
    expect(stem("tests")).toBe(stem("test"));
    expect(stem("cli")).toBe("cli");
    expect(stem("get")).toBe("get");
  });
});

describe("weightedQuery", () => {
  it("adds adjacent-word bigrams (joined and with an underscore) unless disabled", () => {
    const q = weightedQuery("where is the test client created");
    expect(q.terms).toContain("test_client");
    expect(q.terms).toContain("testclient");
    expect(weightedQuery("test client", { bigrams: false }).terms).not.toContain("test_client");
  });
  it("drops question-framing words", () => {
    expect(weightedQuery("where is the routes command implemented").terms).not.toContain("implement");
    expect(weightedQuery("where is the routes command implemented").terms).not.toContain("implemented");
  });
});

describe("splitClauses / fuseRankings", () => {
  it("splits only multi-sentence requests with enough content words", () => {
    expect(splitClauses("Add a flask config command to the cli. Write a pytest case covering the new command output. Describe the command in the cli guide.")).toHaveLength(3);
    expect(splitClauses("Add a config command to the cli")).toEqual([]);
    expect(splitClauses("Do it. Now.")).toEqual([]);
  });
  it("reciprocal-rank fusion rewards chunks that rank for several lists and is deterministic", () => {
    const fused = fuseRankings([[hit(1), hit(2), hit(3)], [hit(3), hit(4)]]);
    expect(fused.map((h) => h.chunk.id)).toEqual([3, 1, 2, 4]);
    expect(fuseRankings([[hit(1)], [hit(1)]])).toHaveLength(1);
  });
});

describe("chunkAdjustment", () => {
  const chunk = (over: Partial<{ path: string; symbol: string; kind: string }> = {}) => ({ path: "src/a.py", kind: "function", ...over });
  it("boosts a chunk whose symbol is named by an identifier-shaped word", () => {
    const f = chunkAdjustment("fix get_debug_flag", {});
    expect(f(chunk({ symbol: "get_debug_flag" }))).toBe(EXACT_SYMBOL_BOOST);
    expect(f(chunk({ symbol: "other" }))).toBe(1);
  });
  it("does not boost for a common plain word, but does for a rare one", () => {
    const common = chunkAdjustment("the command", { commonness: () => 0.08 });
    expect(common(chunk({ symbol: "Group.command" }))).toBe(1);
    const rare = chunkAdjustment("the jsonify", { commonness: () => 0.01 });
    expect(rare(chunk({ symbol: "jsonify" }))).toBe(EXACT_SYMBOL_BOOST);
  });
  it("penalises window chunks and changelog files", () => {
    const f = chunkAdjustment("anything", {});
    expect(f(chunk({ kind: "window" }))).toBeCloseTo(WINDOW_PENALTY);
    expect(f(chunk({ path: "CHANGES.rst", kind: "doc" }))).toBeCloseTo(CHANGELOG_PENALTY);
  });
});

describe("withoutIntentWords", () => {
  it("removes documentation words (handled by the docs-path boost) and leaves other text alone", () => {
    expect(withoutIntentWords("the command documented in the docs")).not.toMatch(/doc/);
    expect(withoutIntentWords("add a test for the config command")).toBe("add a test for the config command");
  });
});

describe("Bm25Index params and term weights", () => {
  const body = (s: string) => ({ symbol: [], path: [], signature: [], body: tokenize(s) });
  it("honours custom field boosts", () => {
    const idx = new Bm25Index({ boosts: { symbol: 1, path: 1, signature: 1, body: 5 } });
    idx.add(1, { symbol: tokenize("zeta"), path: [], signature: [], body: [] });
    idx.add(2, body("zeta"));
    expect(idx.search([stem("zeta")])[0]?.id).toBe(2);
  });
  it("per-term weights shift the ranking", () => {
    const idx = new Bm25Index();
    idx.add(1, body("alpha filler"));
    idx.add(2, body("beta filler"));
    idx.add(3, body("gamma filler"));
    const terms = [stem("alpha"), stem("beta")];
    expect(idx.search(terms, { weights: new Map([[terms[1]!, 5]]) })[0]?.id).toBe(2);
    expect(idx.search(terms, { weights: new Map([[terms[0]!, 5]]) })[0]?.id).toBe(1);
  });
});
