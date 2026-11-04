import { describe, expect, it } from "vitest";
import {
  MAX_TOTAL_ATTEMPTS,
  backoffDelay,
  classifyFailure,
  exhaustedMessage,
  isModelFailure,
  planNext,
  promoteModel,
  retryingMessage,
  shortReason,
  sideEffectsMessage,
  switchedMessage,
  type AttemptRecord,
  type FailureClass,
} from "../src/trueforge/modelChain";

/** The REAL strings TrueForge / the providers returned in our runs (docs/eval-results.md, eval reports). */
const REAL: Array<[string, string, FailureClass]> = [
  ["503 too busy", "[Model Error] Request failed (503): Service is too busy. We advise users to temporarily switch to alternative LLM API service providers. (request_id: e0b9b317-b257-4b73-8ce7-cfddd68ef113)", "transient"],
  ["503 high demand", "[Model Error] Request failed (503): This model is currently experiencing high demand. Spikes in demand are usually temporary. Please try again later.", "transient"],
  ["500", "[Model Error] Request failed (500): Internal Server Error (request_id: 23fed3a0-e1e4-4fdb-9468-dcb02ee0cc4c)", "transient"],
  ["429", "[Model Error] Request failed (429): Rate limit reached for gpt-oss-120b (TPM)", "transient"],
  ["terminated", "terminated", "transient"],
  ["stream ended", "[Model Error] Response stream ended without a finish reason.", "transient"],
  ["socket reset", "read ECONNRESET", "transient"],
  ["timeout", "Request timed out", "transient"],
  ["400 api key", "[Model Error] Request failed (400): API key not valid. Please pass a valid API key.", "auth"],
  ["401", "[Model Error] Request failed (401): Incorrect API key provided", "auth"],
  ["403", "[Model Error] Request failed (403): permission denied", "auth"],
  ["cannot connect", "[Model Error] Cannot connect to API: connect ECONNREFUSED 127.0.0.1:9", "unreachable"],
  ["cannot connect (bad port)", "Cannot connect to API: bad port", "unreachable"],
  ["dns", "[Model Error] getaddrinfo ENOTFOUND api.example.invalid", "unreachable"],
  ["tool error", "propose_edit: old_text not found in file", "fatal"],
  ["agent error", "Agent needs input of a type Forge doesn't support yet: tool.response_required", "fatal"],
  ["bad request", "[Model Error] Request failed (400): messages: text content blocks must be non-empty", "fatal"],
];

describe("failure classification (real error strings)", () => {
  it.each(REAL)("%s", (_name, message, expected) => {
    expect(classifyFailure({ message, source: "turn" }).class).toBe(expected);
  });
  it("the watchdog is always a stall", () => {
    expect(classifyFailure({ message: "no event for 45 s", source: "watchdog" }).class).toBe("stall");
  });
  it("our own request to TrueForge failing is 'TrueForge down', never a model failure", () => {
    for (const m of ["fetch failed", "connect ECONNREFUSED 127.0.0.1:8790", "TrueForge is not reachable at http://localhost:8790", "socket hang up"]) {
      const f = classifyFailure({ message: m, source: "transport" });
      expect(f.class).toBe("trueforge-down");
      expect(isModelFailure(f.class)).toBe(false);
    }
    // an HTTP error answered BY TrueForge is classified by its content
    expect(classifyFailure({ message: "HTTP 422: thread main: no pending approval", source: "transport" }).class).toBe("fatal");
    expect(classifyFailure({ message: "HTTP 503: Service Unavailable", source: "transport" }).class).toBe("transient");
  });
  it("only transient / unreachable / auth / stall are model failures", () => {
    expect((["transient", "unreachable", "auth", "stall"] as const).every(isModelFailure)).toBe(true);
    expect(isModelFailure("fatal")).toBe(false);
    expect(isModelFailure("trueforge-down")).toBe(false);
  });
  it("shortReason is readable and secret-free", () => {
    expect(shortReason(REAL[0]![1])).toBe("503: too busy");
    expect(shortReason(REAL[1]![1])).toBe("503: high demand");
    expect(shortReason(REAL[2]![1])).toBe("500: internal error");
    expect(shortReason(REAL[8]![1])).toBe("400: api key not valid");
    expect(shortReason(REAL[11]![1])).toBe("connection refused");
    expect(shortReason(REAL[0]![1])).not.toContain("request_id");
  });
});

const rec = (model: string, klass: FailureClass, message = "x"): AttemptRecord => ({ model, failure: { class: klass, message } });
const MODELS = ["m1", "m2", "m3"];
const fixed = (v: number) => () => v;

