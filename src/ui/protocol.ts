import type { RunState } from "../trueforge/runState";

/**
 * Typed message protocol between the extension and the Agent panel webview. Pure and DOM-free so both
 * TypeScript projects (extension, webview) can import it. Messages from the webview are untrusted and
 * must go through `parseWebMessage`.
 */

export type { RunState };

/** Mirrors ToolCallStatus in src/trueforge/events.ts (checked by test/uiModel.test.ts). */
export type ToolStatus = "running" | "awaiting_approval" | "done" | "denied";

export type ApprovalState = "pending" | "allowed" | "denied";

/** Mirrors ReviewState in src/review/tracker.ts (checked in transcript.ts). */
export type ReviewState = "queued" | "reviewing" | "applied" | "rejected" | "failed" | "cancelled";

/** A propose_edit / create_file call going through the diff review. */
export interface ReviewItemInfo {
  path: string;
  summary: string;
  kind: "edit" | "create";
  state: ReviewState;
  hunks?: number;
  applied?: number;
  detail?: string;
}

export interface ReviewQueueEntry extends ReviewItemInfo {
  callId: string;
}

export type ChatItem =
  | { kind: "user"; id: string; text: string }
  | { kind: "assistant"; id: string; text: string; streaming: boolean; subagent?: string }
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
      approval?: ApprovalState;
      /** Present for propose_edit / create_file: the card shows "Review diff" instead of Allow/Deny. */
      review?: ReviewItemInfo;
    }
  | { kind: "notice"; id: string; level: "info" | "warning" | "error"; text: string };

export interface StatusInfo {
  state: RunState;
  model?: string;
  detail?: string;
  /** Context compaction is in progress. */
  compacting?: boolean;
  /** A run changed files and can be rolled back ("Undo run"). */
  canUndo?: boolean;
}

export type ExtToWeb =
  | { type: "init"; items: ChatItem[]; status: StatusInfo }
  | { type: "upsert"; items: ChatItem[] }
  | { type: "status"; status: StatusInfo }
  | { type: "review"; entries: ReviewQueueEntry[] }
  | { type: "reset" };

export type WebToExt =
  | { type: "ready" }
  | { type: "send"; text: string }
  | { type: "stop" }
  | { type: "newChat" }
  | { type: "undoRun" }
  | { type: "openReview"; callId: string }
  | { type: "approval"; callId: string; decision: "allow" | "deny"; reason?: string };

const MAX_TEXT = 50_000;
const MAX_ID = 300;
const MAX_REASON = 1_000;

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
      return { type: data["type"] };
    case "openReview": {
      const callId = data["callId"];
      if (typeof callId !== "string" || callId === "" || callId.length > MAX_ID) return undefined;
      return { type: "openReview", callId };
    }
    case "send": {
      const text = data["text"];
      if (typeof text !== "string" || text.trim() === "" || text.length > MAX_TEXT) return undefined;
      return { type: "send", text };
    }
    case "approval": {
      const { callId, decision, reason } = data;
      if (typeof callId !== "string" || callId === "" || callId.length > MAX_ID) return undefined;
      if (decision !== "allow" && decision !== "deny") return undefined;
      if (reason !== undefined && (typeof reason !== "string" || reason.length > MAX_REASON)) return undefined;
      return { type: "approval", callId, decision, ...(reason !== undefined ? { reason } : {}) };
    }
    default:
      return undefined;
  }
}
