/**
 * TEMPORARY LIVE CHECK (P05): does the decision recorded from the model's raw approval arguments get found
 * by the propose_edit / create_file call TrueForge actually sends? Drives the PRODUCT tools, DecisionStore,
 * ReviewApprovalHandler and AgentController against an in-memory workspace, with scripted accept/reject
 * decisions in place of the human, through a real TrueForge and deepseek/flash.
 *
 * SAFETY: only the throwaway names `forge-spike-edit` (agent) and `forge-spike-edit-mcp` (MCP server) are
 * ever created or deleted; every mutating call goes through `assertThrowaway`; the script refuses to start
 * if either exists, compares TrueForge before/after, and cleans up on errors and signals. It never touches
 * `forge-agent` or `forge-editor` (the user's running extension owns those).
 *
 *   npx tsx scripts/spike-edit.ts        (about a dozen cheap model calls)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { generateToken } from "../src/mcp/auth";
import { DecisionStore } from "../src/mcp/decisions";
import { HostError } from "../src/mcp/host";
import { startMcpServer } from "../src/mcp/server";
import { WRITE_TOOL_NAMES } from "../src/mcp/tools/index";
import { AgentController, type TurnClient, type UiSink } from "../src/trueforge/agentController";
import { createClient, describeError, parseAgentFile } from "../src/trueforge/client";
import type { StreamEvent, TurnView } from "../src/trueforge/events";
import { createSdkTurnClient } from "../src/trueforge/sdkAdapter";
import { applyAccepted, type ApplyIo } from "../src/review/applyCore";
import { CheckpointStore } from "../src/review/checkpoints";
import { applyRangedEdits } from "../src/review/hunks";
import { ReviewApprovalHandler, type ReviewEditor, type ReviewHandle, type ReviewPresenter } from "../src/review/reviewHandler";
import type { ReviewSession } from "../src/review/session";
import { ReviewTracker } from "../src/review/tracker";
import { FakeHost } from "../test/helpers/fakeHost";

const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const AGENT = "forge-spike-edit";
const MCP = "forge-spike-edit-mcp";
const MODEL = "deepseek/flash";
const OUT_DIR = join(__dirname, "..", "test", "fixtures", "edit");

function assertThrowaway(name: string): void {
  if (!name.startsWith("forge-spike-edit")) throw new Error(`SAFETY: refusing to touch "${name}" (only forge-spike-edit* names are allowed)`);
}

const FILES = (): Record<string, string> => ({
  "src/greet.py": 'def greet(name):\n    """Say hello."""\n    return "Hello, " + name\n',
  "src/multi.py": [
    "def alpha():",
    "    return 1",
    "",
    "",
    "def beta():",
    "    return 2",
    "",
    "",
    "def gamma():",
    "    return 3",
    "",
  ].join("\n"),
  "src/keep.py": "VALUE = 1\n",
});

class Capture {
  readonly lines: string[] = [];
  private turn = 0;
  constructor(
    readonly name: string,
    private readonly redact: (s: string) => string,
  ) {}
  started(input: unknown): number {
    this.turn++;
    this.lines.push(this.redact(JSON.stringify({ turn: this.turn, input })));
    return this.turn;
  }
  event(turn: number, event: unknown): void {
    this.lines.push(this.redact(JSON.stringify({ turn, event })));
  }
  async save(): Promise<void> {
    await mkdir(OUT_DIR, { recursive: true });
    await writeFile(join(OUT_DIR, `${this.name}.jsonl`), `${this.lines.join("\n")}\n`, "utf8");
  }
}

function recording(inner: TurnClient, capture: Capture): TurnClient {
  return {
    createSession: (a, m) => inner.createSession(a, m),
    cancel: (id) => inner.cancel(id),
    async createTurnStream(sessionId, input) {
      const turn = capture.started(input);
      const stream = await inner.createTurnStream(sessionId, input);
      return (async function* () {
        for await (const event of stream as AsyncIterable<StreamEvent>) {
          capture.event(turn, event);
          yield event;
        }
      })();
    },
  };
}

class Sink implements UiSink {
  view: TurnView | undefined;
  readonly states: string[] = [];
  readonly notices: string[] = [];
  onState(state: string): void {
    this.states.push(state);
  }
  onUserMessage(): void {}
  onTurnChange(view: TurnView): void {
    this.view = view;
  }
  onSession(): void {}
  onNotice(level: string, text: string): void {
    this.notices.push(`${level}: ${text}`);
  }
  onReset(): void {}
}

async function main(): Promise<void> {
  const log = (m: string): void => console.log(m);
  const client = createClient(BASE_URL);
  const token = generateToken();
  const decisions = new DecisionStore();
  const files = FILES();
  const host = new FakeHost(files);
  const checkpoints = new CheckpointStore();
  const tracker = new ReviewTracker();

  // product tools + product review handler over an in-memory workspace
  const writes: string[] = [];
  const io: ApplyIo = {
    readLive: (p) => Promise.resolve(files[p]),
    write: (req) => {
      writes.push(req.path);
      files[req.path] = req.kind === "create" ? req.newText : applyRangedEdits(files[req.path] ?? "", req.edits);
      return Promise.resolve();
    },
  };
  const editor: ReviewEditor = {
    rootPath: () => host.rootPath(),
    readText: (p) => (files[p] !== undefined ? Promise.resolve(files[p]) : Promise.reject(new HostError("ENOENT", p))),
    apply: (req) => applyAccepted(io, checkpoints, req),
  };
  let policy: (s: ReviewSession) => void = (s) => s.rejectAll();
  const presented: string[] = [];
  const presenter: ReviewPresenter = {
    present(session): ReviewHandle {
      presented.push(`${session.info.path}: ${session.hunks.length} hunk(s)`);
      setTimeout(() => policy(session), 20); // "the human decides" shortly after the review opens
      return { close: () => undefined };
    },
  };
  const handler = new ReviewApprovalHandler({ editor, presenter, decisions, tracker, getRunId: () => "spike-run", log: (m) => log(`  [review] ${m}`) });

  const server = await startMcpServer({ token, host, decisions });
  const redact = (s: string): string => s.split(token).join("<token>").split(server.url).join("http://127.0.0.1:<port>/mcp");

  const snapshot = async (): Promise<{ agents: string[]; mcp: string[] }> => {
    const agents: string[] = [];
    for await (const a of await client.agents.list({ limit: 100 })) agents.push(a.name);
    return { agents: agents.sort(), mcp: (await client.settings.mcpServers.list()).data.map((m) => m.name).sort() };
  };

  const createdSessions: string[] = [];
  let agentAttempted = false;
  let mcpRegistered = false;
  let cleaned = false;
  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const id of createdSessions) await client.sessions.delete(id).catch(() => undefined);
    if (agentAttempted) {
      assertThrowaway(AGENT);
      for await (const a of await client.agents.list({ agentName: AGENT, limit: 100 })) {
        if (a.name === AGENT) await client.agents.delete(a.id).catch((e: unknown) => log(`cleanup agent failed: ${describeError(e)}`));
      }
    }
    if (mcpRegistered) {
      assertThrowaway(MCP);
      await client.settings.mcpServers.delete(MCP).catch((e: unknown) => log(`cleanup mcp failed: ${describeError(e)}`));
    }
    await server.dispose();
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
  log(`Before: agents=${JSON.stringify(before.agents)} mcp=${JSON.stringify(before.mcp)}`);
  if (before.agents.includes(AGENT) || before.mcp.includes(MCP)) {
    await server.dispose();
    throw new Error(`ABORT: "${AGENT}" or "${MCP}" already exists on this TrueForge; refusing to touch anything.`);
  }
  if (!(await client.models.list()).data.some((m) => m.name === MODEL)) {
    await server.dispose();
    throw new Error(`ABORT: model ${MODEL} is not configured`);
  }

  const results: Array<{ name: string; ok: boolean; detail: string }> = [];
  try {
    // the PRODUCT agent definition (instructions + gated tools by name), pointed at the throwaway server
    const productAgent = parseAgentFile(JSON.parse(await readFile(join(__dirname, "..", "agents", "forge-agent.json"), "utf8")) as unknown);
    assertThrowaway(MCP);
    mcpRegistered = true;
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: "remote", name: MCP, url: server.url, description: "Throwaway P05 edit check server", auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } },
    });
    assertThrowaway(AGENT);
    agentAttempted = true;
    await client.agents.create({
      name: AGENT,
      description: "Throwaway P05 edit check agent",
      manifest: {
        ...productAgent.spec,
        mcpServers: [{ name: MCP, enableTools: ["@all"], requireApprovalForTools: [...WRITE_TOOL_NAMES], preload: true }],
      },
    });
    log(`Registered ${MCP} + ${AGENT}; gated by name: ${JSON.stringify(WRITE_TOOL_NAMES)}`);

    const run = async (name: string, prompt: string, decide: (s: ReviewSession) => void, check: (view: TurnView, final: string) => { ok: boolean; detail: string }): Promise<void> => {
      log(`\n=== ${name}: ${prompt}`);
      policy = decide;
      decisions.clear();
      presented.length = 0;
      writes.length = 0;
      const capture = new Capture(name, redact);
      const sink = new Sink();
      const controller = new AgentController({
        client: recording(createSdkTurnClient(() => client), capture),
        agentName: AGENT,
        ui: sink,
        approvals: handler,
        log: (m) => log(`  [controller] ${m}`),
      });
      await Promise.race([controller.send(prompt), new Promise((r) => setTimeout(r, 180_000)).then(() => controller.stop())]);
      if (controller.sessionId) createdSessions.push(controller.sessionId);
      await capture.save();
      const view = sink.view;
      const finalText = view?.messages.filter((m) => m.threadId === "main").map((m) => m.text).filter(Boolean).at(-1) ?? "";
      for (const c of view?.toolCalls ?? []) {
        log(`  tool ${c.name}(${c.args.slice(0, 160).replace(/\s+/g, " ")}) [${c.status}] -> ${(c.response ?? "").slice(0, 200).replace(/\s+/g, " ")}`);
      }
      log(`  presented: ${presented.join(" | ") || "(none)"}   decisions left unconsumed: ${decisions.size}`);
      log(`  states: ${sink.states.join(" > ")}   notices: ${sink.notices.join(" | ") || "(none)"}`);
      log(`  final: ${JSON.stringify(finalText.slice(0, 260))}`);
      const r = view ? check(view, finalText) : { ok: false, detail: "no view" };
      results.push({ name, ...r });
      log(`  => ${r.ok ? "PASS" : "FAIL"}: ${r.detail}`);
    };

    const responseOf = (view: TurnView, tool: string): string | undefined => view.toolCalls.find((c) => c.name === tool && c.response !== undefined)?.response;

    await run("e1_single_edit", "In src/greet.py change the greeting from 'Hello' to 'Hi'. Read the file first, then use propose_edit.", (s) => (s.acceptAll(), s.apply()), (view) => {
      const resp = responseOf(view, "propose_edit") ?? "";
      const okResp = /^applied 1 of 1 hunks \(\+1 -1 lines\) to src\/greet\.py$/.test(resp);
      const okFile = (files["src/greet.py"] ?? "").includes('"Hi, "');
      return { ok: okResp && okFile && decisions.size === 0, detail: `tool said ${JSON.stringify(resp)}; file has Hi=${okFile}; unconsumed=${decisions.size}` };
    });

    await run(
      "e2_partial_accept",
      "In src/multi.py, add a one-line docstring to each of the three functions alpha, beta and gamma, using ONE propose_edit call with three edits. Read the file first.",
      (s) => {
        s.accept(0);
        s.reject(1);
        s.accept(2);
        s.apply();
      },
      (view, finalText) => {
        const resp = responseOf(view, "propose_edit") ?? "";
        const after = files["src/multi.py"] ?? "";
        const okResp = /^applied 2 of 3 hunks .* to src\/multi\.py; rejected: hunk 2 /.test(resp);
        const okFile = after.includes("def alpha():\n    \"\"\"") && !after.includes("def beta():\n    \"\"\"") && after.includes("def gamma():\n    \"\"\"");
        return { ok: okResp && okFile && decisions.size === 0, detail: `tool said ${JSON.stringify(resp.slice(0, 160))}; file ok=${okFile}; agent mentioned rejection=${/reject|not appl|skipp/i.test(finalText)}` };
      },
    );

    await run("e3_reject_all", "In src/keep.py change VALUE from 1 to 2 using propose_edit.", (s) => s.rejectAll(), (view, finalText) => {
      const call = view.toolCalls.find((c) => c.name === "propose_edit");
      const unchanged = files["src/keep.py"] === "VALUE = 1\n";
      const sawReason = (call?.response ?? "").includes("User rejected all changes to src/keep.py");
      return { ok: unchanged && sawReason && call?.status === "denied", detail: `status=${call?.status}; response mentions rejection=${sawReason}; file unchanged=${unchanged}; agent said: ${JSON.stringify(finalText.slice(0, 120))}` };
    });

    await run("e4_create_file", "Create a new file src/util.py containing a function add(a, b) that returns a + b, using create_file.", (s) => (s.acceptAll(), s.apply()), (view) => {
      const resp = responseOf(view, "create_file") ?? "";
      const created = files["src/util.py"] ?? "";
      return { ok: /^created src\/util\.py \(\+\d+ lines\)$/.test(resp) && /def add\(/.test(created) && decisions.size === 0, detail: `tool said ${JSON.stringify(resp)}; file=${JSON.stringify(created.slice(0, 80))}` };
    });
  } finally {
    await cleanup();
  }

  const after = await snapshot();
  log(`\nAfter:  agents=${JSON.stringify(after.agents)} mcp=${JSON.stringify(after.mcp)}`);
  log(JSON.stringify(before) === JSON.stringify(after) ? "CLEANUP OK: TrueForge state is identical to before." : "WARNING: state differs from before; inspect manually.");
  log("\nSUMMARY");
  for (const r of results) log(`  ${r.ok ? "PASS" : "FAIL"} ${r.name}: ${r.detail}`);
  if (results.some((r) => !r.ok)) process.exitCode = 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(`spike failed: ${describeError(err)}`);
    process.exit(1);
  },
);
