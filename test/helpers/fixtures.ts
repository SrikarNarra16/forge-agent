import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type { StreamEvent } from "../../src/trueforge/events";

/** One recorded turn: the request body's input and the raw events TrueForge streamed back. */
export interface RecordedTurn {
  turn: number;
  input: unknown[];
  events: StreamEvent[];
}

/** Loads test/fixtures/<folder>/<name>.jsonl (see docs/approval-spike.md for the format). */
export async function loadRecording(name: string, folder: "approval" | "edit" = "approval"): Promise<RecordedTurn[]> {
  const text = await readFile(join(__dirname, "..", "fixtures", folder, `${name}.jsonl`), "utf8");
  const turns = new Map<number, RecordedTurn>();
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    const row = JSON.parse(line) as { turn?: number; input?: unknown[]; event?: StreamEvent; probe?: string };
    if (row.turn === undefined) continue;
    const turn = turns.get(row.turn) ?? { turn: row.turn, input: [], events: [] };
    if (row.input) turn.input = row.input;
    if (row.event) turn.events.push(row.event);
    turns.set(row.turn, turn);
  }
  return [...turns.values()].sort((a, b) => a.turn - b.turn);
}
