import { describe, expect, it } from "vitest";
import {
  MAX_REVIEW_LINES, ReviewTooLargeError, applyEdits, composeText, computeHunks, hunkStats, hunkSummary, layoutText, splitLines, totalStats,
  type Decision, type Hunk,
} from "../src/review/hunks";

const all = (n: number, d: Decision): Decision[] => Array.from({ length: n }, () => d);

describe("splitLines", () => {
  it("keeps terminators and round-trips", () => {
    expect(splitLines("a\nb\n")).toEqual(["a\n", "b\n"]);
    expect(splitLines("a\nb")).toEqual(["a\n", "b"]);
    expect(splitLines("a\r\nb\r\n")).toEqual(["a\r\n", "b\r\n"]);
    expect(splitLines("")).toEqual([]);
    expect(splitLines("\n")).toEqual(["\n"]);
    expect(splitLines("\n\nx").join("")).toBe("\n\nx");
  });
});

describe("computeHunks", () => {
  it("returns no hunks for identical text, including empty", () => {
    expect(computeHunks("a\nb\n", "a\nb\n")).toEqual([]);
    expect(computeHunks("", "")).toEqual([]);
  });

  it("produces one minimal hunk for a single changed line", () => {
    const [h, ...rest] = computeHunks("one\ntwo\nthree\n", "one\nTWO\nthree\n");
    expect(rest).toEqual([]);
    expect(h).toMatchObject({ id: 0, origStart: 1, origLines: 1, newStart: 1, newLines: 1 });
    expect(h?.lines).toEqual([{ type: "-", text: "two\n" }, { type: "+", text: "TWO\n" }]);
  });

  it("splits changes that are 2+ unchanged lines apart and merges those 1 line apart", () => {
    const base = ["a", "b", "c", "d", "e", "f", "g"].map((l) => `${l}\n`).join("");
    const twoApart = computeHunks(base, base.replace("a\n", "A\n").replace("d\n", "D\n")); // b,c unchanged between
    expect(twoApart).toHaveLength(2);
    const oneApart = computeHunks(base, base.replace("a\n", "A\n").replace("c\n", "C\n")); // only b between
    expect(oneApart).toHaveLength(1);
    expect(oneApart[0]?.lines.map((l) => l.type).join("")).toBe("-+ -+");
    expect(oneApart[0]).toMatchObject({ origStart: 0, origLines: 3, newStart: 0, newLines: 3 });
  });

  it("handles a hunk at the very start and at the very end", () => {
    const hunks = computeHunks("b\nc\nd\ne\nf\n", "a\nb\nc\nd\ne\nf\ng\n");
    expect(hunks).toHaveLength(2);
    expect(hunks[0]).toMatchObject({ origStart: 0, origLines: 0, newStart: 0, newLines: 1 });
    expect(hunks[1]).toMatchObject({ origStart: 5, origLines: 0, newStart: 6, newLines: 1 });
  });

  it("handles empty originals and empty proposals", () => {
    const create = computeHunks("", "x\ny\n");
    expect(create).toHaveLength(1);
    expect(create[0]).toMatchObject({ origStart: 0, origLines: 0, newLines: 2 });
    const wipe = computeHunks("x\ny\n", "");
    expect(wipe[0]).toMatchObject({ origLines: 2, newLines: 0 });
    expect(composeText("x\ny\n", wipe, all(1, "accepted"))).toBe("");
  });

  it("treats adding or removing the final newline as a change to the last line", () => {
    const hunks = computeHunks("a\nb", "a\nb\n");
    expect(hunks).toHaveLength(1);
    expect(hunks[0]?.lines).toEqual([{ type: "-", text: "b" }, { type: "+", text: "b\n" }]);
    expect(composeText("a\nb", hunks, all(1, "accepted"))).toBe("a\nb\n");
    expect(composeText("a\nb\n", computeHunks("a\nb\n", "a\nb"), all(1, "accepted"))).toBe("a\nb");
  });

  it("preserves CRLF and mixed line endings exactly", () => {
    const original = "a\r\nb\r\nc\nd\r\n";
    const proposed = "a\r\nB\r\nc\nd\r\ne\r\n";
    const hunks = computeHunks(original, proposed);
    expect(composeText(original, hunks, all(hunks.length, "accepted"))).toBe(proposed);
    expect(composeText(original, hunks, all(hunks.length, "rejected"))).toBe(original);
  });

  it("refuses inputs that are too large instead of blocking", () => {
    const big = "x\n".repeat(MAX_REVIEW_LINES + 1);
    expect(() => computeHunks(big, `${big}y\n`)).toThrow(ReviewTooLargeError);
    expect(() => computeHunks("a", "b".repeat(2_000_001))).toThrow(ReviewTooLargeError);
  });

  it("numbers hunks 0..n-1 in file order without overlap", () => {
    const base = Array.from({ length: 40 }, (_, i) => `line ${i}\n`).join("");
    const changed = base.replace("line 3\n", "X\n").replace("line 20\n", "Y\n").replace("line 37\n", "Z\n");
    const hunks = computeHunks(base, changed);
    expect(hunks.map((h) => h.id)).toEqual([0, 1, 2]);
    for (let i = 1; i < hunks.length; i++) expect(hunks[i]!.origStart).toBeGreaterThanOrEqual(hunks[i - 1]!.origStart + hunks[i - 1]!.origLines);
  });
});

