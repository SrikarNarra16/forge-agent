import type { WorkspaceHost } from "../mcp/host";
import { budgetTokens } from "./budget";
import type { ContextIndex } from "./indexer";
import { mergeMentions, parseMentions, resolveMentions, stripMentions, type Mention } from "./mentions";
import { retrieve } from "./retrieval";
import type { ContextViewPlan } from "./view";

/** Builds the message of a panel turn: the <context> block (pinned + auto-retrieved) followed by the user's request. */

export const INDEX_WAIT_MS = 1500;
export const INDEX_BUILDING_NOTE = "Index still building: no auto context this turn";

export interface TurnContextRequest {
  /** Exactly what the user typed. */
  text: string;
  /** Mentions chosen with the @ autocomplete (typed @tokens are parsed from the text as well). */
  chips?: readonly Mention[];
  budgetTokens: number;
  waitMs?: number;
}

export interface TurnContext {
  /** What is sent to the model. */
  message: string;
  /** What the transcript shows. */
  display: string;
  plan: ContextViewPlan;
  /** Budget tokens of the injected block (0 when none). */
  blockTokens: number;
}

export const mentionLabel = (m: Mention): string => `@${m.kind === "symbol" ? "#" : ""}${m.value}`;

export async function buildTurnContext(index: ContextIndex, host: WorkspaceHost, request: TurnContextRequest, now: () => number = () => performance.now()): Promise<TurnContext> {
  const chips = request.chips ?? [];
  const display = chips.length > 0 ? `${request.text}\n${chips.map(mentionLabel).join(" ")}` : request.text;
  const mentions = mergeMentions(chips, parseMentions(request.text));
  const empty = (note: string | undefined, warnings: string[]): TurnContext => ({
    message: request.text,
    display,
    blockTokens: 0,
    plan: { budgetTokens: request.budgetTokens, usedTokens: 0, items: [], warnings, ...(note ? { note } : {}) },
  });

  if (!index.ready && !(await index.whenReady(request.waitMs ?? INDEX_WAIT_MS))) {
    return empty(
      INDEX_BUILDING_NOTE,
      mentions.map((m) => `Index still building: could not resolve ${mentionLabel(m)}.`),
    );
  }

  const resolution = await resolveMentions(index, host, mentions);
  const extraTerms = resolution.resolved.flatMap((r) => (r.mention.kind === "symbol" && r.symbol ? [r.symbol] : []));
  const result = retrieve(
    index,
    { query: stripMentions(request.text), pinned: resolution.pinned, budgetTokens: request.budgetTokens, extraTerms },
    now,
  );
  const { plan } = result;
  const warnings = [...resolution.warnings, ...plan.warnings];
  if (plan.items.length === 0) return { ...empty(undefined, warnings), plan: { budgetTokens: plan.budgetTokens, usedTokens: 0, items: [], warnings, retrievalMs: result.timing.totalMs } };
  return {
    message: `${plan.text}\n\nUser request:\n${request.text}`,
    display,
    blockTokens: budgetTokens(plan.text),
    plan: {
      budgetTokens: plan.budgetTokens,
      usedTokens: plan.usedTokens,
      items: plan.items.map((i) => ({
        path: i.path,
        startLine: i.startLine,
        endLine: i.endLine,
        ...(i.symbol ? { symbol: i.symbol } : {}),
        source: i.source,
        reason: i.reason,
        tokens: i.tokens,
        form: i.form,
      })),
      warnings,
      retrievalMs: result.timing.totalMs,
    },
  };
}
