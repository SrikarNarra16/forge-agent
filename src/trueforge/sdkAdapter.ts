import type { TrueForge, TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { SessionSpec, TurnClient } from "./agentController";
import type { StreamEvent } from "./events";

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
    async getTurnStatus(sessionId, turnId) {
      const res = await getClient().sessions.getTurn(sessionId, turnId);
      return String((res.data as { state?: { status?: string } }).state?.status ?? "unknown");
    },
    async subscribeToTurn(sessionId, turnId, options) {
      const stream = await getClient().sessions.subscribeToTurn(sessionId, turnId, { afterSequenceNumber: options.afterSequenceNumber }, options.signal ? { abortSignal: options.signal } : undefined);
      return (async function* () {
        for await (const event of stream) yield event;
      })();
    },
    async listTurnEvents(sessionId, turnId) {
      const events: StreamEvent[] = [];
      for await (const event of await getClient().sessions.listTurnEvents(sessionId, turnId, { limit: 100 })) events.push(event as unknown as StreamEvent);
      return events;
    },
  };
}