describe("composeText", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g", "h", "i", "j"].map((l) => `${l}\n`).join("");
  const proposed = original.replace("b\n", "B\n").replace("e\n", "E1\nE2\n").replace("i\n", "");
  const hunks = computeHunks(original, proposed);

  it("has three hunks for this change", () => {
    expect(hunks).toHaveLength(3);
  });
  it("all accepted equals the proposal; none accepted (rejected or pending) equals the original", () => {
    expect(composeText(original, hunks, all(3, "accepted"))).toBe(proposed);
    expect(composeText(original, hunks, all(3, "rejected"))).toBe(original);
    expect(composeText(original, hunks, all(3, "pending"))).toBe(original);
  });
  it("applies exactly the accepted subset", () => {
    expect(composeText(original, hunks, ["accepted", "rejected", "accepted"])).toBe(original.replace("b\n", "B\n").replace("i\n", ""));
    expect(composeText(original, hunks, ["rejected", "accepted", "pending"])).toBe(original.replace("e\n", "E1\nE2\n"));
  });
  it("accepts decisions as a function of the hunk", () => {
    expect(composeText(original, hunks, (h) => (h.id === 1 ? "accepted" : "rejected"))).toBe(original.replace("e\n", "E1\nE2\n"));
  });
  it("is idempotent and pure", () => {
    const d: Decision[] = ["accepted", "rejected", "accepted"];
    expect(composeText(original, hunks, d)).toBe(composeText(original, hunks, d));
    expect(hunks).toEqual(computeHunks(original, proposed));
  });
});

describe("layoutText", () => {
  const original = ["a", "b", "c", "d", "e", "f", "g"].map((l) => `${l}\n`).join("");
  const proposed = original.replace("a\n", "A1\nA2\n").replace("f\n", "");
  const hunks = computeHunks(original, proposed);

  it("shows pending and accepted hunks as proposed, with correct ranges", () => {
    const layout = layoutText(original, hunks, all(2, "pending"));
    expect(layout.text).toBe(proposed);
    expect(layout.ranges).toEqual([{ start: 0, end: 2 }, { start: 6, end: 6 }]); // second hunk is a pure deletion (after A1,A2,b,c,d,e): empty range
  });
  it("reverts rejected hunks in the visible text, so the diff shrinks, and moves later ranges", () => {
    const layout = layoutText(original, hunks, ["rejected", "pending"]);
    expect(layout.text).toBe(original.replace("f\n", ""));
    expect(layout.ranges).toEqual([{ start: 0, end: 1 }, { start: 5, end: 5 }]);
    expect(layoutText(original, hunks, all(2, "rejected")).text).toBe(original);
  });
  it("visible text always diffs against the original as exactly the non-rejected hunks", () => {
    const decisions: Decision[] = ["pending", "rejected"];
    const visible = layoutText(original, hunks, decisions).text;
    expect(computeHunks(original, visible)).toHaveLength(1);
  });
});

describe("hunk helpers", () => {
  const [h] = computeHunks("x\nold1\nold2\ny\n", "x\nnew\ny\n") as [Hunk];
  it("counts added and removed lines", () => {
    expect(hunkStats(h)).toEqual({ added: 1, removed: 2 });
  });
  it("sums only the requested decision", () => {
    expect(totalStats([h], ["accepted"])).toEqual({ added: 1, removed: 2 });
    expect(totalStats([h], ["rejected"])).toEqual({ added: 0, removed: 0 });
    expect(totalStats([h], ["rejected"], "rejected")).toEqual({ added: 1, removed: 2 });
  });
  it("describes a hunk briefly with its original line number", () => {
    expect(hunkSummary(h)).toBe("hunk 1 (line 2): + new");
    const long = computeHunks("a\n", `b${"x".repeat(100)}\n`)[0]!;
    expect(hunkSummary(long).length).toBeLessThan(100);
    expect(hunkSummary(computeHunks("a\nb\nc\n", "a\nc\n")[0]!)).toBe("hunk 1 (line 2): - b");
  });
});

