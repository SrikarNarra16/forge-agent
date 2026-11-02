import type { TrueForge } from "@truefoundry/trueforge-sdk";
import type { PrepareResult } from "./agentController";
import { TRUEFORGE_START_COMMAND, describeError, type AgentFile } from "./client";

/**
 * Preflight before the first turn of a session: re-run bootstrap (idempotent; heals a lost MCP
 * registration or agent) and make sure the agent's model is configured in TrueForge. Returns the model
 * name for the status line or an actionable message. vscode-free.
 */
export interface BootstrapOutcome {
  ok: boolean;
  stage: string;
  message: string;
  agents: AgentFile[];
}

export interface PreflightDeps {
  bootstrap: () => Promise<BootstrapOutcome>;
  getClient: () => TrueForge;
  baseUrl: () => string;
}

export interface PreflightRequest {
  agentName: string;
  /** A model override; checked instead of the agent definition's model. */
  model?: string;
}

export async function preflight(deps: PreflightDeps, request: PreflightRequest): Promise<PrepareResult> {
  const ready = await deps.bootstrap();
  if (!ready.ok) {
    return {
      ok: false,
      message:
        ready.stage === "unreachable"
          ? `TrueForge is not reachable at ${deps.baseUrl()}. Start it with "npm run tf:start" (or: ${TRUEFORGE_START_COMMAND}).`
          : ready.message,
    };
  }
  const agent = ready.agents.find((a) => a.name === request.agentName);
  if (!agent) {
    return {
      ok: false,
      message: `The agent "${request.agentName}" is not defined in this extension (agents/${request.agentName}.json is missing from the install). Reinstall or update Forge.`,
    };
  }
  const model = request.model ?? agent.spec.model.name;
  try {
    const models = await deps.getClient().models.list();
    if (!models.data.some((m) => m.name === model)) {
      return { ok: false, message: `Model "${model}" is not configured in TrueForge. Run "npm run tf:setup" (needs the provider API key env var) or add it in the TrueForge UI.` };
    }
  } catch (err) {
    return { ok: false, message: `Could not check the model list in TrueForge: ${describeError(err)}` };
  }
  return { ok: true, model };
}
