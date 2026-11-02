import type { ApprovalDecision, ApprovalHandler, PendingToolCall } from "./agentController";

/**
 * Sends each pending call to the handler registered for its tool name (propose_edit / create_file go to the
 * diff review), and everything else to the generic Allow/Deny card. Pure and vscode-free.
 */
export class RoutingApprovalHandler implements ApprovalHandler {
  constructor(
    private readonly routes: ReadonlyMap<string, ApprovalHandler>,
    private readonly fallback: ApprovalHandler,
  ) {}

  decide(call: PendingToolCall, signal: AbortSignal): Promise<ApprovalDecision> {
    return (this.routes.get(call.name) ?? this.fallback).decide(call, signal);
  }
}
