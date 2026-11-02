import { describe, expect, it } from "vitest";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { createSdkTurnClient, resolveAgentRef } from "../src/trueforge/sdkAdapter";

const manifest = { model: { name: "deepseek/flash", params: { temperature: 0 } }, instructions: "be precise", mcpServers: [{ name: "forge-editor" }] };

function fakeClient(agents: Array<{ name: string }>, created: unknown[] = []): TrueForge {
  return {
    agents: {
      list: () => Promise.resolve({ async *[Symbol.asyncIterator]() { for (const a of agents) yield { ...a, id: `id-${a.name}`, manifest }; } }),
    },
    sessions: {
      create: (req: unknown) => {
        created.push(req);
        return Promise.resolve({ data: { id: "sess-x" } });
      },
    },
  } as unknown as TrueForge;
}

describe("resolveAgentRef (model override)", () => {
  it("uses the saved agent by name when no model is requested", async () => {
    expect(await resolveAgentRef(fakeClient([{ name: "forge-inline" }]), "forge-inline", undefined)).toEqual({ name: "forge-inline" });
  });
  it("uses the saved agent by name when the requested model is the one in its definition", async () => {
    expect(await resolveAgentRef(fakeClient([{ name: "forge-inline" }]), "forge-inline", "deepseek/flash")).toEqual({ name: "forge-inline" });
  });
  it("overrides ONLY model.name in an inline spec when a different model is requested, keeping everything else", async () => {
    const ref = await resolveAgentRef(fakeClient([{ name: "forge-inline" }]), "forge-inline", "groq/gpt-oss-120b");
    expect(ref).toEqual({ spec: { ...manifest, model: { name: "groq/gpt-oss-120b", params: { temperature: 0 } } } });
    expect(manifest.model.name).toBe("deepseek/flash"); // the agent definition itself is not modified
  });
  it("falls back to the name when the agent is not found (TrueForge then reports it)", async () => {
    expect(await resolveAgentRef(fakeClient([{ name: "other" }]), "forge-inline", "m/x")).toEqual({ name: "forge-inline" });
  });
});

describe("createSdkTurnClient.createSession", () => {
  it("creates by name, or with the overridden spec, and passes metadata", async () => {
    const created: unknown[] = [];
    const client = createSdkTurnClient(() => fakeClient([{ name: "forge-inline" }], created));
    expect(await client.createSession({ agentName: "forge-inline", metadata: { purpose: "inline-edit" } })).toEqual({ id: "sess-x" });
    await client.createSession({ agentName: "forge-inline", model: "groq/gpt-oss-120b" });
    expect(created[0]).toEqual({ agent: { name: "forge-inline" }, metadata: { purpose: "inline-edit" } });
    expect(created[1]).toMatchObject({ agent: { spec: { model: { name: "groq/gpt-oss-120b" } } } });
  });
});
