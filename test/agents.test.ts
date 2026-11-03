import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { GATED_TOOL_NAMES, READ_TOOL_NAMES, TOOL_NAMES, WRITE_TOOL_NAMES } from "../src/mcp/tools/index";
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
      { name: "forge-editor", enableTools: ["@all"], requireApprovalForTools: ["propose_edit", "create_file", "run_command"], preload: true },
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
    expect(gated).toEqual([...GATED_TOOL_NAMES]);
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

describe("agents/forge-inline.json", () => {
  const load = async () => parseAgentFile(await loadJson("forge-inline.json"));

  it("is the inline editor: deepseek/flash, 8 iterations, no extras", async () => {
    const agent = await load();
    expect(agent.name).toBe("forge-inline");
    expect(agent.spec.model.name).toBe("deepseek/flash");
    expect(agent.spec.config).toEqual({
      iterationLimit: 8,
      dynamicSubAgents: { enabled: false },
      askUserQuestions: { enabled: false },
      generativeUi: { enabled: false },
    });
  });

  it("exposes only read_file, search_code and propose_edit of the forge-editor server, preloaded", async () => {
    const [server, ...rest] = (await load()).spec.mcpServers ?? [];
    expect(rest).toEqual([]);
    expect(server).toMatchObject({ name: "forge-editor", enableTools: ["read_file", "search_code", "propose_edit"], preload: true });
    for (const tool of server?.enableTools ?? []) expect(TOOL_NAMES as readonly string[]).toContain(tool);
  });

  it("gates propose_edit BY NAME and nothing it cannot call", async () => {
    const server = (await load()).spec.mcpServers?.[0];
    expect(server?.requireApprovalForTools).toEqual(["propose_edit"]);
    for (const gated of server?.requireApprovalForTools ?? []) {
      expect(WRITE_TOOL_NAMES as readonly string[]).toContain(gated);
      expect(server?.enableTools).toContain(gated);
    }
  });

  it("gives the model the single-call, smallest-edit, code-and-docstring workflow", async () => {
    const instructions = (await load()).spec.instructions ?? "";
    for (const phrase of ["at most two tool calls", "propose_edit ONCE", "smallest old_text/new_text edits", "must match exactly once", "code AND its docstring", "one sentence after the tool result"]) {
      expect(instructions).toContain(phrase);
    }
  });
});

describe("all agents/*.json", () => {
  it("parse, are named after their file, and have unique names (bootstrap upserts every one)", async () => {
    const { readdir } = await import("node:fs/promises");
    const files = (await readdir(join(__dirname, "..", "agents"))).filter((f) => f.endsWith(".json")).sort();
    expect(files).toEqual(["forge-agent.json", "forge-inline.json"]);
    const names = [];
    for (const file of files) {
      const agent = parseAgentFile(await loadJson(file));
      expect(`${agent.name}.json`).toBe(file);
      names.push(agent.name);
    }
    expect(new Set(names).size).toBe(names.length);
  });
});
