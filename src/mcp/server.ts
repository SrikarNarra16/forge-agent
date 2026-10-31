/**
 * Localhost streamable-HTTP MCP server (127.0.0.1:<port>) exposing editor capabilities to the TrueForge agent.
 */
export interface McpServerHandle {
  readonly url: string;
  dispose(): Promise<void>;
}
