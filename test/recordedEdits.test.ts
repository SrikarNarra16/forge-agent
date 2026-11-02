import { describe, expect, it } from "vitest";
import { AgentController } from "../src/trueforge/agentController";
import { TurnReducer } from "../src/trueforge/events";
import { keyForCall, parseEditArgs } from "../src/mcp/tools/editTools";
import { DecisionStore } from "../src/mcp/decisions";
import { applyEdits } from "../src/review/hunks";
import { loadRecording } from "./helpers/fixtures";
import { ALLOW, FakeClient, RecordingUi, ScriptedApprovals, events } from "./helpers/fakeClient";
import type { RecordedTurn } from "./helpers/fixtures";

/**
 * Real deepseek/flash <-> TrueForge traffic from the P05 live check (test/fixtures/edit/*.jsonl): a model
 * calling propose_edit / create_file against the product tools, with the product agent instructions.
 */
function reduce(turns: RecordedTurn[]): TurnReducer {
  const r = new TurnReducer();
  for (const t of turns) {
    r.beginRound();
    for (const e of t.events) r.apply(e);
  }
  return r;
}

describe("recorded edit sessions", () => {
  it("every propose_edit / create_file call the real model made parses with the tool's own schema", async () => {
    let seen = 0;
    for (const name of ["e1_single_edit", "e2_partial_accept", "e3_reject_all", "e4_create_file"]) {
      const view = reduce(await loadRecording(name, "edit")).view;
      for (const call of view.toolCalls.filter((c) => c.name === "propose_edit" || c.name === "create_file")) {
        const tool = call.name as "propose_edit" | "create_file";
        expect(parseEditArgs(tool, call.args), `${name}: ${call.args.slice(0, 80)}`).toMatchObject({ ok: true });
        expect(keyForCall(tool, call.args), name).toMatch(/^[0-9a-f]{64}$/);
        seen++;
      }
    }
    expect(seen).toBe(4);
  });

  it("the model's edits are applicable to the original file text (anchors match exactly once)", async () => {
    const view = reduce(await loadRecording("e2_partial_accept", "edit")).view;
    const call = view.toolCalls.find((c) => c.name === "propose_edit")!;
    const args = parseEditArgs("propose_edit", call.args);
    expect(args.ok).toBe(true);
    if (!args.ok || args.tool !== "propose_edit") return;
    const original = ["def alpha():", "    return 1", "", "", "def beta():", "    return 2", "", "", "def gamma():", "    return 3", ""].join("\n");
    const applied = applyEdits(original, args.args.edits, "src/multi.py");
    expect(applied.ok).toBe(true);
  });

  it("e2: the pause lists the gated call; replaying through the controller sends the exact approval the live run did", async () => {
    const recording = await loadRecording("e2_partial_accept", "edit");
    const approvalTurn = recording.find((t) => (t.input[0] as { type?: string } | undefined)?.type === "user.tool_approval");
    expect(approvalTurn).toBeDefined();
    const client = new FakeClient(...recording.map((t) => () => events(...t.events)));
    const ui = new RecordingUi();
    const approvals = new ScriptedApprovals(() => ALLOW);
    const controller = new AgentController({ client, agentName: "forge-spike-edit", ui, approvals });
    await controller.send("replay");
    expect(approvals.started).toHaveLength(1);
    expect(client.turns.find((t) => (t.input[0] as { type?: string }).type === "user.tool_approval")?.input).toEqual(approvalTurn?.input);
    expect(ui.lastView?.toolCalls.find((c) => c.name === "propose_edit")?.response).toMatch(/^applied 2 of 3 hunks .* to src\/multi\.py; rejected: hunk 2 /);
  });

  it("e3: a rejected change reaches the model as a denied call with the exact reason", async () => {
    const recording = await loadRecording("e3_reject_all", "edit");
    const resume = recording.find((t) => (t.input[0] as { type?: string } | undefined)?.type === "user.tool_approval");
    expect(resume?.input).toEqual([expect.objectContaining({ type: "user.tool_approval", approval: { status: "deny", reason: "User rejected all changes to src/keep.py" } })]);
    const view = reduce(recording).view;
    expect(view.toolCalls.find((c) => c.name === "propose_edit")?.response).toContain("User denied tool call: User rejected all changes to src/keep.py");
  });

  it("the recorded tool results match what the tool reports for the same decisions (format contract)", async () => {
    const { formatDecision } = await import("../src/mcp/tools/editTools");
    const store = new DecisionStore();
    store.put("k", { path: "src/greet.py", kind: "edit", applied: 1, total: 1, added: 1, removed: 1, rejected: [] });
    expect(formatDecision(store.take("k")!)).toBe(reduce(await loadRecording("e1_single_edit", "edit")).view.toolCalls.find((c) => c.name === "propose_edit")?.response);
    expect(formatDecision({ path: "src/util.py", kind: "create", applied: 1, total: 1, added: 3, removed: 0, rejected: [] })).toBe(reduce(await loadRecording("e4_create_file", "edit")).view.toolCalls.find((c) => c.name === "create_file")?.response);
  });
});
