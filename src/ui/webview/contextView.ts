import type { ContextViewItem, ContextViewRead, ContextViewState } from "../protocol";
import { budgetLabel, budgetPercent, contextSummary, formatCount, groupContext, locationLabel, retrievalLabel } from "./contextModel";

function el<K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

function itemRow(item: ContextViewItem): HTMLElement {
  const row = el("div", "ctx-row");
  row.appendChild(el("span", "ctx-loc", locationLabel(item)));
  if (item.symbol) row.appendChild(el("span", "ctx-symbol", item.symbol));
  row.appendChild(el("span", "ctx-tokens", `${formatCount(item.tokens)} tok${item.form === "signature" ? " · outline" : ""}`));
  row.appendChild(el("div", "ctx-reason", item.reason));
  row.title = `${locationLabel(item)}\n${item.reason}`;
  return row;
}

function readRow(read: ContextViewRead): HTMLElement {
  const row = el("div", "ctx-row");
  row.appendChild(el("span", "ctx-loc", locationLabel(read)));
  row.appendChild(el("span", "ctx-tokens", `${formatCount(read.tokens)} tok`));
  row.appendChild(el("div", "ctx-reason", read.why)); // the agent's full reason, never truncated
  return row;
}

function group(title: string, rows: readonly HTMLElement[]): HTMLElement | undefined {
  if (rows.length === 0) return undefined;
  const box = el("div", "ctx-group");
  box.appendChild(el("div", "ctx-group-title", `${title} (${rows.length})`));
  box.append(...rows);
  return box;
}

/** The collapsible Context section. `previous` keeps the user's open/closed choice unless the state asks to expand. */
export function renderContext(state: ContextViewState, previous?: HTMLElement): HTMLElement {
  const details = el("details", "context");
  details.open = state.expand || (previous instanceof HTMLDetailsElement && previous.open);
  const summary = el("summary");
  summary.appendChild(el("span", "ctx-title", "Context"));
  summary.appendChild(el("span", "ctx-summary", contextSummary(state)));
  details.appendChild(summary);

  const plan = state.plan;
  if (plan) {
    const meter = el("div", "ctx-meter");
    const bar = el("div", "ctx-bar");
    const fill = el("div", "ctx-fill");
    fill.style.width = `${budgetPercent(plan)}%`;
    bar.appendChild(fill);
    meter.appendChild(bar);
    meter.appendChild(el("span", "ctx-budget", budgetLabel(plan)));
    details.appendChild(meter);
    const facts: string[] = [];
    if (plan.retrievalMs !== undefined) facts.push(retrievalLabel(plan.retrievalMs));
    if (state.modelInputTokens !== undefined) facts.push(`model input tokens: ${formatCount(state.modelInputTokens)}`);
    if (facts.length > 0) details.appendChild(el("div", "ctx-facts", facts.join(" · ")));
    if (plan.note) details.appendChild(el("div", "ctx-note", plan.note));
    for (const warning of plan.warnings) details.appendChild(el("div", "ctx-warning", warning));
  } else if (state.modelInputTokens !== undefined) {
    details.appendChild(el("div", "ctx-facts", `model input tokens: ${formatCount(state.modelInputTokens)}`));
  }

  const g = groupContext(state);
  for (const section of [group("Pinned", g.pinned.map(itemRow)), group("Auto-retrieved", g.auto.map(itemRow)), group("Read by the agent", g.reads.map(readRow))]) {
    if (section) details.appendChild(section);
  }
  return details;
}
