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
  return { headline: item.argsSummary, inlineArgs: hasArgs ? item.args : undefined, detailsArgs: undefined };
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
    decided: item.approval === "allowed" ? "You allowed this command." : item.approval === "denied" ? "You denied this command." : undefined,
  };
}
