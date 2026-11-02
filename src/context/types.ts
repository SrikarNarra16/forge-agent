/**
 * Shared types of the context engine (vscode-free). Lines are 1-based and inclusive everywhere in this
 * module's public data, like the line numbers the agent sees from read_file.
 */
export type ChunkKind = "function" | "method" | "class" | "interface" | "type" | "enum" | "const" | "doc" | "module" | "window";

/** Kinds that name a code symbol (what `@symbol` mentions and symbol search can target). */
export const SYMBOL_KINDS: ReadonlySet<ChunkKind> = new Set(["function", "method", "class", "interface", "type", "enum", "const"]);

export interface ChunkDraft {
  path: string;
  startLine: number;
  endLine: number;
  /** Qualified name for code (`FlaskGroup.__init__`), the heading for docs. */
  symbol?: string;
  kind: ChunkKind;
  /** The definition line(s) for code, the heading text for docs. */
  signature?: string;
  /** The exact lines startLine..endLine joined with "\n". */
  text: string;
}

export interface Chunk extends ChunkDraft {
  id: number;
  /** Estimated tokens of `text` (chars / 4). */
  tokens: number;
}
