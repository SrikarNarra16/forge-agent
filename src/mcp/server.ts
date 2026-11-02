import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { checkBearer, type BearerToken } from "./auth";
import type { DecisionStore } from "./decisions";
import { McpEvents } from "./events";
import type { WorkspaceHost } from "./host";
import { createToolDeps, type ToolBudgets, type ToolDeps } from "./tools/common";
import { registerTools } from "./tools/index";

/**
 * Localhost streamable-HTTP MCP server (127.0.0.1, random port, path /mcp) exposing editor
 * capabilities to the TrueForge agent. Every /mcp request needs `Authorization: Bearer <token>`.
 * Stateless: a fresh McpServer + transport per request. GET /healthz is unauthenticated.
 */
export interface McpServerHandle {
  readonly port: number;
  /** URL to register in TrueForge, e.g. http://127.0.0.1:41234/mcp */
  readonly url: string;
  dispose(): Promise<void>;
}

export interface McpServerOptions {
  token: BearerToken;
  /** Editor access for the tools (vscode implementation in production, in-memory fake in tests). */
  host: WorkspaceHost;
  /** Receives `context:read` events from read_file; a private bus is used when omitted. */
  events?: McpEvents;
  /** Where the review handler records approval decisions for propose_edit / create_file. */
  decisions?: DecisionStore;
  budgets?: Partial<ToolBudgets>;
  /** Receives server and tool log lines (tool name, duration, argument summary). Never the token, request bodies or file contents. */
  log?: (message: string) => void;
}

const MAX_BODY_BYTES = 1_000_000;
const SERVER_INFO = { name: "forge-editor", version: "0.0.1" } as const;

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: http.OutgoingHttpHeaders = {}): void {
  if (res.headersSent) return;
  res.writeHead(status, { "content-type": "application/json", ...headers });
  res.end(JSON.stringify(body));
}

function rpcError(res: http.ServerResponse, status: number, code: number, message: string, headers?: http.OutgoingHttpHeaders): void {
  sendJson(res, status, { jsonrpc: "2.0", error: { code, message }, id: null }, headers);
}

class BodyTooLargeError extends Error {}

async function readJsonBody(req: http.IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buf = chunk as Buffer;
    size += buf.length;
    if (size > MAX_BODY_BYTES) throw new BodyTooLargeError();
    chunks.push(buf);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

async function handleMcp(req: http.IncomingMessage, res: http.ServerResponse, host: WorkspaceHost, deps: ToolDeps): Promise<void> {
  let body: unknown;
  try {
    body = await readJsonBody(req);
  } catch (err) {
    if (err instanceof BodyTooLargeError) return rpcError(res, 413, -32600, "Request body too large");
    return rpcError(res, 400, -32700, "Parse error");
  }
  const server = new McpServer(SERVER_INFO);
  registerTools(server, host, deps);
  const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
  res.on("close", () => {
    void transport.close();
    void server.close();
  });
  await server.connect(transport);
  await transport.handleRequest(req, res, body);
}

export async function startMcpServer(options: McpServerOptions): Promise<McpServerHandle> {
  const { token, host, log } = options;
  const deps = createToolDeps({ log: (m) => log?.(m), events: options.events ?? new McpEvents(), ...(options.budgets ? { budgets: options.budgets } : {}), ...(options.decisions ? { decisions: options.decisions } : {}) });

  const httpServer = http.createServer((req, res) => {
    const path = (req.url ?? "").split("?")[0];
    if (path === "/healthz" && req.method === "GET") {
      res.writeHead(200, { "content-type": "text/plain" });
      res.end("ok");
      return;
    }
    if (path !== "/mcp") {
      sendJson(res, 404, { error: "not found" });
      return;
    }
    if (!checkBearer(req.headers.authorization, token)) {
      rpcError(res, 401, -32001, "Unauthorized", { "www-authenticate": "Bearer" });
      return;
    }
    if (req.method !== "POST") {
      rpcError(res, 405, -32000, "Method not allowed (stateless server: POST only)", { allow: "POST" });
      return;
    }
    handleMcp(req, res, host, deps).catch((err: unknown) => {
      log?.(`MCP request failed: ${err instanceof Error ? err.message : String(err)}`);
      rpcError(res, 500, -32603, "Internal server error");
    });
  });

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(0, "127.0.0.1", () => {
      httpServer.off("error", reject);
      resolve();
    });
  });

  const port = (httpServer.address() as AddressInfo).port;
  log?.(`MCP server listening on 127.0.0.1:${port}`);

  let closing: Promise<void> | undefined;
  return {
    port,
    url: `http://127.0.0.1:${port}/mcp`,
    dispose: () => {
      closing ??= new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      });
      return closing;
    },
  };
}
