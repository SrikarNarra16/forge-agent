import * as path from "node:path";
import * as vscode from "vscode";
import { HostError, type DiagnosticInfo, type DirEntry, type FindFilesOptions, type FindFilesResult, type SymbolInfo, type WorkspaceHost } from "../mcp/host";
import { createGlobMatcher, createIgnoreMatcher, type IgnoreMatcher } from "../mcp/ignore";
import { BLOCKED_SEGMENTS } from "../mcp/tools/common";
import { isInside } from "../util/paths";

/**
 * WorkspaceHost backed by the VS Code API. Reads return the live text of already-open documents
 * (unsaved edits included) and otherwise read from disk with workspace.fs; it never calls
 * openTextDocument for unopened files, so no language servers are spawned for reads. All I/O is async.
 */

const MAX_READ_BYTES = 2_000_000;
const BINARY_SNIFF_BYTES = 8000;
const GITIGNORE_CACHE_MS = 5000;
const YIELD_EVERY_DIRS = 50;

function mapFsError(err: unknown, rel: string): never {
  const code = err instanceof vscode.FileSystemError ? err.code : undefined;
  const message = err instanceof Error ? err.message : String(err);
  if (code === "FileNotFound" || /ENOENT/.test(message)) throw new HostError("ENOENT", `not found: ${rel}`);
  if (code === "FileNotADirectory" || /ENOTDIR/.test(message)) throw new HostError("ENOTDIR", `not a directory: ${rel}`);
  if (code === "FileIsADirectory" || /EISDIR/.test(message)) throw new HostError("EISDIR", `is a directory: ${rel}`);
  throw err;
}

function severityOf(severity: vscode.DiagnosticSeverity): DiagnosticInfo["severity"] {
  switch (severity) {
    case vscode.DiagnosticSeverity.Error:
      return "error";
    case vscode.DiagnosticSeverity.Warning:
      return "warning";
    case vscode.DiagnosticSeverity.Information:
      return "info";
    default:
      return "hint";
  }
}

function toSymbolInfo(symbol: vscode.DocumentSymbol | vscode.SymbolInformation): SymbolInfo {
  const kind = (vscode.SymbolKind[symbol.kind] ?? "symbol").toLowerCase();
  if ("range" in symbol) {
    return {
      name: symbol.name,
      kind,
      line: symbol.range.start.line + 1,
      endLine: symbol.range.end.line + 1,
      children: symbol.children.map(toSymbolInfo),
    };
  }
  return { name: symbol.name, kind, line: symbol.location.range.start.line + 1, endLine: symbol.location.range.end.line + 1 };
}

export class VscodeHost implements WorkspaceHost {
  private ignoreCache: { root: string; at: number; matcher: IgnoreMatcher; text: string | undefined } | undefined;
  private readonly decoder = new TextDecoder("utf-8");

  rootPath(): Promise<string> {
    const folder = vscode.workspace.workspaceFolders?.[0];
    if (!folder) return Promise.reject(new HostError("ENOWORKSPACE", "no workspace folder is open"));
    return Promise.resolve(folder.uri.fsPath);
  }

  private uriOf(root: string, rel: string): vscode.Uri {
    return vscode.Uri.file(rel === "" ? root : path.join(root, ...rel.split("/")));
  }

  /** Root .gitignore (cached briefly) combined with the hard excludes. Nested .gitignore files are not read. */
  private async ignoreMatcher(root: string): Promise<{ matcher: IgnoreMatcher; text: string | undefined }> {
    const cached = this.ignoreCache;
    if (cached && cached.root === root && Date.now() - cached.at < GITIGNORE_CACHE_MS) return cached;
    let text: string | undefined;
    try {
      text = this.decoder.decode(await vscode.workspace.fs.readFile(this.uriOf(root, ".gitignore")));
    } catch {
      text = undefined; // no .gitignore
    }
    this.ignoreCache = { root, at: Date.now(), matcher: createIgnoreMatcher(text), text };
    return this.ignoreCache;
  }

