import type { ChatItem } from "../protocol";

/**
 * Pure view-model helpers for the Agent panel (no DOM), so they can be unit-tested: the Review block
 * header and what a tool card shows. render.ts turns these into elements.
 */

/** "Review (2 changes in 1 file)": counts changes AND distinct files, so two edits to one file read correctly. */
export function reviewHeader(entries: ReadonlyArray<{ path: string }>): string {
  const changes = entries.length;
  const files = new Set(entries.map((e) => e.path)).size;
  return `Review (${changes} ${changes === 1 ? "change" : "changes"} in ${files} ${files === 1 ? "file" : "files"})`;
}

/** The decisions of a review in progress. Undecided = not accepted and not rejected; they count as rejected on Apply. */
export interface ReviewDecisions {
  hunks: number;
  accepted: number;
  rejected: number;
  undecided: number;
}

export function reviewDecisions(review: { hunks?: number; accepted?: number; rejected?: number }): ReviewDecisions {
  const hunks = review.hunks ?? 0;
  const accepted = Math.min(review.accepted ?? 0, hunks);
  const rejected = Math.min(review.rejected ?? 0, hunks - accepted);
  return { hunks, accepted, rejected, undecided: hunks - accepted - rejected };
}

/** "2 of 3 hunks accepted, 1 undecided" (a rejected count appears only when there is one). */
export function reviewStatusLine(review: { hunks?: number; accepted?: number; rejected?: number }): string {
  const d = reviewDecisions(review);
  const parts = [`${d.accepted} of ${d.hunks} ${d.hunks === 1 ? "hunk" : "hunks"} accepted`];
  if (d.rejected > 0) parts.push(`${d.rejected} rejected`);
  if (d.undecided > 0) parts.push(`${d.undecided} undecided`);
  return parts.join(", ");
}

/** What Apply will leave out; empty when every hunk is decided. */
export function reviewUndecidedNote(review: { hunks?: number; accepted?: number; rejected?: number }): string {
  const d = reviewDecisions(review);
  if (d.undecided === 0) return "";
  return `${d.undecided === 1 ? "The undecided hunk counts" : "Undecided hunks count"} as rejected: ${d.undecided === 1 ? "it" : "they"} will not be applied.`;
}

/** The line shown once a review has finished (or is being written). Empty while it is still waiting for a decision. */
export function reviewOutcomeLine(review: { state: string; hunks?: number; applied?: number; detail?: string }): { text: string; tone: "ok" | "error" | "info" } | undefined {
  switch (review.state) {
    case "applying":
      return { text: "Applying the accepted hunks…", tone: "info" };
    case "applied": {
      const applied = review.applied ?? 0;
      const total = review.hunks ?? applied;
      const left = total - applied;
      return { text: `Applied ${applied} of ${total} ${total === 1 ? "hunk" : "hunks"}${left > 0 ? `; ${left} not applied (rejected or undecided)` : ""}.`, tone: "ok" };
    }
    case "rejected":
      return { text: "Rejected: nothing was written.", tone: "info" };
    case "failed":
      return { text: `Not applied: nothing was written.${review.detail ? ` ${review.detail}` : ""}`, tone: "error" };
    case "cancelled":
      return { text: "Cancelled: nothing was written.", tone: "info" };
    default:
      return undefined;
  }
}

export type ToolItem = Extract<ChatItem, { kind: "tool" }>;

export interface ToolCardModel {
  /** Text on the collapsed card line next to the tool name. */
  headline: string;
  /** Raw JSON arguments in the card body (only for non-review tools). */
  inlineArgs: string | undefined;
  /** Raw JSON arguments behind the collapsed "Details" toggle (review cards only). */
  detailsArgs: string | undefined;
}

/**
 * propose_edit / create_file cards show the file, the summary, the hunk count and the Review button; the
 * raw JSON arguments are tucked behind a collapsed "Details" toggle. Other tools show their arguments inline.
 */
export function toolCardModel(item: ToolItem): ToolCardModel {
  const hasArgs = item.args !== "" && item.args !== "{}";
  if (item.review) {
    return { headline: item.review.path, inlineArgs: undefined, detailsArgs: hasArgs ? item.args : undefined };
  }
  const meta = metaToolHeadline(item);
  if (meta) return { headline: meta, inlineArgs: hasArgs ? item.args : undefined, detailsArgs: undefined };
  return { headline: item.argsSummary, inlineArgs: hasArgs ? item.args : undefined, detailsArgs: undefined };
}

/** The short badge on a command card line: "auto-allowed (tier 1)". */
export function autoAllowBadge(item: Pick<ToolItem, "autoAllowed">): string | undefined {
  return item.autoAllowed ? `auto-allowed (tier ${item.autoAllowed})` : undefined;
}

export interface CommandCardModel {
  command: string;
  /** Show the "Allow this exact command for this run" checkbox (only while the approval is pending). */
  offerRunAllow: boolean;
  /** One-line note under the code block once decided. */
  decided: string | undefined;
}

/** run_command cards show the exact command in a code block instead of JSON arguments. */
export function commandCardModel(item: ToolItem): CommandCardModel | undefined {
  if (item.name !== "run_command" || item.command === undefined) return undefined;
  return {
    command: item.command,
    offerRunAllow: item.approval === "pending",
    decided: item.autoAllowed ? `Auto-allowed (${item.autoAllowed === 1 ? "tier 1: read-only" : "tier 2: tests"}) by your forge.autoAllowCommands setting; you were not asked.` : item.approval === "allowed" ? "You allowed this command." : item.approval === "denied" ? "You denied this command." : undefined,
  };
}

/**
 * TrueForge's deferred-loading meta tools: show WHICH tool they find or call ("git_diff via forge-editor-extras")
 * instead of raw JSON, so the discovery is readable in the panel.
 */
export function metaToolHeadline(item: Pick<ToolItem, "name" | "args">): string | undefined {
  if (item.name !== "list_tools" && item.name !== "get_tool_info" && item.name !== "call_tool") return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(item.args);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
  const { mcp_server: server, tool_name: tool } = parsed as { mcp_server?: unknown; tool_name?: unknown };
  const where = typeof server === "string" ? server : undefined;
  if (item.name === "list_tools") return where ? `list tools of ${where}` : undefined;
  if (typeof tool !== "string") return undefined;
  return `${item.name === "get_tool_info" ? "describe " : ""}${tool}${where ? ` via ${where}` : ""}`;
}
