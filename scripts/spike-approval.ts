/**
 * TEMPORARY SPIKE (P04): how does TrueForge behave around tool approvals? Run against a live TrueForge
 * with throwaway names only: agent `forge-spike`, MCP server `forge-spike-mcp`. It writes raw captured
 * events to test/fixtures/approval/*.jsonl and prints the facts that go into docs/approval-spike.md.
 *
 * SAFETY: the user's running extension owns `forge-editor` and `forge-agent`. Every mutating call below
 * goes through `assertThrowaway`, the script refuses to start if either throwaway name already exists, and
 * at the end it verifies that nothing except its own items changed.
 *
 *   npx tsx scripts/spike-approval.ts            (costs about a dozen cheap model calls)
 */
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { TrueForgeApi } from "@truefoundry/trueforge-sdk";
import { z } from "zod";
import { AgentController, type ApprovalDecision, type PendingToolCall, type TurnClient, type TurnInput, type UiSink } from "../src/trueforge/agentController";
import { createClient, describeError } from "../src/trueforge/client";
import type { StreamEvent } from "../src/trueforge/events";
import { createSdkTurnClient } from "../src/trueforge/sdkAdapter";
import { checkBearer, generateToken } from "../src/mcp/auth";

const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const AGENT = "forge-spike";
const MCP = "forge-spike-mcp";
const MODEL = "deepseek/flash";
const OUT_DIR = join(__dirname, "..", "test", "fixtures", "approval");

function assertThrowaway(name: string): void {
  if (!name.startsWith("forge-spike")) throw new Error(`SAFETY: refusing to touch "${name}" (only forge-spike* names are allowed)`);
}

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// --- throwaway MCP server -------------------------------------------------------------------------

interface SpikeServer {
  url: string;
  token: string;
  written: string[];
  close(): Promise<void>;
}

async function startSpikeServer(): Promise<SpikeServer> {
  const token = generateToken();
  const written: string[] = [];
  const makeServer = (): McpServer => {
    const server = new McpServer({ name: MCP, version: "0" });
    server.registerTool(
      "echo_write",
      {
        description: "Appends `text` to an in-memory list. Gated: needs the user's approval.",
        inputSchema: { text: z.string().describe("Text to append") },
        annotations: { readOnlyHint: false, destructiveHint: false },
      },
      ({ text }) => {
        written.push(text);
        return { content: [{ type: "text", text: `appended ${JSON.stringify(text)}; list is now ${JSON.stringify(written)}` }] };
      },
    );
    server.registerTool(
      "echo_read",
      { description: "Returns the in-memory list. Not gated.", annotations: { readOnlyHint: true } },
      () => ({ content: [{ type: "text", text: `list is ${JSON.stringify(written)}` }] }),
    );
    return server;
  };
  const httpServer = http.createServer((req, res) => {
    if (!checkBearer(req.headers.authorization, token)) {
      res.writeHead(401).end();
      return;
    }
    if (req.method !== "POST") {
      res.writeHead(405, { allow: "POST" }).end(); // stateless server: no GET stream, no DELETE
      return;
    }
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      void (async () => {
        try {
          const raw = Buffer.concat(chunks).toString("utf8");
          if (raw.trim() === "") {
            res.writeHead(400).end();
            return;
          }
          const server = makeServer();
          const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined });
          res.on("close", () => {
            void transport.close();
            void server.close();
          });
          await server.connect(transport);
          await transport.handleRequest(req, res, JSON.parse(raw) as unknown);
        } catch (err) {
          console.error(`spike server error: ${describeError(err)}`);
          if (!res.headersSent) res.writeHead(500);
          res.end();
        }
      })();
    });
  });
  await new Promise<void>((resolve) => httpServer.listen(0, "127.0.0.1", resolve));
  const port = (httpServer.address() as AddressInfo).port;
  return {
    url: `http://127.0.0.1:${port}/mcp`,
    token,
    written,
    close: () =>
      new Promise<void>((resolve) => {
        httpServer.close(() => resolve());
        httpServer.closeAllConnections();
      }),
  };
}

