import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceHost } from "../host";
import type { ToolDeps } from "./common";
import { registerGetDiagnostics } from "./getDiagnostics";
import { registerGetSymbols } from "./getSymbols";
import { registerListDir } from "./listDir";
import { registerPing } from "./ping";
import { registerReadFile } from "./readFile";
import { registerRepoMap } from "./repoMap";
import { registerSearchCode } from "./searchCode";

/**
 * Registry of MCP tools served to the TrueForge agent (server `forge-editor`). All current tools are
 * read-only. The write tools (propose_edit, create_file, run_command) land in P05 and must be named
 * explicitly in the agent's require_approval_for_tools; never rely on tool annotations for gating.
 */
export const TOOL_NAMES = ["ping", "list_dir", "repo_map", "search_code", "read_file", "get_symbols", "get_diagnostics"] as const;

export function registerTools(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  registerPing(server);
  registerListDir(server, host, deps);
  registerRepoMap(server, host, deps);
  registerSearchCode(server, host, deps);
  registerReadFile(server, host, deps);
  registerGetSymbols(server, host, deps);
  registerGetDiagnostics(server, host, deps);
}
