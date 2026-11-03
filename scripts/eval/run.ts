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
import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
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
import { AgentController, type UiSink } from "../../src/trueforge/agentController";
import { createClient, describeError, parseAgentFile } from "../../src/trueforge/client";
import type { TurnView } from "../../src/trueforge/events";
import { createSdkTurnClient } from "../../src/trueforge/sdkAdapter";
import { DiskHost } from "../diskHost";
import { autoPresenter, diskReviewEditor, type AcceptMode } from "./diskEditor";
import { agentName, assertThrowaway, mcpName, snapshotDiff, type Snapshot } from "./guard";
import { appendResults, formatSummary, type EvalCheck, type RunReport } from "./report";
import { REQUIRED_FILES, changedFiles, formatScore, scoreTaskB } from "./score-task-b";
import { createWorkspace, pythonEnv, type Workspace } from "./workspace";

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
}

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
  runNumber: number;
  log: (m: string) => void;
  /** Resources this process created, so a signal handler can clean the current run. */
  cleanups: Set<() => Promise<void>>;
}

async function runOnce(c: RunContext): Promise<RunReport> {
  const { client, log, task, runNumber } = c;
  const pid = process.pid;
  const agent = agentName(pid, runNumber);
  const mcp = mcpName(pid, runNumber);
  const runId = `${new Date().toISOString().slice(0, 10)}-${pid}-r${runNumber}`;
  const started = Date.now();
  const errors: string[] = [];
  let ws: Workspace | undefined;
  let server: Awaited<ReturnType<typeof startMcpServer>> | undefined;
  let agentCreated = false;
  let mcpRegistered = false;
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
    await server?.dispose();
    await ws?.dispose();
  };
  c.cleanups.add(cleanup);

  const reads: ContextReadEvent[] = [];
  let keyFilesInContext: string[] = [];
  let contextItems = 0;
  let contextTokens = 0;
  let checks: EvalCheck[] = [];
  let changed: string[] = [];
  let state = "error";
  let finalMessage = "";
  let view: TurnView | undefined;
  let model = c.model ?? "(agent file default)";

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
    const handler = new ReviewApprovalHandler({
      editor: diskReviewEditor(ws.root, checkpoints),
      presenter: autoPresenter(c.accept),
      decisions,
      tracker,
      getRunId: () => `eval-${runId}`,
    });
    const token = generateToken();
    server = await startMcpServer({ token, host, events, decisions, index });

    const agentFile = parseAgentFile(JSON.parse(await readFile(join(ROOT, "agents", task === "a" ? "forge-inline.json" : "forge-agent.json"), "utf8")) as unknown);
    if (c.model && !(await client.models.list()).data.some((m) => m.name === c.model)) throw new Error(`model ${c.model} is not configured in TrueForge`);
    model = c.model ?? agentFile.spec.model.name;
    assertThrowaway(mcp);
    mcpRegistered = true;
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: "remote", name: mcp, url: server.url, description: "Throwaway eval MCP server", auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } },
    });
    assertThrowaway(agent);
    agentCreated = true;
    await client.agents.create({
      name: agent,
      description: `Throwaway eval agent (copy of ${agentFile.name})`,
      manifest: {
        ...agentFile.spec,
        model: { ...agentFile.spec.model, name: model },
        mcpServers: (agentFile.spec.mcpServers ?? []).map((s) => ({ ...s, name: mcp })),
      },
    });

    const sink = new Sink();
    const controller = new AgentController({ client: createSdkTurnClient(() => client), agentName: agent, ui: sink, approvals: handler });
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
      contextTokens = turn.plan.usedTokens;
      log(`    context: ${contextItems} items, ${contextTokens}/${turn.plan.budgetTokens} tokens, ${turn.plan.retrievalMs?.toFixed(1)} ms; key files in context: ${keyFilesInContext.join(", ") || "none"}`);
      options = { display: turn.display, purpose: "eval-task-b" };
    }

    const timer = setTimeout(() => void controller.stop(), c.timeoutSeconds * 1000);
    const result = await controller.send(sendText, options);
    clearTimeout(timer);
    if (controller.sessionId) sessions.push(controller.sessionId);
    view = sink.view;
    state = result.ok ? result.state : "busy";
    if (result.ok && result.detail) errors.push(result.detail);
    errors.push(...sink.notices.filter((n) => n.startsWith("error")));
    finalMessage = view?.messages.filter((m) => m.threadId === "main").map((m) => m.text).filter(Boolean).at(-1) ?? "";

    if (task === "b") {
      const score = await scoreTaskB({ root: ws.root, python: ws.python });
      checks = score.checks;
      changed = score.changedFiles;
      log(formatScore(score).split("\n").map((l) => `    ${l}`).join("\n"));
    } else {
      const out = await exec(ws.python, [join(ROOT, "scripts", "task_a_check.py"), "--installed"], { cwd: ws.root, env: pythonEnv(ws.root) }).then(
        (r) => r.stdout,
        (e: { stdout?: string }) => e.stdout ?? "",
      );
      const failing = out.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/^FAIL\s+/, ""));
      changed = await changedFiles(ws.root);
      checks = [
        { id: "a", name: "task_a_check.py (19 behaviour + docstring checks)", pass: /RESULT: PASS/.test(out), detail: failing.join("; ").slice(0, 200) || "ok" },
        { id: "b", name: "only src/flask/helpers.py changed", pass: changed.length === 1 && changed[0] === HELPERS, detail: changed.join(", ") || "nothing changed" },
      ];
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
    contextItems,
    contextTokens,
    tokens: usage.length > 0 ? { input: usage.reduce((n, u) => n + u.inputTokens, 0), output: usage.reduce((n, u) => n + (u.outputTokens ?? 0), 0), calls: usage.length } : undefined,
    finalMessage,
    errors,
    changedFiles: changed,
  };
  log(`    ${report.pass ? "PASS" : "FAIL"} in ${report.seconds.toFixed(0)}s; state ${state}; ${report.modelCalls} model calls; tools ${JSON.stringify(toolCalls)}`);
  log(`    files read: ${filesRead.join(", ") || "(none)"}`);
  if (task === "b") log(`    key files in context: ${keyFilesInContext.length}/3; read by the agent: ${report.keyFilesRead.length}/3`);
  log(`    tokens: ${report.tokens ? `${report.tokens.input} in / ${report.tokens.output} out over ${report.tokens.calls} calls` : "not reported"}`);
  log(`    agent said: ${JSON.stringify(finalMessage.slice(0, 240))}`);
  if (errors.length > 0) log(`    errors: ${errors.map((e) => e.slice(0, 200)).join(" | ")}`);
  return report;
}

