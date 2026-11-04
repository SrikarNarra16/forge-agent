import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { EXTRAS_TOOL_NAMES } from "../mcp/tools/extras";
import { TOOL_NAMES } from "../mcp/tools/index";
import { EXTRAS_DESCRIPTION, FORGE_EDITOR_SERVER, FORGE_EXTRAS_SERVER, buildMcpServerUpsert, isUnreachable, listMcpToolNames } from "./client";

/** Server names to register (defaults, or the prefixed ones from resourceNames.ts). */
export interface ServerNames {
  editor: string;
  extras: string;
}

/**
 * Registers BOTH Forge MCP servers in TrueForge (forge-editor and forge-editor-extras, same token) and verifies
 * that TrueForge can list every tool of each. vscode-free so it is unit-tested.
 */
export type RegistrationResult =
  | { ok: true }
  | { ok: false; stage: "unreachable" }
  | { ok: false; stage: "mcp-register" | "mcp-verify"; url: string; error: unknown };

export async function registerMcpServers(client: TrueForge, handle: { url: string; extrasUrl: string }, token: string, log: (message: string) => void, names: ServerNames = { editor: FORGE_EDITOR_SERVER, extras: FORGE_EXTRAS_SERVER }): Promise<RegistrationResult> {
  const servers = [
    { name: names.editor, url: handle.url, expected: TOOL_NAMES as readonly string[], request: buildMcpServerUpsert(handle.url, token, names.editor) },
    { name: names.extras, url: handle.extrasUrl, expected: EXTRAS_TOOL_NAMES as readonly string[], request: buildMcpServerUpsert(handle.extrasUrl, token, names.extras, EXTRAS_DESCRIPTION) },
  ];
  for (const server of servers) {
    try {
      await client.settings.mcpServers.createOrUpdate(server.request);
      log(`Registered MCP server "${server.name}" in TrueForge at ${server.url}`);
    } catch (error) {
      if (isUnreachable(error)) return { ok: false, stage: "unreachable" };
      return { ok: false, stage: "mcp-register", url: server.url, error };
    }
  }
  for (const server of servers) {
    try {
      const tools = await listMcpToolNames(client, server.name);
      log(`TrueForge lists tools from ${server.name}: ${tools.join(", ") || "(none)"}`);
      const missing = server.expected.filter((name) => !tools.includes(name));
      if (missing.length > 0) throw new Error(`TrueForge does not list these tools from ${server.name}: ${missing.join(", ")} (it lists ${tools.length})`);
    } catch (error) {
      if (isUnreachable(error)) return { ok: false, stage: "unreachable" };
      return { ok: false, stage: "mcp-verify", url: server.url, error };
    }
  }
  return { ok: true };
}
