/**
 * Headless eval: drives the REAL product pipeline (context index + retrieval + injection, MCP tools + decision
 * store, ReviewApprovalHandler, AgentController, SDK adapter, the committed agent definition) against a live
 * TrueForge on a fresh temp copy of Flask, auto-accepts the review, and scores the result.
 *
 *   npm run eval -- --task b --model deepseek/flash --runs 5 [--accept all|first-only] [--timeout 600]
 *   npm run eval -- --task a --model deepseek/v4-pro --runs 3
 *
 * SAFETY: fixtures/flask is only cloned from. Every run registers its own throwaway agent + MCP server
 * (forge-eval-<pid>-r<run>-agent|mcp; a name guard refuses anything else, never forge-agent / forge-editor /
 * forge-inline), cleans them up after the run (also on errors and signals), and the TrueForge resources are
 * compared before and after the whole invocation. At most 10 runs per invocation.
 */
import { execFile, execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { NodeCommandRunner } from "../../src/host/commandRunner";
import { ContextIndex } from "../../src/context/indexer";
import { buildTurnContext } from "../../src/context/injection";
import { buildInlineMessage, inlineDisplayText, snapshotSelection } from "../../src/inline/message";
import { generateToken } from "../../src/mcp/auth";
import { DecisionStore } from "../../src/mcp/decisions";
import { McpEvents, type ContextReadEvent } from "../../src/mcp/events";
import { startMcpServer } from "../../src/mcp/server";
import { CheckpointStore } from "../../src/review/checkpoints";
import { ReviewApprovalHandler } from "../../src/review/reviewHandler";
import { ReviewTracker } from "../../src/review/tracker";
import { RoutingApprovalHandler } from "../../src/trueforge/routingApprovals";
import { CommandApprovalHandler } from "../../src/trueforge/commandApprovals";
import { AgentController, type ApprovalHandler, type TurnClient, type UiSink } from "../../src/trueforge/agentController";
import { FORGE_EDITOR_SERVER, FORGE_EXTRAS_SERVER, createClient, describeError, parseAgentFile } from "../../src/trueforge/client";
import type { StreamEvent, TurnView } from "../../src/trueforge/events";
import { createSdkTurnClient } from "../../src/trueforge/sdkAdapter";
import { DiskHost } from "../diskHost";
import { autoPresenter, diskRestorer, diskReviewEditor, type AcceptMode } from "./diskEditor";
import { RunRegistry } from "../../src/trueforge/runRegistry";
import { CommandTickets } from "../../src/mcp/commandTickets";
import { HarnessCommandApproval } from "./commands";
import { randomCuts } from "./cuts";
import { parseChainArgs, expectsExhaustion } from "./chainArgs";
import type { ChainEvent } from "../../src/trueforge/modelChain";
import { agentName, assertThrowaway, extrasName, mcpName, snapshotDiff, type Snapshot } from "./guard";
import { DEFAULT_RUN_LIMIT, DEFAULT_TOKEN_LIMIT, appendLedger, checkLimits, readLedger, totalsOf } from "./ledger";
import { OutageGuard, ProviderOutage, classifyFailure, withRetries } from "./retry";
import { deriveSignals } from "./signals";
import { appendResults, formatContextLink, formatSummary, type EvalCheck, type RunReport } from "./report";
import { REQUIRED_FILES, changedFiles, formatScore, scoreTaskB } from "./score-task-b";
import { FIXTURE_PYTHON, createWorkspace, pythonEnv, type Workspace } from "./workspace";

const exec = promisify(execFile);
const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const ROOT = join(__dirname, "..", "..");
const MAX_RUNS = 10;
const HELPERS = "src/flask/helpers.py";
export const TASK_A_INSTRUCTION = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value";
export const TASK_B_PROMPT =
  'Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.';
/** Rough per-run totals (input + output, all model calls) used only for the up-front estimate. */
const TOKEN_HEURISTIC = { a: 15_000, b: 250_000 } as const;

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(name);
  if (i >= 0) return process.argv[i + 1] ?? fallback;
  const eq = process.argv.find((a) => a.startsWith(`${name}=`));
  return eq ? eq.slice(name.length + 1) : fallback;
}

