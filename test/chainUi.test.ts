import { describe, expect, it } from "vitest";
import { CompositeUi } from "../src/trueforge/uiSinks";
import { RunSideEffects } from "../src/trueforge/sideEffects";
import { TurnReducer } from "../src/trueforge/events";
import { Transcript } from "../src/ui/transcript";
import { delta, modelMessage, turnCreated } from "./helpers/events";
import { RecordingUi } from "./helpers/fakeClient";

describe("Transcript.discardAttempt", () => {
  function partialAttempt(t: Transcript): void {
    const r = new TurnReducer();
    for (const e of [turnCreated(), modelMessage({ id: "m1" }), delta({ id: "m1", content: "half an answ" })]) t.applyTurn(r.view, r.apply(e));
    t.upsert({ kind: "notice", id: "chain-status", level: "info", text: "Retrying" });
  }
  it("removes everything after the user message (assistant text, cards, the old chain notice) but keeps earlier turns and the user entry", () => {
    const t = new Transcript();
    t.addUser("first");
    t.upsert({ kind: "assistant", id: "old", text: "an earlier answer", streaming: false });
    t.addUser("second");
    partialAttempt(t);
    expect(t.items.map((i) => i.id)).toEqual(["user-1", "old", "user-2", "m1", "chain-status"]);
    const removed = t.discardAttempt();
    expect(removed).toEqual(["m1", "chain-status"]);
    expect(t.items.map((i) => i.id)).toEqual(["user-1", "old", "user-2"]);
    // the transcript is still consistent afterwards: a new attempt appends normally and ids resolve
    partialAttempt(t);
    expect(t.find("m1")).toMatchObject({ kind: "assistant", text: "half an answ" });
    expect(t.items.map((i) => i.id)).toEqual(["user-1", "old", "user-2", "m1", "chain-status"]);
  });
  it("is harmless when nothing was produced and after clear()", () => {
    const t = new Transcript();
    t.addUser("x");
    expect(t.discardAttempt()).toEqual([]);
    t.clear();
    expect(t.discardAttempt()).toEqual([]);
  });
});

describe("RunSideEffects", () => {
  it("combines checkpointed files with the commands recorded for the current run", () => {
    let run: string | undefined = "run-1";
    const files: Record<string, string[]> = { "run-1": ["src/a.py"], "run-2": [] };
    const fx = new RunSideEffects((id) => files[id] ?? [], () => run);
    expect(fx.of()).toEqual({ files: ["src/a.py"], commands: [] });
    fx.recordCommand("  pytest -q ");
    expect(fx.of("run-1")).toEqual({ files: ["src/a.py"], commands: ["pytest -q"] });
    run = "run-2";
    expect(fx.of()).toEqual({ files: [], commands: [] }); // a new run starts clean
    run = undefined;
    fx.recordCommand("ls"); // no run: ignored
    expect(fx.of()).toEqual({ files: [], commands: [] });
  });
});

describe("CompositeUi forwards the chain hooks to the sinks that implement them", () => {
  it("onChain / onAttemptDiscarded", () => {
    const a = new RecordingUi();
    const plain = { onState() {}, onUserMessage() {}, onTurnChange() {}, onSession() {}, onNotice() {}, onReset() {} };
    const ui = new CompositeUi([a, plain]);
    ui.onChain({ kind: "retrying", model: "m", text: "Retrying m in 0.5 s (503)" });
    ui.onAttemptDiscarded();
    expect(a.chainEvents.map((e) => e.kind)).toEqual(["retrying"]);
    expect(a.discards).toBe(1);
  });
});
