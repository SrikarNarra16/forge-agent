/**
 * Token budget accounting for injected context and tool results (est. tokens = chars / 4).
 */
export interface Budget {
  readonly limitTokens: number;
}
