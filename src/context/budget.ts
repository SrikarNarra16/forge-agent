import { estimateTokens } from "../util/tokens";
import type { ChunkKind } from "./types";

/**
 * ContextBudget: packs ranked candidates into the injected context block without EVER exceeding the token
 * budget. Estimates are chars/4 times a 1.15 safety factor (code tokenises worse than prose). Pinned
 * (@mention) items go first but may use at most 50% of the budget; then ranked automatic items; each is shown
 * as a location line (signature-only) or with its full body, whichever fits. After packing, the exact
 * rendered block is re-measured and items are dropped/downgraded until it fits, so the guarantee does not
 * depend on the additive estimates being right. Pure and vscode-free.
 */
export const CODE_SAFETY_FACTOR = 1.15;
export const PINNED_SHARE = 0.5;
export const AUTO_BODIES = 2;

/** Conservative token estimate used for every budget decision. */
export function budgetTokens(text: string): number {
  return Math.ceil(estimateTokens(text) * CODE_SAFETY_FACTOR);
}

export type ContextForm = "body" | "signature";
export type ContextSource = "mention" | "auto";

/** What the UI shows for an item (no text). */
export interface ContextItem {
  path: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  symbol?: string;
  kind: ChunkKind;
  signature?: string;
  source: ContextSource;
  score: number;
  /** "matches: cli, command, routes" for auto items; "pinned by @mention" for pinned ones. */
  reason: string;
  /** Budget tokens this item occupies in the block (its location line plus its body when shown). */
  tokens: number;
  form: ContextForm;
}

export interface Candidate {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  kind: ChunkKind;
  signature?: string;
  /** Exact text of lines startLine..endLine. */
  text: string;
  source: ContextSource;
  score: number;
  reason: string;
  /** For a pinned whole file: signature lines shown instead of the body when the body does not fit. */
  outline?: readonly string[];
}

export interface PackedItem extends ContextItem {
  locationLine: string;
  outlineLines: readonly string[];
  /** Present when form === "body": the numbered lines. */
  bodyText?: string;
}

export interface ContextPlan {
  items: PackedItem[];
  budgetTokens: number;
  /** Budget tokens of the final rendered block. Always <= budgetTokens. */
  usedTokens: number;
  /** Tokens used by pinned items (always <= 50% of the budget). */
  pinnedTokens: number;
  text: string;
  /** Visible notes, e.g. a pinned item that did not fit. */
  warnings: string[];
}

const HEADER_PINNED = "Pinned by the user (@mentions):";
const FOOTER = "More can be fetched with read_file (line ranges), search_code and repo_map.";

export function locationLine(c: Pick<Candidate, "path" | "startLine" | "endLine" | "symbol" | "signature" | "kind" | "reason" | "source">): string {
  const where = `${c.path}:${c.startLine}-${c.endLine}`;
  const what = c.symbol ? `${c.symbol}${c.signature && c.signature !== c.symbol ? ` - ${c.signature}` : ""}` : `(${c.kind})`;
  const why = c.source === "auto" && c.reason ? `  [${c.reason}]` : "";
  return `- ${where}  ${what}${why}`;
}

export function numberedBody(c: Pick<Candidate, "startLine" | "endLine" | "text" | "path" | "symbol">): string {
  const lines = c.text.split("\n");
  const width = String(c.endLine).length;
  const numbered = lines.map((l, i) => `${String(c.startLine + i).padStart(width)}| ${l}`).join("\n");
  return `--- ${c.path}:${c.startLine}-${c.endLine}${c.symbol ? ` (${c.symbol})` : ""} ---\n${numbered}`;
}

interface Draft {
  candidate: Candidate;
  form: ContextForm;
  line: string;
  outline: readonly string[];
  body: string | undefined;
}

function draftOf(candidate: Candidate, form: ContextForm): Draft {
  return {
    candidate,
    form,
    line: locationLine(candidate),
    outline: form === "signature" && candidate.outline ? candidate.outline.map((o) => `    ${o}`) : [],
    body: form === "body" ? numberedBody(candidate) : undefined,
  };
}

function render(budget: number, pinned: readonly Draft[], auto: readonly Draft[]): string {
  const out: string[] = ["<context>"];
  if (pinned.length > 0) {
    out.push(HEADER_PINNED);
    for (const d of pinned) out.push(d.line, ...d.outline);
  }
  out.push(`Relevant locations (auto-retrieved, budget ${budget} tokens):`);
  if (auto.length === 0) out.push("- (none found)");
  for (const d of auto) out.push(d.line);
  const bodies = [...pinned, ...auto].filter((d) => d.body !== undefined);
  if (bodies.length > 0) {
    out.push("", "Code:");
    for (const d of bodies) out.push(d.body ?? "");
  }
  out.push(FOOTER, "</context>");
  return out.join("\n");
}

