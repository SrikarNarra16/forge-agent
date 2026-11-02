import type { ContextReadEvent } from "../mcp/events";
import type { ContextViewPlan, ContextViewState } from "../context/view";

/** Holds what the Context section shows and produces the snapshot the webview renders. Pure and vscode-free. */
export class ContextPanelState {
  private plan: ContextViewPlan | undefined;
  private reads: ContextViewState["reads"] = [];
  private modelInputTokens: number | undefined;
  private expand = false;

  /** A new run starts: the plan of the latest turn replaces the old one, reads accumulate, the section opens. */
  beginRun(plan: ContextViewPlan | undefined): void {
    this.plan = plan;
    this.modelInputTokens = undefined;
    this.expand = true;
  }

  addRead(event: ContextReadEvent): void {
    this.reads = [...this.reads, { path: event.path, startLine: event.start, endLine: event.end, why: event.why, tokens: event.tokens }];
    this.expand = false;
  }

  /** TrueForge's input-token count of the run's first model call; kept once set. */
  setModelInputTokens(tokens: number): boolean {
    if (this.modelInputTokens !== undefined) return false;
    this.modelInputTokens = tokens;
    this.expand = false;
    return true;
  }

  hasModelInputTokens(): boolean {
    return this.modelInputTokens !== undefined;
  }

  clear(): void {
    this.plan = undefined;
    this.reads = [];
    this.modelInputTokens = undefined;
    this.expand = false;
  }

  snapshot(): ContextViewState {
    return {
      ...(this.plan ? { plan: this.plan } : {}),
      reads: this.reads,
      ...(this.modelInputTokens !== undefined ? { modelInputTokens: this.modelInputTokens } : {}),
      expand: this.expand,
    };
  }
}
