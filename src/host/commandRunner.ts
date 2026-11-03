import { spawn } from "node:child_process";
import type { CommandResult, CommandRunOptions, CommandRunner } from "../mcp/commandRunner";

/**
 * Runs shell commands for run_command. Async only (never blocks the extension host), merges stdout and stderr,
 * enforces a hard timeout and kills the WHOLE process group on timeout or abort (Stop). No vscode import, so the
 * eval harness uses the same runner. Not for Windows (uses a POSIX shell and process groups).
 */
export const MAX_CAPTURE_CHARS = 1_000_000;
const HEAD_CHARS = 100_000;
const KILL_GRACE_MS = 2000;
const SETTLE_AFTER_KILL_MS = 3000;

export interface NodeRunnerOptions {
  /** `source .venv/bin/activate &&`-style prefix (forge.commandPrefix); read per run so setting changes apply. */
  getPrefix?: () => string;
  env?: NodeJS.ProcessEnv;
  shell?: string;
}

/** Keeps the first HEAD_CHARS and a rolling tail so a noisy command cannot exhaust memory. */
export class OutputCapture {
  private head = "";
  private tail = "";
  private dropped = 0;
  constructor(private readonly max: number = MAX_CAPTURE_CHARS) {}

  push(chunk: string): void {
    if (this.head.length < HEAD_CHARS) {
      const room = HEAD_CHARS - this.head.length;
      this.head += chunk.slice(0, room);
      chunk = chunk.slice(room);
    }
    this.tail += chunk;
    const tailMax = this.max - HEAD_CHARS;
    if (this.tail.length > tailMax) {
      this.dropped += this.tail.length - tailMax;
      this.tail = this.tail.slice(this.tail.length - tailMax);
    }
  }

  text(): string {
    return this.dropped > 0 ? `${this.head}\n[... ${this.dropped} characters omitted ...]\n${this.tail}` : this.head + this.tail;
  }
}

export class NodeCommandRunner implements CommandRunner {
  constructor(private readonly options: NodeRunnerOptions = {}) {}

  run(command: string, options: CommandRunOptions): Promise<CommandResult> {
    const prefix = options.usePrefix === false ? "" : (this.options.getPrefix?.().trim() ?? "");
    const full = prefix === "" ? command : `${prefix} ${command}`;
    const started = Date.now();
    return new Promise<CommandResult>((resolve) => {
      const capture = new OutputCapture();
      let timedOut = false;
      let aborted = false;
      let settled = false;
      let killTimer: ReturnType<typeof setTimeout> | undefined;
      let settleTimer: ReturnType<typeof setTimeout> | undefined;
      const shell = this.options.shell ?? process.env["SHELL"] ?? "/bin/sh";
      const child = spawn(shell, ["-c", full], { cwd: options.cwd, env: { ...process.env, ...this.options.env }, detached: true, stdio: ["ignore", "pipe", "pipe"] });

      const finish = (exitCode: number | null): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timeout);
        clearTimeout(killTimer);
        clearTimeout(settleTimer);
        options.signal?.removeEventListener("abort", onAbort);
        resolve({ exitCode, output: capture.text(), timedOut, aborted, durationMs: Date.now() - started });
      };
      const signalGroup = (sig: NodeJS.Signals): void => {
        if (child.pid === undefined) return;
        try {
          process.kill(-child.pid, sig);
        } catch {
          try {
            child.kill(sig);
          } catch {
            /* already gone */
          }
        }
      };
      const kill = (): void => {
        signalGroup("SIGTERM");
        killTimer = setTimeout(() => signalGroup("SIGKILL"), KILL_GRACE_MS);
        // grandchildren can keep the pipes open: never wait for them forever
        settleTimer = setTimeout(() => finish(null), SETTLE_AFTER_KILL_MS);
      };
      const onAbort = (): void => {
        aborted = true;
        kill();
      };
      const timeout = setTimeout(() => {
        timedOut = true;
        kill();
      }, options.timeoutMs);

      const onData = (data: Buffer): void => {
        const text = data.toString("utf8");
        capture.push(text);
        options.onOutput?.(text);
      };
      child.stdout.on("data", onData);
      child.stderr.on("data", onData);
      child.on("error", (err) => {
        capture.push(`failed to start: ${err.message}\n`);
        finish(127);
      });
      child.on("close", (code) => finish(code));
      if (options.signal?.aborted) onAbort();
      else options.signal?.addEventListener("abort", onAbort, { once: true });
    });
  }
}
