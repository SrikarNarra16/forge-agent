/**
 * Data the Context section of the Agent panel renders. No imports: shared by the extension and the webview.
 */
export interface ContextViewItem {
  path: string;
  startLine: number;
  endLine: number;
  symbol?: string;
  source: "mention" | "auto";
  /** "matches: cli, command" for auto items, "pinned by @mention" for pinned ones. */
  reason: string;
  tokens: number;
  form: "body" | "signature";
}

/** What was put into the model's message for the latest turn. */
export interface ContextViewPlan {
  budgetTokens: number;
  usedTokens: number;
  items: ContextViewItem[];
  warnings: string[];
  /** Visible note, e.g. "Index still building: no auto context this turn". */
  note?: string;
  /** Index search + budget packing time. */
  retrievalMs?: number;
}

/** A read_file call by the agent. */
export interface ContextViewRead {
  path: string;
  startLine: number;
  endLine: number;
  /** The agent's full reason for reading. */
  why: string;
  tokens: number;
}

export interface ContextViewState {
  plan?: ContextViewPlan;
  reads: ContextViewRead[];
  /** "model input tokens" reported by TrueForge for the run's first model call. */
  modelInputTokens?: number;
  /** Open the section (first turn of a run). */
  expand: boolean;
}
