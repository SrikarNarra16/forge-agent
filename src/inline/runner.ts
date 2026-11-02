import type { SendOptions, SendResult } from "../trueforge/agentController";
import { buildInlineMessage, inlineDisplayText, type SelectionSnapshot } from "./message";

/**
 * Runs one inline edit through the shared AgentController (same run lock, state machine and approval
 * wiring as the panel) and turns the result into ONE message for the user. Pure and vscode-free: the editor
 * UI (status bar item, messages) is injected as `InlineUi`.
 */
export interface InlineController {
  readonly runState: { readonly busy: boolean };
  send(text: string, options: SendOptions): Promise<SendResult>;
}

export interface InlineUi {
  /** "Forge is busy with another run" */
  busy(): void;
  /** Shows the "editing… (click to stop)" indicator; returns a function that removes it. */
  running(): () => void;
  /** One information message with an Undo button. Must not block the caller. */
  applied(message: string): void;
  info(message: string): void;
  error(message: string): void;
}

export type InlineOutcome =
  | { kind: "busy" }
  | { kind: "applied"; message: string }
  | { kind: "rejected" }
  | { kind: "no-edit"; text: string }
  | { kind: "cancelled" }
  | { kind: "error"; message: string };

export interface InlineDeps {
  controller: InlineController;
  ui: InlineUi;
  agentName: string;
  /** Model override (the first of forge.models); omitted to use the agent file's model. */
  model?: string | undefined;
}

type RunView = Extract<SendResult, { ok: true }>["view"];

function lastAssistantText(view: RunView): string {
  const texts = view.messages.filter((m) => m.threadId === "main" && m.text.trim() !== "").map((m) => m.text.trim());
  return texts[texts.length - 1] ?? "";
}

/** Maps a finished run to what the user should hear. */
export function describeInlineOutcome(result: Extract<SendResult, { ok: true }>): InlineOutcome {
  if (result.state === "error") return { kind: "error", message: result.detail ?? "The agent run failed." };
  if (result.state === "cancelled") return { kind: "cancelled" };

  const edits = result.view.toolCalls.filter((c) => c.name === "propose_edit");
  const applied = edits.find((c) => (c.response ?? "").startsWith("applied"));
  if (applied) return { kind: "applied", message: applied.response ?? "applied" };
  if (edits.length === 0) return { kind: "no-edit", text: lastAssistantText(result.view) };
  if (edits.some((c) => c.status === "denied" || (c.response ?? "").includes("User denied tool call"))) return { kind: "rejected" };
  const failure = edits.map((c) => c.response ?? "").find((r) => r !== "") ?? "no response from the tool";
  return { kind: "error", message: `The edit could not be applied: ${failure}` };
}

export async function runInlineEdit(deps: InlineDeps, request: { snapshot: SelectionSnapshot; instruction: string }): Promise<InlineOutcome> {
  const { controller, ui } = deps;
  if (controller.runState.busy) {
    ui.busy();
    return { kind: "busy" };
  }
  const hide = ui.running();
  let result: SendResult;
  try {
    result = await controller.send(buildInlineMessage(request.snapshot, request.instruction), {
      freshSession: true,
      agentName: deps.agentName,
      ...(deps.model ? { model: deps.model } : {}),
      display: inlineDisplayText(request.snapshot, request.instruction),
      purpose: "inline-edit",
    });
  } finally {
    hide(); // the indicator never outlives the run, however it ended
  }

  if (!result.ok) {
    ui.busy(); // lost a race with another run between the check and the send
    return { kind: "busy" };
  }
  const outcome = describeInlineOutcome(result);
  switch (outcome.kind) {
    case "applied":
      ui.applied(`Forge: ${outcome.message}`);
      break;
    case "rejected":
      ui.info("Forge: no changes were applied (you rejected the edit).");
      break;
    case "no-edit":
      ui.info(outcome.text ? `Forge made no edit. It said: ${outcome.text}` : "Forge finished without proposing an edit.");
      break;
    case "cancelled":
      ui.info("Forge: the edit was stopped.");
      break;
    case "error":
      ui.error(`Forge: ${outcome.message}`);
      break;
    case "busy":
      break;
  }
  return outcome;
}