// --- seeded random properties --------------------------------------------------------------------------

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

function randomDoc(rand: () => number): string[] {
  const vocab = ["x", "y", "z", "foo", "bar", "", "  indented", "}", "{"]; // small vocabulary: many duplicate lines stress the diff
  const n = Math.floor(rand() * 30);
  return Array.from({ length: n }, () => vocab[Math.floor(rand() * vocab.length)] ?? "");
}

function render(lines: string[], rand: () => number, crlf: boolean, trailingNewline: boolean): string {
  const eol = (): string => (crlf && rand() < 0.8 ? "\r\n" : "\n");
  return lines.map((l, i) => l + (i === lines.length - 1 && !trailingNewline ? "" : eol())).join("");
}

function mutate(lines: string[], rand: () => number): string[] {
  const out = [...lines];
  const ops = Math.floor(rand() * 6);
  for (let k = 0; k < ops; k++) {
    const at = Math.floor(rand() * (out.length + 1));
    const r = rand();
    if (r < 0.35) out.splice(at, 0, `new${Math.floor(rand() * 4)}`);
    else if (r < 0.65 && out.length) out.splice(Math.min(at, out.length - 1), 1);
    else if (out.length) out[Math.min(at, out.length - 1)] = `chg${Math.floor(rand() * 4)}`;
  }
  return out;
}

describe("hunks: seeded random properties", () => {
  it("holds for 400 random documents, mixed EOLs, with and without trailing newline", () => {
    for (let seed = 1; seed <= 400; seed++) {
      const rand = mulberry32(seed);
      const crlf = rand() < 0.4;
      const lines = randomDoc(rand);
      const original = render(lines, rand, crlf, rand() < 0.7);
      const proposed = render(mutate(lines, rand), rand, crlf, rand() < 0.7);
      const ctx = `seed ${seed}`;
      const hunks = computeHunks(original, proposed);

      // P1/P2
      expect(composeText(original, hunks, all(hunks.length, "accepted")), ctx).toBe(proposed);
      expect(composeText(original, hunks, all(hunks.length, "rejected")), ctx).toBe(original);

      // structure: ordered, non-overlapping, consistent offsets
      let delta = 0;
      for (const [i, h] of hunks.entries()) {
        expect(h.id, ctx).toBe(i);
        if (i > 0) expect(h.origStart, ctx).toBeGreaterThanOrEqual(hunks[i - 1]!.origStart + hunks[i - 1]!.origLines);
        expect(h.newStart, ctx).toBe(h.origStart + delta);
        delta += h.newLines - h.origLines;
      }

      // P3: for random subsets, compare with an oracle that splices the PROPOSED text (not hunk.lines)
      const a = splitLines(original);
      const b = splitLines(proposed);
      for (let trial = 0; trial < 4; trial++) {
        const decisions: Decision[] = hunks.map(() => (rand() < 0.5 ? "accepted" : rand() < 0.5 ? "rejected" : "pending"));
        const expected: string[] = [];
        let idx = 0;
        for (const h of hunks) {
          expected.push(...a.slice(idx, h.origStart));
          expected.push(...(decisions[h.id] === "accepted" ? b.slice(h.newStart, h.newStart + h.newLines) : a.slice(h.origStart, h.origStart + h.origLines)));
          idx = h.origStart + h.origLines;
        }
        expected.push(...a.slice(idx));
        const composed = composeText(original, hunks, decisions);
        expect(composed, ctx).toBe(expected.join(""));

        // P4: from any partial result, diffing against the proposal and accepting everything reaches the proposal
        const rest = computeHunks(composed, proposed);
        expect(composeText(composed, rest, all(rest.length, "accepted")), ctx).toBe(proposed);

        // layout shows every non-rejected hunk and ranges stay inside the text
        const layout = layoutText(original, hunks, decisions);
        const lineCount = splitLines(layout.text).length;
        for (const r of layout.ranges) {
          expect(r.start, ctx).toBeLessThanOrEqual(r.end);
          expect(r.end, ctx).toBeLessThanOrEqual(lineCount);
        }
        const visibleDecisions = decisions.map((d): Decision => (d === "rejected" ? "rejected" : "accepted"));
        expect(layout.text, ctx).toBe(composeText(original, hunks, visibleDecisions));
      }
    }
  });
});

