/**
 * WorkspaceHost: everything the MCP tools need from the editor, as async methods. The vscode
 * implementation lives in src/host/vscodeHost.ts; tests use an in-memory fake. This file (like all of
 * src/mcp) must stay free of the vscode API.
 *
 * All paths are workspace-relative, POSIX-separated ("" is the root). Hosts apply .gitignore and the
 * hard excludes (see ignore.ts) to listDir and findFiles.
 */

export type HostErrorCode = "ENOENT" | "EISDIR" | "ENOTDIR" | "EBINARY" | "ETOOBIG" | "ESYMLINK" | "ENOWORKSPACE";

export class HostError extends Error {
  constructor(
    readonly code: HostErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "HostError";
  }
}

export interface DirEntry {
  name: string;
  type: "file" | "dir";
}

export interface SymbolInfo {
  name: string;
  /** Lower-case symbol kind, e.g. "function", "class", "method". */
  kind: string;
  /** 1-based, inclusive. */
  line: number;
  endLine: number;
  children?: SymbolInfo[];
}

export type DiagnosticSeverity = "error" | "warning" | "info" | "hint";

export interface DiagnosticInfo {
  path: string;
  /** 1-based. */
  line: number;
  column: number;
  severity: DiagnosticSeverity;
  message: string;
  source?: string;
}

export interface FindFilesOptions {
  /** Directory to start from (relative); default the workspace root. */
  under?: string;
  /** Gitignore-syntax patterns; when given, only matching files are returned (e.g. "*.py"). */
  globs?: readonly string[];
  /** Extra gitignore-syntax patterns to exclude, on top of .gitignore and the hard excludes. */
  excludes?: readonly string[];
  max: number;
  signal?: AbortSignal;
}

export interface FindFilesResult {
  files: string[];
  /** True when `max` stopped the walk early. */
  truncated: boolean;
}

export interface WorkspaceHost {
  /** Absolute path of the workspace root. Throws HostError("ENOWORKSPACE") when no folder is open. */
  rootPath(): Promise<string>;
  /**
   * CURRENT text of a file, including unsaved edits when the file is open in an editor. Must not open
   * documents that are not already open. Throws HostError (ENOENT, EISDIR, EBINARY, ETOOBIG, ESYMLINK).
   */
  readText(relPath: string, signal?: AbortSignal): Promise<string>;
  /** Direct children of a directory, with ignored entries already removed. Throws HostError (ENOENT, ENOTDIR). */
  listDir(relPath: string): Promise<DirEntry[]>;
  findFiles(options: FindFilesOptions): Promise<FindFilesResult>;
  /** Language-server symbols for a file; an empty array means "none available". */
  documentSymbols(relPath: string): Promise<SymbolInfo[]>;
  /** Diagnostics for one file, or for every file when `relPath` is omitted. */
  diagnostics(relPath?: string): Promise<DiagnosticInfo[]>;
}
