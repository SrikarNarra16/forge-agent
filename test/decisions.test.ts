import { describe, expect, it } from "vitest";
import { DecisionStore, canonicalJson, decisionKey, type EditDecision } from "../src/mcp/decisions";

const decision = (over: Partial<EditDecision> = {}): EditDecision => ({ path: "a.py", kind: "edit", applied: 1, total: 1, added: 2, removed: 1, rejected: [], ...over });

describe("canonicalJson / decisionKey", () => {
  it("is independent of object key order at every depth", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe(canonicalJson({ a: { c: null, d: [3, { x: 2, y: 1 }] }, b: 1 }));
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
  });
  it("keeps array order significant", () => {
    expect(canonicalJson([1, 2])).not.toBe(canonicalJson([2, 1]));
  });
  it("keys differ by tool name, by any argument value, and by edit order", () => {
    const args = { path: "a.py", edits: [{ old_text: "x", new_text: "y" }, { old_text: "p", new_text: "q" }], summary: "s" };
    expect(decisionKey("propose_edit", args)).toBe(decisionKey("propose_edit", structuredClone(args)));
    expect(decisionKey("propose_edit", args)).not.toBe(decisionKey("create_file", args));
    expect(decisionKey("propose_edit", args)).not.toBe(decisionKey("propose_edit", { ...args, summary: "t" }));
    expect(decisionKey("propose_edit", args)).not.toBe(decisionKey("propose_edit", { ...args, edits: [...args.edits].reverse() }));
  });
  it("is a sha256 hex string", () => {
    expect(decisionKey("t", {})).toMatch(/^[0-9a-f]{64}$/);
  });
});

describe("DecisionStore", () => {
  it("returns decisions FIFO per key, so identical calls each get their own", () => {
    const s = new DecisionStore();
    s.put("k", decision({ applied: 1 }));
    s.put("k", decision({ applied: 2 }));
    s.put("other", decision({ applied: 9 }));
    expect(s.size).toBe(3);
    expect(s.take("k")?.applied).toBe(1);
    expect(s.take("k")?.applied).toBe(2);
    expect(s.take("k")).toBeUndefined();
    expect(s.take("other")?.applied).toBe(9);
    expect(s.size).toBe(0);
  });

  it("returns undefined for an unknown key", () => {
    expect(new DecisionStore().take("nope")).toBeUndefined();
  });

  it("expires decisions after the TTL", () => {
    const s = new DecisionStore(1000);
    s.put("k", decision({ applied: 1 }), 0);
    s.put("k", decision({ applied: 2 }), 900);
    expect(s.take("k", 1500)?.applied).toBe(2); // the first expired
    s.put("k", decision(), 0);
    expect(s.take("k", 5000)).toBeUndefined();
    expect(s.size).toBe(0);
  });

  it("clear drops everything", () => {
    const s = new DecisionStore();
    s.put("a", decision());
    s.put("b", decision());
    s.clear();
    expect(s.size).toBe(0);
    expect(s.take("a")).toBeUndefined();
  });
});
