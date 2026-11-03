import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { GATED_TOOL_NAMES, READ_TOOL_NAMES, TOOL_NAMES, registerTools } from "../src/mcp/tools/index";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig } from "./helpers/fakeHost";

/** Exercises the tools through a real MCP client/server pair, i.e. what the model's schema validation sees. */
describe("tools over MCP", () => {
  let client: Client;
  let server: McpServer;
  const rig = makeRig();

  beforeEach(async () => {
    server = new McpServer({ name: "forge-editor", version: "0" });
    registerTools(server, new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE }), rig.deps);
    client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("registers exactly the expected tools; read tools are read-only, the write tools are not", async () => {
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
    for (const tool of tools) {
      const isGated = (GATED_TOOL_NAMES as readonly string[]).includes(tool.name);
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(!isGated);
      expect(tool.annotations?.destructiveHint, tool.name).toBe(tool.name === "run_command");
    }
    expect([...READ_TOOL_NAMES, ...GATED_TOOL_NAMES].sort()).toEqual([...TOOL_NAMES].sort());
  });

  it("gives every tool and every parameter a description (this is what the model reads)", async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      expect(tool.description?.length ?? 0, `${tool.name} description`).toBeGreaterThan(40);
      const props = (tool.inputSchema.properties ?? {}) as Record<string, { description?: string }>;
      for (const [name, schema] of Object.entries(props)) {
        expect(schema.description?.length ?? 0, `${tool.name}.${name}`).toBeGreaterThan(10);
      }
    }
  });

  it("marks path and why as required for read_file", async () => {
    const { tools } = await client.listTools();
    const readFile = tools.find((t) => t.name === "read_file");
    expect(readFile?.inputSchema.required).toEqual(expect.arrayContaining(["path", "why"]));
    const why = (readFile?.inputSchema.properties as Record<string, { description?: string }>).why;
    expect(why?.description).toMatch(/REQUIRED.*why/s);
  });

  it("serves calls end to end, including read_file's context event", async () => {
    const res = await client.callTool({ name: "read_file", arguments: { path: "src/app/helpers.py", start: 4, end: 4, why: "see the function" } });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("def get_debug_flag");
    expect(rig.reads.at(-1)).toMatchObject({ path: "src/app/helpers.py", start: 4, end: 4, why: "see the function" });
    const search = await client.callTool({ name: "search_code", arguments: { query: "get_debug_flag", kind: "symbol" } });
    expect(JSON.stringify(search.content)).toContain("src/app/helpers.py:4");
  });

  it("surfaces a missing `why` as an error that names the field", async () => {
    let message = "";
    try {
      const res = await client.callTool({ name: "read_file", arguments: { path: "src/app/helpers.py" } });
      message = JSON.stringify(res.content);
      expect(res.isError).toBe(true);
    } catch (err) {
      message = err instanceof Error ? err.message : String(err);
    }
    expect(message).toMatch(/why/);
  });

  it("returns teaching isError results for bad paths", async () => {
    const res = await client.callTool({ name: "read_file", arguments: { path: "../../etc/passwd", why: "just testing it" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/outside the workspace/);
  });

  it("keeps ping", async () => {
    const res = await client.callTool({ name: "ping", arguments: {} });
    expect(JSON.stringify(res.content)).toContain("pong from forge-editor");
  });
});
