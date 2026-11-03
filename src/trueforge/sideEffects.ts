/**
 * What the current run has already changed, so the model chain knows whether a failed attempt may be replayed:
 * files applied (from the checkpoints) and commands executed (recorded when run_command starts). Pure and vscode-free.
 */
export interface SideEffects {
  files: string[];
  commands: string[];
}

export class RunSideEffects {
  private readonly commands = new Map<string, string[]>();

  constructor(
    private readonly filesOf: (runId: string) => string[],
    private readonly currentRun: () => string | undefined,
  ) {}

  /** A run_command is about to execute in the current run. */
  recordCommand(command: string): void {
    const run = this.currentRun();
    if (run === undefined) return;
    const list = this.commands.get(run) ?? [];
    list.push(command.trim());
    this.commands.set(run, list);
  }

  of(runId: string | undefined = this.currentRun()): SideEffects {
    if (runId === undefined) return { files: [], commands: [] };
    return { files: this.filesOf(runId), commands: [...(this.commands.get(runId) ?? [])] };
  }
}
