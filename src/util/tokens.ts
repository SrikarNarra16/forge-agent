/** Token estimation used by the context budget: chars / 4, rounded up. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