export interface PackInput {
  pinned: readonly Candidate[];
  auto: readonly Candidate[];
  budgetTokens: number;
  /** How many top automatic items get their full body (default 2). */
  autoBodies?: number;
}

/** Packs candidates into a block that fits `budgetTokens`. */
export function packContext(input: PackInput): ContextPlan {
  const budget = Math.max(0, Math.floor(input.budgetTokens));
  const autoBodies = input.autoBodies ?? AUTO_BODIES;
  const warnings: string[] = [];
  const cost = (pinned: readonly Draft[], auto: readonly Draft[]): number => budgetTokens(render(budget, pinned, auto));

  const pinned: Draft[] = [];
  const auto: Draft[] = [];
  const empty = cost([], []);
  if (empty > budget) {
    return { items: [], budgetTokens: budget, usedTokens: 0, pinnedTokens: 0, text: "", warnings: [`The context budget (${budget} tokens) is too small for any context.`] };
  }

  // 1. pinned, at most half of the budget
  const pinnedLimit = Math.floor(budget * PINNED_SHARE);
  const pinnedTotal = (drafts: readonly Draft[]): number => (drafts.length === 0 ? 0 : cost(drafts, []) - empty);
  for (const candidate of input.pinned) {
    const label = `${candidate.path}${candidate.symbol ? ` (${candidate.symbol})` : ""}`;
    const tries: Draft[] = candidate.text === "" ? [draftOf(candidate, "signature")] : [draftOf(candidate, "body"), draftOf(candidate, "signature")];
    const chosen = tries.find((d) => pinnedTotal([...pinned, d]) <= pinnedLimit && cost([...pinned, d], auto) <= budget);
    if (chosen) {
      pinned.push(chosen);
      if (chosen.form === "signature" && candidate.kind !== "module") warnings.push(`${label} was pinned but only its location fits the pinned share of the budget.`);
      else if (chosen.form === "signature") warnings.push(`${label} is large: only its outline is included (the pinned share is ${pinnedLimit} tokens).`);
    } else {
      warnings.push(`${label} was pinned but does not fit the pinned share of the budget (${pinnedLimit} tokens), so it is not included. Use read_file for it.`);
    }
  }

  // 2. automatic items in rank order: full bodies for the top few, locations for the rest
  let bodiesGiven = 0;
  for (const candidate of input.auto) {
    let chosen: Draft | undefined;
    if (bodiesGiven < autoBodies) {
      const withBody = draftOf(candidate, "body");
      if (cost(pinned, [...auto, withBody]) <= budget) chosen = withBody;
    }
    if (!chosen) {
      const signatureOnly = draftOf(candidate, "signature");
      if (cost(pinned, [...auto, signatureOnly]) <= budget) chosen = signatureOnly;
    }
    if (!chosen) break; // nothing smaller than a location line exists; later items cannot fit either
    if (chosen.form === "body") bodiesGiven++;
    auto.push(chosen);
  }

  // 3. exact re-measurement of the rendered block; shed items until it fits (rounding can make sums differ from the whole)
  while (cost(pinned, auto) > budget && (auto.length > 0 || pinned.length > 0)) {
    if (auto.length > 0) auto.pop();
    else pinned.pop();
  }

  const text = render(budget, pinned, auto);
  const used = budgetTokens(text);
  const itemOf = (d: Draft, others: readonly Draft[], isPinned: boolean): PackedItem => {
    const without = isPinned ? cost(others.filter((o) => o !== d), auto) : cost(pinned, others.filter((o) => o !== d));
    const withIt = isPinned ? cost(others, auto) : cost(pinned, others);
    return {
      path: d.candidate.path,
      startLine: d.candidate.startLine,
      endLine: d.candidate.endLine,
      ...(d.candidate.symbol ? { symbol: d.candidate.symbol } : {}),
      kind: d.candidate.kind,
      ...(d.candidate.signature ? { signature: d.candidate.signature } : {}),
      source: d.candidate.source,
      score: d.candidate.score,
      reason: d.candidate.reason,
      tokens: Math.max(1, withIt - without),
      form: d.form,
      locationLine: d.line,
      outlineLines: d.outline,
      ...(d.body !== undefined ? { bodyText: d.body } : {}),
    };
  };
  const items = [...pinned.map((d) => itemOf(d, pinned, true)), ...auto.map((d) => itemOf(d, auto, false))];
  return { items, budgetTokens: budget, usedTokens: used, pinnedTokens: pinnedTotal(pinned), text, warnings };
}