async function main(): Promise<number> {
  const task = arg("--task");
  if (task !== "a" && task !== "b") throw new Error("usage: npm run eval -- --task a|b [--model <name>] [--runs N<=10] [--accept all|first-only] [--timeout seconds]");
  const runs = Number(arg("--runs", "1"));
  if (!Number.isInteger(runs) || runs < 1 || runs > MAX_RUNS) throw new Error(`--runs must be a whole number from 1 to ${MAX_RUNS}`);
  const accept = arg("--accept", "all");
  if (accept !== "all" && accept !== "first-only") throw new Error("--accept must be all or first-only");
  const model = arg("--model");
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

  const reports: RunReport[] = [];
  for (let n = 1; n <= runs; n++) reports.push(await runOnce({ client, task, model, accept, timeoutSeconds, runNumber: n, log, cleanups }));

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
  log("\n| Run id | Task | Model | Result | Checks | Tokens in/out | Seconds |\n|---|---|---|---|---|---|---|");
  for (const r of reports) log(`| ${r.runId} | ${r.task.toUpperCase()} | ${r.model} | ${r.pass ? "PASS" : "FAIL"} | ${r.checks.map((k) => `${k.id}${k.pass ? "✓" : "✗"}`).join(" ")} | ${r.tokens ? `${r.tokens.input}/${r.tokens.output}` : "n/a"} | ${r.seconds.toFixed(0)} |`);
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