// --- capture ---------------------------------------------------------------------------------------

class Capture {
  readonly lines: string[] = [];
  private turn = 0;
  constructor(
    private readonly redact: (s: string) => string,
    readonly name: string,
  ) {}
  turnStarted(sessionId: string, input: unknown): number {
    this.turn++;
    this.lines.push(this.redact(JSON.stringify({ turn: this.turn, sessionId: "<session>", input })));
    void sessionId;
    return this.turn;
  }
  event(turn: number, event: unknown): void {
    this.lines.push(this.redact(JSON.stringify({ turn, event })));
  }
  probe(label: string, value: unknown): void {
    this.lines.push(this.redact(JSON.stringify({ probe: label, value })));
  }
  async save(): Promise<string> {
    await mkdir(OUT_DIR, { recursive: true });
    const file = join(OUT_DIR, `${this.name}.jsonl`);
    await writeFile(file, `${this.lines.join("\n")}\n`, "utf8");
    return file;
  }
}

/** Wraps a TurnClient so every turn's input and raw events are copied into a Capture. */
function recording(inner: TurnClient, capture: Capture, log: (m: string) => void): TurnClient {
  return {
    createSession: (agent, metadata) => inner.createSession(agent, metadata),
    cancel: (id) => inner.cancel(id),
    async createTurnStream(sessionId, input) {
      const turn = capture.turnStarted(sessionId, input);
      log(`  turn ${turn} input: ${input.map((i) => i.type).join(", ")}`);
      const stream = await inner.createTurnStream(sessionId, input);
      return (async function* () {
        for await (const event of stream) {
          capture.event(turn, event);
          yield event;
        }
      })();
    },
  };
}

class QuietUi implements UiSink {
  readonly notices: string[] = [];
  readonly states: string[] = [];
  onState(state: string): void {
    this.states.push(state);
  }
  onUserMessage(): void {}
  onTurnChange(): void {}
  onSession(): void {}
  onNotice(level: string, text: string): void {
    this.notices.push(`${level}: ${text}`);
  }
  onReset(): void {}
}

// --- main --------------------------------------------------------------------------------------------

