import { describe, expect, it } from "vitest";
import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "../src/trueforge/agentController";
import { RoutingApprovalHandler } from "../src/trueforge/routingApprovals";
import { DecisionStore } from "../src/mcp/decisions";
import { RunScope } from "../src/review/runScope";
import { ReviewTracker } from "../src/review/tracker";

const call = (name: string): PendingToolCall => ({ id: `c-${name}`, name, args: "{}", threadId: "main", sourceEventId: "m" });
const handler = (label: string, seen: string[]): ApprovalHandler => ({
  decide: (c): Promise<ApprovalDecision> => {
    seen.push(`${label}:${c.name}`);
    return Promise.resolve({ status: "allow" });
  },
});

describe("RoutingApprovalHandler", () => {
  it("sends registered tools to their handler and everything else to the fallback", async () => {
    const seen: string[] = [];
    const router = new RoutingApprovalHandler(new Map([["propose_edit", handler("review", seen)], ["create_file", handler("review", seen)]]), handler("card", seen));
    const signal = new AbortController().signal;
    for (const name of ["propose_edit", "run_command", "create_file", "constructor", "toString"]) await router.decide(call(name), signal);
    expect(seen).toEqual(["review:propose_edit", "card:run_command", "review:create_file", "card:constructor", "card:toString"]);
  });

  it("passes the abort signal through unchanged", async () => {
    const ctrl = new AbortController();
    let received: AbortSignal | undefined;
    const router = new RoutingApprovalHandler(new Map(), { decide: (_c, s) => ((received = s), Promise.resolve({ status: "allow" })) });
    await router.decide(call("x"), ctrl.signal);
    expect(received).toBe(ctrl.signal);
  });
});

describe("RunScope", () => {
  const entry = { callId: "c", path: "a.py", kind: "edit" as const, summary: "s" };

  it("mints a new run id per user request", () => {
    const scope = new RunScope({ decisions: new DecisionStore(), tracker: new ReviewTracker() });
    expect(scope.runId).toBe("run-0");
    scope.onUserMessage();
    expect(scope.runId).toBe("run-1");
    scope.onUserMessage();
    expect(scope.runId).toBe("run-2");
  });

  it("drops leftover decisions and finished review entries when a new request starts, keeping active ones", () => {
    const decisions = new DecisionStore();
    const tracker = new ReviewTracker();
    decisions.put("k", { path: "a.py", kind: "edit", applied: 1, total: 1, added: 1, removed: 0, rejected: [] });
    tracker.add({ ...entry, callId: "done", state: "applied" });
    tracker.add({ ...entry, callId: "open", state: "reviewing" });
    new RunScope({ decisions, tracker }).onUserMessage();
    expect(decisions.size).toBe(0);
    expect(tracker.list().map((e) => e.callId)).toEqual(["open"]);
  });
});
