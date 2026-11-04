import type { ContextViewState } from "../context/view";
import type { RunState } from "../trueforge/runState";

/**
 * Typed message protocol between the extension and the Agent panel webview. Pure and DOM-free so both
 * TypeScript projects (extension, webview) can import it. Messages from the webview are untrusted and
 * must go through `parseWebMessage`.
 */

export type { RunState };
export type { ContextViewPlan, ContextViewRead, ContextViewRun, ContextViewState, ContextViewItem } from "../context/view";

/** A file or symbol the user pinned with @. */
export interface MentionRef {
  kind: "file" | "symbol";
  value: string;
}

export interface MentionSuggestionInfo extends MentionRef {
  /** Extra text for the list, e.g. "src/flask/cli.py:594" for a symbol. */
  detail?: string;
}

/** Mirrors ToolCallStatus in src/trueforge/events.ts (checked by test/uiModel.test.ts). */
export type ToolStatus = "running" | "awaiting_approval" | "done" | "denied";

export type ApprovalState = "pending" | "allowed" | "denied";

/** Mirrors ReviewState in src/review/tracker.ts (checked in transcript.ts). */
export type ReviewState = "queued" | "reviewing" | "applying" | "applied" | "rejected" | "failed" | "cancelled";

/** A propose_edit / create_file call going through the diff review. */
export interface ReviewItemInfo {
  path: string;
  summary: string;
  kind: "edit" | "create";
  state: ReviewState;
  hunks?: number;
  applied?: number;
  /** While reviewing: hunks accepted / rejected so far; undecided = hunks - accepted - rejected. */
  accepted?: number;
  rejected?: number;
  detail?: string;
}

export interface ReviewQueueEntry extends ReviewItemInfo {
  callId: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; subagent?: string; thread?: string }
  | {
      kind: "tool";
      id: string;
      name: string;
      /** One-line summary of the arguments, e.g. path="src/a.py" why="check parsing". */
      argsSummary: string;
      /** Pretty-printed full arguments for the expanded card. */
      args: string;
      status: ToolStatus;
      resultPreview?: string;
      durationMs?: number;
      subagent?: string;
      /** Id of the subagent thread this call ran in (absent for the root agent). */
      thread?: string;
      approval?: ApprovalState;
      /** run_command: the exact command, shown in a code block on the approval card. */
      command?: string;
      /** run_command allowed without asking by forge.autoAllowCommands: tier 1 (read-only) or 2 (tests). */
      autoAllowed?: 1 | 2;
      /** Present for propose_edit / create_file: the card shows "Review diff" instead of Allow/Deny. */
      review?: ReviewItemInfo;
    }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string }
  /** A subagent run: a collapsible block that holds the messages and tool calls of its thread. */
  | { kind: "subagent"; id: string; thread: string; title: string; state: "running" | "done" | "error" }
  /** A horizontal divider such as "Context compacted". */
  | { kind: "divider"; id: string; text: string };

export interface StatusInfo {
  state: RunState;
  model?: string;
  detail?: string;
  /** Context compaction is in progress. */
  compacting?: boolean;
  /** A run changed files and can be rolled back ("Undo run"). */
  canUndo?: boolean;
  /** TrueForge session of the current run (the "Open in TrueForge" button links to it). */
  sessionId?: string;
}

export type ExtToWeb =
  | { type: "init"; items: ChatItem[]; status: StatusInfo }
  | { type: "upsert"; items: ChatItem[] }
  /** Items to delete (a failed attempt that is being replayed on another model). */
  | { type: "remove"; ids: string[] }
  | { type: "status"; status: StatusInfo }
  | { type: "review"; entries: ReviewQueueEntry[] }
  | { type: "context"; state: ContextViewState }
  | { type: "mentionResults"; id: number; results: MentionSuggestionInfo[] }
  | { type: "reset" };

export type WebToExt =
  | { type: "ready" }
  | { type: "send"; text: string; mentions?: MentionRef[] }
  | { type: "mentionQuery"; id: number; kind: "file" | "symbol"; query: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "undoRun" }
  | { type: "openReview"; callId: string }
  /** Panel buttons of a pending review: the same as Cmd+Enter / the CodeLens (forge.reviewApply / forge.reviewRejectAll). */
  | { type: "reviewApply"; callId: string }
  | { type: "reviewRejectAll"; callId: string }
  /** Accept every undecided hunk, then apply (forge.reviewAcceptPending + forge.reviewApply). */
  | { type: "reviewAcceptAllApply"; callId: string }
  | { type: "openTrueForge" }
  | { type: "approval"; callId: string; decision: "allow" | "deny"; reason?: string; allowThisRun?: boolean };

const MAX_TEXT = 50_000;
const MAX_ID = 300;
const MAX_REASON = 1_000;
const MAX_MENTIONS = 20;
const MAX_MENTION_VALUE = 300;
const MAX_QUERY = 200;

function parseMentionRefs(value: unknown): MentionRef[] | undefined {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > MAX_MENTIONS) return undefined;
  const out: MentionRef[] = [];
  for (const item of value as unknown[]) {
    if (!isRecord(item)) return undefined;
    const { kind, value: v } = item;
    if ((kind !== "file" && kind !== "symbol") || typeof v !== "string" || v === "" || v.length > MAX_MENTION_VALUE) return undefined;
    out.push({ kind, value: v });
  }
  return out;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Validates a message received from the webview; returns undefined for anything malformed. */
export function parseWebMessage(data: unknown): WebToExt | undefined {
  if (!isRecord(data) || typeof data["type"] !== "string") return undefined;
  switch (data["type"]) {
    case "ready":
    case "stop":
    case "newChat":
    case "undoRun":
    case "openTrueForge":
      return { type: data["type"] };
    case "openReview":
    case "reviewApply":
    case "reviewRejectAll":
    case "reviewAcceptAllApply": {
      const callId = data["callId"];
      if (typeof callId !== "string" || callId === "" || callId.length > MAX_ID) return undefined;
      return { type: data["type"], callId };
    }
    case "send": {
      const text = data["text"];
      if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT) return undefined;
      const mentions = parseMentionRefs(data["mentions"]);
      if (!mentions) return undefined;
      return { type: "send", text, ...(mentions.length > 0 ? { mentions } : {}) };
    }
    case "mentionQuery": {
      const { id, kind, query } = data;
      if (typeof id !== "number" || !Number.isInteger(id) || id < 0) return undefined;
      if (kind !== "file" && kind !== "symbol") return undefined;
      if (typeof query !== "string" || query.length > MAX_QUERY) return undefined;
      return { type: "mentionQuery", id, kind, query };
    }
    case "approval": {
      const { callId, decision, reason, allowThisRun } = data;
      if (allowThisRun !== undefined && typeof allowThisRun !== "boolean") return undefined;
      if (typeof callId !== "string" || callId === "" || callId.length > MAX_ID) return undefined;
      if (decision !== "allow" && decision !== "deny") return undefined;
      if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON)) return undefined;
      return { type: "approval", callId, decision, ...(reason !== undefined ? { reason } : {}), ...(allowThisRun === true ? { allowThisRun } : {}) };
    }
    default:
      return undefined;
  }
}
