import { UserModifiedError } from "./checkpoints";
import * as path from "node:path";
import * as vscode from "vscode";
import { HostError, type WorkspaceHost } from "../mcp/host";
import { applyAccepted, type ApplyIo, type ApplyRequest } from "./applyCore";
import type { CheckpointStore, FileRestorer } from "./checkpoints";
import { hashText } from "./hash";
import type { ReviewEditor } from "./reviewHandler";

/**
 * The ONLY place in the extension that changes files. Accepted hunks go into ONE WorkspaceEdit (a single
 * undo step, so Cmd+Z on the result undoes the whole apply) and the document is saved. A grep test
 * (test/writeIsolation.test.ts) enforces that no other source file writes or calls applyEdit/save.
 */

function uriOf(root: string, rel: string): vscode.Uri {
  return vscode.Uri.file(path.join(root, ...rel.split("/")));
}

export class VscodeApplyIo implements ApplyIo {
  constructor(private readonly host: WorkspaceHost) {}

  /** Live text the same way the review read it (open buffer, else disk); undefined when the file is gone. */
  async readLive(rel: string): Promise<string | undefined> {
    try {
      return await this.host.readText(rel);
    } catch (err) {
      if (err instanceof HostError && err.code === "ENOENT") return undefined;
      throw err;
    }
  }

  async write(request: ApplyRequest): Promise<void> {
    const root = await this.host.rootPath();
    const uri = uriOf(root, request.path);
    const edit = new vscode.WorkspaceEdit();

    if (request.kind === "create") {
      edit.createFile(uri, { ignoreIfExists: false });
      edit.insert(uri, new vscode.Position(0, 0), request.newText);
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code could not create ${request.path}`);
      const created = await vscode.workspace.openTextDocument(uri);
      if (!(await created.save())) throw new Error(`${request.path} was created but could not be saved`);
      return;
    }

    const document = await vscode.workspace.openTextDocument(uri);
    for (const e of request.edits) {
      // Original line coordinates; validateRange clamps an end past the last line to the end of the document.
      edit.replace(uri, document.validateRange(new vscode.Range(e.startLine, 0, e.endLine, 0)), e.text);
    }
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the edit to ${request.path}`);
    if (!(await document.save())) throw new Error(`${request.path} was changed but could not be saved`);
  }
}

/** ReviewEditor over VS Code: reads through the WorkspaceHost, writes through the apply core (verify, checkpoint, write). */
export class VscodeReviewEditor implements ReviewEditor {
  private readonly io: VscodeApplyIo;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly checkpoints: CheckpointStore,
  ) {
    this.io = new VscodeApplyIo(host);
  }

  rootPath(): Promise<string> {
    return this.host.rootPath();
  }

  readText(rel: string): Promise<string> {
    return this.host.readText(rel);
  }

  apply(request: ApplyRequest): Promise<void> {
    return applyAccepted(this.io, this.checkpoints, request);
  }
}

/** Puts files back from a checkpoint; warns before overwriting something the user changed after Forge wrote it. */
export class VscodeRestorer implements FileRestorer {
  /** interactive=false (cancel): never ask, never overwrite a file the user changed (UserModifiedError -> skipped + warning). */
  constructor(
    private readonly host: WorkspaceHost,
    private readonly interactive = true,
  ) {}

  async restoreText(rel: string, text: string, expectedCurrentHash: string | undefined): Promise<void> {
    const root = await this.host.rootPath();
    const uri = uriOf(root, rel);
    const document = await vscode.workspace.openTextDocument(uri);
    await this.confirmIfChanged(rel, document.getText(), expectedCurrentHash, "Restore the original anyway? This discards those later changes.");
    const edit = new vscode.WorkspaceEdit();
    edit.replace(uri, document.validateRange(new vscode.Range(0, 0, document.lineCount, 0)), text);
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code rejected the restore of ${rel}`);
    if (!(await document.save())) throw new Error(`${rel} was restored but could not be saved`);
  }

  async deleteFile(rel: string, expectedCurrentHash: string | undefined): Promise<void> {
    const root = await this.host.rootPath();
    const uri = uriOf(root, rel);
    try {
      const document = await vscode.workspace.openTextDocument(uri);
      await this.confirmIfChanged(rel, document.getText(), expectedCurrentHash, "Delete it anyway? This discards those changes.");
    } catch (err) {
      if (err instanceof vscode.FileSystemError && err.code === "FileNotFound") return; // already gone
      throw err;
    }
    const edit = new vscode.WorkspaceEdit();
    edit.deleteFile(uri, { ignoreIfNotExists: true });
    if (!(await vscode.workspace.applyEdit(edit))) throw new Error(`VS Code could not delete ${rel}`);
  }

  private async confirmIfChanged(rel: string, current: string, expectedHash: string | undefined, question: string): Promise<void> {
    if (expectedHash === undefined || hashText(current) === expectedHash) return;
    if (!this.interactive) throw new UserModifiedError(rel);
    const choice = await vscode.window.showWarningMessage(`${rel} was changed after Forge edited it. ${question}`, { modal: true }, "Continue");
    if (choice !== "Continue") throw new Error(`skipped ${rel}: it changed after Forge edited it`);
  }
}
