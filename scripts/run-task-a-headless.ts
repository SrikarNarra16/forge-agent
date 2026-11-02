/**
 * Headless Task A runner: drives the REAL controller + SDK + product tools (propose_edit, read_file,
 * search_code ...) + review handler against a live TrueForge, with an in-memory COPY of the Flask fixture and
 * an auto-accept-all presenter in place of the human, using the committed agents/forge-inline.json.
 * Each run starts a fresh session; the result text of helpers.py is checked by scripts/task_a_check.py,
 * the same checker scripts/verify-task-a.sh uses on the real fixture.
 *
 * SAFETY: only throwaway names `forge-inline-test` (agent) and `forge-inline-test-mcp` (MCP server) are ever
 * created or deleted. A name guard refuses everything else (explicitly forge-agent, forge-editor,
 * forge-inline); the script refuses to start if the throwaway names exist, compares TrueForge before/after,
 * and cleans up on errors and signals. The fixture on disk is only READ.
 *
 *   npx tsx scripts/run-task-a-headless.ts [--runs 5] [--model deepseek/flash] [--save]
 */
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import { promisify } from "node:util";
import { generateToken } from "../src/mcp/auth";
import { DecisionStore } from "../src/mcp/decisions";
import { HostError } from "../src/mcp/host";
import { startMcpServer } from "../src/mcp/server";
import { WRITE_TOOL_NAMES } from "../src/mcp/tools/index";
import { buildInlineMessage, inlineDisplayText, snapshotSelection } from "../src/inline/message";
import { AgentController, type TurnClient, type UiSink } from "../src/trueforge/agentController";
import { createClient, describeError, parseAgentFile } from "../src/trueforge/client";
import type { StreamEvent, TurnView } from "../src/trueforge/events";
import { createSdkTurnClient } from "../src/trueforge/sdkAdapter";
import { applyAccepted, type ApplyIo } from "../src/review/applyCore";
import { CheckpointStore } from "../src/review/checkpoints";
import { applyRangedEdits, computeHunks } from "../src/review/hunks";
import { ReviewApprovalHandler, type ReviewEditor, type ReviewHandle, type ReviewPresenter } from "../src/review/reviewHandler";
import { ReviewTracker } from "../src/review/tracker";
import { FakeHost } from "../test/helpers/fakeHost";

const execFileAsync = promisify(execFile);

const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const AGENT = "forge-inline-test";
const MCP = "forge-inline-test-mcp";
const FIXTURE = join(__dirname, "..", "..", "fixtures", "flask");
const HELPERS = "src/flask/helpers.py";
const INSTRUCTION = "treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value";
const OUT_DIR = join(__dirname, "..", "test", "fixtures", "task-a");

const FORBIDDEN = new Set(["forge-agent", "forge-editor", "forge-inline"]);
function assertThrowaway(name: string): void {
  if (FORBIDDEN.has(name) || !name.startsWith("forge-inline-test")) throw new Error(`SAFETY: refusing to touch "${name}" (only forge-inline-test* names are allowed)`);
}

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(name);
  return i >= 0 ? (process.argv[i + 1] ?? fallback) : fallback;
}

/** Reads src/**.py and tests/**.py of the fixture into memory (read-only). */
async function loadFixture(): Promise<Record<string, string>> {
  const files: Record<string, string> = {};
  const walk = async (dir: string): Promise<void> => {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!["__pycache__", ".venv", "node_modules", ".git"].includes(entry.name)) await walk(full);
      } else if (entry.name.endsWith(".py")) {
        files[relative(FIXTURE, full).split("\\").join("/")] = await readFile(full, "utf8");
      }
    }
  };
  await walk(join(FIXTURE, "src"));
  await walk(join(FIXTURE, "tests"));
  return files;
}

class Capture {
  readonly lines: string[] = [];
  private turn = 0;
  constructor(private readonly redact: (s: string) => string) {}
  started(input: unknown): number {
    this.turn++;
    this.lines.push(this.redact(JSON.stringify({ turn: this.turn, input })));
    return this.turn;
  }
  event(turn: number, event: unknown): void {
    this.lines.push(this.redact(JSON.stringify({ turn, event })));
  }
}