class Sink implements UiSink {
  view: TurnView | undefined;
  readonly notices: string[] = [];
  onState(): void {}
  onUserMessage(): void {}
  onTurnChange(view: TurnView): void {
    this.view = view;
  }
  onSession(): void {}
  onNotice(level: string, text: string): void {
    this.notices.push(`${level}: ${text}`);
  }
  onReset(): void {}
  readonly chainEvents: ChainEvent[] = [];
  /** Result of `git status` in the temp copy at the moment the chain switched models (must be empty). */
  dirtyAtSwitch: string | undefined;
  checkWorkspace: (() => string) | undefined;
  onChain(event: ChainEvent): void {
    this.chainEvents.push(event);
    if (event.kind === "switched" && this.dirtyAtSwitch === undefined) this.dirtyAtSwitch = this.checkWorkspace?.() ?? "";
  }
  onAttemptDiscarded(): void {}
}

class Capture {
  readonly lines: string[] = [];
  private turn = 0;
  started(input: unknown): number {
    this.turn++;
    this.lines.push(JSON.stringify({ turn: this.turn, input }));
    return this.turn;
  }
  event(turn: number, event: unknown): void {
    this.lines.push(JSON.stringify({ turn, event }));
  }
  /** ms since this capture started: arrival time of each event (for the stall-timing analysis). */
  readonly startedAt = Date.now();
}

function recording(inner: TurnClient, capture: Capture, redact: (s: string) => string): TurnClient {
  return {
    createSession: (spec) => inner.createSession(spec),
    cancel: (id) => inner.cancel(id),
    async createTurnStream(sessionId, input) {
      const turn = capture.started(input);
      const stream = await inner.createTurnStream(sessionId, input);
      return (async function* () {
        for await (const event of stream as AsyncIterable<StreamEvent>) {
          capture.lines.push(redact(JSON.stringify({ turn, t: Date.now() - capture.startedAt, event })));
          yield event;
        }
      })();
    },
  };
}

/** Rejects anything gated that the harness does not know (nothing should reach it). */
const denyUnknown: ApprovalHandler = { decide: () => Promise.resolve({ status: "deny", reason: "The eval harness does not approve this tool." }) };

function selectFunction(text: string): { startLine: number; endLine: number } {
  const lines = text.split("\n");
  const def = lines.findIndex((l) => l.startsWith("def get_debug_flag"));
  if (def < 0) throw new Error("get_debug_flag not found");
  let end = def;
  while (end + 1 < lines.length && lines[end + 1] !== "" && /^\s/.test(lines[end + 1] ?? "")) end++;
  return { startLine: def, endLine: end };
}

interface RunContext {
  client: ReturnType<typeof createClient>;
  task: "a" | "b";
  model: string | undefined;
  accept: AcceptMode;
  timeoutSeconds: number;
  /** Cancel mode: press Stop (the real controller.stop()) this many seconds into the run, then check the workspace. */
  cancelAfter?: number | undefined;
  /** Model chain (names, primary first); the controller falls back through it exactly like the product. */
  chain?: string[] | undefined;
  runNumber: number;
  log: (m: string) => void;
  /** Resources this process created, so a signal handler can clean the current run. */
  cleanups: Set<() => Promise<void>>;
}

