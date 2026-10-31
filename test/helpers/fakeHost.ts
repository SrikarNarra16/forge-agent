import { HostError, type DiagnosticInfo, type DirEntry, type FindFilesOptions, type FindFilesResult, type SymbolInfo, type WorkspaceHost } from "../../src/mcp/host";
import { createGlobMatcher, createIgnoreMatcher } from "../../src/mcp/ignore";
import { McpEvents, type ContextReadEvent } from "../../src/mcp/events";
import { createToolDeps, type ToolBudgets, type ToolDeps } from "../../src/mcp/tools/common";

export interface FakeHostOptions {
  root?: string;
  gitignore?: string;
  symbols?: Record<string, SymbolInfo[]>;
  diagnostics?: DiagnosticInfo[];
  /** Called after every successful readText, with the number of reads so far (lets tests abort mid-scan). */
  onRead?: (count: number) => void;
}

/** In-memory WorkspaceHost: files are a path -> text map; ignore rules match the real host. */
export class FakeHost implements WorkspaceHost {
  readonly readCalls: string[] = [];
  readonly diagnosticCalls: Array<string | undefined> = [];
  private readonly matcher;
  private readonly root: string;

  constructor(
    readonly files: Record<string, string>,
    private readonly options: FakeHostOptions = {},
  ) {
    this.root = options.root ?? "/work";
    this.matcher = createIgnoreMatcher(options.gitignore);
  }

  rootPath(): Promise<string> {
    return Promise.resolve(this.root);
  }

  readText(relPath: string, signal?: AbortSignal): Promise<string> {
    signal?.throwIfAborted();
    this.readCalls.push(relPath);
    const text = this.files[relPath];
    if (text === undefined) {
      const isDir = Object.keys(this.files).some((f) => f.startsWith(`${relPath}/`));
      return Promise.reject(new HostError(isDir ? "EISDIR" : "ENOENT", relPath));
    }
    if (text.includes("\0")) return Promise.reject(new HostError("EBINARY", relPath));
    this.options.onRead?.(this.readCalls.length);
    return Promise.resolve(text);
  }

  listDir(relPath: string): Promise<DirEntry[]> {
    if (this.files[relPath] !== undefined) return Promise.reject(new HostError("ENOTDIR", relPath));
    const prefix = relPath === "" ? "" : `${relPath}/`;
    const children = new Map<string, "file" | "dir">();
    for (const file of Object.keys(this.files)) {
      if (!file.startsWith(prefix)) continue;
      const rest = file.slice(prefix.length);
      const slash = rest.indexOf("/");
      const name = slash === -1 ? rest : rest.slice(0, slash);
      children.set(name, slash === -1 ? "file" : "dir");
    }
    if (children.size === 0 && relPath !== "") return Promise.reject(new HostError("ENOENT", relPath));
    const entries: DirEntry[] = [];
    for (const [name, type] of children) {
      if (!this.matcher.isIgnored(`${prefix}${name}`, type === "dir")) entries.push({ name, type });
    }
    return Promise.resolve(entries);
  }

  findFiles(options: FindFilesOptions): Promise<FindFilesResult> {
    options.signal?.throwIfAborted();
    const extra = createIgnoreMatcher(undefined, options.excludes ?? []);
    const included = createGlobMatcher(options.globs ?? []);
    const under = options.under ? `${options.under}/` : "";
    const all = Object.keys(this.files)
      .filter((f) => f.startsWith(under) && !this.matcher.isIgnored(f, false) && !extra.isIgnored(f, false) && included(f))
      .sort();
    return Promise.resolve({ files: all.slice(0, options.max), truncated: all.length > options.max });
  }

  documentSymbols(relPath: string): Promise<SymbolInfo[]> {
    return Promise.resolve(this.options.symbols?.[relPath] ?? []);
  }

  diagnostics(relPath?: string): Promise<DiagnosticInfo[]> {
    this.diagnosticCalls.push(relPath);
    const all = this.options.diagnostics ?? [];
    return Promise.resolve(relPath ? all.filter((d) => d.path === relPath || d.path.startsWith(`${relPath}/`)) : all);
  }
}

export interface TestRig {
  deps: ToolDeps;
  logs: string[];
  reads: ContextReadEvent[];
}

export function makeRig(budgets: Partial<ToolBudgets> = {}): TestRig {
  const logs: string[] = [];
  const reads: ContextReadEvent[] = [];
  const events = new McpEvents();
  events.onContextRead((e) => reads.push(e));
  return { deps: createToolDeps({ log: (m) => logs.push(m), events, budgets }), logs, reads };
}

/** Text of a tool result's first content block. */
export function textOf(result: { content: unknown }): string {
  const first = (result.content as Array<{ type: string; text?: string }>)[0];
  return first?.text ?? "";
}

/** A small Flask-like workspace used by the tool tests. */
export const FIXTURE_FILES: Record<string, string> = {
  "src/app/helpers.py": [
    "import os",
    "",
    "",
    "def get_debug_flag() -> bool:",
    '    """Get whether debug mode should be enabled."""',
    '    val = os.environ.get("FLASK_DEBUG")',
    '    return bool(val and val.lower() not in {"0", "false", "no"})',
    "",
    "",
    "class Helper:",
    "    def run(self):",
    "        pass",
    "",
  ].join("\n"),
  "src/app/__init__.py": "from .helpers import get_debug_flag\n",
  "src/app/web.ts": "export function render(x: number) {}\nexport const handler = async (req: string) => {};\ninterface Props {}\n",
  "tests/test_helpers.py": "def test_flag():\n    assert get_debug_flag() is False\n",
  "README.md": "# demo\nget_debug_flag docs\n",
  "node_modules/pkg/index.js": "function get_debug_flag(){}",
  ".git/config": "[core]",
  ".venv/lib/x.py": "def get_debug_flag(): pass",
  "build/out.txt": "ignored by gitignore get_debug_flag",
  "logo.png": "\0PNG",
};

export const FIXTURE_GITIGNORE = "build/\n";
