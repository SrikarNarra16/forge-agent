import * as vscode from "vscode";
import type { EditorUi } from "../mcp/editorUi";
import type { WorkspaceHost } from "../mcp/host";

/** open_in_editor: reveals a file/line for the user. Read-only UI action; never edits. */
export class VscodeEditorUi implements EditorUi {
  constructor(private readonly host: WorkspaceHost) {}

  async reveal(path: string, line?: number): Promise<void> {
    const root = await this.host.rootPath();
    const doc = await vscode.workspace.openTextDocument(vscode.Uri.file(`${root}/${path}`));
    const at = line !== undefined ? new vscode.Position(Math.max(0, Math.min(line - 1, doc.lineCount - 1)), 0) : new vscode.Position(0, 0);
    await vscode.window.showTextDocument(doc, { selection: new vscode.Range(at, at), preview: true, preserveFocus: true });
  }
}