async function runOnce(c: RunContext, attempt: number): Promise<RunReport> {
  const { client, log, task, runNumber } = c;
  const pid = process.pid;
  const agent = agentName(pid, runNumber);
  const mcp = mcpName(pid, runNumber);
  const extras = extrasName(pid, runNumber);
  const runId = `${new Date().toISOString().slice(0, 10)}-${pid}-r${runNumber}${attempt > 1 ? `-a${attempt}` : ""}`;
  const started = Date.now();
  const errors: string[] = [];
  let ws: Workspace | undefined;
  let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  let agentCreated = false;
  let mcpRegistered = false;
  let extrasRegistered = false;
  const capture = new Capture();
  const harnessCommands = new HarnessCommandApproval();
  const sessions: string[] = [];
  let cleaned = false;

  const cleanup = async (): Promise<void> => {
    if (cleaned) return;
    cleaned = true;
    for (const id of sessions) await client.sessions.delete(id).catch(() => undefined);
    if (agentCreated) {
      assertThrowaway(agent);
      for await (const a of await client.agents.list({ agentName: agent, limit: 100 })) {
        if (a.name === agent) await client.agents.delete(a.id).catch((e: unknown) => errors.push(`cleanup agent: ${describeError(e)}`));
      }
    }
    if (mcpRegistered) {
      assertThrowaway(mcp);
      await client.settings.mcpServers.delete(mcp).catch((e: unknown) => errors.push(`cleanup mcp: ${describeError(e)}`));
    }
    if (extrasRegistered) {
      assertThrowaway(extras);
      await client.settings.mcpServers.delete(extras).catch((e: unknown) => errors.push(`cleanup extras: ${describeError(e)}`));
    }
    await server?.dispose();
    await ws?.dispose();
  };
  c.cleanups.add(cleanup);

  const reads: ContextReadEvent[] = [];
  let keyFilesInContext: string[] = [];
  let contextItems = 0;
  let contextPaths: string[] = [];
  let contextTokens = 0;
  let checks: EvalCheck[] = [];
  let changed: string[] = [];
  let state = "error";
  let finalMessage = "";
  let view: TurnView | undefined;
  let model = c.model ?? "(agent file default)";
  let timeToFallbackMs: number | undefined;
  let sinkRef: Sink | undefined;

  try {
    ws = await createWorkspace();
    log(`\n=== run ${runNumber} (${task.toUpperCase()}) workspace ${ws.root}`);
    const host = new DiskHost(ws.root);
    const decisions = new DecisionStore();
    const checkpoints = new CheckpointStore();
    const tracker = new ReviewTracker();
    const events = new McpEvents();
    events.onContextRead((e) => reads.push(e));
    const index = new ContextIndex();
    await index.build(host);
    const venvBin = join(FIXTURE_PYTHON, "..");
    // The product mechanism: forge.commandPrefix. It makes `pytest`/`flask` resolve to the fixture venv and the copy's src/.
    const runner = new NodeCommandRunner({ getPrefix: () => `export PATH='${venvBin}':"$PATH" PYTHONPATH='${join(ws?.root ?? "", "src")}' PYTHONDONTWRITEBYTECODE=1 &&` });
    const registry = new RunRegistry();
    const tickets = new CommandTickets();
    const cancelMode = c.cancelAfter !== undefined;
    const reviewHandler = new ReviewApprovalHandler({
      editor: diskReviewEditor(ws.root, checkpoints),
      // in cancel mode the "user" takes 4 s per review, so a cut can land while a diff is open
      presenter: autoPresenter(c.accept, undefined, cancelMode ? 4000 : 10),
      decisions,
      tracker,
      getRunId: () => `eval-${runId}`,
      registry,
    });
    const token = generateToken();
    server = await startMcpServer({ token, host, events, decisions, index, commands: runner, editor: { reveal: () => Promise.resolve() }, run: { isCancelled: () => registry.isCancelled(), signal: () => registry.signal }, tickets });
    const handler = new RoutingApprovalHandler(
      new Map<string, ApprovalHandler>([
        ["propose_edit", reviewHandler],
        ["create_file", reviewHandler],
        ["run_command", new CommandApprovalHandler({ inner: harnessCommands, getRunId: () => `eval-${runId}`, getRoot: () => host.rootPath(), tickets, registry })],
      ]),
      denyUnknown,
    );

    const agentFile = parseAgentFile(JSON.parse(await readFile(join(ROOT, "agents", task === "a" ? "forge-inline.json" : "forge-agent.json"), "utf8")) as unknown);
    if (c.model && !(await client.models.list()).data.some((m) => m.name === c.model)) throw new Error(`model ${c.model} is not configured in TrueForge`);
    model = c.model ?? agentFile.spec.model.name;
    assertThrowaway(mcp);
    mcpRegistered = true;
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: "remote", name: mcp, url: server.url, description: "Throwaway eval MCP server", auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } },
    });
    if ((agentFile.spec.mcpServers ?? []).some((m) => m.name === FORGE_EXTRAS_SERVER)) {
      assertThrowaway(extras);
      extrasRegistered = true;
      await client.settings.mcpServers.createOrUpdate({
        manifest: { type: "remote", name: extras, url: server.extrasUrl, description: "Throwaway eval extras server", auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } },
      });
    }
    assertThrowaway(agent);
    agentCreated = true;
    await client.agents.create({
      name: agent,
      description: `Throwaway eval agent (copy of ${agentFile.name})`,
      manifest: {
        ...agentFile.spec,
        model: { ...agentFile.spec.model, name: model },
        mcpServers: (agentFile.spec.mcpServers ?? []).map((s) => ({ ...s, name: s.name === FORGE_EXTRAS_SERVER ? extras : s.name === FORGE_EDITOR_SERVER ? mcp : s.name })),
      },
    });

    const sink = new Sink();
    sinkRef = sink;
    sink.checkWorkspace = () => execFileSync("git", ["status", "--porcelain", "-uall"], { cwd: ws?.root, encoding: "utf8" }).trim();
    const redact = (t: string): string => t.split(token).join("<token>");
    const controller = new AgentController({ client: recording(createSdkTurnClient(() => client), capture, redact), agentName: agent, ui: sink, approvals: handler, getRunId: () => `eval-${runId}`, registry, ...(c.chain ? { chain: { models: () => c.chain ?? [], stall: () => ({ firstMs: 45000, idleMs: 90000 }), sideEffects: (id: string | undefined) => ({ files: id ? checkpoints.filesOf(id) : [], commands: harnessCommands.records.filter((k) => k.approved).map((k) => k.command) }), sessionUrl: (id: string) => `${BASE_URL}/sessions/${id}` } } : {}), log: (m) => capture.lines.push(JSON.stringify({ log: m })), cancel: {
      cancelWork: () => {
        runner.cancelAll();
        decisions.clear();
        tickets.clear();
      },
      settle: () => reviewHandler.idle(),
      rollbackEnabled: () => true,
      rollback: async (id) => {
        const r = await checkpoints.rollbackRun(id, diskRestorer(ws?.root ?? ""));
        return { restored: r.restored, skipped: r.skipped, failed: r.failed };
      },
      changedFiles: (id) => checkpoints.filesOf(id),
    } });
    let sendText: string;
    let display: string;
    let options: Parameters<AgentController["send"]>[1];
    if (task === "a") {
      const text = await host.readText(HELPERS);
      const range = selectFunction(text);
      const lines = text.split("\n");
      const snap = snapshotSelection({ text, start: { line: range.startLine, character: 0 }, end: { line: range.endLine, character: (lines[range.endLine] ?? "").length }, path: HELPERS, languageId: "python" });
      if (!snap.ok) throw new Error("could not build the Task A selection");
      sendText = buildInlineMessage(snap.snapshot, TASK_A_INSTRUCTION);
      display = inlineDisplayText(snap.snapshot, TASK_A_INSTRUCTION);
      options = { freshSession: true, agentName: agent, display, purpose: "eval-task-a" };
    } else {
      const turn = await buildTurnContext(index, host, { text: TASK_B_PROMPT, budgetTokens: 6000 });
      sendText = turn.message;
      keyFilesInContext = REQUIRED_FILES.filter((f) => turn.plan.items.some((i) => i.path === f));
      contextItems = turn.plan.items.length;
      contextPaths = [...new Set(turn.plan.items.map((i) => i.path))];
      contextTokens = turn.plan.usedTokens;
      log(`    context: ${contextItems} items, ${contextTokens}/${turn.plan.budgetTokens} tokens, ${turn.plan.retrievalMs?.toFixed(1)} ms; key files in context: ${keyFilesInContext.join(", ") || "none"}`);
      options = { display: turn.display, purpose: "eval-task-b" };
    }

    const states: string[] = [];
    controller.runState.onChange((st) => states.push(st));
    let stopClickedAt = 0;
    let stopDoneMs = 0;
    let cutPhase = "";
    const timer = setTimeout(
      () => {
        stopClickedAt = Date.now();
        const calls = sink.view?.toolCalls ?? [];
        cutPhase = controller.state === "awaitingApproval" ? "awaiting approval / review open" : calls.length === 0 ? "before the first tool call" : `after ${calls.length} tool call(s), last: ${calls.at(-1)?.name ?? "?"}`;
        void controller.stop().then(() => (stopDoneMs = Date.now() - stopClickedAt));
      },
      (c.cancelAfter ?? c.timeoutSeconds) * 1000,
    );
    const result = await controller.send(sendText, options);
    clearTimeout(timer);
    const sendReturnedMs = stopClickedAt > 0 ? Date.now() - stopClickedAt : 0;
    if (controller.sessionId) sessions.push(controller.sessionId);
    view = sink.view;
    state = result.ok ? result.state : "busy";
    if (result.ok && result.detail) errors.push(result.detail);
    errors.push(...sink.notices.filter((n) => n.startsWith("error")));
    finalMessage = view?.messages.filter((m) => m.threadId === "main").map((m) => m.text).filter(Boolean).at(-1) ?? "";

    if (cancelMode) {
      const dirty = (await changedFiles(ws.root)).join(", ");
      const cancelled = state === "cancelled" && stopClickedAt > 0;
      checks = [
        { id: "a", name: "Stop pressed mid-run and the run ended 'cancelled'", pass: cancelled, detail: cancelled ? `cut ${c.cancelAfter}s into the run: ${cutPhase}; states ${states.join(">")}` : `run ended '${state}' before the cut at ${c.cancelAfter}s (inconclusive)` },
        { id: "b", name: "temp workspace identical to the pristine checkout (git status clean)", pass: dirty === "", detail: dirty === "" ? `clean${result.ok && result.detail ? `; ${result.detail.slice(0, 160)}` : ""}` : `dirty: ${dirty}` },
        { id: "c", name: "Stop completed and send() returned within 1 s of the click", pass: cancelled && stopDoneMs > 0 && stopDoneMs < 1000 && sendReturnedMs < 1000, detail: `stop() took ${stopDoneMs} ms, send() returned ${sendReturnedMs} ms after the click` },
      ];
      changed = await changedFiles(ws.root);
      log(`    cut phase: ${cutPhase || "(run ended first)"}`);
      log(checks.map((k) => `    ${k.pass ? "PASS" : "FAIL"} (${k.id}) ${k.name} [${k.detail}]`).join("\n"));
    } else if (task === "b") {
      const score = await scoreTaskB({ root: ws.root, python: ws.python });
      checks = score.checks;
      changed = score.changedFiles;
      log(formatScore(score).split("\n").map((l) => `    ${l}`).join("\n"));
    } else if (!cancelMode) {
      const out = await exec(ws.python, [join(ROOT, "scripts", "task_a_check.py"), "--installed"], { cwd: ws.root, env: pythonEnv(ws.root) }).then(
        (r) => r.stdout,
        (e: { stdout?: string }) => e.stdout ?? "",
      );
      const failing = out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/^FAIL\s+/, ""));
      changed = await changedFiles(ws.root);
      const switched = sink.chainEvents.find((e) => e.kind === "switched");
      if (c.chain && expectsExhaustion(c.chain)) {
        // every model is a demo failure: the correct outcome is a clear error and an untouched workspace
        const message = sink.notices.find((n) => n.includes("No model could answer")) ?? "";
        checks = [
          { id: "a", name: "ended with a clear error naming every model (no hang, no crash)", pass: state === "error" && c.chain.every((m) => message.includes(m)), detail: message ? message.slice(0, 220) : `state '${state}', no exhausted message` },
          { id: "b", name: "workspace pristine (git status clean)", pass: changed.length === 0, detail: changed.join(", ") || "clean" },
          { id: "c", name: "the editor was told (chain event 'exhausted')", pass: sink.chainEvents.some((e) => e.kind === "exhausted"), detail: sink.chainEvents.map((e) => e.kind).join(",") || "no chain events" },
        ];
      } else {
        checks = [
          { id: "a", name: "task_a_check.py (19 behaviour + docstring checks)", pass: /RESULT: PASS/.test(out), detail: failing.join("; ").slice(0, 200) || "ok" },
          { id: "b", name: "only src/flask/helpers.py changed", pass: changed.length === 1 && changed[0] === HELPERS, detail: changed.join(", ") || "nothing changed" },
          ...(c.chain && c.chain.length > 1
            ? [
                { id: "c", name: "fell back automatically to the next model", pass: switched !== undefined, detail: switched ? `${switched.text}` : `no switch happened (events: ${sink.chainEvents.map((e) => e.kind).join(",") || "none"})` },
                { id: "d", name: "workspace unchanged by the failed attempt (checked at the moment of the switch)", pass: sink.dirtyAtSwitch === "", detail: sink.dirtyAtSwitch === undefined ? "no switch" : sink.dirtyAtSwitch === "" ? "clean" : `dirty: ${sink.dirtyAtSwitch.replace(/\n/g, ", ")}` },
              ]
            : []),
        ];
      }
      timeToFallbackMs = switched?.afterMs;
      log(checks.map((k) => `    ${k.pass ? "PASS" : "FAIL"} (${k.id}) ${k.name} [${k.detail}]`).join("\n"));
    }
  } catch (err) {
    errors.push(describeError(err));
    log(`    run error: ${describeError(err)}`);
  } finally {
    await cleanup();
    c.cleanups.delete(cleanup);
  }

  const toolCalls: Record<string, number> = {};
  for (const call of view?.toolCalls ?? []) toolCalls[call.name] = (toolCalls[call.name] ?? 0) + 1;
  const filesRead = [...new Set(reads.map((r) => r.path))];
  const usage = view?.usage ?? [];
  const report: RunReport = {
    runId,
    date: new Date().toISOString().slice(0, 10),
    task,
    model,
    accept: c.accept,
    pass: checks.length > 0 && checks.every((k) => k.pass),
    checks,
    seconds: (Date.now() - started) / 1000,
    state,
    modelCalls: view?.messages.length ?? 0,
    toolCalls,
    filesRead,
    keyFilesInContext,
    keyFilesRead: REQUIRED_FILES.filter((f) => filesRead.includes(f)),
    contextPaths,
    contextItems,
    contextTokens,
    tokens: usage.length > 0 ? { input: usage.reduce((n, u) => n + u.inputTokens, 0), output: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0), calls: usage.length } : undefined,
    finalMessage,
    errors,
    providerError: !(checks.length > 0 && checks.every((k) => k.pass)) && classifyFailure(errors) === "provider",
    attempts: attempt,
    attemptKinds: [],
    ...deriveSignals(view),
    commands: harnessCommands.records,
    ...(c.chain ? { chain: { models: c.chain, events: sinkRef?.chainEvents.map((e) => `${e.kind}: ${e.text}`) ?? [], ...(timeToFallbackMs !== undefined ? { timeToFallbackMs } : {}), ...(sinkRef?.dirtyAtSwitch !== undefined ? { dirtyAtSwitch: sinkRef.dirtyAtSwitch } : {}) } } : {}),
    changedFiles: changed,
  };
  log(`    ${report.pass ? "PASS" : "FAIL"} in ${report.seconds.toFixed(0)}s; state ${state}; ${report.modelCalls} model calls; tools ${JSON.stringify(toolCalls)}`);
  log(`    files read: ${filesRead.join(", ") || "(none)"}`);
  if (task === "b") log(`    key files in context: ${keyFilesInContext.length}/3; read by the agent: ${report.keyFilesRead.length}/3`);
  if (task === "b") log(`    behaviour: ran tests ${report.ranTests ? "yes" : "no"}, deferred loading ${report.usedDeferredLoading ? "yes" : "no"}, scout ${report.usedScout ? "yes" : "no"}; commands: ${report.commands.map((k) => `${k.approved ? "✓" : "✗"} ${k.command.slice(0, 70)}`).join(" | ") || "none"}`);
  await mkdir(join(ROOT, "eval-output"), { recursive: true });
  await writeFile(join(ROOT, "eval-output", `${runId}.events.jsonl`), `${capture.lines.join("\n")}\n`, "utf8");
  log(`    tokens: ${report.tokens ? `${report.tokens.input} in / ${report.tokens.output} out over ${report.tokens.calls} calls` : "not reported"}`);
  log(`    agent said: ${JSON.stringify(finalMessage.slice(0, 240))}`);
  if (errors.length > 0) log(`    errors: ${errors.map((e) => e.slice(0, 200)).join(" | ")}`);
  return report;
}

