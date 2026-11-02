import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { WorkspaceHost } from "../host";
import type { ToolDeps } from "./common";
import { registerEditTools } from "./editTools";
import { registerGetDiagnostics } from "./getDiagnostics";
import { registerGetSymbols } from "./getSymbols";
import { registerListDir } from "./listDir";
import { registerPing } from "./ping";
import { registerReadFile } from "./readFile";
import { registerRepoMap } from "./repoMap";
import { registerSearchCode } from "./searchCode";

/**
 * Registry of MCP tools served to the TrueForge agent (server `forge-editor`).
 *
 * WRITE_TOOL_NAMES must be listed BY NAME in the agent's require_approval_for_tools (a test enforces
 * it); never rely on tool annotations for gating. These tools never write themselves: the extension's
 * review handler applies the accepted hunks and the tools only report the recorded decision.
 */
export const WRITE_TOOL_NAMES = ["propose_edit", "create_file"] as const;
export const READ_TOOL_NAMES = ["ping", "list_dir", "repo_map", "search_code", "read_file", "get_symbols", "get_diagnostics"] as const;
export const TOOL_NAMES = [...READ_TOOL_NAMES, ...WRITE_TOOL_NAMES] as const;

export function registerTools(server: McpServer, host: WorkspaceHost, deps: ToolDeps): void {
  registerPing(server);
  registerListDir(server, host, deps);
  registerRepoMap(server, host, deps);
  registerSearchCode(server, host, deps);
  registerReadFile(server, host, deps);
  registerGetSymbols(server, host, deps);
  registerGetDiagnostics(server, host, deps);
  registerEditTools(server, deps);
}
