import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseEditArgs } from "../src/mcp/tools/editTools";
import { TurnReducer } from "../src/trueforge/events";
import type { RecordedTurn } from "./helpers/fixtures";
import { loadRecording } from "./helpers/fixtures";

/** Real deepseek/flash runs of Task A through the product forge-inline agent (scripts/run-task-a-headless.ts --save). */
async function recordingNames(): Promise<string[]> {
  return (await readdir(join(__dirname, "fixtures", "task-a"))).filter((f) => f.endsWith(".jsonl")).map((f) => f.replace(/\.jsonl$/, "")).sort();
}

function reduce(turns: RecordedTurn[]): TurnReducer {
  const r = new TurnReducer();
  for (const t of turns) {
    r.beginRound();
    for (const e of t.events) r.apply(e);
  }
  return r;
}

describe("recorded Task A runs", () => {
  it("has the five passing runs from the headless runner", async () => {
    expect(await recordingNames()).toEqual(["run1-pass", "run2-pass", "run3-pass", "run4-pass", "run5-pass"]);
  });

  it("each run: ONE propose_edit call for helpers.py that handles 'off' and 'n' and updates the docstring, applied in full", async () => {
    for (const name of await recordingNames()) {
      const view = reduce(await loadRecording(name, "task-a")).view;
      const edits = view.toolCalls.filter((c) => c.name === "propose_edit");
      expect(edits, name).toHaveLength(1);
      const call = edits[0]!;
      const parsed = parseEditArgs("propose_edit", call.args);
      expect(parsed.ok, name).toBe(true);
      if (!parsed.ok || parsed.tool !== "propose_edit") continue;
      expect(parsed.args.path, name).toBe("src/flask/helpers.py");
      const newText = parsed.args.edits.map((e) => e.new_text).join("\n");
      expect(newText, name).toMatch(/"off"/);
      expect(newText, name).toMatch(/"n"/);
      expect(newText, name).toMatch(/not in \{[^}]*"off"[^}]*"n"[^}]*\}|not in \{[^}]*"n"[^}]*"off"[^}]*\}/); // the code change
      expect(parsed.args.edits.length, `${name}: code and docstring together`).toBeGreaterThanOrEqual(1);
      expect(call.response, name).toMatch(/^applied 2 of 2 hunks \(\+\d+ -\d+ lines\) to src\/flask\/helpers\.py$/);
      expect(view.done, name).toMatchObject({ status: "done" });
    }
  });

  it("the agent needed at most one read before editing and never used another write tool", async () => {
    for (const name of await recordingNames()) {
      const names = reduce(await loadRecording(name, "task-a")).view.toolCalls.map((c) => c.name);
      expect(names.filter((n) => n === "create_file"), name).toEqual([]);
      expect(names.length, name).toBeLessThanOrEqual(3);
    }
  });
});
