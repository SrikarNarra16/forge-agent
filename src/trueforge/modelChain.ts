/**
 * ModelChain: classification of model failures and the retry/advance policy over forge.models. Pure and
 * vscode-free: the clock, the random source and sleeping are injected by the caller. The controller runs the
 * attempts; this file decides what a failure means and what happens next. Fallback always means "the same turn
 * in a fresh TrueForge session on the next model"; no provider is ever called directly.
 */

export type FailureClass =
  /** 429, 5xx, "too busy / high demand", a dropped stream: worth retrying the same model. */
  | "transient"
  /** The model's endpoint cannot be reached ("Cannot connect to API", connection refused): retrying will not help. */
  | "unreachable"
  /** 401/403, "API key not valid": retrying will not help. */
  | "auth"
  /** No stream progress within the watchdog limits. */
  | "stall"
  /** Anything else (agent or tool errors, unsupported pauses): NOT a model failure, never falls back. */
  | "fatal"
  /** TrueForge itself cannot be reached: stop and say so, no fallback. */
  | "trueforge-down";

/** Where the error text came from: TrueForge reporting a model problem, or our own call to TrueForge failing. */
export type FailureSource = "turn" | "transport" | "watchdog";

export interface Failure {
  class: FailureClass;
  /** The error text TrueForge returned (secret-free, as shown to the user). */
  message: string;
}

const AUTH = /\b(?:401|403)\b|API key not valid|invalid[\s_-]*(?:api[\s_-]*)?key|incorrect api key|unauthori[sz]ed|authentication (?:failed|error)|permission denied/i;
const UNREACHABLE = /Cannot connect to API|ECONNREFUSED|ENOTFOUND|EAI_AGAIN|getaddrinfo|connection refused|No route to host|unable to connect|dns/i;
const TRANSIENT = /Request failed \((?:5\d\d|429)\)|\b(?:429|500|502|503|504|529)\b|too busy|high demand|overloaded|rate.?limit|try again|temporarily|^terminated$|stream ended without a finish reason|ECONNRESET|socket hang up|other side closed|UND_ERR|ETIMEDOUT|timed? ?out|connection (?:closed|reset|error)/i;
const TRUEFORGE_DOWN = /fetch failed|ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|socket hang up|Failed to fetch|network error|TrueForge is not reachable/i;

/** One-line reason for notices: "503: high demand", "connection refused", "API key not valid". */
export function shortReason(message: string): string {
  const flat = message.replace(/^\[Model Error\]\s*/i, "").replace(/\s*\(request_id:[^)]*\)/gi, "").replace(/\s+/g, " ").trim();
  const status = /Request failed \((\d{3})\)/.exec(flat);
  if (status) {
    const rest = flat.replace(/^Request failed \(\d{3}\):?\s*/, "");
    const first = /high demand|too busy|overloaded|Internal Server Error|rate.?limit|API key not valid/i.exec(rest)?.[0] ?? rest.split(/[.:]/)[0] ?? "";
    return `${status[1]}${first ? `: ${first.toLowerCase().replace(/^internal server error$/, "internal error")}` : ""}`;
  }
  if (/Cannot connect to API/i.test(flat)) return /refused|ECONNREFUSED|bad port/i.test(flat) ? "connection refused" : "cannot connect";
  return flat.length > 70 ? `${flat.slice(0, 69)}…` : flat;
}

/**
 * Classifies a failure. `turn` errors come from TrueForge's turn.done / stream and describe the model call;
 * `transport` errors are our own request to TrueForge failing; `watchdog` is the stall timer.
 */
export function classifyFailure(input: { message: string; source: FailureSource }): Failure {
  const { message, source } = input;
  if (source === "watchdog") return { class: "stall", message };
  if (source === "transport") {
    // TrueForge itself not answering (no HTTP status in the error text) is not the model's fault
    if (/\bHTTP (?:4\d\d|5\d\d)\b|Request failed \(\d{3}\)/.test(message)) return classifyFailure({ message, source: "turn" });
    return TRUEFORGE_DOWN.test(message) ? { class: "trueforge-down", message } : { class: "fatal", message };
  }
  if (AUTH.test(message)) return { class: "auth", message };
  if (UNREACHABLE.test(message)) return { class: "unreachable", message };
  if (TRANSIENT.test(message)) return { class: "transient", message };
  return { class: "fatal", message };
}

/** True for failure classes that are about the model/provider (the only ones that may retry or fall back). */
export function isModelFailure(c: FailureClass): boolean {
  return c === "transient" || c === "unreachable" || c === "auth" || c === "stall";
}

export const RETRY_BACKOFF_MS: readonly number[] = [500, 1500];
export const MAX_TRANSIENT_RETRIES = 2;
export const MAX_STALL_RETRIES = 1;
export const MAX_TOTAL_ATTEMPTS = 8;
export const JITTER = 0.2;

export interface AttemptRecord {
  model: string;
  failure: Failure;
}

export type NextStep =
  | { kind: "retry"; model: string; delayMs: number }
  | { kind: "advance"; model: string }
  | { kind: "stop"; reason: "exhausted" | "not-a-model-failure" | "trueforge-down" | "too-many-attempts" };

