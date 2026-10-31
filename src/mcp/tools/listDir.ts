import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { DirEntry, WorkspaceHost } from "../host";
import { READ_ONLY, errorResult, explainHostError, resolveWorkspacePath, runTool, summarize, textResult, throwIfAborted, type ToolDeps } from "./common";

const HARD_ENTRY_CAP = 2000;

export interface ListDirArgs {
  path?: string | undefined;
  depth?: number | undefined;
}

/** list_dir: gitignore-aware directory listing, 1 to 3 levels deep, capped with an omitted-entries footer. */
export async function runListDir(host: WorkspaceHost, deps: ToolDeps, args: ListDirArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "list_dir", summarize({ path: args.path, depth: args.depth }), signal, async () => {
    const depth = args.depth ?? 1;
    if (!Number.isInteger(depth) || depth < 1 || depth > 3) {
      return errorResult(`depth must be a whole number from 1 to 3 (got ${String(args.depth)}). Use depth 1 for a quick look and list a subdirectory to go deeper.`);
    }
    const root = await host.rootPath();
    const target = resolveWorkspacePath(root, args.path);
    if (!target.ok) return errorResult(target.message);

    const lines: string[] = [];
    let hitHardCap = false;
    const byKind = (a: DirEntry, b: DirEntry): number => (a.type === b.type ? a.name.localeCompare(b.name) : a.type === "dir" ? -1 : 1);

    const walk = async (rel: string, level: number): Promise<void> => {
      throwIfAborted(signal);
      const entries = [...(await host.listDir(rel))].sort(byKind);
      for (const entry of entries) {
        if (lines.length >= HARD_ENTRY_CAP) {
          hitHardCap = true;
          return;
        }
        lines.push(`${"  ".repeat(level - 1)}${entry.name}${entry.type === "dir" ? "/" : ""}`);
        if (entry.type === "dir" && level < depth) await walk(rel === "" ? entry.name : `${rel}/${entry.name}`, level + 1);
      }
    };

    try {
      await walk(target.rel, 1);
    } catch (err) {
      const teaching = explainHostError(err, target.rel);
      if (teaching) return errorResult(teaching);
      throw err;
    }

    const header = `${target.rel === "" ? "." : target.rel}/ (depth ${depth})`;
    if (lines.length === 0) return textResult(`${header}\n(empty directory, or everything in it is gitignored/excluded)`);
    const shown = lines.slice(0, deps.budgets.listDirMaxEntries);
    const omitted = lines.length - shown.length;
    const footer =
      omitted > 0
        ? `\n[${hitHardCap ? "at least " : ""}${omitted} more entries omitted; list a subdirectory with path, or lower depth]`
        : hitHardCap
          ? "\n[listing stopped at 2000 entries; list a subdirectory with path]"
          : "";
    return textResult(`${header}\n${shown.join("\n")}${footer}`);
  });
}

export function registerListDir(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "list_dir",
    {
      title: "List directory",
      description:
        "List files and subdirectories of a directory in the workspace (directories end with '/'). Respects .gitignore and hides .git, node_modules, .venv, __pycache__, dist, out and tool caches (.pytest_cache, .mypy_cache). Use it to see what exists before reading; for finding code prefer repo_map or search_code.",
      inputSchema: {
        path: z.string().optional().describe("Directory relative to the workspace root, e.g. 'src/flask'. Omit to list the workspace root."),
        depth: z.number().optional().describe("Levels to show: 1 (default, direct children only) to 3. Use 2-3 only for small directories; at most 200 entries are returned."),
      },
      annotations: { title: "List directory", ...READ_ONLY },
    },
    (args, extra) => runListDir(host, deps, args, extra.signal),
  );
}
