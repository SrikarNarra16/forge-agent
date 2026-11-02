import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { startMcpServer, type McpServerHandle } from "../src/mcp/server";
import { READ_TOOL_NAMES, TOOL_NAMES } from "../src/mcp/tools/index";
import { FIXTURE_FILES, FakeHost } from "./helpers/fakeHost";

const TOKEN = "test-token";

describe("MCP server", () => {
  let handle: McpServerHandle;

  beforeEach(async () => {
    handle = await startMcpServer({ token: TOKEN, host: new FakeHost(FIXTURE_FILES) });
  });
  afterEach(async () => {
    await handle.dispose();
  });

  const base = (): string => `http://127.0.0.1:${handle.port}`;
  const initBody = JSON.stringify({
    jsonrpc: "2.0",
    id: 1,
    method: "initialize",
    params: { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "t", version: "0" } },
  });

  it("serves /healthz without auth", async () => {
    const res = await fetch(`${base()}/healthz`);
    expect(res.status).toBe(200);
    expect(await res.text()).toBe("ok");
  });

  it("rejects /mcp without or with a wrong bearer token (401)", async () => {
    const headers = { "content-type": "application/json", accept: "application/json, text/event-stream" };
    const none = await fetch(`${base()}/mcp`, { method: "POST", headers, body: initBody });
    expect(none.status).toBe(401);
    const wrong = await fetch(`${base()}/mcp`, { method: "POST", headers: { ...headers, authorization: "Bearer nope" }, body: initBody });
    expect(wrong.status).toBe(401);
  });

  it("returns 404 for unknown paths", async () => {
    expect((await fetch(`${base()}/other`)).status).toBe(404);
  });

  it("lists and calls the ping tool through a real MCP client", async () => {
    const client = new Client({ name: "test", version: "0" });
    const transport = new StreamableHTTPClientTransport(new URL(handle.url), {
      requestInit: { headers: { Authorization: `Bearer ${TOKEN}` } },
    });
    await client.connect(transport);
    try {
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const readOnly = tools.tools.filter((t) => t.annotations?.readOnlyHint === true).map((t) => t.name).sort();
      expect(readOnly).toEqual([...READ_TOOL_NAMES].sort());
      const result = await client.callTool({ name: "ping", arguments: {} });
      expect(result.content).toEqual([{ type: "text", text: "pong from forge-editor" }]);
      const read = await client.callTool({ name: "read_file", arguments: { path: "src/app/helpers.py", start: 4, end: 4, why: "check the server wiring" } });
      expect(JSON.stringify(read.content)).toContain("def get_debug_flag");
    } finally {
      await client.close();
    }
  });

  it("stops listening after dispose", async () => {
    const port = handle.port;
    await handle.dispose();
    await expect(fetch(`http://127.0.0.1:${port}/healthz`)).rejects.toThrow();
  });
});