const log0 = (m: string): void => console.log(m);

async function main(): Promise<number> {
  const task = arg("--task");
  if (task !== "a" && task !== "b") throw new Error("usage: npm run eval -- --task a|b [--model <name>] [--runs N<=10] [--accept all|first-only] [--timeout seconds]");
  const chainFlag = arg("--chain");
  const failPrimary = process.argv.includes("--fail-primary");
  const cancelRandom = arg("--cancel-at") === "random";
  const cancelAfterArg = arg("--cancel-after");
  if (cancelAfterArg !== undefined && (!Number.isFinite(Number(cancelAfterArg)) || Number(cancelAfterArg) <= 0)) throw new Error("--cancel-after must be a number of seconds > 0");
  const runs = Number(arg("--runs", cancelRandom ? "5" : "1"));
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new Error(`--runs must be a whole number from 1 to ${MAX_RUNS}`);
  const accept = arg("--accept", "all");
  if (accept !== "all" && accept !== "first-only") throw new Error("--accept must be all or first-only");
  const model = arg("--model");
  const chain = parseChainArgs({ chain: chainFlag, failPrimary, model, defaultModel: "deepseek/flash" });
  if (chain) log0(`Model chain: ${chain.join(" -> ")}${expectsExhaustion(chain) ? "  (every model is a demo failure: expecting a clear error and a pristine workspace)" : ""}`);
  const seed = Number(arg("--seed", "7"));
  const cuts = cancelRandom ? randomCuts(runs, seed, task) : [];
  if (cancelRandom) log0(`Cancel trials: Stop pressed at ${cuts.map((c) => `${c}s`).join(", ")} (seed ${seed})`);
  const timeoutSeconds = Number(arg("--timeout", task === "b" ? "600" : "180"));
  const log = (m: string): void => console.log(m);
  const client = createClient(BASE_URL);

  const snapshot = async (): Promise<Snapshot> => {
    const agents: string[] = [];
    for await (const a of await client.agents.list({ limit: 100 })) agents.push(a.name);
    return { agents: agents.sort(), mcp: (await client.settings.mcpServers.list()).data.map((m) => m.name).sort() };
  };
  const before = await snapshot();
  log(`TrueForge before: agents=${JSON.stringify(before.agents)} mcp=${JSON.stringify(before.mcp)}`);
  const clash = [...before.agents, ...before.mcp].filter((n) => n.startsWith(`forge-eval-${process.pid}-`));
  if (clash.length > 0) throw new Error(`ABORT: throwaway names already exist: ${clash.join(", ")}`);
  log(`Plan: task ${task.toUpperCase()}, model ${model ?? "(agent file default)"}, ${runs} run(s), accept=${accept}, timeout ${timeoutSeconds}s per run`);
  log(`Estimated tokens: ~${(TOKEN_HEURISTIC[task] * runs).toLocaleString("en-US")} total (heuristic ${TOKEN_HEURISTIC[task].toLocaleString("en-US")} per run, input + output over all model calls; per-run actuals are reported below)`);

  const cleanups = new Set<() => Promise<void>>();
  const abort = (what: string): void => {
    console.error(`${what}: cleaning up throwaway items`);
    void Promise.all([...cleanups].map((f) => f())).finally(() => process.exit(1));
  };
  process.once("SIGINT", () => abort("interrupted"));
  process.once("SIGTERM", () => abort("terminated"));
  process.once("uncaughtException", (e) => abort(`uncaught exception: ${describeError(e)}`));
  process.once("unhandledRejection", (e) => abort(`unhandled rejection: ${describeError(e)}`));

  const ledgerFile = join(ROOT, "eval-output", "ledger.jsonl");
  const limits = { tokens: Number(arg("--token-limit", String(DEFAULT_TOKEN_LIMIT))), runs: Number(arg("--run-limit", String(DEFAULT_RUN_LIMIT))) };
  const startTotals = totalsOf(await readLedger(ledgerFile));
  log(`Cost guard: ${startTotals.attempts} attempt(s) and ${startTotals.total.toLocaleString("en-US")} tokens used so far (limits: ${limits.runs} attempts, ${limits.tokens.toLocaleString("en-US")} tokens)`);

  const initial = checkLimits(startTotals, limits);
  if (!initial.ok) {
    console.error(initial.reason);
    return 4;
  }

  const outage = new OutageGuard({ log });
  const reports: RunReport[] = [];
  let stopped: string | undefined;
  for (let n = 1; n <= runs && stopped === undefined; n++) {
    const attempts = await withRetries(
      (attempt) => runOnce({ client, task, model, accept, timeoutSeconds, chain, cancelAfter: cancelRandom ? cuts[n - 1] : cancelAfterArg !== undefined ? Number(cancelAfterArg) : undefined, runNumber: n, log, cleanups }, attempt).then(async (report) => {
        const entry = { runId: report.runId, task, model: report.model, attempt, input: report.tokens?.input ?? 0, output: report.tokens?.output ?? 0, at: new Date().toISOString() };
        await appendLedger(ledgerFile, entry);
        outage.record(!report.pass && report.providerError);
        const totals = totalsOf(await readLedger(ledgerFile));
        log(`    cost guard: running total ${totals.total.toLocaleString("en-US")} tokens (${totals.input.toLocaleString("en-US")} in / ${totals.output.toLocaleString("en-US")} out) over ${totals.attempts} counted attempt(s) (+${totals.providerFailures} provider failure(s) with no tokens, not counted)`);
        return report;
      }),
      {
        beforeAttempt: () => outage.beforeAttempt(),
        retryable: async (r) => {
          if (r.pass || !r.providerError) return false;
          const limit = checkLimits(totalsOf(await readLedger(ledgerFile)), limits);
          if (!limit.ok) return false;
          log("    provider failure: retrying after backoff (10 s, then 30 s)");
          return true;
        },
      },
    ).catch((err: unknown) => {
      stopped = err instanceof ProviderOutage ? err.message : describeError(err);
      return [];
    });
    const last = attempts.at(-1)?.result;
    if (last) {
      const kinds = attempts.map((a) => (a.result.pass ? "pass" : a.result.providerError ? "provider" : "agent"));
      reports.push({ ...last, attempts: attempts.length, attemptKinds: kinds });
    }
    const check = checkLimits(totalsOf(await readLedger(ledgerFile)), limits);
    if (!check.ok) stopped = check.reason;
  }
  if (stopped) log(`\nSTOPPED EARLY: ${stopped}`);
  const finalTotals = totalsOf(await readLedger(ledgerFile));
  log(`Cost guard total: ${finalTotals.total.toLocaleString("en-US")} tokens (${finalTotals.input.toLocaleString("en-US")} in / ${finalTotals.output.toLocaleString("en-US")} out) over ${finalTotals.attempts} attempt(s)`);

  const after = await snapshot();
  log(`\nTrueForge after:  agents=${JSON.stringify(after.agents)} mcp=${JSON.stringify(after.mcp)}`);
  const diff = snapshotDiff(before, after);
  if (diff.length > 0) {
    console.error(`FAIL LOUDLY: TrueForge resources changed: ${diff.join(", ")}`);
    return 3;
  }
  log("CLEANUP OK: TrueForge resources are identical to before.");

  await mkdir(join(ROOT, "eval-output"), { recursive: true });
  for (const r of reports) await writeFile(join(ROOT, "eval-output", `${r.runId}-${r.task}.json`), JSON.stringify(r, null, 2), "utf8");
  await appendResults(join(ROOT, "docs", "eval-results.md"), reports);
  log(`\n${formatSummary(reports)}`);
  if (task === "b") log(`\n${formatContextLink(reports)}`);
  log("\n| Run id | Task | Model | Result | Checks | Tokens in/out | Seconds |\n|---|---|---|---|---|---|---|");
  for (const r of reports) log(`| ${r.runId} | ${r.task.toUpperCase()} | ${r.model} | ${r.pass ? "PASS" : "FAIL"}${r.providerError ? " (provider error)" : ""} | ${r.checks.map((k) => `${k.id}${k.pass ? "✓" : "✗"}`).join(" ")} | ${r.tokens ? `${r.tokens.input}/${r.tokens.output}` : "n/a"} | ${r.seconds.toFixed(0)} |`);
  if (stopped && /LIMIT/.test(stopped)) return 4;
  if (stopped && /PROVIDER OUTAGE/.test(stopped)) return 5;
  return reports.every((r) => r.pass) ? 0 : 1;
}

if (require.main === module) {
  main().then(
    (code) => process.exit(code),
    (err: unknown) => {
      console.error(`eval failed: ${describeError(err)}`);
      process.exit(2);
    },
  );
}