/** Backoff with +-20 % jitter; `random()` is in [0,1). */
export function backoffDelay(retryNumber: number, random: () => number): number {
  const base = RETRY_BACKOFF_MS[Math.min(retryNumber, RETRY_BACKOFF_MS.length) - 1] ?? RETRY_BACKOFF_MS[RETRY_BACKOFF_MS.length - 1] ?? 1500;
  return Math.round(base * (1 - JITTER + 2 * JITTER * random()));
}

/**
 * What to do after the latest failed attempt. `history` holds every failed attempt so far (the latest last).
 * transient -> same model up to 2 times (500 ms, 1.5 s); unreachable and auth -> advance at once;
 * stall -> one retry, then advance; fatal / TrueForge down -> stop (no fallback). Bounded by MAX_TOTAL_ATTEMPTS.
 */
export function planNext(history: readonly AttemptRecord[], models: readonly string[], random: () => number = Math.random): NextStep {
  const last = history[history.length - 1];
  if (!last) return { kind: "stop", reason: "not-a-model-failure" };
  if (last.failure.class === "trueforge-down") return { kind: "stop", reason: "trueforge-down" };
  if (!isModelFailure(last.failure.class)) return { kind: "stop", reason: "not-a-model-failure" };
  if (history.length >= MAX_TOTAL_ATTEMPTS) return { kind: "stop", reason: "too-many-attempts" };

  const sameModel = history.filter((h) => h.model === last.model);
  const sameClass = sameModel.filter((h) => h.failure.class === last.failure.class).length;
  if (last.failure.class === "transient" && sameClass <= MAX_TRANSIENT_RETRIES) return { kind: "retry", model: last.model, delayMs: backoffDelay(sameClass, random) };
  if (last.failure.class === "stall" && sameClass <= MAX_STALL_RETRIES) return { kind: "retry", model: last.model, delayMs: backoffDelay(1, random) };

  const index = models.indexOf(last.model);
  const next = models.slice(index + 1).find((m) => !history.some((h) => h.model === m && (h.failure.class === "unreachable" || h.failure.class === "auth")));
  return next ? { kind: "advance", model: next } : { kind: "stop", reason: "exhausted" };
}

/** "deepseek/flash unreachable (connection refused) -> switched to deepseek/v4-pro (after 2.1 s)" */
export function switchedMessage(from: AttemptRecord, to: string, afterMs: number): string {
  return `${from.model} ${describeClass(from.failure.class)} (${shortReason(from.failure.message)}) -> switched to ${to} (after ${afterMs < 1000 ? `${Math.round(afterMs)} ms` : `${(afterMs / 1000).toFixed(1)} s`})`;
}

/** "Retrying deepseek/flash in 1.5 s (503: high demand)" */
export function retryingMessage(model: string, delayMs: number, failure: Failure): string {
  return `Retrying ${model} in ${(delayMs / 1000).toFixed(1)} s (${shortReason(failure.message)})`;
}

export function describeClass(c: FailureClass): string {
  switch (c) {
    case "transient":
      return "failed";
    case "unreachable":
      return "unreachable";
    case "auth":
      return "rejected the API key";
    case "stall":
      return "stopped responding";
    case "fatal":
      return "failed";
    case "trueforge-down":
      return "TrueForge unreachable";
  }
}

/** Final error when no model could answer: names each model and its failure class, with an actionable hint. */
export function exhaustedMessage(history: readonly AttemptRecord[], models: readonly string[]): string {
  const lines = models.map((model) => {
    const attempts = history.filter((h) => h.model === model);
    const last = attempts[attempts.length - 1];
    if (!last) return `${model}: not tried`;
    const times = attempts.length > 1 ? `, ${attempts.length} attempts` : "";
    return `${model} (${last.failure.class}${times}: ${shortReason(last.failure.message)})`;
  });
  return `No model could answer. ${lines.join("; ")}. Check Settings -> Models in TrueForge (is the provider reachable and the API key valid?) and the forge.models setting.`;
}

/** Message when the failed attempt already changed something, so replaying it would be unsafe. */
export function sideEffectsMessage(model: string, failure: Failure, effects: { files: readonly string[]; commands: readonly string[] }): string {
  const parts = [
    effects.files.length > 0 ? `applied ${effects.files.length} file${effects.files.length === 1 ? "" : "s"} (${effects.files.join(", ")})` : "",
    effects.commands.length > 0 ? `ran ${effects.commands.length} command${effects.commands.length === 1 ? "" : "s"} (${effects.commands.map((c) => (c.length > 40 ? `${c.slice(0, 39)}…` : c)).join("; ")})` : "",
  ].filter(Boolean);
  return `${model} failed (${shortReason(failure.message)}) after Forge had already ${parts.join(" and ")}. Forge did not replay the request on another model because that could repeat those changes. ${effects.files.length > 0 ? "Use Undo run to restore the files, or send your request again." : "Send your request again to continue."}`;
}

/** Moves `chosen` to the front of the model list (Forge: Switch Model); keeps the rest in order, without duplicates. */
export function promoteModel(models: readonly string[], chosen: string): string[] {
  return [chosen, ...models.filter((m) => m !== chosen)];
}

export interface ChainEvent {
  kind: "retrying" | "switched" | "exhausted" | "blocked" | "trueforge-down";
  model: string;
  text: string;
  /** For `switched`: time from the first failure to the switch. */
  afterMs?: number;
}
