import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { z } from "zod";
import type { WorkspaceHost } from "../host";
import { READ_ONLY, errorResult, resolveWorkspacePath, runTool, summarize, textResult, type ToolDeps } from "./common";

const MAX_DIAGNOSTICS = 100;

export interface GetDiagnosticsArgs {
  path?: string | undefined;
}

/** get_diagnostics: current errors/warnings that VS Code's language services report. */
export async function runGetDiagnostics(host: WorkspaceHost, deps: ToolDeps, args: GetDiagnosticsArgs, signal?: AbortSignal): Promise<CallToolResult> {
  return runTool(deps, "get_diagnostics", summarize({ path: args.path }), signal, async () => {
    const root = await host.rootPath();
    const target = resolveWorkspacePath(root, args.path);
    if (!target.ok) return errorResult(target.message);

    const all = await host.diagnostics(target.rel === "" ? undefined : target.rel);
    const scope = target.rel === "" ? "the workspace" : target.rel;
    if (all.length === 0) {
      return textResult(`No diagnostics reported for ${scope}. (VS Code only knows about files its language services have analysed, usually open files, so this does not prove the code is correct. Run the tests with the project's test command to be sure.)`);
    }
    const sorted = [...all].sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column);
    const errors = sorted.filter((d) => d.severity === "error").length;
    const warnings = sorted.filter((d) => d.severity === "warning").length;
    const shown = sorted.slice(0, MAX_DIAGNOSTICS).map((d) => `${d.path}:${d.line}:${d.column} ${d.severity}${d.source ? ` [${d.source}]` : ""}: ${d.message}`);
    const footer = sorted.length > shown.length ? `\n[${sorted.length - shown.length} more diagnostics omitted; pass a path to narrow down]` : "";
    return textResult(`${sorted.length} diagnostics in ${scope} (${errors} errors, ${warnings} warnings):\n${shown.join("\n")}${footer}`);
  });
}

export function registerGetDiagnostics(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  server.registerTool(
    "get_diagnostics",
    {
      title: "Get diagnostics",
      description:
        "Errors and warnings currently reported by VS Code's language services (type errors, lint, syntax) for one file or the whole workspace, as 'path:line:col severity: message'. Only covers files the editor has analysed (usually open ones); an empty result does not prove the code is correct.",
      inputSchema: {
        path: z.string().optional().describe("File path relative to the workspace root. Omit for diagnostics across the workspace."),
      },
      annotations: { title: "Get diagnostics", ...READ_ONLY },
    },
    (args, extra) => runGetDiagnostics(host, deps, args, extra.signal),
  );
}
