import * as path from "node:path";
import * as vscode from "vscode";
import type { InlineEditHandle } from "../inline/inlineEdit";
import type { ReviewUi } from "../review/reviewUi";
import type { AgentController, NoticeLevel, UiSink } from "../trueforge/agentController";
import type { ReducerChange, TurnView } from "../trueforge/events";
import type { ChainEvent } from "../trueforge/modelChain";
import type { RunState } from "../trueforge/runState";
import type { PanelUi } from "../ui/panel";

/**
 * End-to-end test hooks. Registered ONLY when the environment variable FORGE_E2E=1 (extension.ts checks it), and
 * not declared in package.json, so a normal install does not have them. The hooks only DRIVE the real extension:
 * they call the same functions and commands a user triggers (the panel's send path, the inline-edit function that
 * follows the QuickPick, forge.review* commands, the webview's own message handler). They never write files,
 * apply edits, register providers or touch documents themselves (test/e2eHooks.test.ts scans this file for that).
 */

/** Records what the UI sinks see, so `forge.e2e.state` can report it. */
export class E2eRecorder implements UiSink {
  readonly states: RunState[] = [];
  readonly chainEvents: ChainEvent[] = [];
  readonly notices: Array<{ level: NoticeLevel; text: string }> = [];
  readonly sessions: string[] = [];
  readonly models: string[] = [];
  discards = 0;
  lastView: TurnView | undefined;

  onState(state: RunState): void {
    this.states.push(state);
  }
  onUserMessage(): void {}
  onTurnChange(view: TurnView, _change: ReducerChange): void {
    this.lastView = view;
  }
  onSession(info: { sessionId: string; model?: string }): void {
    this.sessions.push(info.sessionId);
    if (info.model) this.models.push(info.model);
  }
  onNotice(level: NoticeLevel, text: string): void {
    this.notices.push({ level, text });
  }
  onReset(): void {}
  onChain(event: ChainEvent): void {
    this.chainEvents.push(event);
  }
  onAttemptDiscarded(): void {
    this.discards++;
  }

  usage(): { input: number; output: number; calls: number } {
    const usage = this.lastView?.usage ?? [];
    return { input: usage.reduce((n, u) => n + u.inputTokens, 0), output: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0), calls: usage.length };
  }
}

export interface E2eDeps {
  panel: PanelUi;
  controller: AgentController;
  reviewUi: ReviewUi;
  recorder: E2eRecorder;
  inline: InlineEditHandle;
  /** The panel's Send path (context assembly + controller.send). */
  sendPanel: (prompt: string) => Promise<void>;
  names: { editor: string; extras: string; agent: string; inline: string; prefix: string };
}

/** How the autopilot decides: all of it goes through the real review commands and the webview's message handler. */
export type DecidePolicy =
  | { review: "acceptAll" | "rejectAll"; commands?: "allow" | "deny" }
  | { review: "rejectHunkMatching"; pattern: string; commands?: "allow" | "deny" }
  /** Reject hunk `index` of the FIRST review only; every other hunk and review is accepted. */
  | { review: "rejectIndexOfFirst"; index: number; commands?: "allow" | "deny" }
  | { review: "none"; commands?: "allow" | "deny" };

function policyFrom(raw: unknown): DecidePolicy | undefined {
  if (raw === "stop" || raw === "none" || raw === undefined) return undefined;
  if (typeof raw === "string") {
    if (raw === "acceptAll" || raw === "rejectAll") return { review: raw, commands: "allow" };
    if (raw === "allowCommands") return { review: "none", commands: "allow" };
    const index = /^rejectIndexOfFirst:(\d+)$/.exec(raw);
    if (index) return { review: "rejectIndexOfFirst", index: Number(index[1]), commands: "allow" };
    if (raw.startsWith("rejectHunk:")) return { review: "rejectHunkMatching", pattern: raw.slice("rejectHunk:".length), commands: "allow" };
  }
  if (typeof raw === "object" && raw !== null) return raw as DecidePolicy;
  return undefined;
}

