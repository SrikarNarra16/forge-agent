import { messageText, type ReducerChange, type TurnView } from "./events";
import { sessionUrl } from "./client";
import type { NoticeLevel, UiSink } from "./agentController";
import type { ChainEvent } from "./modelChain";
import type { RunState } from "./runState";

/** Small UiSink helpers (vscode-free): fan-out to several sinks, and a plain-text activity log for the Forge output channel. */

export class CompositeUi implements UiSink {
  constructor(private readonly sinks: readonly UiSink[]) {}
  onState(state: RunState, detail?: string): void {
    for (const s of this.sinks) s.onState(state, detail);
  }
  onUserMessage(text: string): void {
    for (const s of this.sinks) s.onUserMessage(text);
  }
  onTurnChange(view: TurnView, change: ReducerChange): void {
    for (const s of this.sinks) s.onTurnChange(view, change);
  }
  onSession(info: { sessionId: string; model?: string }): void {
    for (const s of this.sinks) s.onSession(info);
  }
  onNotice(level: NoticeLevel, text: string): void {
    for (const s of this.sinks) s.onNotice(level, text);
  }
  onReset(): void {
    for (const s of this.sinks) s.onReset();
  }
  onChain(event: ChainEvent): void {
    for (const s of this.sinks) s.onChain?.(event);
  }
  onAttemptDiscarded(): void {
    for (const s of this.sinks) s.onAttemptDiscarded?.();
  }
}

export interface LineLog {
  info(message: string): void;
  warn(message: string): void;
  error(message: string): void;
}

function preview(text: string, max = 300): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length > max ? `${flat.slice(0, max)}… (${flat.length} chars)` : flat;
}

/**
 * Writes the run to the Forge output channel: session id and URL, state changes, every tool call with its
 * arguments (so the agent's `why` is visible), short tool-result previews, and the final answer.
 * Each fact is logged once.
 */
export class ActivityLog implements UiSink {
  private readonly seen = new Set<string>();

  constructor(
    private readonly log: LineLog,
    private readonly baseUrl: () => string,
  ) {}

  onState(state: RunState, detail?: string): void {
    this.log.info(`run state: ${state}${detail ? ` (${detail})` : ""}`);
  }

  onUserMessage(text: string): void {
    this.seen.clear();
    this.log.info(`> ${preview(text, 500)}`);
  }

  onSession(info: { sessionId: string; model?: string }): void {
    this.log.info(`TrueForge session id: ${info.sessionId}${info.model ? ` (model ${info.model})` : ""}`);
    this.log.info(`Session URL: ${sessionUrl(this.baseUrl(), info.sessionId)}`);
  }

  onTurnChange(view: TurnView, change: ReducerChange): void {
    for (const id of change.toolCalls) {
      const call = view.toolCalls.find((c) => c.id === id);
      if (!call) continue;
      if (this.once(`call:${id}:${call.status}`)) {
        if (call.status === "running" && !call.response) this.log.info(`  tool call ${call.name}(${preview(call.args, 500)})`);
        else if (call.status === "awaiting_approval") this.log.info(`  tool ${call.name} awaits approval`);
        else if (call.status === "denied") this.log.info(`  tool ${call.name} denied${call.denyReason ? `: ${call.denyReason}` : ""}`);
      }
      if (call.response !== undefined && this.once(`resp:${id}`)) {
        this.log.info(`  tool.response ${call.name} (${call.durationMs ?? "?"} ms): ${preview(call.response, 200)}`);
      }
    }
    for (const id of change.threads) {
      const thread = view.threads.find((t) => t.id === id);
      if (thread && this.once(`thread:${id}:${thread.state}`)) this.log.info(`  subagent ${thread.state}: ${thread.title}`);
    }
    if (change.compaction && this.once(`compaction:${view.compaction.count}:${view.compaction.active}`)) {
      this.log.info(view.compaction.active ? "  context compaction started" : `  context compaction finished (${view.compaction.lastDurationMs ?? "?"} ms)`);
    }
    for (const id of change.messages) {
      const message = view.messages.find((m) => m.id === id);
      if (message?.complete && message.text && this.once(`msg:${id}`)) this.log.info(`  assistant${message.threadId === "main" ? "" : ` [${message.threadId}]`}: ${preview(message.text, 600)}`);
    }
    if (change.done && view.done && this.once(`done:${view.done.status}:${view.done.completedAt}`)) {
      const done = view.done;
      const answer = done.status === "done" && done.output ? messageText(done.output.content) : "";
      this.log.info(`  turn.done status=${done.status}${done.status === "error" ? ` message=${done.message}` : ""}${answer ? ` answer="${preview(answer, 400)}"` : ""}`);
    }
  }

  onNotice(level: NoticeLevel, text: string): void {
    const write = level === "warning" ? this.log.warn : level === "error" ? this.log.error : this.log.info;
    write.call(this.log, `notice: ${text}`);
  }

  onReset(): void {
    this.seen.clear();
    this.log.info("new chat");
  }

  private once(key: string): boolean {
    if (this.seen.has(key)) return false;
    this.seen.add(key);
    return true;
  }
}