describe("retry / advance policy", () => {
  it("transient: retries the same model twice with 500 ms then 1.5 s (jitter +-20 %), then advances", () => {
    const h: AttemptRecord[] = [rec("m1", "transient")];
    expect(planNext(h, MODELS, fixed(0.5))).toEqual({ kind: "retry", model: "m1", delayMs: 500 });
    h.push(rec("m1", "transient"));
    expect(planNext(h, MODELS, fixed(0.5))).toEqual({ kind: "retry", model: "m1", delayMs: 1500 });
    h.push(rec("m1", "transient"));
    expect(planNext(h, MODELS)).toEqual({ kind: "advance", model: "m2" });
  });
  it("jitter stays within +-20 %", () => {
    expect(backoffDelay(1, fixed(0))).toBe(400);
    expect(backoffDelay(1, fixed(0.999))).toBeGreaterThanOrEqual(598);
    expect(backoffDelay(2, fixed(0))).toBe(1200);
    expect(backoffDelay(2, fixed(0.999))).toBeGreaterThanOrEqual(1798);
  });
  it("unreachable and auth never retry: they advance immediately", () => {
    expect(planNext([rec("m1", "unreachable")], MODELS)).toEqual({ kind: "advance", model: "m2" });
    expect(planNext([rec("m1", "auth")], MODELS)).toEqual({ kind: "advance", model: "m2" });
  });
  it("stall: one retry, then advance", () => {
    expect(planNext([rec("m1", "stall")], MODELS, fixed(0.5))).toMatchObject({ kind: "retry", model: "m1" });
    expect(planNext([rec("m1", "stall"), rec("m1", "stall")], MODELS)).toEqual({ kind: "advance", model: "m2" });
  });
  it("skips later models that already failed unreachable/auth and stops when the chain is exhausted", () => {
    expect(planNext([rec("m3", "unreachable"), rec("m1", "unreachable")], MODELS)).toEqual({ kind: "advance", model: "m2" });
    expect(planNext([rec("m1", "unreachable"), rec("m2", "auth"), rec("m3", "unreachable")], MODELS)).toEqual({ kind: "stop", reason: "exhausted" });
    expect(planNext([rec("only", "unreachable")], ["only"])).toEqual({ kind: "stop", reason: "exhausted" });
  });
  it("fatal errors and TrueForge being down never fall back", () => {
    expect(planNext([rec("m1", "fatal")], MODELS)).toEqual({ kind: "stop", reason: "not-a-model-failure" });
    expect(planNext([rec("m1", "trueforge-down")], MODELS)).toEqual({ kind: "stop", reason: "trueforge-down" });
    expect(planNext([], MODELS)).toEqual({ kind: "stop", reason: "not-a-model-failure" });
  });
  it("total attempts are bounded (no infinite loops)", () => {
    const many = Array.from({ length: MAX_TOTAL_ATTEMPTS }, (_, i) => rec(`m${(i % 3) + 1}`, "transient"));
    expect(planNext(many, MODELS)).toEqual({ kind: "stop", reason: "too-many-attempts" });
    // worst case walk: simulate the policy until it stops; it must terminate within the bound
    const h: AttemptRecord[] = [];
    let model = "m1";
    for (let i = 0; i < 50; i++) {
      h.push(rec(model, "transient"));
      const n = planNext(h, MODELS, fixed(0));
      if (n.kind === "stop") break;
      model = n.model;
    }
    expect(h.length).toBeLessThanOrEqual(MAX_TOTAL_ATTEMPTS);
  });
});

describe("messages", () => {
  it("switched / retrying notices", () => {
    expect(switchedMessage(rec("deepseek/flash", "unreachable", "[Model Error] Cannot connect to API: connect ECONNREFUSED"), "deepseek/v4-pro", 2100)).toBe(
      "deepseek/flash unreachable (connection refused) -> switched to deepseek/v4-pro (after 2.1 s)",
    );
    expect(retryingMessage("deepseek/flash", 1500, { class: "transient", message: REAL[1]![1] })).toBe("Retrying deepseek/flash in 1.5 s (503: high demand)");
  });
  it("switch notice shows milliseconds under one second", () => {
    expect(switchedMessage(rec("a/x", "unreachable", "[Model Error] Cannot connect to API: connect ECONNREFUSED"), "b/y", 39)).toBe("a/x unreachable (connection refused) -> switched to b/y (after 39 ms)");
  });
  it("exhausted message names each model with its class and gives the hint", () => {
    const text = exhaustedMessage([rec("a/x", "unreachable", REAL[11]![1]), rec("b/y", "transient", REAL[0]![1]), rec("b/y", "transient", REAL[0]![1])], ["a/x", "b/y", "c/z"]);
    expect(text).toContain("a/x (unreachable: connection refused)");
    expect(text).toContain("b/y (transient, 2 attempts: 503: too busy)");
    expect(text).toContain("c/z: not tried");
    expect(text).toMatch(/Check Settings -> Models in TrueForge.*forge\.models/);
  });
  it("side-effect message lists what was applied and offers Undo run", () => {
    const text = sideEffectsMessage("m1", { class: "transient", message: REAL[0]![1] }, { files: ["src/flask/cli.py"], commands: ["pytest -q"] });
    expect(text).toContain("applied 1 file (src/flask/cli.py) and ran 1 command (pytest -q)");
    expect(text).toContain("did not replay");
    expect(text).toContain("Undo run");
    expect(sideEffectsMessage("m1", { class: "transient", message: "x" }, { files: [], commands: ["ls"] })).not.toContain("Undo run");
  });
  it("promoteModel puts the choice first without duplicates", () => {
    expect(promoteModel(["a", "b", "c"], "c")).toEqual(["c", "a", "b"]);
    expect(promoteModel(["a", "b"], "z")).toEqual(["z", "a", "b"]);
    expect(promoteModel(["a", "b"], "a")).toEqual(["a", "b"]);
  });
});
