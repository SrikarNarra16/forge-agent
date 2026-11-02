import type { ContextViewItem, ContextViewPlan, ContextViewRead, ContextViewState } from "../protocol";

/** Pure view-model helpers for the Context section (kept DOM-free so they are unit-tested). */

export const formatCount = (n: number): string => n.toLocaleString("en-US");

export function locationLabel(item: { path: string; startLine: number; endLine: number }): string {
  return `${item.path}:${item.startLine}${item.endLine > item.startLine ? `-${item.endLine}` : ""}`;
}

export function budgetLabel(plan: Pick<ContextViewPlan, "usedTokens" | "budgetTokens">): string {
  return `${formatCount(plan.usedTokens)} / ${formatCount(plan.budgetTokens)} tokens`;
}

/** 0..100 for the bar; a zero budget shows an empty bar. */
export function budgetPercent(plan: Pick<ContextViewPlan, "usedTokens" | "budgetTokens">): number {
  if (plan.budgetTokens <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((plan.usedTokens / plan.budgetTokens) * 100)));
}

export function retrievalLabel(ms: number): string {
  return ms < 1 ? "retrieved in <1 ms" : `retrieved in ${Math.round(ms)} ms`;
}

export interface ContextGroups {
  pinned: ContextViewItem[];
  auto: ContextViewItem[];
  reads: ContextViewRead[];
}

export function groupContext(state: ContextViewState): ContextGroups {
  const items = state.plan?.items ?? [];
  return { pinned: items.filter((i) => i.source === "mention"), auto: items.filter((i) => i.source === "auto"), reads: state.reads };
}

/** One-line summary on the collapsed section header. */
export function contextSummary(state: ContextViewState): string {
  const g = groupContext(state);
  const parts: string[] = [];
  if (g.pinned.length > 0) parts.push(`${g.pinned.length} pinned`);
  if (g.auto.length > 0) parts.push(`${g.auto.length} auto`);
  if (g.reads.length > 0) parts.push(`${g.reads.length} read`);
  if (state.plan?.note) parts.push("no auto context");
  return parts.length > 0 ? parts.join(" · ") : "nothing yet";
}

export const hasContext = (state: ContextViewState): boolean => state.plan !== undefined || state.reads.length > 0;
