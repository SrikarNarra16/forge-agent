import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { classifyFailure } from "./retry";

export interface EvalCheck {
  id: string;
  name: string;
  pass: boolean;
  detail: string;
}

export interface RunReport {
  runId: string;
  date: string;
  task: "a" | "b";
  model: string;
  accept: string;
  pass: boolean;
  checks: EvalCheck[];
  seconds: number;
  state: string;
  modelCalls: number;
  toolCalls: Record<string, number>;
  filesRead: string[];
  /** Task B: the three key files that were in the injected context / read by the agent anyway. */
  keyFilesInContext: string[];
  keyFilesRead: string[];
  /** Every file path the retrieval put into the context block (Task B). */
  contextPaths: string[];
  contextItems: number;
  contextTokens: number;
  tokens: { input: number; output: number; calls: number } | undefined;
  finalMessage: string;
  errors: string[];
  /** The FINAL attempt failed on a provider/infrastructure error (5xx, rate limit, timeout), not an agent mistake. */
  providerError: boolean;
  /** How many attempts this run took (1 = no retry). */
  attempts: number;
  /** One entry per attempt: "pass", "agent" (agent failure) or "provider" (provider failure, retried). */
  attemptKinds: string[];
  ranTests: boolean;
  usedDeferredLoading: boolean;
  usedScout: boolean;
  /** Every run_command the agent issued with the harness verdict. */
  commands: Array<{ command: string; approved: boolean; reason?: string }>;
  /** Model-chain runs: what the chain did and how long the fallback took. */
  chain?: { models: string[]; events: string[]; timeToFallbackMs?: number; dirtyAtSwitch?: string };
  changedFiles: string[];
}

const HEADER = "| Run id | Date | Task | Model | Result | Checks | Tokens (in/out) | Notes |\n|---|---|---|---|---|---|---|---|\n";

export function isProviderError(errors: readonly string[]): boolean {
  return classifyFailure(errors) === "provider";
}

export function checksCell(checks: readonly EvalCheck[]): string {
  return checks.map((c) => `${c.id}${c.pass ? "✓" : "✗"}`).join(" ");
}

export function tableRow(r: RunReport): string {
  const tokens = r.tokens ? `${r.tokens.input}/${r.tokens.output}` : "n/a";
  const tools = Object.entries(r.toolCalls).map(([n, c]) => `${n}×${c}`).join(" ");
  const notes = [
    `${r.seconds.toFixed(0)}s`,
    `${r.modelCalls} model calls`,
    tools || "no tools",
    r.task === "b" && r.changedFiles.length ? `changed ${r.changedFiles.length} (${contextLink(r).filter((l) => l.inContext).length} surfaced in context)` : "",
    r.task === "b" ? `key files in context ${r.keyFilesInContext.length}/3, read ${r.keyFilesRead.length}/3` : "",
    r.accept !== "all" ? `accept=${r.accept}` : "",
    r.providerError ? "PROVIDER ERROR" : "",
    r.chain ? `chain ${r.chain.models.join(" > ")}${r.chain.timeToFallbackMs !== undefined ? `; fallback after ${(r.chain.timeToFallbackMs / 1000).toFixed(1)} s` : ""}` : "",
    r.attempts > 1 ? `${r.attempts} attempts (${r.attemptKinds.join(">")})` : "",
    r.task === "b" ? `tests ${r.ranTests ? "yes" : "no"}, deferred ${r.usedDeferredLoading ? "yes" : "no"}, scout ${r.usedScout ? "yes" : "no"}` : "",
    ...r.checks.filter((c) => !c.pass).map((c) => `FAIL ${c.id}: ${c.detail.slice(0, 80)}`),
    ...r.errors.slice(0, 1).map((e) => `error: ${e.slice(0, 80)}`),
  ]
    .filter(Boolean)
    .join("; ")
    .replace(/\|/g, "\\|")
    .replace(/\n/g, " ");
  return `| ${r.runId} | ${r.date} | ${r.task.toUpperCase()} | ${r.model} | ${r.pass ? "PASS" : "FAIL"} | ${checksCell(r.checks)} | ${tokens} | ${notes} |\n`;
}

