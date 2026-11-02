import * as vscode from "vscode";
import { VscodeHost } from "./host/vscodeHost";
import { generateToken } from "./mcp/auth";
import { DecisionStore } from "./mcp/decisions";
import { McpEvents } from "./mcp/events";
import { startMcpServer, type McpServerHandle } from "./mcp/server";
import { AgentController } from "./trueforge/agentController";
import { Bootstrapper } from "./trueforge/bootstrap";
import { FORGE_AGENT_NAME, createClient } from "./trueforge/client";
import { preflight } from "./trueforge/preflight";
import { createSdkTurnClient } from "./trueforge/sdkAdapter";
import { SMOKE_PROMPTS } from "./trueforge/smokeTest";
import { RoutingApprovalHandler } from "./trueforge/routingApprovals";
import { ActivityLog, CompositeUi } from "./trueforge/uiSinks";
import { VscodeRestorer, VscodeReviewEditor } from "./review/applier";
import { CheckpointStore } from "./review/checkpoints";
import { runFakeProposal } from "./review/fakeProposal";
import { ProposalFileSystem } from "./review/proposalFs";
import { ReviewApprovalHandler } from "./review/reviewHandler";
import { ReviewUi } from "./review/reviewUi";
import { RunScope } from "./review/runScope";
import { ReviewTracker } from "./review/tracker";
import { createLogger } from "./util/log";
import { AgentViewProvider, PanelUi } from "./ui/panel";
import { TrueForgeStatus } from "./ui/statusBar";

let mcpStarting: Promise<McpServerHandle> | undefined;

/** Commands that are stubs for now; each shows an information message until its prompt implements it. */
const STUB_COMMANDS: ReadonlyArray<readonly [id: string, message: string]> = [
  ["forge.inlineEdit", "Forge: inline edit is not implemented yet (P06)."],
  ["forge.switchModel", "Forge: model switching is not implemented yet (P10)."],
];

/**
 * Rolls back every file changed during a run (one user request): restores edited files and deletes files
 * the run created. Exposed for P09's cancel logic ("rollbackOnCancel"). Set in activate().
 */
export let rollbackRun: ((runId: string) => Promise<readonly string[]>) | undefined;

export function activate(context: vscode.ExtensionContext): void {
  const log = createLogger();
  const status = new TrueForgeStatus(log);
  context.subscriptions.push(log, status);
  log.info("Forge activated");

  // --- editor access, review and write-safety plumbing ------------------------------------------------
  // Writes never happen in the MCP tools. The review handler applies accepted hunks and records a decision
  // (DecisionStore) that propose_edit / create_file then report; checkpoints make every run undoable.
  const host = new VscodeHost();
  const decisions = new DecisionStore();
  const checkpoints = new CheckpointStore();
  const tracker = new ReviewTracker();
  const runScope = new RunScope({ decisions, tracker });
  const proposalFs = new ProposalFileSystem();
  const reviewUi = new ReviewUi(proposalFs, context.globalState, log);
  const reviewHandler = new ReviewApprovalHandler({
    editor: new VscodeReviewEditor(host, checkpoints),
    presenter: reviewUi,
    decisions,
    tracker,
    getRunId: () => runScope.runId,
    log: (m) => log.info(m),
  });
  const restorer = new VscodeRestorer(host);
  context.subscriptions.push(proposalFs, reviewUi);

  // The bearer token lives only in memory for this activation; it is never logged or persisted.
  const token = generateToken();
  const events = new McpEvents(); // read_file emits context:read here; the context panel subscribes in a later prompt
  const mcp = startMcpServer({ token, host, events, decisions, log: (m) => log.info(m) });
  mcpStarting = mcp;
  mcp.catch((err: unknown) => log.error("MCP server failed to start", err));
  const getClient = () => createClient(status.baseUrl);
  const bootstrapper = new Bootstrapper({ log, extensionUri: context.extensionUri, token, mcp, getClient });
  context.subscriptions.push(bootstrapper.watch(status));
  void bootstrapper.run(); // background: activation must stay fast and must never throw here

  // The Agent panel and its controller. The panel is the UiSink and the generic Allow/Deny ApprovalHandler;
  // propose_edit / create_file are routed to the diff review instead.
  const panel = new PanelUi(log, tracker);
  const controller = new AgentController({
    client: createSdkTurnClient(getClient),
    agentName: FORGE_AGENT_NAME,
    ui: new CompositeUi([runScope, panel, new ActivityLog(log, () => status.baseUrl)]),
    approvals: new RoutingApprovalHandler(
      new Map([
        ["propose_edit", reviewHandler],
        ["create_file", reviewHandler],
      ]),
      panel,
    ),
    prepare: () => preflight({ bootstrap: () => bootstrapper.run(), getClient, agentName: FORGE_AGENT_NAME, baseUrl: () => status.baseUrl }),
    log: (m) => log.info(m),
  });

  rollbackRun = async (runId) => (await checkpoints.rollbackRun(runId, restorer)).restored;
  /** "Undo run": restores the files changed by the last run that changed anything. */
  const undoLastRun = async (): Promise<void> => {
    const runId = checkpoints.lastRunId();
    if (!runId) {
      void vscode.window.showInformationMessage("Forge: no agent run to undo.");
      return;
    }
    const result = await checkpoints.rollbackRun(runId, restorer);
    log.info(`undo ${runId}: restored ${result.restored.join(", ") || "nothing"}${result.failed.length ? `; failed ${result.failed.map((f) => `${f.path} (${f.error})`).join(", ")}` : ""}`);
    if (result.failed.length > 0) {
      void vscode.window.showWarningMessage(`Forge restored ${result.restored.length} file(s), but ${result.failed.length} could not be restored: ${result.failed.map((f) => `${f.path} (${f.error})`).join("; ")}`);
    } else {
      void vscode.window.showInformationMessage(`Forge restored ${result.restored.length} file(s): ${result.restored.join(", ")}`);
    }
  };
  checkpoints.onChange(() => panel.setCanUndo(checkpoints.canUndo));

  panel.setHandlers({
    send: (text) => void controller.send(text),
    stop: () => void controller.stop(),
    newChat: () => void controller.newChat(),
    openReview: (callId) => void reviewUi.open(callId),
    undoRun: () => void undoLastRun(),
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
    vscode.commands.registerCommand("forge.undoLastRun", undoLastRun),
    vscode.commands.registerCommand("forge.fakeProposal", () => runFakeProposal({ host, handler: reviewHandler })),
  );
}

export async function deactivate(): Promise<void> {
  // Other disposables (status bar timer, commands) are cleaned up by VS Code; the MCP server needs an awaited close.
  const handle = await mcpStarting?.catch(() => undefined);
  mcpStarting = undefined;
  await handle?.dispose();
}
