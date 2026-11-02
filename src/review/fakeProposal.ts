import * as path from "node:path";
import * as vscode from "vscode";
import type { WorkspaceHost } from "../mcp/host";
import { isInside } from "../util/paths";
import type { ApprovalHandler, PendingToolCall } from "../trueforge/agentController";
import { planFakeEdits } from "./fakeProposalPlan";

/**
 * "Forge: Fake Proposal": runs a made-up propose_edit (three separate edits to the active file, or to
 * src/flask/helpers.py) through the REAL review handler, so the whole review UI (lenses, rejecting a hunk,
 * Apply, Cmd+Z, Undo run) can be tried without a model. Nothing is written unless you accept and apply.
 */
const FALLBACK_FILE = "src/flask/helpers.py";
let counter = 0;

export async function runFakeProposal(deps: { host: WorkspaceHost; handler: ApprovalHandler }): Promise<void> {
  let root: string;
  try {
    root = await deps.host.rootPath();
  } catch {
    void vscode.window.showInformationMessage("Forge: open a workspace folder first.");
    return;
  }

  let rel = FALLBACK_FILE;
  const active = vscode.window.activeTextEditor?.document;
  if (active && active.uri.scheme === "file" && isInside(root, active.uri.fsPath)) {
    rel = path.relative(root, active.uri.fsPath).split(path.sep).join("/");
  }

  let text: string;
  try {
    text = await deps.host.readText(rel);
  } catch {
    void vscode.window.showInformationMessage(`Forge: could not read ${rel}. Open a source file with at least 12 lines and run "Forge: Fake Proposal" again.`);
    return;
  }

  const plan = planFakeEdits(text, path.extname(rel).slice(1));
  if (!plan.ok) {
    void vscode.window.showInformationMessage(`Forge: ${plan.error}`);
    return;
  }

  const call: PendingToolCall = {
    id: `fake-${++counter}`,
    name: "propose_edit",
    args: JSON.stringify({ path: rel, edits: plan.edits, summary: "Fake proposal: three separate edits to try the review UI" }),
    threadId: "main",
    sourceEventId: "fake",
  };
  try {
    const decision = await deps.handler.decide(call, new AbortController().signal);
    void vscode.window.showInformationMessage(
      decision.status === "allow" ? `Forge fake proposal: applied to ${rel}. Try Cmd/Ctrl+Z, or "Forge: Undo Last Agent Run".` : `Forge fake proposal: nothing was written (${decision.reason ?? "rejected"}).`,
    );
  } catch {
    void vscode.window.showInformationMessage("Forge fake proposal: cancelled, nothing was written.");
  }
}
