import { budgetTokens } from "./budget";

/**
 * Estimated-vs-actual input tokens for a turn that carried an injected context block. The estimate is
 * chars/4 (`raw`); the budget uses 1.15x that as a safety factor. TrueForge reports the real count of the
 * conversation messages of each model call (`messageTokens`); for the first turn of a session that is exactly
 * the injected message, for later turns it also contains the history, so only an approximate delta is possible.
 */
export interface UsageSample {
  /** The full model-facing message (context block + request). */
  message: string;
  /** Budget tokens of the injected block alone. */
  blockTokens: number;
  /** TrueForge's numbers for the run's first model call. */
  inputTokens: number;
  messageTokens?: number | undefined;
  /** messageTokens of the previous run's last model call in this session; 0 for the first turn. */
  priorMessageTokens: number;
}

export interface UsageComparison {
  rawEstimate: number;
  budgetEstimate: number;
  actualMessageTokens: number | undefined;
  /** actual / raw estimate; undefined without messageTokens. */
  ratio: number | undefined;
  exact: boolean;
}

export function compareUsage(sample: UsageSample): UsageComparison {
  const rawEstimate = Math.ceil(sample.message.length / 4);
  const exact = sample.priorMessageTokens === 0;
  const actual = sample.messageTokens === undefined ? undefined : Math.max(0, sample.messageTokens - sample.priorMessageTokens);
  return { rawEstimate, budgetEstimate: budgetTokens(sample.message), actualMessageTokens: actual, ratio: actual !== undefined && rawEstimate > 0 ? actual / rawEstimate : undefined, exact };
}

export function describeUsage(sample: UsageSample): string {
  const c = compareUsage(sample);
  const actual = c.actualMessageTokens === undefined ? "n/a" : String(c.actualMessageTokens);
  const ratio = c.ratio === undefined ? "n/a" : c.ratio.toFixed(2);
  return `context usage: block ~${sample.blockTokens} budget tokens; message estimate ${c.rawEstimate} (x1.15 = ${c.budgetEstimate}); TrueForge first call input ${sample.inputTokens}, message tokens ${actual}${c.exact ? "" : " (approx: history included)"}; actual/estimate ${ratio}`;
}
