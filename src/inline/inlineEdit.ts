import * as path from "node:path";
import * as vscode from "vscode";
import { isInside } from "../util/paths";
import type { Logger } from "../util/log";
import { MAX_HISTORY, pushHistory, snapshotSelection } from "./message";
import { runInlineEdit, type InlineController, type InlineUi } from "./runner";

/**
 * "Forge: Edit Selection…" (Cmd+Alt+K / Ctrl+Alt+K, editor context menu): captures the selection, asks for an
 * instruction (with a 20-entry history) and runs it on the `forge-inline` agent in a fresh session through the
 * shared AgentController. No progress notification is awaited anywhere: a status bar item shows the run and
 * is removed when it ends, followed by ONE message with an Undo button.
 */
export const INLINE_AGENT = "forge-inline"; // default; the prefixed name comes in through InlineEditDeps.agentName
const HISTORY_KEY = "forge.inlineHistory";

export interface InlineEditDeps {
  controller: InlineController;
  /** Name of the inline agent in TrueForge (default `forge-inline`, or the prefixed one). */
  agentName?: string;
  /** Rolls back the last agent run (the Undo button). */
  undo: () => Promise<void>;
  memento: vscode.Memento;
  log: Logger;
}

/** QuickPick as an input box with history: type to enter an instruction, Up/Down to pick a recent one. */
function pickInstruction(history: readonly string[]): Promise<string | undefined> {
  return new Promise((resolve) => {
    const quickPick = vscode.window.createQuickPick<vscode.QuickPickItem>();
    quickPick.title = "Forge: Edit Selection";
    quickPick.placeholder = "What should change?  Enter to run  ·  ↑/↓ for recent instructions";
    quickPick.ignoreFocusOut = true;
    let result: string | undefined;

    const historyItems = history.map((label): vscode.QuickPickItem => ({ label, description: "recent", alwaysShow: true }));
    const refresh = (): void => {
      const typed = quickPick.value.trim();
      if (typed === "") {
        quickPick.items = historyItems;
        quickPick.activeItems = []; // Enter with nothing typed must not silently re-run an old instruction
        return;
      }
      const matching = historyItems.filter((i) => i.label !== typed && i.label.toLowerCase().includes(typed.toLowerCase()));
      quickPick.items = [{ label: typed, description: "Enter to run", alwaysShow: true }, ...matching];
    };
    quickPick.onDidChangeValue(refresh);
    quickPick.onDidAccept(() => {
      const picked = quickPick.activeItems[0]?.label ?? quickPick.value.trim();
      if (picked.trim() === "") return;
      result = picked.trim();
      quickPick.hide();
    });
    quickPick.onDidHide(() => {
      quickPick.dispose();
      resolve(result);
    });
    refresh();
    quickPick.show();
  });
}

function createUi(deps: InlineEditDeps): InlineUi {
  return {
    busy: () => void vscode.window.showInformationMessage("Forge is busy with another run. Wait for it to finish or stop it first."),
    running: () => {
      const item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
      item.text = "$(sync~spin) Forge: editing… (click to stop)";
      item.tooltip = "Stop this edit";
      item.command = "forge.stop";
      item.show();
      return () => item.dispose();
    },
    // Fire and forget: nothing waits on these messages, so no progress UI can be left hanging behind them.
    applied: (message) => void vscode.window.showInformationMessage(message, "Undo").then((choice) => (choice === "Undo" ? deps.undo() : undefined)),
    info: (message) => void vscode.window.showInformationMessage(message),
    error: (message) => void vscode.window.showErrorMessage(message),
  };
}

export function registerInlineEdit(deps: InlineEditDeps): vscode.Disposable {
  const ui = createUi(deps);
  return vscode.commands.registerCommand("forge.inlineEdit", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.selection.isEmpty) {
      void vscode.window.showInformationMessage("Select some code first");
      return;
    }
    if (deps.controller.runState.busy) {
      ui.busy();
      return;
    }
    const document = editor.document;
    const root = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!root || document.uri.scheme !== "file" || !isInside(root, document.uri.fsPath)) {
      void vscode.window.showInformationMessage("Forge can only edit saved files inside the open workspace folder.");
      return;
    }

    const snapshot = snapshotSelection({
      text: document.getText(), // the live buffer: unsaved edits included, same as the agent's read_file
      start: editor.selection.start,
      end: editor.selection.end,
      path: path.relative(root, document.uri.fsPath).split(path.sep).join("/"),
      languageId: document.languageId,
    });
    if (!snapshot.ok) {
      void vscode.window.showInformationMessage("Select some code first");
      return;
    }

    const history = deps.memento.get<string[]>(HISTORY_KEY, []).slice(0, MAX_HISTORY);
    const instruction = await pickInstruction(history);
    if (!instruction) return;
    await deps.memento.update(HISTORY_KEY, pushHistory(history, instruction));

    deps.log.info(`inline edit: ${snapshot.snapshot.path}:${snapshot.snapshot.startLine}-${snapshot.snapshot.endLine}`);
    // Not awaited by anything that shows progress; the controller reports through the shared UI sinks.
    void runInlineEdit({ controller: deps.controller, ui, agentName: deps.agentName ?? INLINE_AGENT }, { snapshot: snapshot.snapshot, instruction });
  });
}
