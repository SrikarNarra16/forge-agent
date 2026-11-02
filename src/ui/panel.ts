import { randomBytes } from "node:crypto";
import * as vscode from "vscode";
import type { ApprovalDecision, ApprovalHandler, NoticeLevel, PendingToolCall, UiSink } from "../trueforge/agentController";
import type { ReducerChange, TurnView } from "../trueforge/events";
import type { RunState } from "../trueforge/runState";
import type { Logger } from "../util/log";
import { Batcher } from "./batcher";
import { parseWebMessage, type ChatItem, type ExtToWeb, type StatusInfo } from "./protocol";
import { Transcript, prettyArgs, summarizeArgs } from "./transcript";

/**
 * The Agent panel. `PanelUi` is the UiSink and the ApprovalHandler for the controller: it keeps the
 * transcript for the current session, batches streamed updates to the webview (at most one flush per
 * 30 ms), shows approval requests as inline cards and resolves them from the webview's Allow/Deny
 * clicks. `AgentViewProvider` serves the CSP-locked webview page and hands the view to `PanelUi`.
 */

export const DEFAULT_DENY_REASON = "The user denied this tool call.";
const FLUSH_INTERVAL_MS = 30;

export interface PanelHandlers {
  send(text: string): void;
  stop(): void;
  newChat(): void;
}

interface PendingApproval {
  resolve(decision: ApprovalDecision): void;
}

export class PanelUi implements UiSink, ApprovalHandler, vscode.Disposable {
  private view: vscode.WebviewView | undefined;
  private handlers: PanelHandlers | undefined;
  private status: StatusInfo = { state: "idle" };
  private readonly transcript = new Transcript();
  private readonly batcher = new Batcher<ChatItem>((items) => this.post({ type: "upsert", items }), FLUSH_INTERVAL_MS);
  private readonly pending = new Map<string, PendingApproval>();
  private readonly testCards = new Set<string>();
  private testCardCounter = 0;

  constructor(private readonly log: Logger) {}

  setHandlers(handlers: PanelHandlers): void {
    this.handlers = handlers;
  }

  /** Called when VS Code resolves (or re-resolves) the webview view. The webview asks for the transcript with `ready`. */
  attach(view: vscode.WebviewView): void {
    this.view = view;
    const subscription = view.webview.onDidReceiveMessage((raw: unknown) => this.onMessage(raw));
    view.onDidDispose(() => {
      subscription.dispose();
      if (this.view === view) this.view = undefined;
    });
  }

  dispose(): void {
    this.batcher.dispose();
    this.pending.clear();
  }

  // --- UiSink -------------------------------------------------------------------------------------

  onState(state: RunState, detail?: string): void {
    this.status = { ...this.status, state, ...(detail ? { detail } : {}), compacting: false };
    if (!detail) delete this.status.detail;
    this.batcher.flush(); // deliver pending text before the state change so "Done" never precedes the last token
    this.post({ type: "status", status: this.status });
  }

  onUserMessage(text: string): void {
    this.batcher.push(this.transcript.addUser(text));
  }

  onTurnChange(view: TurnView, change: ReducerChange): void {
    for (const item of this.transcript.applyTurn(view, change)) this.batcher.push(item);
    if (change.compaction) {
      this.status = { ...this.status, compacting: view.compaction.active };
      this.post({ type: "status", status: this.status });
    }
  }

  onSession(info: { sessionId: string; model?: string }): void {
    if (info.model) this.status = { ...this.status, model: info.model };
    this.post({ type: "status", status: this.status });
  }

  onNotice(level: NoticeLevel, text: string): void {
    this.batcher.push(this.transcript.addNotice(level, text));
  }

  onReset(): void {
    this.batcher.clear();
    this.transcript.clear();
    this.post({ type: "reset" });
  }

  // --- ApprovalHandler (inline cards) -----------------------------------------------------------------

  decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision> {
    return new Promise<ApprovalDecision>((resolve, reject) => {
      if (signal.aborted) {
        reject(new Error("Approval cancelled"));
        return;
      }
      const onAbort = (): void => {
        this.pending.delete(call.id);
        const item = this.transcript.setApproval(call.id, "denied", "denied");
        if (item) this.batcher.push(item);
        reject(new Error("Approval cancelled"));
      };
      signal.addEventListener("abort", onAbort, { once: true });
      this.pending.set(call.id, {
        resolve: (decision) => {
          signal.removeEventListener("abort", onAbort);
          this.pending.delete(call.id);
          resolve(decision);
        },
      });
      void this.reveal(); // make sure the user can see the card
    });
  }

