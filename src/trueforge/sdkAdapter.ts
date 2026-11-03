import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { SessionSpec, TurnClient } from "./agentController";

/**
 * Adapts the TrueForge SDK client to the small TurnClient interface the controller depends on. Takes a
 * factory so a changed `forge.trueforge.baseUrl` is picked up without recreating the controller.
 *
 * Model override: when a different model is requested than the one in the saved agent's definition, the
 * session is created with the agent's spec inline and `model.name` replaced (the committed agent file stays
 * the default). If the saved agent already uses that model, or cannot be found, the session just references it by name.
 */
export async function resolveAgentRef(client: TrueForge, agentName: string, model: string | undefined): Promise<TrueForgeApi.CreateSessionAgent> {
  if (!model) return { name: agentName };
  for await (const agent of await client.agents.list({ agentName, limit: 100 })) {
    if (agent.name !== agentName) continue;
    if (agent.manifest.model.name === model) return { name: agentName };
    return { spec: { ...agent.manifest, model: { ...agent.manifest.model, name: model } } };
  }
  return { name: agentName };
}

export function createSdkTurnClient(getClient: () => TrueForge): TurnClient {
  return {
    async createSession(spec: SessionSpec) {
      const client = getClient();
      const agent = await resolveAgentRef(client, spec.agentName, spec.model);
      const res = await client.sessions.create({ agent, ...(spec.metadata ? { metadata: spec.metadata } : {}) });
      return { id: res.data.id };
    },
    async createTurnStream(sessionId, input, options) {
      const stream = await getClient().sessions.createTurnStream(sessionId, { input }, options?.signal ? { abortSignal: options.signal } : undefined);
      return (async function* () {
        for await (const event of stream) yield event;
      })();
    },
    async cancel(sessionId) {
      await getClient().sessions.cancel(sessionId);
    },
  };
}
