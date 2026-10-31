import * as vscode from "vscode";
import { TrueForgeError, isEventDelta, mergeEventDelta, type TrueForge, type TrueForgeApi } from "@truefoundry/trueforge-sdk";
import type { Logger } from "../util/log";
import type { Bootstrapper } from "./bootstrap";
import { FORGE_AGENT_NAME, TRUEFORGE_START_COMMAND, describeError, isUnreachable, sessionUrl } from "./client";

/**
 * "Forge: Smoke Test": runs the saved `forge-agent` once through TrueForge and asks it to call the
 * ping tool served by OUR extension over MCP. Streams every event into the Forge output channel and
 * shows the final answer. This is the end-to-end proof of the eligibility gate.
 */
export interface SmokeTestDeps {
  log: Logger;
  bootstrapper: Bootstrapper;
  getClient: () => TrueForge;
  getBaseUrl: () => string;
}

export type SmokeTestKind = "ping" | "code";

const SMOKE_TESTS: Record<SmokeTestKind, { title: string; prompt: string }> = {
  ping: { title: "Smoke test", prompt: "Use the ping tool and tell me what it returned." },
  code: {
    title: "Smoke test (code question)",
    prompt: "Find get_debug_flag in this workspace and explain exactly which values it treats as false.",
  },
};

const PREVIEW_CHARS = 300;
/** Tool-call arguments are logged longer than other previews so the model's `why` stays visible. */
const TOOL_ARGS_PREVIEW_CHARS = 500;

type Event = TrueForgeApi.TurnStreamingEvent;
type ModelMessage = TrueForgeApi.ModelMessageEvent;

