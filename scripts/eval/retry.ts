/** Provider-failure classification and retry-with-backoff for eval runs. */
export type FailureKind = "provider" | "agent";

const PROVIDER = /Request failed \((?:5\d\d|429)\)|\b(?:502|503|504|529)\b|too busy|overloaded|rate.?limit|client-cancelled|ECONNRESET|ECONNREFUSED|ETIMEDOUT|EAI_AGAIN|fetch failed|socket hang up|connection (?:error|closed|reset)|timed? ?out/i;

/** A failed run counts as a provider failure when its errors look like 5xx / 429 / timeout / connection problems. */
export function classifyFailure(errors: readonly string[]): FailureKind {
  return errors.some((e) => PROVIDER.test(e)) ? "provider" : "agent";
}

export const BACKOFF_MS: readonly number[] = [10_000, 30_000];

export interface Attempt<T> {
  result: T;
  /** 1-based. */
  attempt: number;
}

/**
 * Runs `fn`; while `retryable(result)` holds and retries remain, waits the next backoff delay and runs it again.
 * Returns every attempt (the last one is the outcome).
 */
export async function withRetries<T>(
  fn: (attempt: number) => Promise<T>,
  options: { retryable: (result: T) => boolean | Promise<boolean>; delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; beforeAttempt?: (attempt: number) => void },
): Promise<Attempt<T>[]> {
  const delays = options.delays ?? BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt<T>[] = [];
  for (let attempt = 1; ; attempt++) {
    options.beforeAttempt?.(attempt);
    const result = await fn(attempt);
    attempts.push({ result, attempt });
    const delay = delays[attempt - 1];
    if (delay === undefined || !(await options.retryable(result))) return attempts;
    await sleep(delay);
  }
}
