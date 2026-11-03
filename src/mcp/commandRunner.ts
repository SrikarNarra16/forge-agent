/** What run_command needs from the machine. The node implementation lives in src/host/commandRunner.ts. */
export interface CommandRunOptions {
  cwd: string;
  timeoutMs: number;
  signal?: AbortSignal | undefined;
  /** Called with each chunk of merged stdout/stderr as it arrives (live terminal view). */
  onOutput?: ((chunk: string) => void) | undefined;
  /** Apply forge.commandPrefix (default true). Fixed internal commands such as git set false. */
  usePrefix?: boolean | undefined;
}

export interface CommandResult {
  /** null when the process was killed by a signal. */
  exitCode: number | null;
  /** Merged stdout + stderr (the middle is dropped if it exceeds the capture cap). */
  output: string;
  timedOut: boolean;
  aborted: boolean;
  durationMs: number;
}

export interface CommandRunner {
  run(command: string, options: CommandRunOptions): Promise<CommandResult>;
}

/** Live view of commands (the "Forge: Terminal" output channel in VS Code). */
export interface TerminalSink {
  started(command: string): void;
  output(chunk: string): void;
  finished(result: CommandResult): void;
}
