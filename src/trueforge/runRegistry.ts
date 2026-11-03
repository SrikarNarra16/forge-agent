/**
 * Run-scoped registry shared by everything that could still act for a run after the user pressed Stop: the
 * controller (stream events), the approval handlers (review, commands), the decision store and the MCP tools.
 * Once a run is cancelled nothing may write or execute on its behalf. Pure and vscode-free.
 */
export class RunRegistry {
  private currentId: string | undefined;
  private readonly cancelledIds = new Set<string>();

  /** A new run starts (RunScope mints the id on each user message). */
  begin(runId: string): void {
    this.currentId = runId;
  }

  get current(): string | undefined {
    return this.currentId;
  }

  cancel(runId: string | undefined = this.currentId): void {
    if (runId !== undefined) this.cancelledIds.add(runId);
  }

  isCancelled(runId: string | undefined = this.currentId): boolean {
    return runId !== undefined && this.cancelledIds.has(runId);
  }

  /** Throws RunCancelledError when the run was cancelled. */
  assertActive(runId: string | undefined = this.currentId): void {
    if (this.isCancelled(runId)) throw new RunCancelledError(runId);
  }
}

export class RunCancelledError extends Error {
  constructor(runId?: string) {
    super(`The run${runId ? ` (${runId})` : ""} was cancelled`);
    this.name = "RunCancelledError";
  }
}

export const CANCELLED_TOOL_MESSAGE = "This run was cancelled by the user, so nothing was changed. Do not retry; wait for the user's next message.";
