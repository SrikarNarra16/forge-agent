import * as vscode from "vscode";
import { NodeCommandRunner } from "./host/commandRunner";
import { CommandTickets } from "./mcp/commandTickets";
import { RunRegistry } from "./trueforge/runRegistry";
import { RunSideEffects } from "./trueforge/sideEffects";
import { promoteModel } from "./trueforge/modelChain";
import { sessionUrl } from "./trueforge/client";
import { ChainToasts } from "./ui/chainToasts";
import { VscodeEditorUi } from "./host/editorUi";
import { TerminalOutput } from "./host/terminalOutput";
import { CommandApprovalHandler } from "./trueforge/commandApprovals";
import { ContextService } from "./host/contextWiring";
import { buildTurnContext } from "./context/injection";
import { describeUsage } from "./context/usageLog";
import { suggestFiles, suggestSymbols } from "./context/mentions";
import { VscodeHost } from "./host/vscodeHost";
import { registerInlineEdit } from "./inline/inlineEdit";
import { generateToken } from "./mcp/auth";
import { DecisionStore } from "./mcp/decisions";
import { McpEvents } from "./mcp/events";
import { startMcpServer, type McpServerHandle } from "./mcp/server";
import { AgentController, type ApprovalHandler } from "./trueforge/agentController";
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
  const registry = new RunRegistry(); // which runs were cancelled; shared by the controller, handlers and tools
  const tickets = new CommandTickets();
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
    registry,
    log: (m) => log.info(m),
  });
  const restorer = new VscodeRestorer(host);
  context.subscriptions.push(proposalFs, reviewUi);

  // The bearer token lives only in memory for this activation; it is never logged or persisted.
  const token = generateToken();
  const events = new McpEvents(); // read_file emits context:read here; the panel's Context section subscribes below
  const contextService = new ContextService(host, log);
  context.subscriptions.push(contextService);
  contextService.rebuild(); // background; search_code / repo_map scan files until the index is ready
  const terminalOutput = new TerminalOutput();
  const sideEffects = new RunSideEffects((runId) => checkpoints.filesOf(runId), () => registry.current);
  // every command that starts counts as a side effect for the model chain (it may have changed anything)
  const terminal = { started: (c: string) => (sideEffects.recordCommand(c), terminalOutput.started(c)), output: (c: string) => terminalOutput.output(c), finished: (r: Parameters<TerminalOutput["finished"]>[0]) => terminalOutput.finished(r) };
  context.subscriptions.push(terminalOutput);
  const commands = new NodeCommandRunner({ getPrefix: () => vscode.workspace.getConfiguration("forge").get<string>("commandPrefix", "") });
  const mcp = startMcpServer({ token, host, events, decisions, index: contextService.index, commands, terminal, editor: new VscodeEditorUi(host), run: { isCancelled: () => registry.isCancelled(), signal: () => registry.signal }, tickets, log: (m) => log.info(m) });
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
    ui: new CompositeUi([runScope, panel, new ChainToasts(), new ActivityLog(log, () => status.baseUrl)]),
    approvals: new RoutingApprovalHandler(
      new Map<string, ApprovalHandler>([
        ["propose_edit", reviewHandler],
        ["create_file", reviewHandler],
        ["run_command", new CommandApprovalHandler({ inner: panel, getRunId: () => runScope.runId, getRoot: () => host.rootPath(), tickets, registry, log: (m) => log.info(m) })],
      ]),
      panel,
    ),
    prepare: (request) => preflight({ bootstrap: () => bootstrapper.run(), getClient, baseUrl: () => status.baseUrl }, request),
    log: (m) => log.info(m),
    getRunId: () => runScope.runId,
    registry,
    chain: {
      models: () => vscode.workspace.getConfiguration("forge").get<string[]>("models", []).filter((m) => m.trim() !== ""),
      stall: () => {
        const cfg = vscode.workspace.getConfiguration("forge");
        return { firstMs: cfg.get<number>("stallFirstEventSeconds", 45) * 1000, idleMs: cfg.get<number>("stallIdleSeconds", 90) * 1000 };
      },
      sideEffects: (runId) => sideEffects.of(runId),
      sessionUrl: (id) => sessionUrl(status.baseUrl, id),
    },
    cancel: {
      // Stop: kill commands, drop what could still act for the run, let an in-flight apply finish, then roll back.
      cancelWork: () => {
        commands.cancelAll();
        decisions.clear();
        tickets.clear();
      },
      settle: () => reviewHandler.idle(),
      rollbackEnabled: () => vscode.workspace.getConfiguration("forge").get<boolean>("rollbackOnCancel", true),
      rollback: async (runId) => {
        const result = await checkpoints.rollbackRun(runId, new VscodeRestorer(host, false)); // never asks, never overwrites the user's own edits
        return { restored: result.restored, skipped: result.skipped, failed: result.failed };
      },
      changedFiles: (runId) => checkpoints.filesOf(runId),
    },
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
  context.subscriptions.push(registerInlineEdit({ controller, undo: undoLastRun, memento: context.globalState, log }));

  // Context assembly for panel turns: the <context> block goes to the model, the transcript shows what was typed.
  let preparing = false;
  let priorMessageTokens = 0;
  const sendWithContext = async (text: string, chips: ReadonlyArray<{ kind: "file" | "symbol"; value: string }>): Promise<void> => {
    if (controller.runState.busy || preparing) return;
    preparing = true;
    let turn: Awaited<ReturnType<typeof buildTurnContext>>;
    try {
      const budget = vscode.workspace.getConfiguration("forge").get<number>("contextBudgetTokens", 6000);
      turn = await buildTurnContext(contextService.index, host, { text, chips, budgetTokens: budget });
    } catch (err) {
      log.warn(`context assembly failed, sending without context: ${err instanceof Error ? err.message : String(err)}`);
      turn = { message: text, display: text, blockTokens: 0, plan: { budgetTokens: 0, usedTokens: 0, items: [], warnings: ["Context assembly failed; sent without context."] } };
    } finally {
      preparing = false;
    }
    log.info(`context: ${turn.plan.items.length} items, ${turn.plan.usedTokens}/${turn.plan.budgetTokens} tokens${turn.plan.retrievalMs !== undefined ? `, retrieved in ${turn.plan.retrievalMs.toFixed(1)} ms` : ""}${turn.plan.note ? `; ${turn.plan.note}` : ""}`);
    panel.showContext(turn.plan);
    const result = await controller.send(turn.message, { display: turn.display });
    if (!result.ok || turn.blockTokens === 0) return;
    const calls = result.view.usage.filter((u) => u.threadId === (result.view.usage[0]?.threadId ?? "main"));
    const first = calls[0];
    if (first) log.info(describeUsage({ message: turn.message, blockTokens: turn.blockTokens, inputTokens: first.inputTokens, messageTokens: first.messageTokens, priorMessageTokens }));
    const last = calls[calls.length - 1];
    if (last?.messageTokens !== undefined) priorMessageTokens = last.messageTokens;
  };

  panel.setHandlers({
    send: (text, mentions) => void sendWithContext(text, mentions),
    suggest: (kind, query) => (kind === "file" ? suggestFiles(contextService.index, query) : suggestSymbols(contextService.index, query)).map((s) => ({ kind: s.kind, value: s.value, ...("detail" in s ? { detail: s.detail } : {}) })),
    stop: () => void controller.stop(),
    newChat: () => {
      priorMessageTokens = 0;
      void controller.newChat();
    },
    openReview: (callId) => void reviewUi.open(callId),
    undoRun: () => void undoLastRun(),
  });
  context.subscriptions.push({ dispose: events.onContextRead((e) => panel.noteContextRead(e)) });
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
    vscode.commands.registerCommand("forge.switchModel", async () => {
      try {
        const listed = (await getClient().models.list()).data.map((m) => m.name).sort();
        const current = vscode.workspace.getConfiguration("forge").get<string[]>("models", []);
        const picked = await vscode.window.showQuickPick(
          listed.map((name) => ({ label: name, description: name === current[0] ? "in use" : current.includes(name) ? "fallback" : "" })),
          { title: "Forge: Switch Model", placeHolder: "Choose the model to use first (the rest of forge.models stays as the fallback chain)" },
        );
        if (!picked) return;
        // user settings (Global), never the workspace: the Flask checkout must stay clean
        await vscode.workspace.getConfiguration("forge").update("models", promoteModel(current, picked.label), vscode.ConfigurationTarget.Global);
        void vscode.window.showInformationMessage(`Forge will use ${picked.label} first. The next message starts a new session on it.`);
      } catch (err) {
        void vscode.window.showErrorMessage(`Forge: could not list the models from TrueForge (${err instanceof Error ? err.message : String(err)}). Is TrueForge running?`);
      }
    }),
    vscode.commands.registerCommand("forge.rebuildContextIndex", () => contextService.rebuild()),
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
