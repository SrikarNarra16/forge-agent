import * as vscode from "vscode";
import { createLogger } from "./util/log";
import { AgentViewProvider } from "./ui/panel";
import { TrueForgeStatus } from "./ui/statusBar";

/** Commands that are stubs for now; each shows an information message until its prompt implements it. */
const STUB_COMMANDS: ReadonlyArray<readonly [id: string, message: string]> = [
  ["forge.inlineEdit", "Forge: inline edit is not implemented yet (P06)."],
  ["forge.stop", "Forge: nothing is running."],
  ["forge.undoLastRun", "Forge: no agent run to undo yet (P05)."],
  ["forge.switchModel", "Forge: model switching is not implemented yet (P10)."],
  ["forge.reviewAcceptAll", "Forge: no review in progress."],
  ["forge.reviewRejectAll", "Forge: no review in progress."],
  ["forge.reviewAcceptHunk", "Forge: no review in progress."],
  ["forge.reviewRejectHunk", "Forge: no review in progress."],
];

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const status = new TrueForgeStatus(log);
  context.subscriptions.push(log, status);
  log.info("Forge activated");

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, new AgentViewProvider(context.extensionUri)),
  );

  for (const [id, message] of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => vscode.window.showInformationMessage(message)));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.openAgent", () => vscode.commands.executeCommand("forge.agentView.focus")),
    vscode.commands.registerCommand("forge.checkConnection", () => status.check()),
    vscode.commands.registerCommand("forge.smokeTest", async () => {
      await status.check();
      void vscode.window.showInformationMessage(`Forge smoke test: TrueForge ${status.state} (${status.baseUrl}).`);
    }),
  );
}

export function deactivate(): void {
  // Disposables registered in activate() are cleaned up by VS Code (timers and requests included).
}
