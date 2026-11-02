import * as vscode from "vscode";

/**
 * In-memory, READ-ONLY file system for the `forge-proposal:` scheme. It holds the PROPOSED text shown on
 * the right of the review diff (and an empty "original" for new files). Only Forge changes the content
 * (`set`), so the user decides per hunk with the lenses instead of typing into the proposal, which would
 * desynchronise hunks and decisions. Nothing here touches the real file system.
 */
export const PROPOSAL_SCHEME = "forge-proposal";

interface Entry {
  data: Uint8Array;
  ctime: number;
  mtime: number;
}

export class ProposalFileSystem implements vscode.FileSystemProvider, vscode.Disposable {
  private readonly files = new Map<string, Entry>();
  private readonly changed = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  private readonly encoder = new TextEncoder();
  readonly onDidChangeFile: vscode.Event<vscode.FileChangeEvent[]> = this.changed.event;

  /** URI for a review's document; the path keeps the real file name so the editor picks the right language. */
  uriFor(callId: string, relPath: string, side: "proposal" | "original" = "proposal"): vscode.Uri {
    return vscode.Uri.from({ scheme: PROPOSAL_SCHEME, path: `/${callId}/${side}/${relPath}` });
  }

  /** Replaces the content (the only way it changes). */
  set(uri: vscode.Uri, text: string): void {
    const key = uri.toString();
    const now = Date.now();
    const existing = this.files.get(key);
    this.files.set(key, { data: this.encoder.encode(text), ctime: existing?.ctime ?? now, mtime: now });
    this.changed.fire([{ type: existing ? vscode.FileChangeType.Changed : vscode.FileChangeType.Created, uri }]);
  }

  remove(uri: vscode.Uri): void {
    if (this.files.delete(uri.toString())) this.changed.fire([{ type: vscode.FileChangeType.Deleted, uri }]);
  }

  dispose(): void {
    this.files.clear();
    this.changed.dispose();
  }

  // --- FileSystemProvider ------------------------------------------------------------------------

  watch(): vscode.Disposable {
    return new vscode.Disposable(() => undefined);
  }

  stat(uri: vscode.Uri): vscode.FileStat {
    const entry = this.files.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return { type: vscode.FileType.File, ctime: entry.ctime, mtime: entry.mtime, size: entry.data.byteLength, permissions: vscode.FilePermission.Readonly };
  }

  readDirectory(): [string, vscode.FileType][] {
    return [];
  }

  readFile(uri: vscode.Uri): Uint8Array {
    const entry = this.files.get(uri.toString());
    if (!entry) throw vscode.FileSystemError.FileNotFound(uri);
    return entry.data;
  }

  createDirectory(): void {
    throw vscode.FileSystemError.NoPermissions("Forge proposals are read-only");
  }

  writeFile(): void {
    throw vscode.FileSystemError.NoPermissions("Forge proposals are read-only: accept or reject hunks with the Forge lenses");
  }

  delete(): void {
    throw vscode.FileSystemError.NoPermissions("Forge proposals are read-only");
  }

  rename(): void {
    throw vscode.FileSystemError.NoPermissions("Forge proposals are read-only");
  }
}
