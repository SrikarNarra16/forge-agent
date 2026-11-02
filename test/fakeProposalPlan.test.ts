import { describe, expect, it } from "vitest";
import { applyEdits, computeHunks } from "../src/review/hunks";
import { planFakeEdits } from "../src/review/fakeProposalPlan";

const file = (n: number, dup = false): string => Array.from({ length: n }, (_, i) => `    value_${i} = compute(${i})  # line ${i}${dup && i % 2 === 0 ? "" : ""}`).join("\n") + "\n";

describe("planFakeEdits", () => {
  it("plans three edits on unique, well separated lines in file order", () => {
    const text = file(40);
    const plan = planFakeEdits(text, "py");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.edits).toHaveLength(3);
    const indexes = plan.edits.map((e) => text.split("\n").indexOf(e.old_text));
    expect(indexes[0]).toBeLessThan(indexes[1]!);
    expect(indexes[1]).toBeLessThan(indexes[2]!);
    for (let i = 1; i < 3; i++) expect(indexes[i]! - indexes[i - 1]!).toBeGreaterThanOrEqual(4);
    expect(plan.edits[0]?.new_text).toMatch(/# forge fake proposal 1$/);
  });

  it("the edits apply cleanly and always produce exactly three hunks", () => {
    for (const n of [12, 13, 20, 57, 300]) {
      const text = file(n);
      const plan = planFakeEdits(text, "py");
      expect(plan.ok, `n=${n}`).toBe(true);
      if (!plan.ok) continue;
      const applied = applyEdits(text, plan.edits, "f.py");
      expect(applied.ok, `n=${n}`).toBe(true);
      if (applied.ok) expect(computeHunks(text, applied.text), `n=${n}`).toHaveLength(3);
    }
  });

  it("skips lines that occur more than once, blank lines and punctuation-only lines", () => {
    const lines = Array.from({ length: 30 }, (_, i) => (i % 3 === 0 ? "x = 1  # same" : i % 3 === 1 ? "}" : `unique_line_number_${i}`));
    const text = `${lines.join("\n")}\n`;
    const plan = planFakeEdits(text, "ts");
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    for (const e of plan.edits) {
      expect(e.old_text).toMatch(/^unique_line_number_/);
      expect(text.split(e.old_text).length - 1).toBe(1);
      expect(e.new_text).toContain("// forge fake proposal");
    }
  });

  it("uses a # comment for python-like files and // otherwise", () => {
    expect(planFakeEdits(file(20), "yaml")).toMatchObject({ ok: true, edits: [{ new_text: expect.stringContaining("# forge") }, expect.anything(), expect.anything()] });
    expect(planFakeEdits(file(20), "js")).toMatchObject({ ok: true, edits: [{ new_text: expect.stringContaining("// forge") }, expect.anything(), expect.anything()] });
  });

  it("explains when the file is too short or has too little distinct content", () => {
    expect(planFakeEdits("a\nb\nc\n", "py")).toMatchObject({ ok: false, error: expect.stringContaining("at least 12 lines") });
    expect(planFakeEdits("same line here\n".repeat(30), "py")).toMatchObject({ ok: false, error: expect.stringContaining("three distinct") });
  });
});
