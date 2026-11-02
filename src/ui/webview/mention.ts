/** Where the user is typing an @mention: `@query` ending at the caret, preceded by the start or whitespace. */
export interface MentionTrigger {
  /** Index of the "@". */
  start: number;
  kind: "file" | "symbol";
  /** The text to search for (prefix `#` / `symbol:` removed). */
  query: string;
}

export function findMentionTrigger(text: string, caret: number): MentionTrigger | undefined {
  const before = text.slice(0, caret);
  const match = /(^|\s)@([\w./\-#:]*)$/.exec(before);
  if (!match) return undefined;
  const raw = match[2] ?? "";
  const start = before.length - raw.length - 1;
  if (raw.startsWith("#")) return { start, kind: "symbol", query: raw.slice(1) };
  if (raw.startsWith("symbol:")) return { start, kind: "symbol", query: raw.slice("symbol:".length) };
  return { start, kind: "file", query: raw };
}
