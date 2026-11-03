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
  options: { retryable: (result: T) => boolean | Promise<boolean>; delays?: readonly number[]; sleep?: (ms: number) => Promise<void>; beforeAttempt?: (attempt: number) => void | Promise<void> },
): Promise<Attempt<T>[]> {
  const delays = options.delays ?? BACKOFF_MS;
  const sleep = options.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const attempts: Attempt<T>[] = [];
  for (let attempt = 1; ; attempt++) {
    await options.beforeAttempt?.(attempt);
    const result = await fn(attempt);
    attempts.push({ result, attempt });
    const delay = delays[attempt - 1];
    if (delay === undefined || !(await options.retryable(result))) return attempts;
    await sleep(delay);
  }
}

export const PAUSE_MS = 10 * 60 * 1000;
export const FAILURES_BEFORE_PAUSE = 3;
export const PAUSES_BEFORE_STOP = 3;

export class ProviderOutage extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ProviderOutage";
  }
}

/**
 * Outage handling across attempts: 3 provider failures in a row -> pause 10 minutes; after 3 such pauses in a
 * row, the next failure stops the invocation (ProviderOutage) so it can be reported instead of burning attempts.
 * Any attempt that is not a provider failure resets everything.
 */
export class OutageGuard {
  private consecutive = 0;
  private pauses = 0;

  constructor(
    private readonly options: { sleep?: (ms: number) => Promise<void>; log?: (message: string) => void; pauseMs?: number } = {},
  ) {}

  record(providerFailure: boolean): void {
    if (providerFailure) this.consecutive++;
    else {
      this.consecutive = 0;
      this.pauses = 0;
    }
  }

  /** Call before every attempt: pauses, or throws ProviderOutage when the provider has stayed down. */
  async beforeAttempt(): Promise<void> {
    if (this.pauses >= PAUSES_BEFORE_STOP && this.consecutive >= 1) {
      throw new ProviderOutage(`PROVIDER OUTAGE: ${PAUSES_BEFORE_STOP} pauses of ${(this.options.pauseMs ?? PAUSE_MS) / 60000} minutes in a row and the provider still fails. Stopping; rerun when it recovers.`);
    }
    if (this.consecutive >= FAILURES_BEFORE_PAUSE) {
      this.pauses++;
      this.consecutive = 0;
      const ms = this.options.pauseMs ?? PAUSE_MS;
      this.options.log?.(`    PAUSING ${ms / 60000} minutes: ${FAILURES_BEFORE_PAUSE} provider failures in a row (pause ${this.pauses} of ${PAUSES_BEFORE_STOP})`);
      await (this.options.sleep ?? ((t: number) => new Promise<void>((r) => setTimeout(r, t))))(ms);
    }
  }
}