async function main(): Promise<void> {
  const client = createClient(BASE_URL);
  const log = (m: string): void => console.log(m);
  const createdSessions: string[] = [];
  let agentAttempted = false;
  let mcpRegistered = false;
  const spike = await startSpikeServer();
  const redact = (s: string): string => s.split(spike.token).join("<token>").split(spike.url).join("http://127.0.0.1:<port>/mcp");

  const snapshot = async (): Promise<{ agents: string[]; mcp: string[]; sessions: number }> => {
    const agents: string[] = [];
    for await (const a of await client.agents.list({ limit: 100 })) agents.push(a.name);
    const mcp = (await client.settings.mcpServers.list()).data.map((m) => m.name);
    let sessions = 0;
    for await (const _s of await client.sessions.list({ limit: 25 })) sessions++;
    return { agents: agents.sort(), mcp: mcp.sort(), sessions };
  };

  /** Removes only our own throwaway items, children first. Safe to call more than once. */
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const id of createdSessions) await client.sessions.delete(id).catch(() => undefined);
    if (agentAttempted) {
      assertThrowaway(AGENT);
      // Look the agent up by its exact throwaway name (delete takes the id), so a crash between create and id capture is covered.
      for await (const a of await client.agents.list({ agentName: AGENT, limit: 100 })) {
        if (a.name === AGENT) await client.agents.delete(a.id).catch((e: unknown) => log(`cleanup agent failed: ${describeError(e)}`));
      }
    }
    if (mcpRegistered) {
      assertThrowaway(MCP);
      await client.settings.mcpServers.delete(MCP).catch((e: unknown) => log(`cleanup mcp failed: ${describeError(e)}`));
    }
    await spike.close();
  };
  const fatal = (what: string) => (err: unknown): void => {
    console.error(`${what}: ${describeError(err)}; cleaning up throwaway items`);
    void cleanup().finally(() => process.exit(1));
  };
  process.once("uncaughtException", fatal("uncaught exception"));
  process.once("unhandledRejection", fatal("unhandled rejection"));
  process.once("SIGINT", () => fatal("interrupted")(new Error("SIGINT")));
  process.once("SIGTERM", () => fatal("terminated")(new Error("SIGTERM")));

  const before = await snapshot();
  log(`Before: agents=${JSON.stringify(before.agents)} mcp=${JSON.stringify(before.mcp)} sessions=${before.sessions}`);
  if (before.agents.includes(AGENT) || before.mcp.includes(MCP)) {
    await spike.close();
    throw new Error(`ABORT: "${AGENT}" or "${MCP}" already exists on this TrueForge; refusing to touch anything.`);
  }
  const models = (await client.models.list()).data.map((m) => m.name);
  if (!models.includes(MODEL)) {
    await spike.close();
    throw new Error(`ABORT: model ${MODEL} is not configured (have: ${models.join(", ") || "none"})`);
  }

  const newSession = async (): Promise<string> => {
    const { data } = await client.sessions.create({ agent: { name: AGENT }, metadata: { client: "forge-spike" } });
    createdSessions.push(data.id);
    return data.id;
  };

  const collect = async (sessionId: string, input: TurnInput[], capture: Capture): Promise<StreamEvent[]> => {
    const turn = capture.turnStarted(sessionId, input);
    const out: StreamEvent[] = [];
    const stream = await client.sessions.createTurnStream(sessionId, { input });
    for await (const event of stream) {
      capture.event(turn, event);
      out.push(event);
    }
    return out;
  };

  const findings: Record<string, unknown> = {};

  const runScenario = async (name: string, prompt: string, decide: (c: PendingToolCall) => ApprovalDecision | Promise<ApprovalDecision>): Promise<{ capture: Capture; final: string; notices: string[]; states: string[]; decisions: string[] }> => {
    log(`\n=== scenario ${name}: ${prompt}`);
    const capture = new Capture(redact, name);
    const ui = new QuietUi();
    const decisions: string[] = [];
    let finalText = "";
    const wrappedUi: UiSink = Object.assign(ui, {
      onTurnChange: (view: { messages: Array<{ text: string; threadId: string }> }) => {
        finalText = view.messages.filter((m) => m.threadId === "main").map((m) => m.text).filter(Boolean).at(-1) ?? finalText;
      },
    });
    const controller = new AgentController({
      client: recording(createSdkTurnClient(() => client), capture, log),
      agentName: AGENT,
      ui: wrappedUi,
      approvals: {
        decide: async (call) => {
          const d = await decide(call);
          decisions.push(`${call.name}(${call.args}) -> ${d.status}`);
          return d;
        },
      },
    });
    await Promise.race([controller.send(prompt), sleep(150_000).then(() => controller.stop())]);
    if (controller.sessionId) createdSessions.push(controller.sessionId);
    log(`  states: ${ui.states.join(" > ")}   decisions: ${decisions.join(" | ") || "(none)"}`);
    log(`  final text: ${JSON.stringify(finalText.slice(0, 300))}`);
    if (ui.notices.length) log(`  notices: ${ui.notices.join(" | ")}`);
    await capture.save();
    return { capture, final: finalText, notices: ui.notices, states: ui.states, decisions };
  };

  try {
    // Register the throwaway MCP server and agent (names asserted).
    assertThrowaway(MCP);
    mcpRegistered = true; // set first: cleanup of a name that never got created is a harmless 404
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: "remote", name: MCP, url: spike.url, description: "Throwaway P04 approval spike server", auth: { type: "header", headers: { Authorization: `Bearer ${spike.token}` } } },
    });
    assertThrowaway(AGENT);
    agentAttempted = true;
    const created = await client.agents.create({
      name: AGENT,
      description: "Throwaway P04 approval spike agent",
      manifest: {
        model: { name: MODEL },
        instructions: "You are a test agent. Follow the user's tool instructions literally. Use the echo tools. Keep answers to one or two sentences and say what each tool returned or why it did not run.",
        mcpServers: [{ name: MCP, enableTools: ["@all"], requireApprovalForTools: ["echo_write"], preload: true }],
        config: { iterationLimit: 10, dynamicSubAgents: { enabled: false }, askUserQuestions: { enabled: false }, generativeUi: { enabled: false } },
      },
    });
    log(`Registered ${MCP} and ${AGENT} (id ${created.data.id}); tools: ${JSON.stringify((await client.mcpServers.listTools(MCP)).data.map((t) => t["name"]))}`);

    // g/h: plain and ungated turns (fixtures for streaming + ungated tool calls)
    const g = await runScenario("g_plain", "Say hello in exactly five words.", () => ({ status: "allow" }));
    findings["g_plain"] = { final: g.final, states: g.states };
    const h = await runScenario("h_ungated", "Call echo_read once and tell me what it returned.", () => ({ status: "allow" }));
    findings["h_ungated"] = { final: h.final, states: h.states };

    // a: allow
    const a = await runScenario("a_allow", "Call echo_write exactly once with text 'alpha'. After it finishes, call echo_read and tell me the list.", () => ({ status: "allow" }));
    findings["a_allow"] = { final: a.final, states: a.states, decisions: a.decisions, written: [...spike.written] };

    // b: deny with reason
    spike.written.length = 0;
    const b = await runScenario("b_deny", "Call echo_write exactly once with text 'beta', then tell me what happened.", () => ({ status: "deny", reason: "User rejected: writes are not allowed in this test" }));
    findings["b_deny"] = { final: b.final, states: b.states, decisions: b.decisions, writtenAfterDeny: [...spike.written] };

    // c: parallel
    spike.written.length = 0;
    const startedAt: number[] = [];
    const c = await runScenario("c_parallel", "In ONE step, call echo_write twice in parallel (two tool calls in the same response): once with text 'one' and once with text 'two'. Do not call any other tool. Then tell me what happened.", async (call) => {
      startedAt.push(Date.now());
      await sleep(call.args.includes("two") ? 50 : 400); // finish out of order on purpose
      return { status: "allow" };
    });
    findings["c_parallel"] = { final: c.final, states: c.states, decisions: c.decisions, written: [...spike.written], handlerStartGapMs: startedAt.length > 1 ? startedAt[1]! - startedAt[0]! : null };

    // d: the paused turn, raw. What does it look like, and does waiting change anything?
    {
      const capture = new Capture(redact, "d_paused_state");
      const sessionId = await newSession();
      log("\n=== scenario d_paused_state (includes a 65 s wait)");
      const events1 = await collect(sessionId, [{ type: "user.message", content: "Call echo_write exactly once with text 'delta', then tell me the result." }], capture);
      const turn1 = events1.find((e) => e.type === "turn.created") as TrueForgeApi.TurnCreatedEvent | undefined;
      const done1 = events1.find((e) => e.type === "turn.done") as TrueForgeApi.TurnDoneEvent | undefined;
      const approval = events1.find((e) => e.type === "tool.approval_required") as TrueForgeApi.ToolApprovalRequiredEvent | undefined;
      findings["d_stream_events"] = events1.map((e) => e.type).filter((t) => t !== "model.message.delta");
      findings["d_turn_done_state"] = done1?.state;
      log(`  stream event types: ${JSON.stringify(findings["d_stream_events"])}`);
      log(`  turn.done.state: ${JSON.stringify(done1?.state, (k, v) => (k === "output" && v ? "<model.message>" : v))}`);
      if (turn1 && approval) {
        const probe0 = await client.sessions.getTurn(sessionId, turn1.turnId);
        capture.probe("getTurn_at_0s", probe0.data);
        findings["d_getTurn_0s"] = probe0.data.state;
        log(`  getTurn @0s state: ${JSON.stringify(probe0.data.state, (k, v) => (k === "output" && v ? "<model.message>" : v)).slice(0, 400)}`);
        await sleep(65_000);
        const probe65 = await client.sessions.getTurn(sessionId, turn1.turnId);
        capture.probe("getTurn_at_65s", probe65.data);
        findings["d_getTurn_65s"] = probe65.data.state;
        log(`  getTurn @65s status: ${probe65.data.state.status}`);
        const resume = await collect(
          sessionId,
          approval.toolCalls.map((ref): TurnInput => ({ type: "user.tool_approval", threadId: approval.threadId, toolCallId: ref.id, approval: { status: "allow" } })),
          capture,
        );
        const doneR = resume.find((e) => e.type === "turn.done") as TrueForgeApi.TurnDoneEvent | undefined;
        findings["d_resume_after_65s"] = { eventTypes: resume.map((e) => e.type).filter((t) => t !== "model.message.delta"), doneStatus: doneR?.state.status, written: [...spike.written] };
        log(`  resume after 65 s: ${JSON.stringify(findings["d_resume_after_65s"])}`);
      }
      await capture.save();
    }

    // f: a new user message while a turn is paused on approval
    {
      const capture = new Capture(redact, "f_new_message_while_paused");
      const sessionId = await newSession();
      log("\n=== scenario f_new_message_while_paused");
      const events1 = await collect(sessionId, [{ type: "user.message", content: "Call echo_write exactly once with text 'foxtrot'." }], capture);
      const turn1 = events1.find((e) => e.type === "turn.created") as TrueForgeApi.TurnCreatedEvent | undefined;
      const approval = events1.find((e) => e.type === "tool.approval_required") as TrueForgeApi.ToolApprovalRequiredEvent | undefined;
      findings["f_first_paused"] = Boolean(approval);
      try {
        const events2 = await collect(sessionId, [{ type: "user.message", content: "Never mind that. Just say hello." }], capture);
        const done2 = events2.find((e) => e.type === "turn.done") as TrueForgeApi.TurnDoneEvent | undefined;
        findings["f_new_message"] = { accepted: true, eventTypes: events2.map((e) => e.type).filter((t) => t !== "model.message.delta"), doneStatus: done2?.state.status };
        log(`  new user.message accepted; turn.done: ${done2?.state.status}`);
        if (turn1) {
          const old = await client.sessions.getTurn(sessionId, turn1.turnId);
          capture.probe("old_turn_after_new_message", old.data);
          findings["f_old_turn_state"] = old.data.state;
          log(`  old turn state afterwards: ${JSON.stringify(old.data.state, (k, v) => (k === "output" && v ? "<model.message>" : v)).slice(0, 300)}`);
        }
      } catch (err) {
        findings["f_new_message"] = { accepted: false, error: describeError(err) };
        log(`  new user.message REJECTED: ${describeError(err)}`);
      }
      if (approval) {
        try {
          const late = await collect(
            sessionId,
            approval.toolCalls.map((ref): TurnInput => ({ type: "user.tool_approval", threadId: approval.threadId, toolCallId: ref.id, approval: { status: "allow" } })),
            capture,
          );
          findings["f_late_approval"] = { accepted: true, eventTypes: late.map((e) => e.type).filter((t) => t !== "model.message.delta") };
        } catch (err) {
          findings["f_late_approval"] = { accepted: false, error: describeError(err) };
        }
        log(`  late approval of the abandoned call: ${JSON.stringify(findings["f_late_approval"])}`);
      }
      await capture.save();
    }
  } finally {
    await cleanup();
  }

  const after = await snapshot();
  log(`\nAfter:  agents=${JSON.stringify(after.agents)} mcp=${JSON.stringify(after.mcp)} sessions=${after.sessions}`);
  const unchanged = JSON.stringify(before) === JSON.stringify(after);
  log(unchanged ? "CLEANUP OK: TrueForge state is identical to before the spike." : "WARNING: state differs from before the spike; inspect manually.");
  await mkdir(OUT_DIR, { recursive: true });
  await writeFile(join(OUT_DIR, "_findings.json"), `${JSON.stringify(findings, null, 2)}\n`, "utf8");
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`spike failed: ${describeError(err)}`);
    process.exit(1);
  },
);
