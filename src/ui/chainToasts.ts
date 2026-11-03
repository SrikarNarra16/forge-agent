import * as vscode from "vscode";
import type { NoticeLevel, UiSink } from "../trueforge/agentController";
import type { ReducerChange, TurnView } from "../trueforge/events";
import type { ChainEvent } from "../trueforge/modelChain";
import type { RunState } from "../trueforge/runState";

/**
 * Non-blocking editor-level surfacing of the model chain: a status bar message when Forge switches models and a
 * toast when no model could answer (or the failed attempt had already changed files). The panel shows the
 * same text as a notice.
 */
export class ChainToasts implements UiSink {
  onState(_state: RunState, _detail?: string): void {}
  onUserMessage(_text: string): void {}
  onTurnChange(_view: TurnView, _change: ReducerChange): void {}
  onSession(_info: { sessionId: string; model?: string }): void {}
  onNotice(_level: NoticeLevel, _text: string): void {}
  onReset(): void {}

  onChain(event: ChainEvent): void {
    switch (event.kind) {
      case "retrying":
      case "switched":
        vscode.window.setStatusBarMessage(`$(sync) Forge: ${event.text}`, 8000);
        break;
      case "exhausted":
      case "blocked":
      case "trueforge-down":
        void vscode.window.showErrorMessage(`Forge: ${event.text}`);
        break;
    }
  }
}

export type { ChainEvent };