function recording(inner: TurnClient, capture: Capture): TurnClient {
  return {
    createSession: (s) => inner.createSession(s),
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

interface RunReport {
  run: number;
  pass: boolean;
  seconds: number;
  tools: string;
  hunks: number | undefined;
  failing: string[];
  changed: string;
  finalText: string;
  state: string;
  notes: string;
}

async function main(): Promise<void> {
  const runs = Number(arg("--runs", "5"));
  const model = arg("--model", "deepseek/flash");
  const save = process.argv.includes("--save");
  const delaySeconds = Number(arg("--delay", "0")); // pause between runs, e.g. for provider rate limits
  const extraParams = JSON.parse(arg("--params", "{}")) as Record<string, unknown>; // merged into model.params (experiments)
  const log = (m: string): void => console.log(m);
  const client = createClient(BASE_URL);
  const token = generateToken();
  const decisions = new DecisionStore();

  const original = await loadFixture();
  const files: Record<string, string> = { ...original };
  const helpersOriginal = original[HELPERS];
  if (helpersOriginal === undefined) throw new Error(`fixture is missing ${HELPERS}`);
  const host = new FakeHost(files);
  const checkpoints = new CheckpointStore();
  const tracker = new ReviewTracker();
  const io: ApplyIo = {
    readLive: (p) => Promise.resolve(files[p]),
    write: (req) => {
      files[req.path] = req.kind === "create" ? req.newText : applyRangedEdits(files[req.path] ?? "", req.edits);
      return Promise.resolve();
    },
  };
  const editor: ReviewEditor = {
    rootPath: () => host.rootPath(),
    readText: (p) => (files[p] !== undefined ? Promise.resolve(files[p]) : Promise.reject(new HostError("ENOENT", p))),
    apply: (req) => applyAccepted(io, checkpoints, req),
  };
  const presenter: ReviewPresenter = {
    present(session): ReviewHandle {
      setTimeout(() => (session.acceptAll(), session.apply()), 10); // the "human" accepts every hunk
      return { close: () => undefined };
    },
  };
  const handler = new ReviewApprovalHandler({ editor, presenter, decisions, tracker, getRunId: () => "task-a-headless" });
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
  if (!(await client.models.list()).data.some((m) => m.name === model)) {
    await server.dispose();
    throw new Error(`ABORT: model ${model} is not configured in TrueForge`);
  }

  // The selection a user would make. --select chooses which part of get_debug_flag is selected:
  //   function (default) = def line to the end, docstring = just the docstring, body = the two code lines,
  //   return = only the return statement.
  const lines = helpersOriginal.split("\n");
  const defIdx = lines.findIndex((l) => l.startsWith("def get_debug_flag"));
  let endIdx = defIdx;
  while (endIdx + 1 < lines.length && (lines[endIdx + 1] === "" ? false : /^\s/.test(lines[endIdx + 1] ?? ""))) endIdx++;
  let docEnd = defIdx + 1;
  while (docEnd < endIdx && !(lines[docEnd] ?? "").trimEnd().endsWith('"""')) docEnd++;
  const selectMode = arg("--select", "function");
  const [fromIdx, toIdx] =
    selectMode === "return" ? [endIdx, endIdx] : selectMode === "body" ? [docEnd + 1, endIdx] : selectMode === "docstring" ? [defIdx + 1, docEnd] : [defIdx, endIdx];
  const snap = snapshotSelection({ text: helpersOriginal, start: { line: fromIdx, character: 0 }, end: { line: toIdx, character: (lines[toIdx] ?? "").length }, path: HELPERS, languageId: "python" });
  if (!snap.ok) throw new Error("could not build the selection");
  const message = buildInlineMessage(snap.snapshot, INSTRUCTION);
  log(`Selection (${selectMode}): ${HELPERS} lines ${snap.snapshot.startLine}-${snap.snapshot.endLine}; model ${model}; ${runs} run(s)${Object.keys(extraParams).length ? `; extra model params ${JSON.stringify(extraParams)}` : ""}`);

  const tmp = await mkdtemp(join(tmpdir(), "forge-task-a-"));
  const reports: RunReport[] = [];
  try {
    const agentFile = parseAgentFile(JSON.parse(await readFile(join(__dirname, "..", "agents", "forge-inline.json"), "utf8")) as unknown);
    assertThrowaway(MCP);
    mcpRegistered = true;
    await client.settings.mcpServers.createOrUpdate({
      manifest: { type: "remote", name: MCP, url: server.url, description: "Throwaway Task A headless server", auth: { type: "header", headers: { Authorization: `Bearer ${token}` } } },
    });
    assertThrowaway(AGENT);
    agentAttempted = true;
    await client.agents.create({
      name: AGENT,
      description: "Throwaway Task A headless agent (copy of forge-inline)",
      manifest: {
        ...agentFile.spec,
        model: { ...agentFile.spec.model, name: model, params: { ...agentFile.spec.model.params, ...extraParams } },
        mcpServers: (agentFile.spec.mcpServers ?? []).map((s) => ({ ...s, name: MCP })),
      },
    });
    log(`Registered ${MCP} + ${AGENT} (gated by name: ${JSON.stringify(agentFile.spec.mcpServers?.[0]?.requireApprovalForTools)}; write tools: ${WRITE_TOOL_NAMES.join(",")})`);

    for (let run = 1; run <= runs; run++) {
      if (run > 1 && delaySeconds > 0) await new Promise((r) => setTimeout(r, delaySeconds * 1000));
      for (const key of Object.keys(files)) delete files[key];
      Object.assign(files, original); // every run starts from the pristine fixture
      decisions.clear();
      tracker.clear();
      const capture = new Capture(redact);
      const sink = new Sink();
      const controller = new AgentController({ client: recording(createSdkTurnClient(() => client), capture), agentName: AGENT, ui: sink, approvals: handler });
      const started = Date.now();
      const timer = setTimeout(() => void controller.stop(), 180_000);
      const result = await controller.send(message, { freshSession: true, agentName: AGENT, display: inlineDisplayText(snap.snapshot, INSTRUCTION), purpose: "task-a-headless" });
      clearTimeout(timer);
      const seconds = (Date.now() - started) / 1000;
      if (controller.sessionId) createdSessions.push(controller.sessionId);

      const view = sink.view;
      const calls = (view?.toolCalls ?? []).map((c) => c.name);
      const edit = (view?.toolCalls ?? []).find((c) => c.name === "propose_edit");
      const resultText = files[HELPERS] ?? "";
      const tmpFile = join(tmp, `helpers-run${run}.py`);
      await writeFile(tmpFile, resultText, "utf8");
      let checkerOut = "";
      try {
        checkerOut = (await execFileAsync("python3", [join(__dirname, "task_a_check.py"), "--file", tmpFile])).stdout;
      } catch (err) {
        checkerOut = (err as { stdout?: string }).stdout ?? String(err);
      }
      const failing = checkerOut.split("\n").filter((l) => l.startsWith("FAIL")).map((l) => l.replace(/^FAIL\s+/, ""));
      const pass = /RESULT: PASS/.test(checkerOut);
      const hunks = computeHunks(helpersOriginal, resultText);
      const changed = hunks.flatMap((h) => h.lines.filter((l) => l.type !== " ").map((l) => `${l.type}${l.text.replace(/\n$/, "")}`)).join("\n");
      const finalText = view?.messages.filter((m) => m.threadId === "main").map((m) => m.text).filter(Boolean).at(-1) ?? "";
      const report: RunReport = {
        run,
        pass,
        seconds,
        tools: calls.join(" > ") || "(none)",
        hunks: edit?.response?.match(/applied (\d+) of (\d+)/) ? Number(edit.response.match(/of (\d+)/)?.[1]) : undefined,
        failing,
        changed,
        finalText,
        state: result.ok ? result.state : "busy",
        notes: edit?.response ?? sink.notices.join(" | "),
      };
      reports.push(report);
      log(`\n--- run ${run}: ${pass ? "PASS" : "FAIL"} in ${seconds.toFixed(1)}s   tools: ${report.tools}   state: ${report.state}`);
      log(`    propose_edit -> ${(edit?.response ?? "(not called)").slice(0, 140)}`);
      if (!pass) log(`    failing checks: ${failing.join("; ")}`);
      log(`    changed lines:\n${changed.split("\n").map((l) => `      ${l}`).join("\n")}`);
      log(`    agent said: ${JSON.stringify(finalText.slice(0, 200))}`);
      if (result.ok && result.detail) log(`    run ended with: ${result.detail.slice(0, 400)}`);
      if (sink.notices.length > 0) log(`    notices: ${sink.notices.map((n) => n.slice(0, 300)).join(" | ")}`);
      if (save) {
        await mkdir(OUT_DIR, { recursive: true });
        await writeFile(join(OUT_DIR, `run${run}-${pass ? "pass" : "fail"}.jsonl`), `${capture.lines.join("\n")}\n`, "utf8");
      }
    }
  } finally {
    await cleanup();
    await rm(tmp, { recursive: true, force: true });
  }

  const after = await snapshot();
  log(`\nAfter:  agents=${JSON.stringify(after.agents)} mcp=${JSON.stringify(after.mcp)}`);
  log(JSON.stringify(before) === JSON.stringify(after) ? "CLEANUP OK: TrueForge state is identical to before." : "WARNING: state differs from before; inspect manually.");

  const passed = reports.filter((r) => r.pass).length;
  log(`\nRESULT: ${passed}/${reports.length} runs passed (model ${model})`);
  log("\n| Run | Model | Result | Notes |\n|---|---|---|---|");
  for (const r of reports) log(`| ${r.run} | ${model} | ${r.pass ? "PASS" : "FAIL"} | ${r.seconds.toFixed(0)}s; ${r.tools}; ${r.pass ? `hunks=${r.hunks ?? "?"}` : `failing: ${r.failing.join(", ")}`} |`);
  process.exitCode = passed === reports.length ? 0 : 1;
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (err: unknown) => {
    console.error(`runner failed: ${describeError(err)}`);
    process.exit(1);
  },
);
