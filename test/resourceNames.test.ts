import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { parseAgentFile } from "../src/trueforge/client";
import { registerMcpServers } from "../src/trueforge/mcpRegistration";
import { preflight } from "../src/trueforge/preflight";
import { DEFAULT_NAMES, applyPrefix, resolvePrefix, resourceNames } from "../src/trueforge/resourceNames";
import { EXTRAS_TOOL_NAMES } from "../src/mcp/tools/extras";
import { TOOL_NAMES } from "../src/mcp/tools/index";
import { assertThrowaway } from "../scripts/eval/guard";

const load = async (file: string) => parseAgentFile(JSON.parse(await readFile(join(__dirname, "..", "agents", file), "utf8")) as unknown);

describe("resolvePrefix", () => {
  it("defaults to empty; the environment wins over the setting; invalid prefixes are rejected", () => {
    expect(resolvePrefix({})).toBe("");
    expect(resolvePrefix({ setting: "win2-" })).toBe("win2-");
    expect(resolvePrefix({ env: "e2e-1-", setting: "win2-" })).toBe("e2e-1-");
    expect(resolvePrefix({ env: "  ", setting: "win2-" })).toBe("win2-"); // an empty env var does not override
    expect(() => resolvePrefix({ env: "Bad Prefix" })).toThrow(/Invalid resource prefix/);
    expect(() => resolvePrefix({ setting: "-x" })).toThrow(/Invalid resource prefix/);
  });
});

describe("resourceNames / applyPrefix", () => {
  it("builds the four prefixed names", () => {
    expect(resourceNames("e2e-7-")).toEqual({ prefix: "e2e-7-", editor: "e2e-7-forge-editor", extras: "e2e-7-forge-editor-extras", agent: "e2e-7-forge-agent", inline: "e2e-7-forge-inline" });
    expect(resourceNames("")).toMatchObject({ editor: DEFAULT_NAMES.editor, agent: DEFAULT_NAMES.agent });
  });

  it("an empty prefix leaves the agent files exactly as committed (same object)", async () => {
    for (const f of ["forge-agent.json", "forge-inline.json"]) {
      const agent = await load(f);
      expect(applyPrefix(agent, resourceNames(""))).toBe(agent);
    }
  });

  it("renames the agent, its mcp_servers and the server names in the instructions, and nothing else", async () => {
    const names = resourceNames("e2e-7-");
    const agent = await load("forge-agent.json");
    const out = applyPrefix(agent, names);
    expect(out.name).toBe("e2e-7-forge-agent");
    expect(out.spec.mcpServers?.map((s) => s.name)).toEqual(["e2e-7-forge-editor", "e2e-7-forge-editor-extras"]);
    expect(out.spec.instructions).toContain("git_diff from e2e-7-forge-editor-extras");
    expect(out.spec.instructions).not.toMatch(/(?<!e2e-7-)forge-editor/);
    // everything else is untouched
    expect({ ...out.spec, mcpServers: agent.spec.mcpServers, instructions: agent.spec.instructions }).toEqual(agent.spec);
    expect(out.spec.mcpServers?.[0]).toMatchObject({ requireApprovalForTools: ["propose_edit", "create_file", "run_command"], preload: true });
    expect(out.spec.mcpServers?.[1]).toMatchObject({ preload: false });
    // the committed agent object is not mutated
    expect(agent.name).toBe("forge-agent");
    expect(agent.spec.mcpServers?.[0]?.name).toBe("forge-editor");

    const inline = applyPrefix(await load("forge-inline.json"), names);
    expect(inline.name).toBe("e2e-7-forge-inline");
    expect(inline.spec.mcpServers?.map((s) => s.name)).toEqual(["e2e-7-forge-editor"]);
  });
});

describe("registration and preflight honour the prefix", () => {
  it("registerMcpServers registers and verifies the prefixed server names", async () => {
    const upserts: string[] = [];
    const listed: string[] = [];
    const client = {
      settings: { mcpServers: { createOrUpdate: (r: { manifest: { name: string } }) => (upserts.push(r.manifest.name), Promise.resolve({})) } },
      mcpServers: { listTools: (name: string) => (listed.push(name), Promise.resolve({ data: (name.endsWith("extras") ? [...EXTRAS_TOOL_NAMES] : [...TOOL_NAMES]).map((n) => ({ name: n })) })) },
    } as unknown as TrueForge;
    const names = resourceNames("e2e-7-");
    const r = await registerMcpServers(client, { url: "http://127.0.0.1:1/mcp", extrasUrl: "http://127.0.0.1:1/mcp-extras" }, "tok", () => undefined, names);
    expect(r).toEqual({ ok: true });
    expect(upserts).toEqual(["e2e-7-forge-editor", "e2e-7-forge-editor-extras"]);
    expect(listed).toEqual(["e2e-7-forge-editor", "e2e-7-forge-editor-extras"]);
  });

  it("preflight finds the prefixed agent by its prefixed name (and not the default one)", async () => {
    const names = resourceNames("e2e-7-");
    const agents = [applyPrefix(await load("forge-agent.json"), names)];
    const deps = {
      bootstrap: () => Promise.resolve({ ok: true, stage: "done", message: "", agents }),
      getClient: () => ({ models: { list: () => Promise.resolve({ data: [{ name: "deepseek/flash" }] }) } }) as unknown as TrueForge,
      baseUrl: () => "http://localhost:8790",
    };
    expect(await preflight(deps, { agentName: names.agent })).toEqual({ ok: true, model: "deepseek/flash" });
    expect(await preflight(deps, { agentName: "forge-agent" })).toMatchObject({ ok: false });
  });

  it("the eval/e2e name guard accepts only e2e-<pid>- prefixed Forge names", () => {
    for (const ok of ["e2e-123-forge-editor", "e2e-123-forge-editor-extras", "e2e-123-forge-agent", "e2e-123-forge-inline"]) expect(() => assertThrowaway(ok), ok).not.toThrow();
    for (const bad of ["forge-agent", "forge-editor", "forge-inline", "e2e-forge-agent", "e2e-12-forge-other", "xe2e-12-forge-agent"]) expect(() => assertThrowaway(bad), bad).toThrow(/SAFETY/);
  });
});
