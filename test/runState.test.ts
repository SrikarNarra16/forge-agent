import { describe, expect, it } from "vitest";
import { IllegalTransitionError, RunStateMachine, type RunState } from "../src/trueforge/runState";

const ALL: RunState[] = ["idle", "running", "awaitingApproval", "cancelling", "done", "error", "cancelled"];
const LEGAL: Record<RunState, RunState[]> = {
  idle: ["running"],
  running: ["awaitingApproval", "done", "error", "cancelled", "cancelling"],
  awaitingApproval: ["running", "cancelled", "error", "cancelling"],
  cancelling: ["cancelled", "error"],
  done: ["running"],
  error: ["running"],
  cancelled: ["running"],
};

/** Walks a fresh machine to `state` through legal transitions. */
function machineAt(state: RunState): RunStateMachine {
  const m = new RunStateMachine();
  const paths: Record<RunState, RunState[]> = {
    idle: [],
    running: ["running"],
    awaitingApproval: ["running", "awaitingApproval"],
    cancelling: ["running", "cancelling"],
    done: ["running", "done"],
    error: ["running", "error"],
    cancelled: ["running", "cancelled"],
  };
  for (const step of paths[state]) m.transition(step);
  return m;
}

describe("RunStateMachine", () => {
  it("starts idle and is not busy", () => {
    const m = new RunStateMachine();
    expect(m.state).toBe("idle");
    expect(m.busy).toBe(false);
  });

  for (const from of ALL) {
    for (const to of ALL) {
      const legal = LEGAL[from].includes(to);
      it(`${from} -> ${to} is ${legal ? "allowed" : "rejected"}`, () => {
        const m = machineAt(from);
        expect(m.canTransition(to)).toBe(legal);
        if (legal) {
          m.transition(to);
          expect(m.state).toBe(to);
        } else {
          expect(() => m.transition(to)).toThrow(IllegalTransitionError);
          expect(m.state).toBe(from);
        }
      });
    }
  }

  it("is busy while running, awaiting approval or cancelling; only the first two are stoppable", () => {
    expect(ALL.filter((s) => machineAt(s).busy)).toEqual(["running", "awaitingApproval", "cancelling"]);
    expect(ALL.filter((s) => machineAt(s).stoppable)).toEqual(["running", "awaitingApproval"]);
  });

  it("cancelling is entered from running or awaitingApproval and ends in cancelled (then the next send works)", () => {
    for (const from of ["running", "awaitingApproval"] as const) {
      const m = machineAt(from);
      m.transition("cancelling");
      m.transition("cancelled");
      m.transition("running");
      expect(m.state).toBe("running");
    }
  });

  it("supports the full approval cycle idle -> running -> awaitingApproval -> running -> done", () => {
    const m = new RunStateMachine();
    const seen: RunState[] = [];
    m.onChange((s) => seen.push(s));
    for (const s of ["running", "awaitingApproval", "running", "done"] as const) m.transition(s);
    expect(seen).toEqual(["running", "awaitingApproval", "running", "done"]);
  });

  it("notifies listeners with previous state and detail, and supports unsubscribe", () => {
    const m = new RunStateMachine();
    const calls: Array<[RunState, RunState, string | undefined]> = [];
    const off = m.onChange((s, p, d) => calls.push([s, p, d]));
    m.transition("running");
    m.transition("error", "boom");
    off();
    m.transition("running");
    expect(calls).toEqual([
      ["running", "idle", undefined],
      ["error", "running", "boom"],
    ]);
  });
});
