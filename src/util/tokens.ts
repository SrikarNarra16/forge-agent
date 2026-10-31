/** Token estimation used by the context budget: chars / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export interface FitResult {
  /** Lines joined with "\n". */
  text: string;
  /** How many of the input lines are included. */
  shown: number;
  truncated: boolean;
}

/**
 * Greedily includes whole lines while the estimated token count (chars / 4, newline included)
 * stays within `maxTokens`. At least one line is always included (cut to fit if it alone is too long).
 */
export function fitToBudget(lines: readonly string[], maxTokens: number): FitResult {
  const out: string[] = [];
  let used = 0;
  for (const line of lines) {
    const cost = estimateTokens(line) + 1;
    if (used + cost > maxTokens && out.length > 0) break;
    if (out.length === 0 && cost > maxTokens) {
      out.push(line.slice(0, Math.max(1, maxTokens * 4 - 4)));
      used = maxTokens;
      break;
    }
    out.push(line);
    used += cost;
  }
  return { text: out.join("\n"), shown: out.length, truncated: out.length < lines.length };
}