  // --- debug: a fake approval card, no TrueForge involved -----------------------------------------------

  async showTestApprovalCard(): Promise<void> {
    const id = `test-approval-${++this.testCardCounter}`;
    const args = JSON.stringify({
      path: "src/flask/helpers.py",
      summary: "Treat 'off' and 'n' as false in get_debug_flag",
      edits: [{ old_text: 'not in {"0", "false", "no"}', new_text: 'not in {"0", "false", "no", "off", "n"}' }],
    });
    this.testCards.add(id);
    this.batcher.push(
      this.transcript.upsert({ kind: "tool", id, name: "propose_edit", argsSummary: summarizeArgs(args), args: prettyArgs(args), status: "awaiting_approval", approval: "pending" }),
    );
    this.batcher.push(this.transcript.addNotice("info", "This is a test approval card (Forge: Show Test Approval Card). Nothing is sent to TrueForge."));
    await this.reveal();
  }

  async reveal(): Promise<void> {
    await vscode.commands.executeCommand("forge.agentView.focus");
  }

  // --- messages from the webview ----------------------------------------------------------------------

  private onMessage(raw: unknown): void {
    const message = parseWebMessage(raw);
    if (!message) {
      this.log.warn("ignored a malformed message from the Agent panel");
      return;
    }
    switch (message.type) {
      case "ready":
        this.post({ type: "init", items: [...this.transcript.items], status: this.status });
        break;
      case "send":
        this.handlers?.send(message.text);
        break;
      case "stop":
        this.handlers?.stop();
        break;
      case "newChat":
        this.handlers?.newChat();
        break;
      case "approval":
        this.resolveApproval(message.callId, message.decision, message.reason);
        break;
    }
  }

  private resolveApproval(callId: string, decision: "allow" | "deny", reason: string | undefined): void {
    const allowed = decision === "allow";
    if (this.testCards.has(callId)) {
      this.testCards.delete(callId);
      this.log.info(`test approval card: user clicked ${allowed ? "Allow" : "Deny"}${reason ? ` (reason: ${reason})` : ""}`);
      const item = this.transcript.setApproval(callId, allowed ? "allowed" : "denied", allowed ? "done" : "denied");
      if (item) this.batcher.push(item);
      this.batcher.push(this.transcript.addNotice("info", `Test card: you clicked ${allowed ? "Allow" : "Deny"}. No call was made to TrueForge.`));
      return;
    }
    const pending = this.pending.get(callId);
    if (!pending) {
      this.log.warn(`approval for ${callId} ignored: nothing is waiting for it`);
      return;
    }
    const item = this.transcript.setApproval(callId, allowed ? "allowed" : "denied"); // optimistic; the controller confirms
    if (item) this.batcher.push(item);
    pending.resolve(allowed ? { status: "allow" } : { status: "deny", reason: reason || DEFAULT_DENY_REASON });
  }

  private post(message: ExtToWeb): void {
    void this.view?.webview.postMessage(message);
  }
}

/** Webview view provider for `forge.agentView`: serves a CSP-locked page (nonce'd script, external stylesheet). */
export class AgentViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "forge.agentView";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly ui: PanelUi,
  ) {}

  resolveWebviewView(view: vscode.WebviewView): void {
    const distUri = vscode.Uri.joinPath(this.extensionUri, "dist");
    view.webview.options = { enableScripts: true, localResourceRoots: [distUri] };
    view.webview.html = this.renderHtml(view.webview, distUri);
    this.ui.attach(view);
  }

  private renderHtml(webview: vscode.Webview, distUri: vscode.Uri): string {
    const nonce = randomBytes(16).toString("base64");
    const script = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.js"));
    const style = webview.asWebviewUri(vscode.Uri.joinPath(distUri, "webview.css"));
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource}`,
      `script-src 'nonce-${nonce}'`,
      `img-src ${webview.cspSource}`,
      `font-src ${webview.cspSource}`,
    ].join("; ");
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${style.toString()}">
  <title>Forge</title>
</head>
<body>
  <div id="app"></div>
  <script nonce="${nonce}" src="${script.toString()}"></script>
</body>
</html>`;
  }
}
