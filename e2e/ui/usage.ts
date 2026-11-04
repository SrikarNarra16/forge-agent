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

// ---- per-session detail (model messages, tool calls, commands), for the per-task rows ------------------------------

export interface EventRow {
  type: string;
  tool_calls?: Array<{ function?: { name?: string; arguments?: string } }>;
}

export interface EventSummary {
  /** `model.message` events: one per model call that answered. */
  modelMessages: number;
  /** `tool.response` events: tool calls that completed. */
  toolResponses: number;
  /** The `command` of every run_command call the model made. */
  commands: string[];
}

export function summarizeEvents(events: readonly EventRow[]): EventSummary {
  const out: EventSummary = { modelMessages: 0, toolResponses: 0, commands: [] };
  for (const e of events) {
    if (e.type === "model.message") {
      out.modelMessages++;
      for (const call of e.tool_calls ?? []) {
        if (call.function?.name !== "run_command") continue;
        try {
          const command = (JSON.parse(call.function.arguments ?? "{}") as { command?: unknown }).command;
          if (typeof command === "string") out.commands.push(command);
        } catch {
          /* unparsable arguments: not counted */
        }
      }
    } else if (e.type === "tool.response") out.toolResponses++;
  }
  return out;
}

export interface SessionDetail extends EventSummary {
  id: string;
  agent: string;
  createdAt: number;
  turns: number;
  input: number;
  output: number;
}

/** Every session of this run with its turns, tokens, model messages, tool calls and commands (from TrueForge's records). */
export async function fetchSessionDetails(baseUrl: string, prefix: string): Promise<SessionDetail[]> {
  const base = baseUrl.replace(/\/+$/, "");
  const get = async <T>(path: string): Promise<T> => {
    const res = await fetch(`${base}${path}`, { signal: AbortSignal.timeout(20_000) });
    if (!res.ok) throw new Error(`GET ${path} -> ${res.status}`);
    return (await res.json()) as T;
  };
  const list = await get<{ data: Array<SessionRow & { created_at: string }> }>("/api/v1/sessions?limit=25");
  const out: SessionDetail[] = [];
  for (const s of list.data.filter((x) => (x.agent?.name ?? "").startsWith(prefix))) {
    const turns = (await get<{ data: Array<TurnRow & { id: string }> }>(`/api/v1/sessions/${s.id}/turns`)).data;
    const detail: SessionDetail = { id: s.id, agent: s.agent?.name ?? "", createdAt: Date.parse(s.created_at), turns: turns.length, input: 0, output: 0, modelMessages: 0, toolResponses: 0, commands: [] };
    for (const t of turns) {
      detail.input += t.state?.metrics?.total_input_tokens ?? 0;
      detail.output += t.state?.metrics?.total_output_tokens ?? 0;
      const sum = summarizeEvents((await get<{ data: EventRow[] }>(`/api/v1/sessions/${s.id}/turns/${t.id}/events`)).data);
      detail.modelMessages += sum.modelMessages;
      detail.toolResponses += sum.toolResponses;
      detail.commands.push(...sum.commands);
    }
    out.push(detail);
  }
  return out.sort((a, b) => a.createdAt - b.createdAt);
}

/** The sessions that belong to a task: created between its instruction being sent and its result being verified. */
export function sessionsInWindow(details: readonly SessionDetail[], from: number, to: number): SessionDetail[] {
  return details.filter((d) => d.createdAt >= from - 3000 && d.createdAt <= to);
}