  async readText(relPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const root = await this.rootPath();
    const uri = this.uriOf(root, relPath);
    const open = vscode.workspace.textDocuments.find((d) => d.uri.scheme === "file" && d.uri.fsPath === uri.fsPath);
    if (open) return open.getText();

    let stat: vscode.FileStat;
    try {
      stat = await vscode.workspace.fs.stat(uri);
    } catch (err) {
      return mapFsError(err, relPath);
    }
    if (stat.type & vscode.FileType.SymbolicLink) throw new HostError("ESYMLINK", `symlink: ${relPath}`);
    if (stat.type & vscode.FileType.Directory) throw new HostError("EISDIR", `is a directory: ${relPath}`);
    if (stat.size > MAX_READ_BYTES) throw new HostError("ETOOBIG", `${stat.size} bytes, limit ${MAX_READ_BYTES}`);

    let bytes: Uint8Array;
    try {
      bytes = await vscode.workspace.fs.readFile(uri);
    } catch (err) {
      return mapFsError(err, relPath);
    }
    signal?.throwIfAborted();
    if (bytes.subarray(0, BINARY_SNIFF_BYTES).includes(0)) throw new HostError("EBINARY", `binary: ${relPath}`);
    return this.decoder.decode(bytes);
  }

  async listDir(relPath: string): Promise<DirEntry[]> {
    const root = await this.rootPath();
    const { matcher } = await this.ignoreMatcher(root);
    let entries: Array<[string, vscode.FileType]>;
    try {
      entries = await vscode.workspace.fs.readDirectory(this.uriOf(root, relPath));
    } catch (err) {
      return mapFsError(err, relPath);
    }
    const out: DirEntry[] = [];
    for (const [name, type] of entries) {
      if (type & vscode.FileType.SymbolicLink) continue;
      const isDir = (type & vscode.FileType.Directory) !== 0;
      if (matcher.isIgnored(relPath === "" ? name : `${relPath}/${name}`, isDir)) continue;
      out.push({ name, type: isDir ? "dir" : "file" });
    }
    return out;
  }

  async findFiles(options: FindFilesOptions): Promise<FindFilesResult> {
    const root = await this.rootPath();
    const { text } = await this.ignoreMatcher(root);
    const matcher = createIgnoreMatcher(text, options.excludes ?? []);
    const included = createGlobMatcher(options.globs ?? []);
    const files: string[] = [];
    const stack: string[] = [options.under ?? ""];
    let dirs = 0;
    let truncated = false;

    while (stack.length > 0 && !truncated) {
      options.signal?.throwIfAborted();
      const dir = stack.pop() ?? "";
      let entries: Array<[string, vscode.FileType]>;
      try {
        entries = await vscode.workspace.fs.readDirectory(this.uriOf(root, dir));
      } catch {
        continue; // vanished or unreadable directory
      }
      for (const [name, type] of entries) {
        if (type & vscode.FileType.SymbolicLink) continue;
        const rel = dir === "" ? name : `${dir}/${name}`;
        const isDir = (type & vscode.FileType.Directory) !== 0;
        if (matcher.isIgnored(rel, isDir)) continue;
        if (isDir) {
          stack.push(rel);
        } else if (included(rel)) {
          files.push(rel);
          if (files.length > options.max) {
            files.pop();
            truncated = true;
            break;
          }
        }
      }
      if (++dirs % YIELD_EVERY_DIRS === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
    return { files: files.sort(), truncated };
  }

  async documentSymbols(relPath: string): Promise<SymbolInfo[]> {
    const root = await this.rootPath();
    try {
      const result = await vscode.commands.executeCommand<Array<vscode.DocumentSymbol | vscode.SymbolInformation> | undefined>(
        "vscode.executeDocumentSymbolProvider",
        this.uriOf(root, relPath),
      );
      return (result ?? []).map(toSymbolInfo);
    } catch {
      return []; // no provider for this language: the tool falls back to regex
    }
  }

  async diagnostics(relPath?: string): Promise<DiagnosticInfo[]> {
    const root = await this.rootPath();
    const out: DiagnosticInfo[] = [];
    for (const [uri, diags] of vscode.languages.getDiagnostics()) {
      if (uri.scheme !== "file" || !isInside(root, uri.fsPath)) continue;
      const rel = path.relative(root, uri.fsPath).split(path.sep).join("/");
      if (rel.split("/").some((seg) => (BLOCKED_SEGMENTS as readonly string[]).includes(seg.toLowerCase()))) continue;
      if (relPath && rel !== relPath && !rel.startsWith(`${relPath}/`)) continue;
      for (const d of diags) {
        out.push({
          path: rel,
          line: d.range.start.line + 1,
          column: d.range.start.character + 1,
          severity: severityOf(d.severity),
          message: d.message,
          ...(d.source ? { source: d.source } : {}),
        });
      }
    }
    return out;
  }
}
