import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

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
  contextItems: number;
  contextTokens: number;
  tokens: { input: number; output: number; calls: number } | undefined;
  finalMessage: string;
  errors: string[];
  changedFiles: string[];
}

const HEADER = "| Run id | Date | Task | Model | Result | Checks | Tokens (in/out) | Notes |\n|---|---|---|---|---|---|---|---|\n";

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
    r.task === "b" ? `key files in context ${r.keyFilesInContext.length}/3, read ${r.keyFilesRead.length}/3` : "",
    r.accept !== "all" ? `accept=${r.accept}` : "",
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
  perCheck: Record<string, { passed: number; total: number }>;
}

export function summarize(reports: readonly RunReport[]): Summary {
  const perCheck: Summary["perCheck"] = {};
  for (const r of reports) {
    for (const c of r.checks) {
      const entry = (perCheck[c.id] ??= { passed: 0, total: 0 });
      entry.total++;
      if (c.pass) entry.passed++;
    }
  }
  return { runs: reports.length, passed: reports.filter((r) => r.pass).length, perCheck };
}

export function formatSummary(reports: readonly RunReport[]): string {
  const s = summarize(reports);
  const names = new Map<string, string>();
  for (const r of reports) for (const c of r.checks) names.set(c.id, c.name);
  const lines = Object.keys(s.perCheck)
    .sort()
    .map((id) => `  (${id}) ${s.perCheck[id]?.passed}/${s.perCheck[id]?.total}  ${names.get(id) ?? ""}`);
  return [`Pass rate per check:`, ...lines, `Overall: ${s.passed}/${s.runs} runs passed`].join("\n");
}
