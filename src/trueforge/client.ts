import { TrueForge, TrueForgeError, serialization, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";

/**
 * TrueForge client helpers: SDK client creation, the MCP-server upsert body, agent-file parsing
 * and `ensureAgent` (create-or-update a saved agent by name). All LLM traffic goes through
 * TrueForge, never a provider. This module is shared with scripts/tf-setup.ts, so it must NOT
 * import "vscode" (enforced by eslint and test/noVscodeImport.test.ts).
 */

/** SDK default is 60s; agent turns need far longer. */
export const DEFAULT_TIMEOUT_SECONDS = 600;

/** Name under which our MCP server is registered in TrueForge. */
export const FORGE_EDITOR_SERVER = "forge-editor";

/** Second MCP server, registered with preload:false to demonstrate deferred tool loading. */
export const FORGE_EXTRAS_SERVER = "forge-editor-extras";
export const EXTRAS_DESCRIPTION = "Forge extra editor tools, discovered on demand: git_status, git_diff, find_references, open_in_editor (all read-only)";

/** Exact command that starts TrueForge so it may call our loopback MCP server (SSRF guard allow-list). */
export const TRUEFORGE_START_COMMAND =
  `OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 MODEL_HTTP_MAX_RETRIES=1 npx @truefoundry/trueforge@latest`;

export function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.trim().replace(/\/+$/, "");
}

export function createClient(baseUrl: string): TrueForge {
  return new TrueForge({ baseUrl: normalizeBaseUrl(baseUrl), timeoutInSeconds: DEFAULT_TIMEOUT_SECONDS });
}

/**
 * Link to a session in the TrueForge UI. The URL shape is read from the running UI itself, not guessed: its bundled
 * route table (checked against @truefoundry/trueforge on 4 Nov 2026) has `session: "/sessions/:sessionId"` and
 * `sessionsBrowser: "/sessions"`, it is a path-based router (no `#`), and the server answers both paths with the UI
 * when the request accepts HTML. The id is the API's session id (the `id` of GET /api/v1/sessions). What was NOT
 * verified is how the page renders in a browser; if a future TrueForge changes its routes, `trueForgeLink` below is
 * the one place to adjust.
 */
export function sessionUrl(baseUrl: string, sessionId: string): string {
  return `${normalizeBaseUrl(baseUrl)}/sessions/${encodeURIComponent(sessionId)}`;
}

/** The "Open in TrueForge" target: the current session's page, or the Sessions list when no session exists yet. */
export function trueForgeLink(baseUrl: string, sessionId: string | undefined): string {
  return sessionId ? sessionUrl(baseUrl, sessionId) : `${normalizeBaseUrl(baseUrl)}/sessions`;
}

/**
 * Body for PUT /api/v1/settings/mcp-servers (see docs/api-cheatsheet.md section 2):
 * a remote server with static header auth. The token is only ever placed in this body.
 */
export function buildMcpServerUpsert(url: string, token: string, name: string = FORGE_EDITOR_SERVER, description = "Forge VS Code editor tools (read, search, edit, run)"): TrueForgeApi.settings.UpdateMcpServerRequest {
  return {
    manifest: {
      type: "remote",
      name,
      url,
      description,
      auth: { type: "header", headers: { Authorization: `Bearer ${token}` } },
    },
  };
}

export interface AgentFile {
  name: string;
  description: string;
  spec: TrueForgeApi.AgentSpec;
}

const agentEnvelope = z.strictObject({
  name: z.string().min(2),
  description: z.string().min(1).max(1024),
  manifest: z.unknown(),
});

/**
 * Parses an agents/*.json file. The file uses the wire format (snake_case); the SDK's own
 * serializer converts it to the camelCase SDK types. Unknown fields are an error, never dropped.
 */
export function parseAgentFile(json: unknown): AgentFile {
  const envelope = agentEnvelope.safeParse(json);
  if (!envelope.success) {
    throw new Error(`invalid agent file: ${envelope.error.issues.map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`).join("; ")}`);
  }
  const { name, description, manifest } = envelope.data;
  const parsed = serialization.AgentSpec.parse(manifest, { unrecognizedObjectKeys: "fail" });
  if (!parsed.ok) {
    throw new Error(`invalid manifest for agent "${name}": ${parsed.errors.map((e) => `${e.path.join(".")}: ${e.message}`).join("; ")}`);
  }
  return { name, description, spec: parsed.value };
}

export interface EnsureAgentResult {
  action: "created" | "updated";
  id: string;
}

/**
 * Upserts a saved agent by name. Names are unique and immutable, and update/delete take the
 * server-generated id, so we look the id up first.
 */
export async function ensureAgent(client: TrueForge, agent: AgentFile): Promise<EnsureAgentResult> {
  const page = await client.agents.list({ agentName: agent.name, limit: 100 });
  for await (const existing of page) {
    if (existing.name === agent.name) {
      await client.agents.update(existing.id, { description: agent.description, manifest: agent.spec });
      return { action: "updated", id: existing.id };
    }
  }
  const created = await client.agents.create({ name: agent.name, description: agent.description, manifest: agent.spec });
  return { action: "created", id: created.data.id };
}

/** Names of the tools TrueForge can list for a registered MCP server (GET /mcp-servers/{name}/tools). */
export async function listMcpToolNames(client: TrueForge, serverName: string): Promise<string[]> {
  const res = await client.mcpServers.listTools(serverName);
  return res.data.flatMap((tool) => (typeof tool["name"] === "string" ? [tool["name"]] : []));
}

/** True when the failure means "could not talk to TrueForge at all" (no HTTP status), e.g. connection refused or timeout. */
export function isUnreachable(err: unknown): boolean {
  return err instanceof TrueForgeError ? err.statusCode === undefined : err instanceof TypeError;
}

/** Short, secret-free description of an SDK error for logs and toasts. */
export function describeError(err: unknown): string {
  if (err instanceof TrueForgeError) {
    const body = err.body;
    const detail =
      typeof body === "object" && body !== null && "error" in body && typeof (body as { error?: { message?: unknown } }).error?.message === "string"
        ? (body as { error: { message: string } }).error.message
        : undefined;
    return [err.statusCode === undefined ? undefined : `HTTP ${err.statusCode}`, detail ?? err.message].filter(Boolean).join(": ");
  }
  return err instanceof Error ? err.message : String(err);
}