function preview(text: string, max = PREVIEW_CHARS): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length} chars)` : flat;
}

/** Plain text of a model message (string content or text parts). */
export function contentText(content: ModelMessage["content"]): string {
  if (!content) return "";
  if (typeof content === "string") return content;
  return content.map((part) => ("text" in part ? part.text : "")).join("");
}

function describeMessage(msg: ModelMessage): string {
  const text = contentText(msg.content);
  const calls = (msg.toolCalls ?? []).map((c) => `${c.function.name}(${preview(c.function.arguments, TOOL_ARGS_PREVIEW_CHARS)})`);
  return [`model.message ${msg.id.slice(-8)}`, text ? `text="${preview(text)}"` : undefined, calls.length ? `tool_calls=[${calls.join(", ")}]` : undefined]
    .filter(Boolean)
    .join(" ");
}

interface StreamOutcome {
  answer: string | undefined;
  status: "done" | "cancelled" | "error" | "no-turn-done";
  errorMessage?: string;
}

async function consume(stream: AsyncIterable<Event>, log: Logger): Promise<StreamOutcome> {
  const messages = new Map<string, ModelMessage>();
  const unlogged = new Set<string>();
  let lastText: string | undefined;

  const flush = (): void => {
    for (const id of unlogged) {
      const msg = messages.get(id);
      if (msg) {
        log.info(`  ${describeMessage(msg)}`);
        const text = contentText(msg.content);
        if (text) lastText = text;
      }
    }
    unlogged.clear();
  };

  for await (const event of stream) {
    if (event.type === "model.message") {
      messages.set(event.id, event);
      unlogged.add(event.id);
      continue;
    }
    if (isEventDelta(event)) {
      const base = messages.get(event.id);
      if (base) mergeEventDelta(base, event);
      continue;
    }
    flush();
    switch (event.type) {
      case "tool.response":
        log.info(`  tool.response call=${event.toolCallId.slice(-8)} "${preview(event.content, 200)}"`);
        break;
      case "turn.done": {
        const state = event.state;
        if (state.status === "error") {
          log.info(`  turn.done status=error message="${state.message}"`);
          return { answer: undefined, status: "error", errorMessage: state.message };
        }
        if (state.status === "cancelled") {
          log.info(`  turn.done status=cancelled reason=${state.reason}`);
          return { answer: undefined, status: "cancelled" };
        }
        const answer = contentText(state.output?.content) || lastText;
        log.info(`  turn.done status=done`);
        return { answer, status: "done" };
      }
      default:
        log.info(`  ${event.type}`);
    }
  }
  flush();
  return { answer: lastText, status: "no-turn-done" };
}

function hintFor(message: string): string {
  if (/model/i.test(message) && /not found|unknown|does not exist|not configured/i.test(message)) {
    return `${message}\nThe model is not configured in TrueForge: run "npm run tf:setup" or add it in the TrueForge UI.`;
  }
  return message;
}

export async function runSmokeTest(deps: SmokeTestDeps, kind: SmokeTestKind = "ping"): Promise<void> {
  const { log, bootstrapper } = deps;
  const { title, prompt } = SMOKE_TESTS[kind];
  const baseUrl = deps.getBaseUrl();
  log.show();
  log.info(`--- ${title} (${new Date().toISOString()}) against ${baseUrl}`);

  await vscode.window.withProgress(
    { location: vscode.ProgressLocation.Notification, title: `Forge ${title.toLowerCase()}`, cancellable: true },
    async (progress, cancel) => {
      progress.report({ message: "Preparing TrueForge…" });
      // Always re-run bootstrap: it is idempotent and cheap, and it heals a registration or agent that TrueForge lost.
      const ready = await bootstrapper.run();
      if (!ready.ok) {
        const msg =
          ready.stage === "unreachable"
            ? `TrueForge is not reachable at ${baseUrl}. Start it with "npm run tf:start" (or: ${TRUEFORGE_START_COMMAND}).`
            : ready.message;
        log.error(`Smoke test aborted at bootstrap (${ready.stage}): ${msg}`);
        void vscode.window.showErrorMessage(`Forge smoke test: ${msg}`);
        return;
      }

      const client = deps.getClient();
      let sessionId: string | undefined;
      cancel.onCancellationRequested(() => {
        if (sessionId) void client.sessions.cancel(sessionId).catch((err: unknown) => log.warn(`cancel failed: ${describeError(err)}`));
      });

      try {
        const modelName = ready.agents.find((a) => a.name === FORGE_AGENT_NAME)?.spec.model.name;
        if (modelName) {
          const models = await client.models.list();
          if (!models.data.some((m) => m.name === modelName)) {
            const msg = `Model "${modelName}" is not configured in TrueForge. Run "npm run tf:setup" (needs the provider API key env var) or add it in the TrueForge UI.`;
            log.error(msg);
            void vscode.window.showErrorMessage(`Forge smoke test: ${msg}`);
            return;
          }
        }

        progress.report({ message: "Creating session…" });
        const { data: session } = await client.sessions.create({
          agent: { name: FORGE_AGENT_NAME },
          metadata: { client: "forge-agent", purpose: kind === "ping" ? "smoke-test" : "smoke-test-code" },
        });
        sessionId = session.id;
        const url = sessionUrl(baseUrl, session.id);
        log.info(`TrueForge session id: ${session.id}`);
        log.info(`Session URL: ${url}`);

        progress.report({ message: "Agent running…" });
        log.info(`> ${prompt}`);
        const stream = await client.sessions.createTurnStream(session.id, { input: [{ type: "user.message", content: prompt }] });
        const outcome = await consume(stream, log);

        if (outcome.status === "done" && outcome.answer) {
          log.info(`Answer: ${outcome.answer}`);
          const choice = await vscode.window.showInformationMessage(`Forge ${title.toLowerCase()}: ${outcome.answer}`, "Open Session", "Show Log");
          if (choice === "Open Session") void vscode.env.openExternal(vscode.Uri.parse(url));
          if (choice === "Show Log") log.show();
        } else if (outcome.status === "error") {
          void vscode.window.showErrorMessage(`Forge smoke test failed: ${hintFor(outcome.errorMessage ?? "unknown error")}`);
        } else if (outcome.status === "cancelled") {
          void vscode.window.showWarningMessage("Forge smoke test cancelled.");
        } else {
          log.warn("Stream ended without a final answer.");
          void vscode.window.showWarningMessage("Forge smoke test: the turn finished without an answer. See the Forge output.");
        }
      } catch (err) {
        log.error("Smoke test failed", err);
        if (isUnreachable(err)) {
          void vscode.window.showErrorMessage(`Forge smoke test: lost connection to TrueForge at ${baseUrl}.`);
        } else if (err instanceof TrueForgeError && err.statusCode === 404) {
          void vscode.window.showErrorMessage(`Forge smoke test: ${describeError(err)}. Is the agent "${FORGE_AGENT_NAME}" saved in TrueForge? Run bootstrap by restarting the extension.`);
        } else {
          void vscode.window.showErrorMessage(`Forge smoke test failed: ${hintFor(describeError(err))}`);
        }
      }
    },
  );
}
