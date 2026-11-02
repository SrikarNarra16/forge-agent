import * as vscode from "vscode";
import { ContextIndex } from "../context/indexer";
import type { WorkspaceHost } from "../mcp/host";
import { createIgnoreMatcher, type IgnoreMatcher } from "../mcp/ignore";
import type { Logger } from "../util/log";

const DEBOUNCE_MS = 400;
const GITIGNORE_TTL_MS = 30_000;
const BLOCKED = /(^|\/)(\.git|node_modules|\.venv)(\/|$)/;

/**
 * Owns the context index in the editor: builds it in the background at activation (async, chunked, abortable),
 * keeps it current from file-system events and unsaved edits (debounced), and shows its state in the status
 * bar. Nothing here blocks the extension host: every step awaits and the index yields between files.
 */
export class ContextService implements vscode.Disposable {
  readonly index = new ContextIndex();
  private readonly item: vscode.StatusBarItem;
  private readonly disposables: vscode.Disposable[] = [];
  private readonly pending = new Map<string, ReturnType<typeof setTimeout>>();
  private abort: AbortController | undefined;
  private ignore: { matcher: IgnoreMatcher; at: number } | undefined;
  private disposed = false;

  constructor(
    private readonly host: WorkspaceHost,
    private readonly log: Logger,
  ) {
    this.item = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 99);
    this.item.command = "forge.rebuildContextIndex";
    this.item.name = "Forge context index";
    this.item.text = "$(search) Forge: index";
    this.item.show();

    const watcher = vscode.workspace.createFileSystemWatcher("**/*");
    this.disposables.push(
      watcher,
      watcher.onDidCreate((uri) => this.touch(uri)),
      watcher.onDidChange((uri) => this.touch(uri)),
      watcher.onDidDelete((uri) => this.forget(uri)),
      vscode.workspace.onDidChangeTextDocument((e) => {
        if (e.document.uri.scheme === "file" && e.contentChanges.length > 0) this.touch(e.document.uri);
      }),
    );
  }

  /** Starts (or restarts) the full build in the background. */
  rebuild(): void {
    this.abort?.abort();
    const controller = new AbortController();
    this.abort = controller;
    this.item.text = "$(sync~spin) Forge: indexing…";
    this.item.tooltip = "Forge is indexing the workspace for context retrieval.";
    void this.index
      .build(this.host, {
        signal: controller.signal,
        onProgress: ({ done, total }) => {
          if (!this.disposed) this.item.text = `$(sync~spin) Indexing ${done}/${total}`;
        },
      })
      .then((stats) => {
        if (this.disposed || controller.signal.aborted) return;
        this.item.text = `$(search) ${stats.files} files`;
        this.item.tooltip = `Forge context index: ${stats.files} files, ${stats.chunks} chunks, built in ${Math.round(stats.buildMs)} ms${stats.truncated ? " (capped)" : ""}. Click to rebuild.`;
        this.log.info(`context index ready: ${stats.files} files, ${stats.chunks} chunks, ${Math.round(stats.buildMs)} ms${stats.truncated ? " (capped)" : ""}`);
      })
      .catch((err: unknown) => {
        if (controller.signal.aborted || this.disposed) return;
        this.item.text = "$(warning) Forge: index failed";
        this.item.tooltip = "Context index failed; click to retry. search_code and repo_map still work by scanning files.";
        this.log.error("context index build failed", err);
      });
  }

  private relative(uri: vscode.Uri): string | undefined {
    if (uri.scheme !== "file") return undefined;
    const folder = vscode.workspace.getWorkspaceFolder(uri);
    if (!folder) return undefined;
    const rel = vscode.workspace.asRelativePath(uri, false).replace(/\\/g, "/");
    return rel === "" || BLOCKED.test(rel) ? undefined : rel;
  }

  private async isIgnored(rel: string): Promise<boolean> {
    if (!this.ignore || Date.now() - this.ignore.at > GITIGNORE_TTL_MS) {
      let text: string | undefined;
      try {
        text = await this.host.readText(".gitignore");
      } catch {
        text = undefined;
      }
      this.ignore = { matcher: createIgnoreMatcher(text), at: Date.now() };
    }
    return this.ignore.matcher.isIgnored(rel, false);
  }

  private touch(uri: vscode.Uri): void {
    const rel = this.relative(uri);
    if (rel === undefined || this.disposed || !this.index.ready) return; // a running build will see the change
    clearTimeout(this.pending.get(rel));
    this.pending.set(
      rel,
      setTimeout(() => {
        this.pending.delete(rel);
        void this.refresh(rel);
      }, DEBOUNCE_MS),
    );
  }

  private async refresh(rel: string): Promise<void> {
    try {
      if (!this.index.hasFile(rel) && (await this.isIgnored(rel))) return;
      await this.index.update(this.host, rel);
    } catch (err) {
      this.log.warn(`context index update failed for ${rel}: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private forget(uri: vscode.Uri): void {
    const rel = this.relative(uri);
    if (rel === undefined) return;
    clearTimeout(this.pending.get(rel));
    this.pending.delete(rel);
    this.index.remove(rel);
  }

  dispose(): void {
    this.disposed = true;
    this.abort?.abort();
    for (const timer of this.pending.values()) clearTimeout(timer);
    this.pending.clear();
    for (const d of this.disposables) d.dispose();
    this.item.dispose();
  }
}