/** Appends the run rows to the markdown results file (creating it with a header). */
export async function appendResults(file: string, reports: readonly RunReport[]): Promise<void> {
  let existing = "";
  try {
    existing = await readFile(file, "utf8");
  } catch {
    existing = "";
  }
  await mkdir(dirname(file), { recursive: true });
  if (existing === "") await writeFile(file, `# Eval results\n\nOne row per headless eval run (\`npm run eval\`). Full JSON per run is in eval-output/ (gitignored).\n\n${HEADER}`, "utf8");
  else if (!existing.endsWith("\n")) await appendFile(file, "\n", "utf8");
  await appendFile(file, reports.map(tableRow).join(""), "utf8");
}

export interface Summary {
  runs: number;
  passed: number;
  /** Runs whose final attempt failed on the provider (no usable answer). */
  providerFailures: number;
  /** Runs that got a real answer but failed a check. */
  agentFailures: number;
  attempts: number;
  /** Provider failures seen on any attempt, including ones that a retry recovered. */
  providerAttempts: number;
  perCheck: Record<string, { passed: number; total: number }>;
  ranTests: number;
  usedDeferredLoading: number;
  usedScout: number;
}

export function summarize(reports: readonly RunReport[]): Summary {
  const perCheck: Summary["perCheck"] = {};
  for (const r of reports) {
    if (r.providerError) continue; // no usable answer: does not count for or against the agent
    for (const c of r.checks) {
      const entry = (perCheck[c.id] ??= { passed: 0, total: 0 });
      entry.total++;
      if (c.pass) entry.passed++;
    }
  }
  const answered = reports.filter((r) => !r.providerError);
  return {
    runs: reports.length,
    passed: reports.filter((r) => r.pass).length,
    providerFailures: reports.filter((r) => r.providerError).length,
    agentFailures: reports.filter((r) => !r.pass && !r.providerError).length,
    attempts: reports.reduce((n, r) => n + r.attempts, 0),
    providerAttempts: reports.reduce((n, r) => n + r.attemptKinds.filter((k) => k === "provider").length, 0),
    perCheck,
    ranTests: answered.filter((r) => r.ranTests).length,
    usedDeferredLoading: answered.filter((r) => r.usedDeferredLoading).length,
    usedScout: answered.filter((r) => r.usedScout).length,
  };
}

export function formatSummary(reports: readonly RunReport[]): string {
  const s = summarize(reports);
  const names = new Map<string, string>();
  for (const r of reports) for (const c of r.checks) names.set(c.id, c.name);
  const answered = s.runs - s.providerFailures;
  const lines = Object.keys(s.perCheck)
    .sort()
    .map((id) => `  (${id}) ${s.perCheck[id]?.passed}/${s.perCheck[id]?.total}  ${names.get(id) ?? ""}`);
  return [
    "Pass rate per check (runs with a real answer only):",
    ...lines,
    `Overall: ${s.passed}/${s.runs} runs passed (${s.passed}/${answered} of the runs that got an answer)`,
    `Failures: ${s.agentFailures} agent, ${s.providerFailures} provider (after retries); ${s.providerAttempts} provider-failed attempt(s) in total over ${s.attempts} attempt(s)`,
    `Behaviour (answered runs): ran tests ${s.ranTests}/${answered}, used deferred tools ${s.usedDeferredLoading}/${answered}, used a scout ${s.usedScout}/${answered}`,
  ].join("\n");
}

/** Per run: the changed files and whether the retrieval had already surfaced each one in the context block. */
export function contextLink(r: Pick<RunReport, "changedFiles" | "contextPaths">): Array<{ file: string; inContext: boolean }> {
  return r.changedFiles.map((file) => ({ file, inContext: r.contextPaths.includes(file) }));
}

export function formatContextLink(reports: readonly RunReport[]): string {
  const lines = ["Context -> edit link (changed files; ✓ = the retrieval had already put it in the context block):"];
  for (const r of reports) {
    const link = contextLink(r);
    lines.push(`  ${r.runId}: ${link.length === 0 ? "(no files changed)" : link.map((l) => `${l.inContext ? "✓" : "✗"} ${l.file}`).join(", ")}${link.length ? `  [${link.filter((l) => l.inContext).length}/${link.length} surfaced]` : ""}`);
  }
  return lines.join("\n");
}
