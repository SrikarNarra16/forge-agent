import { readFile, readdir, stat } from "node:fs/promises";
import { join } from "node:path";
import { HostError, type DiagnosticInfo, type DirEntry, type FindFilesOptions, type FindFilesResult, type SymbolInfo, type WorkspaceHost } from "../src/mcp/host";
import { createGlobMatcher, createIgnoreMatcher, type IgnoreMatcher } from "../src/mcp/ignore";

/**
 * A READ-ONLY WorkspaceHost over a directory on disk, for scripts (the benchmark). Same rules as the VS Code
 * host: root .gitignore plus the hard excludes, binaries skipped, files over 2 MB refused. It has no write API.
 */
const MAX_READ_BYTES = 2_000_000;

export class DiskHost implements WorkspaceHost {
  private matcher: IgnoreMatcher | undefined;
  private gitignore: string | undefined;

  constructor(private readonly root: string) {}

  rootPath(): Promise<string> {
    return Promise.resolve(this.root);
  }

  private async ignore(): Promise<{ matcher: IgnoreMatcher; text: string | undefined }> {
    if (!this.matcher) {
      try {
        this.gitignore = await readFile(join(this.root, ".gitignore"), "utf8");
      } catch {
        this.gitignore = undefined;
      }
      this.matcher = createIgnoreMatcher(this.gitignore);
    }
    return { matcher: this.matcher, text: this.gitignore };
  }

  async readText(relPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    const full = join(this.root, ...relPath.split("/"));
    let info;
    try {
      info = await stat(full);
    } catch {
      throw new HostError("ENOENT", relPath);
    }
    if (info.isDirectory()) throw new HostError("EISDIR", relPath);
    if (info.size > MAX_READ_BYTES) throw new HostError("ETOOBIG", `${info.size} bytes`);
    const bytes = await readFile(full);
    if (bytes.subarray(0, 8000).includes(0)) throw new HostError("EBINARY", relPath);
    return bytes.toString("utf8");
  }

  async listDir(relPath: string): Promise<DirEntry[]> {
    const { matcher } = await this.ignore();
    let entries;
    try {
      entries = await readdir(join(this.root, ...relPath.split("/").filter(Boolean)), { withFileTypes: true });
    } catch {
      throw new HostError("ENOENT", relPath);
    }
    return entries
      .filter((e) => !e.isSymbolicLink() && !matcher.isIgnored(relPath === "" ? e.name : `${relPath}/${e.name}`, e.isDirectory()))
      .map((e) => ({ name: e.name, type: e.isDirectory() ? "dir" : "file" }));
  }

  async findFiles(options: FindFilesOptions): Promise<FindFilesResult> {
    const { text } = await this.ignore();
    const matcher = createIgnoreMatcher(text, options.excludes ?? []);
    const included = createGlobMatcher(options.globs ?? []);
    const files: string[] = [];
    const stack: string[] = [options.under ?? ""];
    let truncated = false;
    while (stack.length > 0 && !truncated) {
      options.signal?.throwIfAborted();
      const dir = stack.pop() ?? "";
      let entries;
      try {
        entries = await readdir(join(this.root, ...dir.split("/").filter(Boolean)), { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (entry.isSymbolicLink()) continue;
        const rel = dir === "" ? entry.name : `${dir}/${entry.name}`;
        if (matcher.isIgnored(rel, entry.isDirectory())) continue;
        if (entry.isDirectory()) stack.push(rel);
        else if (included(rel)) {
          files.push(rel);
          if (files.length > options.max) {
            files.pop();
            truncated = true;
            break;
          }
        }
      }
    }
    return { files: files.sort(), truncated };
  }

  documentSymbols(): Promise<SymbolInfo[]> {
    return Promise.resolve([]);
  }

  diagnostics(): Promise<DiagnosticInfo[]> {
    return Promise.resolve([]);
  }
}
