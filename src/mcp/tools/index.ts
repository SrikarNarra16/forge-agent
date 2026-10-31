import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

/**
 * Registry of MCP tools served to the TrueForge agent. Only `ping` for now; the editor tools
 * (list_dir, repo_map, search_code, read_file, get_symbols, get_diagnostics, propose_edit,
 * create_file, run_command) land in P03. Gated tools must be named explicitly in the agent's
 * require_approval_for_tools; never rely on tool annotations for gating.
 */
export const TOOL_NAMES = ["ping"] as const;

export function registerTools(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Connectivity check for the Forge editor server. Takes no arguments and returns a fixed string.",
      annotations: { readOnlyHint: true },
    },
    () => ({ content: [{ type: "text", text: "pong from forge-editor" }] }),
  );
}
