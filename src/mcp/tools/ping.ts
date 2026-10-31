import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { READ_ONLY, textResult } from "./common";

/** `ping`: connectivity check for the Forge editor server (no arguments, fixed reply). */
export function registerPing(server: McpServer): void {
  server.registerTool(
    "ping",
    {
      title: "Ping",
      description: "Connectivity check for the Forge editor server. Takes no arguments and returns a fixed string.",
      annotations: { title: "Ping", ...READ_ONLY },
    },
    () => textResult("pong from forge-editor"),
  );
}
