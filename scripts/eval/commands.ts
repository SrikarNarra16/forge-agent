import { checkCommand, splitCommands } from "../../src/mcp/commandPolicy";
import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "../../src/trueforge/agentController";
import { commandOf } from "../../src/trueforge/commandApprovals";

/**
 * run_command approvals in the eval harness: a scripted "user" that approves ONLY test/flask/git-read commands and
 * records every command with its verdict. The product CommandApprovalHandler (denylist, allow-for-run) sits in front.
 */
const ALLOWED_SIMPLE: RegExp[] = [
  /^(?:python3?\s+-m\s+)?pytest(?:\s|$)/,
  /^python3?\s+-m\s+flask(?:\s|$)/,
  /^flask(?:\s|$)/,
  /^git\s+(?:--no-pager\s+)?(?:diff|status|log|show)(?:\s|$)/,
  /^(?:tail|head)(?:\s|$)/,
  /^cd\s+\S+$/,
  /^(?:export\s+)?[A-Za-z_][A-Za-z0-9_]*=\S*$/,
];

export function harnessAllows(command: string): boolean {
  const parts = splitCommands(command.replace(/\s2>&1/g, ""));
  if (parts.length === 0) return false;
  return parts.every((part) => {
    const stripped = part.replace(/^(?:[A-Za-z_][A-Za-z0-9_]*=\S*\s+)+/, "");
    return ALLOWED_SIMPLE.some((re) => re.test(stripped)) && !/[<>]/.test(stripped.replace(/2>&1/g, ""));
  });
}

export interface CommandRecord {
  command: string;
  approved: boolean;
  reason?: string;
}

export class HarnessCommandApproval implements ApprovalHandler {
  readonly records: CommandRecord[] = [];

  decide(call: PendingToolCall): Promise<ApprovalDecision> {
    const command = commandOf(call.args) ?? "";
    const policy = checkCommand(command);
    if (policy.ok && harnessAllows(command)) {
      this.records.push({ command, approved: true });
      return Promise.resolve({ status: "allow" });
    }
    const reason = !policy.ok ? policy.reason : "The eval harness only approves pytest, flask and read-only git commands.";
    this.records.push({ command, approved: false, reason });
    return Promise.resolve({ status: "deny", reason });
  }
}
