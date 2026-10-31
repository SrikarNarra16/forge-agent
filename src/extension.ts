import * as vscode from "vscode";
import { generateToken } from "./mcp/auth";
import { startMcpServer, type McpServerHandle } from "./mcp/server";
import { Bootstrapper } from "./trueforge/bootstrap";
import { createClient } from "./trueforge/client";
import { runSmokeTest } from "./trueforge/smokeTest";
import { createLogger } from "./util/log";
import { AgentViewProvider } from "./ui/panel";
import { TrueForgeStatus } from "./ui/statusBar";

let mcpStarting: Promise<McpServerHandle> | undefined;

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

  // The bearer token lives only in memory for this activation; it is never logged or persisted.
  const token = generateToken();
  const mcp = startMcpServer({ token, log: (m) => log.info(m) });
  mcpStarting = mcp;
  mcp.catch((err: unknown) => log.error("MCP server failed to start", err));
  const getClient = () => createClient(status.baseUrl);
  const bootstrapper = new Bootstrapper({ log, extensionUri: context.extensionUri, token, mcp, getClient });
  context.subscriptions.push(bootstrapper.watch(status));
  void bootstrapper.run(); // background: activation must stay fast and must never throw here

  context.subscriptions.push(
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, new AgentViewProvider(context.extensionUri)),
  );

  for (const [id, message] of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => vscode.window.showInformationMessage(message)));
  }

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.openAgent", () => vscode.commands.executeCommand("forge.agentView.focus")),
    vscode.commands.registerCommand("forge.checkConnection", () => status.check()),
    vscode.commands.registerCommand("forge.smokeTest", () =>
      runSmokeTest({ log, bootstrapper, getClient, getBaseUrl: () => status.baseUrl }),
    ),
  );
}

export async function deactivate(): Promise<void> {
  // Other disposables (status bar timer, commands) are cleaned up by VS Code; the MCP server needs an awaited close.
  const handle = await mcpStarting?.catch(() => undefined);
  mcpStarting = undefined;
  await handle?.dispose();
}
