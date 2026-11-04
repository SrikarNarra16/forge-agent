/**
 * Stall-timing analysis for forge.stallFirstEventSeconds / forge.stallIdleSeconds: from the recorded stream events
 * of SUCCESSFUL runs (eval-output/*.events.jsonl, which carry the arrival time `t` in ms), computes
 *   - time to the first model token after each request (first delta / content / tool call), and
 *   - the longest silence between two "progress" events while no tool call was in flight.
 *   npx tsx scripts/eval/timing.ts [files...]
 */
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

interface Rec {
  turn: number;
  t?: number;
  event?: { type: string; content?: unknown; toolCalls?: unknown; finishReason?: unknown; state?: { status?: string }; model?: { name?: string } };
}

const isProgress = (e: NonNullable<Rec["event"]>): boolean =>
  ["model.message.delta", "tool.response", "tool.approval_required", "turn.done", "thread.created", "thread.done"].includes(e.type) || (e.type === "model.message" && Boolean(e.content || e.toolCalls || e.finishReason));

export interface TimingResult {
  model: string;
  /** The turn ended `done`. */
  success: boolean;
  firstTokenMs: number[];
  maxGapMs: number;
  events: number;
}

/** One result per turn (a model-chain run holds several turns on different models). */
export function analyseTurns(lines: readonly string[]): TimingResult[] {
  const recs = lines.flatMap((l) => {
    try {
      return [JSON.parse(l) as Rec];
    } catch {
      return [];
    }
  });
  const byTurn = new Map<number, Rec[]>();
  for (const r of recs) if (r.event && r.t !== undefined) byTurn.set(r.turn, [...(byTurn.get(r.turn) ?? []), r]);
  const out: TimingResult[] = [];
  for (const timed of byTurn.values()) {
    const done = timed.filter((r) => r.event?.type === "turn.done").at(-1);
    const model = timed.find((r) => r.event?.type === "model.message" && r.event.model?.name)?.event?.model?.name ?? "?";
    const firstTokenMs: number[] = [];
    let created: number | undefined;
    let gotToken = false;
    let lastProgress: number | undefined;
    let inFlight = 0;
    let maxGap = 0;
    for (const r of timed) {
      const e = r.event as NonNullable<Rec["event"]>;
      const t = r.t as number;
      if (e.type === "turn.created") {
        created = t;
        gotToken = false;
        lastProgress = t;
      }
      const toolWasInFlight = inFlight > 0; // silence while a tool runs is the tool's time, not the model's
      if (e.type === "model.message" && e.toolCalls) inFlight++;
      if (e.type === "tool.response") inFlight = Math.max(0, inFlight - 1);
      if (isProgress(e)) {
        if (!gotToken && created !== undefined && (e.type === "model.message.delta" || (e.type === "model.message" && (e.content || e.toolCalls)))) {
          firstTokenMs.push(t - created);
          gotToken = true;
        }
        if (lastProgress !== undefined && !toolWasInFlight) maxGap = Math.max(maxGap, t - lastProgress);
        lastProgress = t;
      }
    }
    out.push({ model, success: done?.event?.state?.status === "done", firstTokenMs, maxGapMs: maxGap, events: timed.length });
  }
  return out;
}

/** Whole-recording view (the last turn decides success); kept for the single-turn callers and tests. */
export function analyse(lines: readonly string[]): TimingResult | undefined {
  const turns = analyseTurns(lines);
  if (turns.length === 0) return undefined;
  const last = turns[turns.length - 1] as TimingResult;
  return { model: last.model, success: last.success, firstTokenMs: turns.flatMap((t) => t.firstTokenMs), maxGapMs: Math.max(...turns.map((t) => t.maxGapMs)), events: turns.reduce((n, t) => n + t.events, 0) };
}

async function main(): Promise<void> {
  const dir = join(__dirname, "..", "..", "eval-output");
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : (await readdir(dir)).filter((f) => f.endsWith(".events.jsonl")).map((f) => join(dir, f));
  const byModel = new Map<string, { first: number[]; gap: number[]; runs: number }>();
  for (const f of files) {
    for (const r of analyseTurns((await readFile(f, "utf8")).split("\n").filter(Boolean))) {
      if (!r.success) continue; // only turns that completed on that model
      const m = byModel.get(r.model) ?? { first: [], gap: [], runs: 0 };
      m.first.push(...r.firstTokenMs);
      m.gap.push(r.maxGapMs);
      m.runs++;
      byModel.set(r.model, m);
    }
  }
  if (byModel.size === 0) console.log("No successful run with arrival timestamps yet (events recorded before 3 Nov 2026 have none). Run a few evals, then rerun.");
  for (const [model, m] of byModel) {
    const sorted = [...m.first].sort((a, b) => a - b);
    const p = (q: number): number => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
    console.log(`${model}: ${m.runs} successful turn(s); time to first token: median ${p(0.5)} ms, p95 ${p(0.95)} ms, max ${sorted.at(-1) ?? 0} ms; longest silence between progress events (no tool in flight): max ${Math.max(0, ...m.gap)} ms`);
  }
}

if (require.main === module) void main();
