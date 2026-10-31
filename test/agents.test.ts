import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseAgentFile } from "../src/trueforge/client";

async function loadJson(file: string): Promise<unknown> {
  return JSON.parse(await readFile(join(__dirname, "..", "agents", file), "utf8")) as unknown;
}

describe("parseAgentFile", () => {
  it("converts agents/forge-agent.json (snake_case wire format) to SDK camelCase types", async () => {
    const agent = parseAgentFile(await loadJson("forge-agent.json"));
    expect(agent.name).toBe("forge-agent");
    expect(agent.spec.model.name).toBe("deepseek/flash");
    expect(agent.spec.mcpServers).toEqual([
      { name: "forge-editor", enableTools: ["@all"], requireApprovalForTools: [], preload: true },
    ]);
    expect(agent.spec.config).toEqual({
      iterationLimit: 20,
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: false },
      generativeUi: { enabled: false },
    });
  });

  it("rejects unknown fields instead of silently dropping them", async () => {
    const raw = (await loadJson("forge-agent.json")) as { manifest: Record<string, unknown> };
    expect(() => parseAgentFile({ ...raw, manifest: { ...raw.manifest, bogus_field: 1 } })).toThrow(/bogus_field/);
    expect(() => parseAgentFile({ ...raw, extra: true })).toThrow(/extra/);
  });

  it("rejects a manifest without a model", () => {
    expect(() => parseAgentFile({ name: "x-agent", description: "d", manifest: {} })).toThrow(/model/);
  });
});