export function registerE2eHooks(deps: E2eDeps): vscode.Disposable[] {
  const { panel, controller, reviewUi, recorder } = deps;
  const handledReviews = new Set<string>();
  const handledCommands = new Set<string>();
  let policy: DecidePolicy | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;

  const step = async (): Promise<void> => {
    if (!policy) return;
    const snapshot = panel.snapshot();
    for (const entry of snapshot.review) {
      if (entry.state !== "reviewing" || handledReviews.has(entry.callId) || policy.review === "none") continue;
      handledReviews.add(entry.callId);
      const peek = reviewUi.peek(entry.callId);
      if (policy.review === "rejectAll") {
        await vscode.commands.executeCommand("forge.reviewRejectAll", entry.callId);
      } else if (policy.review === "acceptAll") {
        await vscode.commands.executeCommand("forge.reviewAcceptAll", entry.callId);
        await vscode.commands.executeCommand("forge.reviewApply", entry.callId);
      } else if (policy.review === "rejectIndexOfFirst" && peek) {
        const first = handledReviews.size === 1; // this is the first review the autopilot sees
        for (const hunk of peek.hunks) {
          await vscode.commands.executeCommand(first && hunk.id === policy.index ? "forge.reviewRejectHunk" : "forge.reviewAcceptHunk", entry.callId, hunk.id);
        }
        await vscode.commands.executeCommand("forge.reviewApply", entry.callId);
      } else if (policy.review === "rejectHunkMatching" && peek) {
        const pattern = new RegExp(policy.pattern);
        for (const hunk of peek.hunks) {
          await vscode.commands.executeCommand(pattern.test(hunk.text) ? "forge.reviewRejectHunk" : "forge.reviewAcceptHunk", entry.callId, hunk.id);
        }
        await vscode.commands.executeCommand("forge.reviewApply", entry.callId);
      }
    }
    for (const item of snapshot.items) {
      if (item.kind !== "tool" || item.name !== "run_command" || item.approval !== "pending" || handledCommands.has(item.id)) continue;
      handledCommands.add(item.id);
      // the same message the webview posts when its Allow / Deny button is clicked
      panel.receive({ type: "approval", callId: item.id, decision: policy.commands === "deny" ? "deny" : "allow", ...(policy.commands === "deny" ? { reason: "denied by the e2e policy" } : {}) });
    }
  };

  const state = (): unknown => {
    const snapshot = panel.snapshot();
    const chainItem = snapshot.items.find((i) => i.id === "chain-status");
    return {
      runState: controller.state,
      stateHistory: [...recorder.states],
      statusLine: snapshot.status,
      items: snapshot.items.map((i) => {
        switch (i.kind) {
          case "tool":
            return { kind: i.kind, id: i.id, name: i.name, status: i.status, approval: i.approval, command: i.command, review: i.review, resultPreview: i.resultPreview };
          case "assistant":
            return { kind: i.kind, id: i.id, text: i.text, streaming: i.streaming };
          case "notice":
            return { kind: i.kind, id: i.id, level: i.level, text: i.text };
          default:
            return i;
        }
      }),
      review: snapshot.review,
      context: snapshot.context,
      chainNotice: chainItem && chainItem.kind === "notice" ? chainItem.text : undefined,
      chainEvents: recorder.chainEvents,
      notices: recorder.notices,
      sessions: recorder.sessions,
      models: recorder.models,
      discards: recorder.discards,
      usage: recorder.usage(),
      panelViewResolved: panel.hasView,
      readyCount: panel.readyMessages,
      resourcePrefix: deps.names.prefix,
      names: deps.names,
    };
  };

  const disposables: vscode.Disposable[] = [
    vscode.commands.registerCommand("forge.e2e.sendPanel", (args?: { prompt?: string }) => {
      if (typeof args?.prompt !== "string" || args.prompt.trim() === "") throw new Error("forge.e2e.sendPanel needs { prompt }");
      void deps.sendPanel(args.prompt); // returns at once, like clicking Send; poll forge.e2e.state
      return { started: true };
    }),
    vscode.commands.registerCommand("forge.e2e.inlineEdit", async (args?: { path?: string; startLine?: number; endLine?: number; instruction?: string }) => {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
      if (!root || typeof args?.path !== "string" || typeof args.startLine !== "number" || typeof args.endLine !== "number" || typeof args.instruction !== "string") {
        throw new Error("forge.e2e.inlineEdit needs { path, startLine, endLine, instruction } (1-based, inclusive lines)");
      }
      const document = await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(root, args.path)));
      const editor = await vscode.window.showTextDocument(document);
      const last = document.lineAt(Math.min(args.endLine, document.lineCount) - 1);
      editor.selection = new vscode.Selection(new vscode.Position(args.startLine - 1, 0), last.range.end); // a real selection in a real editor
      await deps.inline.runWith(args.instruction);
      return { started: true };
    }),
    vscode.commands.registerCommand("forge.e2e.state", state),
    vscode.commands.registerCommand("forge.e2e.decide", (args?: { policy?: unknown }) => {
      policy = policyFrom(args?.policy);
      handledReviews.clear();
      handledCommands.clear();
      if (timer) clearInterval(timer);
      timer = undefined;
      if (policy) {
        timer = setInterval(() => void step().catch(() => undefined), 150);
        timer.unref?.();
      }
      return { policy: policy ?? "stopped" };
    }),
    { dispose: () => timer && clearInterval(timer) },
  ];
  return disposables;
}
