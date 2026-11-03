import { describe, expect, it } from "vitest";
import { RunCancelledError, RunRegistry } from "../src/trueforge/runRegistry";

describe("RunRegistry", () => {
  it("tracks the current run and cancels only that run", () => {
    const r = new RunRegistry();
    expect(r.isCancelled()).toBe(false);
    r.begin("run-1");
    r.cancel();
    expect(r.isCancelled("run-1")).toBe(true);
    expect(r.isCancelled()).toBe(true);
    r.begin("run-2");
    expect(r.isCancelled()).toBe(false);
    expect(r.isCancelled("run-1")).toBe(true); // the old run stays cancelled for late events
  });
  it("assertActive throws RunCancelledError for a cancelled run, and cancel is idempotent", () => {
    const r = new RunRegistry();
    r.begin("run-1");
    expect(() => r.assertActive()).not.toThrow();
    r.cancel();
    r.cancel();
    expect(() => r.assertActive()).toThrow(RunCancelledError);
    expect(() => r.assertActive("run-9")).not.toThrow();
  });
});
