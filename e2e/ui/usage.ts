/**
 * Tokens of a rehearsal from TrueForge's own session records, so a task that failed or timed out is still counted
 * (the Forge log only gets a usage line when a turn finishes). Sessions are found by the agent name prefix of the run
 * (`e2e-<pid>-forge-...`); each turn's `state.metrics` has total_input_tokens / total_output_tokens. Pure parsing is
 * separate from the fetch so it can be unit-tested.
 */
export interface SessionUsage {
  sessions: number;
  turns: number;
  input: number;
  output: number;
}

interface SessionRow {
  id: string;
  agent?: { name?: string };
}
interface TurnRow {
  state?: { metrics?: { total_input_tokens?: number; total_output_tokens?: number } };
}

export function sumUsage(sessions: readonly SessionRow[], prefix: string, turnsOf: ReadonlyMap<string, readonly TurnRow[]>): SessionUsage {
  const mine = sessions.filter((s) => (s.agent?.name ?? "").startsWith(prefix));
  const usage: SessionUsage = { sessions: mine.length, turns: 0, input: 0, output: 0 };
  for (const s of mine) {
    for (const t of turnsOf.get(s.id) ?? []) {
      usage.turns++;
      usage.input += t.state?.metrics?.total_input_tokens ?? 0;
      usage.output += t.state?.metrics?.total_output_tokens ?? 0;
    }
  }
  return usage;
}

export async function fetchSessionUsage(baseUrl: string, prefix: string): Promise<SessionUsage> {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(15_000) });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  };
  const list = await get<{ data: SessionRow[] }>("/api/v1/sessions?limit=25"); // newest first; a rehearsal creates fewer than 25
  const mine = list.data.filter((s) => (s.agent?.name ?? "").startsWith(prefix));
  const turns = new Map<string, TurnRow[]>();
  for (const s of mine) turns.set(s.id, (await get<{ data: TurnRow[] }>(`/api/v1/sessions/${s.id}/turns`)).data);
  return sumUsage(list.data, prefix, turns);
}
