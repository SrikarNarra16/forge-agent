/**
 * Approval tickets for run_command. The approval handler issues one per approved call; the tool consumes it before
 * running. No ticket (never approved, or dropped by Stop) means the command does not run, so a late call from a
 * cancelled run cannot execute anything. Pure and vscode-free.
 */
export class CommandTickets {
  private readonly counts = new Map<string, number>();

  issue(command: string): void {
    const key = command.trim();
    this.counts.set(key, (this.counts.get(key) ?? 0) + 1);
  }

  /** True (and the ticket is used up) when the command was approved. */
  take(command: string): boolean {
    const key = command.trim();
    const n = this.counts.get(key) ?? 0;
    if (n === 0) return false;
    if (n === 1) this.counts.delete(key);
    else this.counts.set(key, n - 1);
    return true;
  }

  clear(): void {
    this.counts.clear();
  }

  get size(): number {
    return [...this.counts.values()].reduce((a, b) => a + b, 0);
  }
}
