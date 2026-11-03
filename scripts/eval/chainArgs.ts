/** Parsing of the model-chain flags of the eval harness. */
export const BROKEN_MODEL = "broken-endpoint/broken";
const DEMO_MODEL = /^(?:broken-endpoint|badkey-deepseek)\//;

/**
 * `--chain a,b,c` sets the chain; `--fail-primary` prepends the broken-endpoint model (to the chain, or to the
 * single real model). Returns undefined when neither flag is given (the harness then runs without a chain).
 */
export function parseChainArgs(options: { chain?: string | undefined; failPrimary: boolean; model?: string | undefined; defaultModel: string }): string[] | undefined {
  const explicit = options.chain
    ?.split(",")
    .map((m) => m.trim())
    .filter(Boolean);
  if (options.chain !== undefined && (!explicit || explicit.length === 0)) throw new Error("--chain needs a comma-separated list of TrueForge model names, e.g. --chain broken-endpoint/broken,deepseek/flash");
  if (!explicit && !options.failPrimary) return undefined;
  const base = explicit ?? [options.model ?? options.defaultModel];
  const chain = options.failPrimary && !base.includes(BROKEN_MODEL) ? [BROKEN_MODEL, ...base] : base;
  return [...new Set(chain)];
}

/** A chain made only of demo-failing models cannot succeed: the expected outcome is a clear error and a pristine workspace. */
export function expectsExhaustion(chain: readonly string[] | undefined): boolean {
  return chain !== undefined && chain.length > 0 && chain.every((m) => DEMO_MODEL.test(m));
}
