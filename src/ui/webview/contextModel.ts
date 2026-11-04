import type { ContextViewItem, ContextViewPlan, ContextViewRead, ContextViewRun, ContextViewState } from "../protocol";

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
  if (state.run?.source === "auto") parts.push("venv auto-activated");
  else if (state.run?.source === "setting") parts.push("custom command prefix");
  return parts.length > 0 ? parts.join(" · ") : "nothing yet";
}

/** The panel always has something to show once the command prefix is known (it is never hidden). */
export const hasContext = (state: ContextViewState): boolean => state.plan !== undefined || state.reads.length > 0 || state.run !== undefined;

/** "Commands run with `. .venv/bin/activate &&` (auto-detected virtual environment)". */
export function runPrefixLabel(run: ContextViewRun): { text: string; hint: string } {
  switch (run.source) {
    case "setting":
      return { text: `Commands run with: ${run.prefix}`, hint: "from the forge.commandPrefix setting" };
    case "auto":
      return { text: `Commands run with: ${run.prefix}`, hint: "auto-detected virtual environment; set forge.commandPrefix to override (or to \"true &&\" to turn it off)" };
    case "none":
      return { text: "Commands run without a prefix", hint: "no virtual environment found (.venv or venv); set forge.commandPrefix to activate one" };
  }
}
