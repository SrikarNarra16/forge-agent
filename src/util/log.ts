import * as vscode from "vscode";

/** Logger writing timestamped lines to the "Forge" OutputChannel. */
export interface Logger extends vscode.Disposable {
  info(message: string): void;
  warn(message: string): void;
  error(message: string, err?: unknown): void;
  show(): void;
}

function describe(err: unknown): string {
  if (err instanceof Error) return err.stack ?? err.message;
  return String(err);
}

export function createLogger(): Logger {
  const channel = vscode.window.createOutputChannel("Forge");
  const write = (level: string, message: string): void => {
    channel.appendLine(`${new Date().toISOString()} [${level}] ${message}`);
  };
  return {
    info: (m) => write("info", m),
    warn: (m) => write("warn", m),
    error: (m, err) => write("error", err === undefined ? m : `${m}: ${describe(err)}`),
    show: () => channel.show(true),
    dispose: () => channel.dispose(),
  };
}
