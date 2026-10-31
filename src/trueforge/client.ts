/**
 * TrueForge client wrapper: creates sessions and turns via @truefoundry/trueforge-sdk, streams events, cancels. All LLM traffic goes through TrueForge, never a provider.
 */
export interface TrueForgeClientOptions {
  baseUrl: string;
  /** SDK default is 60s; agent turns need far longer. */
  timeoutInSeconds: number;
}

export const DEFAULT_TIMEOUT_SECONDS = 600;
