import * as vscode from "vscode";
import { VscodeHost } from "./host/vscodeHost";
import { generateToken } from "./mcp/auth";
import { McpEvents } from "./mcp/events";
import { startMcpServer, type McpServerHandle } from "./mcp/server";
import { AgentController } from "./trueforge/agentController";
import { Bootstrapper } from "./trueforge/bootstrap";
import { FORGE_AGENT_NAME, createClient } from "./trueforge/client";
import { preflight } from "./trueforge/preflight";
import { createSdkTurnClient } from "./trueforge/sdkAdapter";
import { SMOKE_PROMPTS } from "./trueforge/smokeTest";
import { ActivityLog, CompositeUi } from "./trueforge/uiSinks";
import { createLogger } from "./util/log";
import { AgentViewProvider, PanelUi } from "./ui/panel";
import { TrueForgeStatus } from "./ui/statusBar";

let mcpStarting: Promise<McpServerHandle> | undefined;

/** Commands that are stubs for now; each shows an information message until its prompt implements it. */
const STUB_COMMANDS: ReadonlyArray<readonly [id: string, message: string]> = [
  ["forge.inlineEdit", "Forge: inline edit is not implemented yet (P06)."],
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
  const events = new McpEvents(); // read_file emits context:read here; the context panel subscribes in a later prompt
  const mcp = startMcpServer({ token, host: new VscodeHost(), events, log: (m) => log.info(m) });
  mcpStarting = mcp;
  mcp.catch((err: unknown) => log.error("MCP server failed to start", err));
  const getClient = () => createClient(status.baseUrl);
  const bootstrapper = new Bootstrapper({ log, extensionUri: context.extensionUri, token, mcp, getClient });
  context.subscriptions.push(bootstrapper.watch(status));
  void bootstrapper.run(); // background: activation must stay fast and must never throw here

  // The Agent panel and its controller. The panel is both the UiSink (renders the run) and the ApprovalHandler (inline cards).
  const panel = new PanelUi(log);
  const controller = new AgentController({
    client: createSdkTurnClient(getClient),
    agentName: FORGE_AGENT_NAME,
    ui: new CompositeUi([panel, new ActivityLog(log, () => status.baseUrl)]),
    approvals: panel,
    prepare: () => preflight({ bootstrap: () => bootstrapper.run(), getClient, agentName: FORGE_AGENT_NAME, baseUrl: () => status.baseUrl }),
    log: (m) => log.info(m),
  });
  panel.setHandlers({
    send: (text) => void controller.send(text),
    stop: () => void controller.stop(),
    newChat: () => void controller.newChat(),
  });
  context.subscriptions.push(
    panel,
    vscode.window.registerWebviewViewProvider(AgentViewProvider.viewType, new AgentViewProvider(context.extensionUri, panel)),
  );

  for (const [id, message] of STUB_COMMANDS) {
    context.subscriptions.push(vscode.commands.registerCommand(id, () => vscode.window.showInformationMessage(message)));
  }

  /** Debug commands send a fixed prompt through the normal panel/controller path. */
  const runPrompt = async (prompt: string): Promise<void> => {
    await panel.reveal();
    void controller.send(prompt);
  };

  context.subscriptions.push(
    vscode.commands.registerCommand("forge.openAgent", () => panel.reveal()),
    vscode.commands.registerCommand("forge.stop", async () => {
      if (!controller.runState.busy) void vscode.window.showInformationMessage("Forge: nothing is running.");
      await controller.stop();
    }),
    vscode.commands.registerCommand("forge.checkConnection", () => status.check()),
    vscode.commands.registerCommand("forge.smokeTest", () => runPrompt(SMOKE_PROMPTS.ping)),
    vscode.commands.registerCommand("forge.smokeTestCode", () => runPrompt(SMOKE_PROMPTS.code)),
    vscode.commands.registerCommand("forge.debugApprovalCard", () => panel.showTestApprovalCard()),
  );
}

export async function deactivate(): Promise<void> {
  // Other disposables (status bar timer, commands) are cleaned up by VS Code; the MCP server needs an awaited close.
  const handle = await mcpStarting?.catch(() => undefined);
  mcpStarting = undefined;
  await handle?.dispose();
}
