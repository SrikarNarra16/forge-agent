import { describe, expect, it } from "vitest";
import { reviewHeader, toolCardModel, type ToolItem } from "../src/ui/webview/format";

describe("reviewHeader", () => {
  it("counts changes and distinct files", () => {
    expect(reviewHeader([{ path: "a.py" }])).toBe("Review (1 change in 1 file)");
    expect(reviewHeader([{ path: "a.py" }, { path: "a.py" }])).toBe("Review (2 changes in 1 file)");
    expect(reviewHeader([{ path: "a.py" }, { path: "b.py" }])).toBe("Review (2 changes in 2 files)");
    expect(reviewHeader([{ path: "a.py" }, { path: "b.py" }, { path: "a.py" }])).toBe("Review (3 changes in 2 files)");
  });
});

describe("toolCardModel", () => {
  const base: ToolItem = { kind: "tool", id: "c1", name: "propose_edit", argsSummary: 'path="src/a.py" edits=[object Object] summary="bump"', args: '{\n  "path": "src/a.py"\n}', status: "awaiting_approval" };

  it("review cards show the file as the headline and keep the raw JSON behind Details only", () => {
    const m = toolCardModel({ ...base, review: { path: "src/a.py", summary: "bump", kind: "edit", state: "reviewing", hunks: 2 } });
    expect(m.headline).toBe("src/a.py");
    expect(m.headline).not.toContain("{");
    expect(m.headline).not.toContain("edits=");
    expect(m.inlineArgs).toBeUndefined();
    expect(m.detailsArgs).toBe(base.args);
  });

  it("other tools show their arguments inline and have no Details", () => {
    const m = toolCardModel({ ...base, name: "read_file", argsSummary: 'path="a.py" why="look"' });
    expect(m).toEqual({ headline: 'path="a.py" why="look"', inlineArgs: base.args, detailsArgs: undefined });
  });

  it("omits empty arguments", () => {
    expect(toolCardModel({ ...base, name: "ping", args: "{}", argsSummary: "" })).toEqual({ headline: "", inlineArgs: undefined, detailsArgs: undefined });
    expect(toolCardModel({ ...base, args: "", review: { path: "a.py", summary: "s", kind: "create", state: "queued" } }).detailsArgs).toBeUndefined();
  });
});
