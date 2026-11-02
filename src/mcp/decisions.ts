import { createHash } from "node:crypto";

/**
 * DecisionStore: what the user decided for a propose_edit / create_file call. The extension applies the
 * accepted hunks inside the ApprovalHandler (when the review finishes) and records a decision here; the MCP
 * tool then only looks the decision up and reports it to the agent. The tools never write.
 *
 * Decisions are keyed by `decisionKey(tool, args)` and kept in a FIFO queue per key, so two identical
 * calls each get their own decision. Pure and vscode-free.
 */

export interface EditDecision {
  path: string;
  kind: "edit" | "create";
  applied: number;
  total: number;
  added: number;
  removed: number;
  /** Short summaries of the hunks that were NOT written (rejected or undecided). */
  rejected: string[];
}

/** JSON with object keys sorted recursively, so equal values always serialise identically. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => [k, sortKeys(v)]));
  }
  return value;
}

/** Stable key for a tool call: sha256 of the tool name and the canonical JSON of its (schema-parsed) arguments. */
export function decisionKey(tool: string, args: unknown): string {
  return createHash("sha256").update(`${tool}\n${canonicalJson(args)}`).digest("hex");
}

export const DECISION_TTL_MS = 30 * 60 * 1000;

interface Stored {
  decision: EditDecision;
  at: number;
}

export class DecisionStore {
  private readonly queues = new Map<string, Stored[]>();

  constructor(private readonly ttlMs = DECISION_TTL_MS) {}

  put(key: string, decision: EditDecision, now = Date.now()): void {
    const queue = this.queues.get(key) ?? [];
    queue.push({ decision, at: now });
    this.queues.set(key, queue);
  }

  /** Removes and returns the oldest unexpired decision for the key. */
  take(key: string, now = Date.now()): EditDecision | undefined {
    const queue = this.queues.get(key);
    if (!queue) return undefined;
    while (queue.length > 0) {
      const next = queue.shift();
      if (next && now - next.at <= this.ttlMs) {
        if (queue.length === 0) this.queues.delete(key);
        return next.decision;
      }
    }
    this.queues.delete(key);
    return undefined;
  }

  /** Drops everything (a new user request starts; leftovers belong to an abandoned run). */
  clear(): void {
    this.queues.clear();
  }

  get size(): number {
    let n = 0;
    for (const q of this.queues.values()) n += q.length;
    return n;
  }
}
