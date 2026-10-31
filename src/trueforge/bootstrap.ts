import * as vscode from "vscode";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import type { McpServerHandle } from "../mcp/server";
import { TOOL_NAMES } from "../mcp/tools/index";
import type { Logger } from "../util/log";
import {
  FORGE_EDITOR_SERVER,
  TRUEFORGE_START_COMMAND,
  buildMcpServerUpsert,
  describeError,
  ensureAgent,
  isUnreachable,
  listMcpToolNames,
  parseAgentFile,
  type AgentFile,
} from "./client";

/**
 * Bootstrap: after the MCP server is listening, registers it in TrueForge (forge-editor, header
 * auth), verifies TrueForge can list our tools, and upserts the agents from agents/*.json.
 * Never throws; failures are logged and returned. If TrueForge is unreachable it stays quiet and
 * runs again when the status bar next sees TrueForge connected.
 */
export type BootstrapStage = "mcp-start" | "unreachable" | "mcp-register" | "mcp-verify" | "agents" | "done";

export interface BootstrapResult {
  ok: boolean;
  stage: BootstrapStage;
  message: string;
  /** Agents parsed from agents/*.json (valid even if upserting them failed). */
  agents: AgentFile[];
}

export interface BootstrapDeps {
  log: Logger;
  extensionUri: vscode.Uri;
  token: string;
  /** Resolves when the MCP server is listening. */
  mcp: Promise<McpServerHandle>;
  /** Called per run so a changed forge.trueforge.baseUrl is picked up. */
  getClient: () => TrueForge;
}

export class Bootstrapper {
  private running: Promise<BootstrapResult> | undefined;
  private last: BootstrapResult | undefined;
  private toastShown = false;

  constructor(private readonly deps: BootstrapDeps) {}

  /** Re-run bootstrap when TrueForge (re)appears and the last run did not succeed. */
  watch(status: { onDidChangeState: vscode.Event<string> }): vscode.Disposable {
    return status.onDidChangeState((state) => {
      if (state === "connected" && !this.last?.ok) void this.run();
    });
  }

  get result(): BootstrapResult | undefined {
    return this.last;
  }

  /** Returns the last successful result, or runs bootstrap (single-flight) if it has not succeeded yet. */
  async ensureReady(): Promise<BootstrapResult> {
    if (this.last?.ok) return this.last;
    return this.run();
  }

  run(): Promise<BootstrapResult> {
    this.running ??= this.execute().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  private async execute(): Promise<BootstrapResult> {
    const { log } = this.deps;
    let agents: AgentFile[] = [];
    const finish = (ok: boolean, stage: BootstrapStage, message: string): BootstrapResult => {
      this.last = { ok, stage, message, agents };
      if (ok) log.info(`Bootstrap complete: ${message}`);
      return this.last;
    };

    let handle: McpServerHandle;
    try {
      handle = await this.deps.mcp;
    } catch (err) {
      log.error("MCP server failed to start", err);
      return finish(false, "mcp-start", `The Forge MCP server failed to start: ${describeError(err)}`);
    }

    try {
      agents = await this.loadAgents();
    } catch (err) {
      log.error("Could not load agents/*.json", err);
      return finish(false, "agents", `Could not load agent definitions: ${describeError(err)}`);
    }

    const client = this.deps.getClient();
    try {
      await client.settings.mcpServers.createOrUpdate(buildMcpServerUpsert(handle.url, this.deps.token));
      log.info(`Registered MCP server "${FORGE_EDITOR_SERVER}" in TrueForge at ${handle.url}`);
    } catch (err) {
      if (isUnreachable(err)) {
        log.info("TrueForge not reachable yet; will retry when it connects.");
        return finish(false, "unreachable", "TrueForge is not reachable.");
      }
      return this.mcpFailure("mcp-register", handle.url, err, agents);
    }

    try {
      const tools = await listMcpToolNames(client, FORGE_EDITOR_SERVER);
      log.info(`TrueForge lists tools from ${FORGE_EDITOR_SERVER}: ${tools.join(", ") || "(none)"}`);
      const missing = TOOL_NAMES.filter((name) => !tools.includes(name));
      if (missing.length > 0) {
        throw new Error(`TrueForge does not list these tools: ${missing.join(", ")} (it lists ${tools.length})`);
      }
    } catch (err) {
      if (isUnreachable(err)) {
        log.info("TrueForge became unreachable during verification; will retry when it connects.");
        return finish(false, "unreachable", "TrueForge is not reachable.");
      }
      return this.mcpFailure("mcp-verify", handle.url, err, agents);
    }

    try {
      for (const agent of agents) {
        const res = await ensureAgent(client, agent);
        log.info(`Agent "${agent.name}" ${res.action} (id ${res.id})`);
      }
    } catch (err) {
      if (isUnreachable(err)) return finish(false, "unreachable", "TrueForge is not reachable.");
      log.error("Could not upsert agents", err);
      return finish(false, "agents", `Could not save agents in TrueForge: ${describeError(err)}`);
    }

    return finish(true, "done", `${agents.length} agent(s), ${TOOL_NAMES.length} tools verified`);
  }

  private mcpFailure(stage: "mcp-register" | "mcp-verify", url: string, err: unknown, agents: AgentFile[]): BootstrapResult {
    const { log } = this.deps;
    const detail = describeError(err);
    log.error(`${stage} failed for ${url}: ${detail}`);
    const message =
      `TrueForge could not use the Forge MCP server at ${url} (${detail}). ` +
      `TrueForge blocks loopback URLs unless the OUTBOUND_URL_ALLOWED_HOSTS env var allows them. ` +
      `Restart TrueForge with: ${TRUEFORGE_START_COMMAND}`;
    this.last = { ok: false, stage, message, agents };
    if (!this.toastShown) {
      this.toastShown = true;
      void vscode.window.showErrorMessage(message, "Copy start command").then((choice) => {
        if (choice) void vscode.env.clipboard.writeText(TRUEFORGE_START_COMMAND);
      });
    }
    return this.last;
  }

  /** Reads and validates every agents/*.json shipped with the extension (async vscode fs, no sync I/O). */
  private async loadAgents(): Promise<AgentFile[]> {
    const dir = vscode.Uri.joinPath(this.deps.extensionUri, "agents");
    const entries = await vscode.workspace.fs.readDirectory(dir);
    const files = entries.filter(([name, type]) => type === vscode.FileType.File && name.endsWith(".json")).map(([name]) => name).sort();
    const decoder = new TextDecoder();
    const agents: AgentFile[] = [];
    for (const name of files) {
      const bytes = await vscode.workspace.fs.readFile(vscode.Uri.joinPath(dir, name));
      try {
        agents.push(parseAgentFile(JSON.parse(decoder.decode(bytes)) as unknown));
      } catch (err) {
        throw new Error(`agents/${name}: ${describeError(err)}`);
      }
    }
    return agents;
  }
}
