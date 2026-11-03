import { checkCommand } from "../mcp/commandPolicy";
import type { CommandTickets } from "../mcp/commandTickets";
import type { RunRegistry } from "./runRegistry";
import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "./agentController";

/** Approval handler for run_command: refuses denylisted commands without asking, remembers "allow this exact command for this run". */
export interface CommandApprovalDeps {
  /** Asks the user (the panel card). Its allow decision may carry `remember`. */
  inner: ApprovalHandler;
  getRunId: () => string;
  getRoot: () => Promise<string>;
  log?: (message: string) => void;
  /** One ticket per approved call; the run_command tool refuses commands without one. */
  tickets?: CommandTickets;
  /** A cancelled run is never asked and never approved. */
  registry?: RunRegistry;
}

export function commandOf(rawArgs: string): string | undefined {
  try {
    const parsed: unknown = JSON.parse(rawArgs);
    const command = typeof parsed === "object" && parsed !== null ? (parsed as { command?: unknown }).command : undefined;
    return typeof command === "string" ? command.trim() : undefined;
  } catch {
    return undefined;
  }
}

export class CommandApprovalHandler implements ApprovalHandler {
  private readonly allowed = new Set<string>();

  constructor(private readonly deps: CommandApprovalDeps) {}

  async decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision> {
    const log = this.deps.log ?? (() => undefined);
    if (this.deps.registry?.isCancelled() || signal.aborted) return { status: "deny", reason: "The run was cancelled by the user." };
    const command = commandOf(call.args);
    if (command === undefined) return { status: "deny", reason: "run_command needs a JSON object with a string `command`. Call it again with {\"command\": \"...\"}." };
    const verdict = checkCommand(command, { root: await this.deps.getRoot().catch(() => "") });
    if (!verdict.ok) {
      log(`run_command denied by policy (${verdict.reason}): ${command.slice(0, 120)}`);
      return { status: "deny", reason: `Not run: ${verdict.reason} Choose a safer command or ask the user to run it.` };
    }
    const key = `${this.deps.getRunId()}\u0000${command}`;
    if (this.allowed.has(key)) {
      log(`run_command auto-allowed (same command already allowed in ${this.deps.getRunId()}): ${command.slice(0, 120)}`);
      this.deps.tickets?.issue(command);
      return { status: "allow" };
    }
    const decision = await this.deps.inner.decide(call, signal);
    if (decision.status === "allow") {
      if (this.deps.registry?.isCancelled()) return { status: "deny", reason: "The run was cancelled by the user." };
      if (decision.remember) this.allowed.add(key);
      this.deps.tickets?.issue(command);
      return { status: "allow" };
    }
    return decision;
  }
}