// --- applyEdits ----------------------------------------------------------------------------------------

describe("applyEdits", () => {
  const text = "def f():\n    return 1\n\n\ndef g():\n    return 2\n";

  it("applies a unique edit", () => {
    expect(applyEdits(text, [{ old_text: "return 1", new_text: "return 10" }], "a.py")).toEqual({ ok: true, text: text.replace("return 1", "return 10") });
  });

  it("applies several edits in order, each matched against the text after the earlier ones", () => {
    const r = applyEdits(text, [{ old_text: "return 1", new_text: "return 1 + 1" }, { old_text: "return 1 + 1", new_text: "return 2 * 1" }], "a.py");
    expect(r).toEqual({ ok: true, text: text.replace("return 1", "return 2 * 1") });
  });

  it("an edit can match text created by an earlier edit", () => {
    expect(applyEdits("a", [{ old_text: "a", new_text: "bb" }, { old_text: "bb", new_text: "c" }], "f")).toEqual({ ok: true, text: "c" });
  });

  it("rejects 0 matches with a teaching message", () => {
    expect(applyEdits(text, [{ old_text: "return 3", new_text: "x" }], "src/a.py")).toEqual({
      ok: false,
      error: "old_text matched 0 times in src/a.py. Re-read the file and include more surrounding context so old_text matches exactly once.",
    });
  });

  it("rejects N matches, including overlapping ones, and names the failing edit", () => {
    const dup = applyEdits(text, [{ old_text: "return", new_text: "yield" }], "a.py");
    expect(dup).toMatchObject({ ok: false, error: expect.stringContaining("old_text matched 2 times in a.py") });
    const overlap = applyEdits("aaa", [{ old_text: "aa", new_text: "b" }], "a.txt");
    expect(overlap).toMatchObject({ ok: false, error: expect.stringContaining("matched 2 times") });
    const second = applyEdits(text, [{ old_text: "return 1", new_text: "return 5" }, { old_text: "nope", new_text: "x" }], "a.py");
    expect(second).toMatchObject({ ok: false, error: expect.stringMatching(/^Edit 2 of 2: old_text matched 0 times/) });
  });

  it("is atomic: a failing later edit returns an error, never a partial text", () => {
    const r = applyEdits(text, [{ old_text: "return 1", new_text: "return 5" }, { old_text: "missing", new_text: "x" }], "a.py");
    expect(r.ok).toBe(false);
    expect(r).not.toHaveProperty("text");
  });

  it("converts LF snippets to the file's CRLF endings", () => {
    const crlf = "a\r\nb\r\nc\r\n";
    expect(applyEdits(crlf, [{ old_text: "a\nb", new_text: "a\nB\nB2" }], "f")).toEqual({ ok: true, text: "a\r\nB\r\nB2\r\nc\r\n" });
  });

  it("rejects empty old_text, no-op edits and edits that change nothing overall", () => {
    expect(applyEdits(text, [{ old_text: "", new_text: "x" }], "a.py")).toMatchObject({ ok: false, error: expect.stringContaining("old_text is empty") });
    expect(applyEdits(text, [{ old_text: "return 1", new_text: "return 1" }], "a.py")).toMatchObject({ ok: false, error: expect.stringContaining("identical") });
    expect(applyEdits(text, [{ old_text: "return 1", new_text: "return 9" }, { old_text: "return 9", new_text: "return 1" }], "a.py")).toMatchObject({ ok: false, error: expect.stringContaining("unchanged") });
  });

  it("matches multi-line anchors exactly (whitespace matters)", () => {
    expect(applyEdits(text, [{ old_text: "def g():\n    return 2", new_text: "def g():\n    return 3" }], "a.py")).toMatchObject({ ok: true });
    expect(applyEdits(text, [{ old_text: "def g():\n  return 2", new_text: "x" }], "a.py")).toMatchObject({ ok: false });
  });

  it("works on a file without a trailing newline", () => {
    expect(applyEdits("x = 1", [{ old_text: "x = 1", new_text: "x = 2" }], "f")).toEqual({ ok: true, text: "x = 2" });
  });
});
