/**
 * ModelChain: ordered fallback over forge.models. Retries a failed turn in a fresh session on the next TrueForge model (still via TrueForge).
 */
export interface ModelChain {
  /** Model names (provider/model), primary first. */
  readonly models: readonly string[];
}
