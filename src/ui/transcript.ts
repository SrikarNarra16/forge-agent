import { commandOf } from "../trueforge/commandApprovals";
import type { ReducerChange, ThreadInfo, ToolCallInfo, TurnView } from "../trueforge/events";
import type { ReviewState as TrackerReviewState } from "../review/tracker";
import type { ApprovalState, ChatItem, ReviewItemInfo, ReviewState, ToolStatus } from "./protocol";

/**
 * Transcript: the conversation as UI items (user messages, assistant text, tool cards, notices), built
 * from reducer views. Pure and vscode-free. Items keep the order in which they first appeared; applying a
 * turn returns only the items that changed so they can be batched to the webview.
 */

// Compile-time guard: the UI's tool status union must match the reducer's.
type Same<A, B> = [A] extends [B] ? ([B] extends [A] ? true : never) : never;
export const _toolStatusMatches: Same<ToolStatus, ToolCallInfo["status"]> = true;
export const _reviewStateMatches: Same<ReviewState, TrackerReviewState> = true;

const MAX_SUMMARY_VALUE = 48;
const MAX_SUMMARY = 110;
const MAX_PREVIEW = 400;

function clip(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** `{"path":"a.py","why":"look"}` -> `path="a.py" why="look"`; non-JSON falls back to clipped raw text. */
export function summarizeArgs(args: string): string {
  if (args.trim() === "") return "";
  try {
    const parsed: unknown = JSON.parse(args);
    if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
      const parts = Object.entries(parsed).map(([k, v]) => `${k}=${typeof v === "string" ? JSON.stringify(clip(v, MAX_SUMMARY_VALUE)) : clip(JSON.stringify(v) ?? "", MAX_SUMMARY_VALUE)}`);
      return clip(parts.join(" "), MAX_SUMMARY);
    }
  } catch {
    // not JSON (or still streaming): show the raw text
  }
  return clip(args, MAX_SUMMARY);
}

export function prettyArgs(args: string): string {
  try {
    return JSON.stringify(JSON.parse(args), null, 2);
  } catch {
    return args;
  }
}

export class Transcript {
  private list: ChatItem[] = [];
  private readonly positions = new Map<string, number>();
  /** Tool calls that went through an approval prompt, so a later non-pending status reads as "allowed". */
  private readonly gated = new Set<string>();
  /** Review info by tool call id, attached to the tool card (it may arrive before or after the card exists). */
  private readonly reviews = new Map<string, ReviewItemInfo>();
  private noticeCounter = 0;
  private userCounter = 0;

  get items(): readonly ChatItem[] {
    return this.list;
  }

  clear(): void {
    this.list = [];
    this.positions.clear();
    this.gated.clear();
    this.reviews.clear();
  }

  /** Attaches (or removes) the review info of a tool call; returns the updated card if it exists. */
  setReview(id: string, review: ReviewItemInfo | undefined): ChatItem | undefined {
    if (review) this.reviews.set(id, review);
    else this.reviews.delete(id);
    const item = this.find(id);
    if (!item || item.kind !== "tool") return undefined;
    const { review: _old, ...rest } = item;
    return this.upsert(review ? { ...rest, review } : rest);
  }

  addUser(text: string): ChatItem {
    return this.upsert({ kind: "user", id: `user-${++this.userCounter}`, text });
  }

  addNotice(level: "info" | "warning" | "error", text: string): ChatItem {
    return this.upsert({ kind: "notice", id: `notice-${++this.noticeCounter}`, level, text });
  }

  /** Inserts or replaces an item (used for the debug approval card). */
  upsert(item: ChatItem): ChatItem {
    const at = this.positions.get(item.id);
    if (at === undefined) {
      this.positions.set(item.id, this.list.length);
      this.list.push(item);
    } else {
      this.list[at] = item;
    }
    return item;
  }

  find(id: string): ChatItem | undefined {
    const at = this.positions.get(id);
    return at === undefined ? undefined : this.list[at];
  }

  /** Applies a reducer view; returns the items that were created or changed. */
  applyTurn(view: TurnView, change: ReducerChange): ChatItem[] {
    const threads = new Map(view.threads.map((t) => [t.id, t]));
    const changed: ChatItem[] = [];
    const subagentOf = (threadId: string): string | undefined => (threadId === "main" ? undefined : threadLabel(threads.get(threadId), threadId));

    // Messages: render when they have text (a message that only carries tool calls has nothing to show).
    for (const id of change.messages) {
      const message = view.messages.find((m) => m.id === id);
      if (!message) continue;
      const existing = this.find(id);
      if (message.text === "" && !existing) continue;
      const subagent = subagentOf(message.threadId);
      changed.push(this.upsert({ kind: "assistant", id, text: message.text, streaming: !message.complete, ...(subagent ? { subagent } : {}) }));
    }

    // Tool calls
    const touched = new Set(change.toolCalls);
    // A subagent thread finishing/starting relabels its items; refresh tool cards of changed threads too.
    for (const threadId of change.threads) for (const call of view.toolCalls) if (call.threadId === threadId) touched.add(call.id);
    for (const id of touched) {
      const call = view.toolCalls.find((c) => c.id === id);
      if (!call) continue;
      changed.push(this.upsert(this.toolItem(call, subagentOf(call.threadId))));
    }
    return changed;
  }

  /** Sets the approval state of a tool card (used for the debug card and optimistic UI). */
  setApproval(id: string, approval: ApprovalState, status?: ToolStatus): ChatItem | undefined {
    const item = this.find(id);
    if (!item || item.kind !== "tool") return undefined;
    return this.upsert({ ...item, approval, ...(status ? { status } : {}) });
  }

  private toolItem(call: ToolCallInfo, subagent: string | undefined): ChatItem {
    if (call.status === "awaiting_approval") this.gated.add(call.id);
    const review = this.reviews.get(call.id);
    const approval: ApprovalState | undefined =
      call.status === "awaiting_approval" ? "pending" : call.status === "denied" ? "denied" : this.gated.has(call.id) ? "allowed" : undefined;
    return {
      kind: "tool",
      id: call.id,
      name: call.name,
      argsSummary: summarizeArgs(call.args),
      args: prettyArgs(call.args),
      status: call.status,
      ...(call.response !== undefined ? { resultPreview: clip(call.response, MAX_PREVIEW) } : {}),
      ...(call.durationMs !== undefined ? { durationMs: call.durationMs } : {}),
      ...(subagent ? { subagent } : {}),
      ...(approval ? { approval } : {}),
      ...(review ? { review } : {}),
      ...(call.name === "run_command" && commandOf(call.args) !== undefined ? { command: commandOf(call.args) as string } : {}),
    };
  }
}

function threadLabel(thread: ThreadInfo | undefined, fallback: string): string {
  return clip(thread?.title || `subagent ${fallback.slice(-6)}`, 40);
}
