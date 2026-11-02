import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { READ_TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/mcp/tools/index";
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
      { name: "forge-editor", enableTools: ["@all"], requireApprovalForTools: ["propose_edit", "create_file"], preload: true },
    ]);
    expect(agent.spec.config).toEqual({
      iterationLimit: 20,
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: false },
      generativeUi: { enabled: false },
    });
  });

  it("gates the write tools BY NAME (never via @write labels) and exactly the ones the server exposes", async () => {
    const agent = parseAgentFile(await loadJson("forge-agent.json"));
    const gated = agent.spec.mcpServers?.[0]?.requireApprovalForTools;
    expect(gated).toEqual([...WRITE_TOOL_NAMES]);
    expect(gated).not.toContain("@write");
    expect(gated).not.toContain("@all");
    for (const name of READ_TOOL_NAMES) expect(gated).not.toContain(name);
  });

  it("teaches the editing workflow in the instructions", async () => {
    const instructions = parseAgentFile(await loadJson("forge-agent.json")).spec.instructions ?? "";
    for (const phrase of ["propose_edit", "create_file", "read_file", "one file per call", "reject", "Never say a change is made until"]) expect(instructions).toContain(phrase);
    expect(parseAgentFile(await loadJson("forge-agent.json")).spec.model.name).toBe("deepseek/flash");
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

describe("forge-agent instructions: one propose_edit per file", () => {
  it("tell the agent to combine edits per file and not to re-propose rejected hunks", async () => {
    const instructions = parseAgentFile(await loadJson("forge-agent.json")).spec.instructions ?? "";
    expect(instructions).toContain("Combine ALL changes to one file into a SINGLE propose_edit call");
    expect(instructions).toContain("Never send two propose_edit calls for the same file in one step");
    expect(instructions).toContain("If a hunk was rejected by the user, do not re-propose it");
  });
});
