import type { AgentFile } from "./client";

/**
 * Names of the TrueForge resources Forge registers (two MCP servers and two agents), with an optional prefix so that
 * several VS Code windows, or the end-to-end tests, can run side by side against one TrueForge without touching
 * each other's resources: `FORGE_RESOURCE_PREFIX` (environment, wins) or the `forge.resourcePrefix` setting.
 * The committed agents/*.json keep the default names; the prefix is applied to the loaded specs. Pure and vscode-free.
 */
export const DEFAULT_NAMES = {
  editor: "forge-editor",
  extras: "forge-editor-extras",
  agent: "forge-agent",
  inline: "forge-inline",
} as const;

export interface ResourceNames {
  prefix: string;
  editor: string;
  extras: string;
  agent: string;
  inline: string;
}

const VALID_PREFIX = /^[a-z0-9][a-z0-9-]*$/;

/** The environment variable wins over the setting. An empty value means "no prefix". */
export function resolvePrefix(sources: { env?: string | undefined; setting?: string | undefined }): string {
  const raw = (sources.env !== undefined && sources.env.trim() !== "" ? sources.env : (sources.setting ?? "")).trim();
  if (raw === "") return "";
  if (!VALID_PREFIX.test(raw)) throw new Error(`Invalid resource prefix "${raw}": use lower-case letters, digits and "-", starting with a letter or digit (for example "e2e-123-").`);
  return raw;
}

export function resourceNames(prefix: string): ResourceNames {
  return { prefix, editor: `${prefix}${DEFAULT_NAMES.editor}`, extras: `${prefix}${DEFAULT_NAMES.extras}`, agent: `${prefix}${DEFAULT_NAMES.agent}`, inline: `${prefix}${DEFAULT_NAMES.inline}` };
}

const MAP: ReadonlyArray<readonly [keyof typeof DEFAULT_NAMES, string]> = [
  ["extras", DEFAULT_NAMES.extras], // before "editor": "forge-editor" is a prefix of "forge-editor-extras"
  ["editor", DEFAULT_NAMES.editor],
  ["agent", DEFAULT_NAMES.agent],
  ["inline", DEFAULT_NAMES.inline],
];

/**
 * Renames the agent, its mcp_servers entries and the server names mentioned in its instructions. With an empty
 * prefix the agent is returned unchanged (same object).
 */
export function applyPrefix(agent: AgentFile, names: ResourceNames): AgentFile {
  if (names.prefix === "") return agent;
  const rename = (name: string): string => {
    for (const [key, def] of MAP) if (name === def) return names[key];
    return name;
  };
  const instructions = agent.spec.instructions;
  return {
    ...agent,
    name: rename(agent.name),
    spec: {
      ...agent.spec,
      ...(instructions !== undefined ? { instructions: instructions.replace(/forge-editor-extras|forge-editor/g, (m) => rename(m)) } : {}),
      ...(agent.spec.mcpServers ? { mcpServers: agent.spec.mcpServers.map((s) => ({ ...s, name: rename(s.name) })) } : {}),
    },
  };
}
