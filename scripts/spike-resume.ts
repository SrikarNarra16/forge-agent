/**
 * Spike: what does subscribeToTurn's afterSequenceNumber mean, and what do getTurn / listTurnEvents return?
 * One tiny turn on a THROWAWAY agent (forge-eval-<pid>-r1-agent, no MCP servers), cleaned up on every exit path.
 * Appends its token usage to eval-output/ledger.jsonl (cost guard).
 *
 *   npx tsx scripts/spike-resume.ts [--model deepseek/flash]
 */
import { join } from "node:path";
import { createClient, describeError } from "../src/trueforge/client";
import { agentName, assertThrowaway } from "./eval/guard";
import { appendLedger } from "./eval/ledger";

const BASE_URL = process.env["TRUEFORGE_BASE_URL"] ?? "http://localhost:8790";
const model = process.argv.includes("--model") ? (process.argv[process.argv.indexOf("--model") + 1] ?? "deepseek/flash") : "deepseek/flash";

async function collect(stream: AsyncIterable<unknown>, limit = Infinity, abort?: AbortController): Promise<Array<Record<string, unknown>>> {
  const out: Array<Record<string, unknown>> = [];
  try {
    for await (const e of stream) {
      out.push(e as Record<string, unknown>);
      if (out.length >= limit) {
        abort?.abort();
        break;
      }
    }
  } catch (err) {
    out.push({ type: "(stream threw)", error: describeError(err) });
  }
  return out;
}

const types = (events: Array<Record<string, unknown>>): string => {
  const counts = new Map<string, number>();
  for (const e of events) counts.set(String(e["type"]), (counts.get(String(e["type"])) ?? 0) + 1);
  return [...counts.entries()].map(([k, v]) => `${k}×${v}`).join(" ");
};

async function main(): Promise<void> {
  const client = createClient(BASE_URL);
  const name = agentName(process.pid, 1);
  assertThrowaway(name);
  let agentId: string | undefined;
  const sessions: string[] = [];
  let tokens = { input: 0, output: 0 };
  try {
    const created = await client.agents.create({ name, description: "throwaway resume spike", manifest: { model: { name: model }, instructions: "Follow the user's instruction exactly. No tools." } });
    agentId = created.data.id;
    const mk = async (): Promise<string> => {
      const s = await client.sessions.create({ agent: { name } });
      sessions.push(s.data.id);
      return s.data.id;
    };
    const prompt = "Write the numbers 1 to 25, one per line, nothing else.";

    // --- A: a complete stream, then replays at several sequence numbers
    const sa = await mk();
    const full = await collect(await client.sessions.createTurnStream(sa, { input: [{ type: "user.message", content: prompt }] }));
    const turnId = String(full.find((e) => e["type"] === "turn.created")?.["turnId"]);
    console.log(`A. live stream: ${full.length} events (${types(full)}) turn ${turnId}`);
    const done = full.find((e) => e["type"] === "turn.done") as { state?: { metrics?: { totalInputTokens?: number; totalOutputTokens?: number } } } | undefined;
    tokens = { input: done?.state?.metrics?.totalInputTokens ?? 0, output: done?.state?.metrics?.totalOutputTokens ?? 0 };
    console.log(`   event keys: ${[...new Set(full.flatMap((e) => Object.keys(e)))].join(",")}`);

    const turn = await client.sessions.getTurn(sa, turnId);
    console.log(`B. getTurn: ${JSON.stringify(turn.data).slice(0, 400)}`);

    const listed: unknown[] = [];
    for await (const ev of await client.sessions.listTurnEvents(sa, turnId, { limit: 100 })) listed.push(ev);
    console.log(`C. listTurnEvents: ${listed.length} events; first keys: ${Object.keys((listed[0] ?? {}) as object).join(",")}; sample: ${JSON.stringify(listed[0]).slice(0, 300)}`);
    console.log(`   listed types: ${types(listed as Array<Record<string, unknown>>)}`);

    for (const after of [undefined, 0, 1, 5, 10, full.length - 1, full.length]) {
      try {
        const replay = await collect(await client.sessions.subscribeToTurn(sa, turnId, after === undefined ? {} : { afterSequenceNumber: after }));
        console.log(`D. subscribe after=${String(after)}: ${replay.length} events; first=${String(replay[0]?.["type"])} last=${String(replay.at(-1)?.["type"])} (${types(replay).slice(0, 120)})`);
      } catch (err) {
        console.log(`D. subscribe after=${String(after)} threw: ${describeError(err)}`);
      }
    }

    // --- E: drop a live stream after ~12 events, then see what the server says and resume
    const sb = await mk();
    const controller = new AbortController();
    const stream = await client.sessions.createTurnStream(sb, { input: [{ type: "user.message", content: prompt }] }, { abortSignal: controller.signal });
    const partial = await collect(stream, 12, controller);
    const turnB = String(partial.find((e) => e["type"] === "turn.created")?.["turnId"]);
    console.log(`E. dropped after ${partial.length} events (${types(partial)}); turn ${turnB}`);
    await new Promise((r) => setTimeout(r, 300));
    const status = await client.sessions.getTurn(sb, turnB);
    console.log(`   getTurn after drop: ${JSON.stringify(status.data).slice(0, 300)}`);
    for (const after of [partial.length - 1, partial.length, partial.length + 1]) {
      const resumed = await collect(await client.sessions.subscribeToTurn(sb, turnB, { afterSequenceNumber: after }));
      console.log(`   resume after=${after}: ${resumed.length} events; first=${String(resumed[0]?.["type"])} id=${String(resumed[0]?.["id"]).slice(-6)} (partial's last id=${String(partial.at(-1)?.["id"]).slice(-6)}); last=${String(resumed.at(-1)?.["type"])}`);
    }
  } finally {
    for (const id of sessions) await client.sessions.delete(id).catch(() => undefined);
    if (agentId) {
      assertThrowaway(name);
      await client.agents.delete(agentId).catch((e: unknown) => console.log(`cleanup agent failed: ${describeError(e)}`));
    }
    await appendLedger(join(__dirname, "..", "eval-output", "ledger.jsonl"), { runId: `spike-resume-${process.pid}`, task: "spike", model, attempt: 1, input: tokens.input, output: tokens.output, at: new Date().toISOString() });
  }
}

main().then(
  () => process.exit(0),
  (err: unknown) => {
    console.error(`spike failed: ${describeError(err)}`);
    process.exit(1);
  },
);
