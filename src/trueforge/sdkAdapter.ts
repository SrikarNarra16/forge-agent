import type { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TurnClient } from "./agentController";

/**
 * Adapts the TrueForge SDK client to the small TurnClient interface the controller depends on. Takes a
 * factory so a changed `forge.trueforge.baseUrl` is picked up without recreating the controller.
 */
export function createSdkTurnClient(getClient: () => TrueForge): TurnClient {
  return {
    async createSession(agentName, metadata) {
      const res = await getClient().sessions.create({ agent: { name: agentName }, ...(metadata ? { metadata } : {}) });
      return { id: res.data.id };
    },
    async createTurnStream(sessionId, input) {
      const stream = await getClient().sessions.createTurnStream(sessionId, { input });
      return (async function* () {
        for await (const event of stream) yield event;
      })();
    },
    async cancel(sessionId) {
      await getClient().sessions.cancel(sessionId);
    },
  };
}
