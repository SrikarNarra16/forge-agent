import type { TrueForge } from "@truefoundry/trueforge-sdk";
import type { TurnClient } from "./agentController";

/** Adapts the TrueForge SDK client to the small TurnClient interface the controller depends on. */
export function createSdkTurnClient(client: TrueForge): TurnClient {
  return {
    async createSession(agentName, metadata) {
      const res = await client.sessions.create({ agent: { name: agentName }, ...(metadata ? { metadata } : {}) });
      return { id: res.data.id };
    },
    async createTurnStream(sessionId, input) {
      const stream = await client.sessions.createTurnStream(sessionId, { input });
      return (async function* () {
        for await (const event of stream) yield event;
      })();
    },
    async cancel(sessionId) {
      await client.sessions.cancel(sessionId);
    },
  };
}
