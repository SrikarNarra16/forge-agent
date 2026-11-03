import * as vscode from "vscode";
import type { CommandResult, TerminalSink } from "../mcp/commandRunner";

/** "Forge: Terminal" output channel: shows every approved command and its live output. */
export class TerminalOutput implements TerminalSink, vscode.Disposable {
  private readonly channel = vscode.window.createOutputChannel("Forge: Terminal");

  started(command: string): void {
    this.channel.appendLine(`\n$ ${command}`);
  }

  output(chunk: string): void {
    this.channel.append(chunk);
  }

  finished(result: CommandResult): void {
    const how = result.timedOut ? "timed out, killed" : result.aborted ? "cancelled, killed" : `exit ${String(result.exitCode)}`;
    this.channel.appendLine(`[${how} in ${(result.durationMs / 1000).toFixed(1)}s]`);
  }

  dispose(): void {
    this.channel.dispose();
  }
}
