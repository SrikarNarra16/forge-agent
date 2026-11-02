/**
 * Pure logic for "Forge: Edit Selection": capturing what the user selected (path, 1-based lines, text and
 * about 40 lines of context), building the user message sent to the `forge-inline` agent, and the
 * instruction history. vscode-free so it is unit-tested. The message is model-agnostic on purpose: plain
 * numbered code and a plain instruction, no model-specific tricks.
 */

export interface Position {
  /** 0-based. */
  line: number;
  character: number;
}

export interface SelectionInput {
  /** The live buffer text, unsaved edits included. */
  text: string;
  start: Position;
  end: Position;
  /** Workspace-relative path. */
  path: string;
  languageId: string;
}

export interface SelectionSnapshot {
  path: string;
  languageId: string;
  /** 1-based, inclusive. */
  startLine: number;
  endLine: number;
  totalLines: number;
  /** Whole lines covered by the selection, without line terminators. */
  selected: string[];
  /** Up to CONTEXT_LINES lines just before the selection, and where they start (1-based). */
  before: { startLine: number; lines: string[] };
  after: { startLine: number; lines: string[] };
}

export type SnapshotResult = { ok: true; snapshot: SelectionSnapshot } | { ok: false; reason: "empty" };

/** Lines of context before and after the selection (about 40 in total). */
export const CONTEXT_LINES = 20;
/** A very large selection is shown truncated; the agent can read_file the rest. */
export const MAX_SELECTED_LINES = 400;

/** Splits like an editor does: CRLF, LF and lone CR all end a line; a trailing newline does not add a line. */
export function splitDocumentLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

export function snapshotSelection(input: SelectionInput): SnapshotResult {
  const lines = splitDocumentLines(input.text);
  const total = lines.length;
  const { start, end } = input;
  const empty = start.line === end.line && start.character === end.character;
  if (empty || total === 0) return { ok: false, reason: "empty" };

  const startIdx = Math.min(Math.max(start.line, 0), total - 1);
  let endIdx = Math.min(Math.max(end.line, 0), total - 1);
  // A selection that ends at column 0 of a later line (e.g. full-line selection) does not include that line.
  if (end.character === 0 && end.line > start.line) endIdx = Math.min(Math.max(end.line - 1, startIdx), total - 1);

  const beforeStart = Math.max(0, startIdx - CONTEXT_LINES);
  const afterEnd = Math.min(total - 1, endIdx + CONTEXT_LINES);
  return {
    ok: true,
    snapshot: {
      path: input.path,
      languageId: input.languageId,
      startLine: startIdx + 1,
      endLine: endIdx + 1,
      totalLines: total,
      selected: lines.slice(startIdx, endIdx + 1),
      before: { startLine: beforeStart + 1, lines: lines.slice(beforeStart, startIdx) },
      after: { startLine: endIdx + 2, lines: lines.slice(endIdx + 1, afterEnd + 1) },
    },
  };
}

function numbered(startLine: number, lines: readonly string[], width: number): string {
  return lines.map((line, i) => `${String(startLine + i).padStart(width)}| ${line}`).join("\n");
}

/** The message sent to the agent: file, the exact selected lines with numbers, surrounding context, instruction. */
export function buildInlineMessage(snapshot: SelectionSnapshot, instruction: string): string {
  const shown = snapshot.selected.slice(0, MAX_SELECTED_LINES);
  const lastShown = snapshot.startLine + shown.length - 1;
  const width = String(Math.max(snapshot.after.startLine + snapshot.after.lines.length, lastShown, snapshot.endLine)).length;
  const parts: string[] = [];
  parts.push(`Edit the file ${snapshot.path} (${snapshot.languageId}) in the user's editor.`);
  parts.push(`Selected code (lines ${snapshot.startLine}-${snapshot.endLine}), exactly as it is now:\n${numbered(snapshot.startLine, shown, width)}`);
  if (shown.length < snapshot.selected.length) {
    parts.push(`[The selection has ${snapshot.selected.length} lines; only the first ${shown.length} are shown. Use read_file for the rest.]`);
  }
  if (snapshot.before.lines.length > 0) {
    parts.push(`Lines before the selection (lines ${snapshot.before.startLine}-${snapshot.startLine - 1}):\n${numbered(snapshot.before.startLine, snapshot.before.lines, width)}`);
  }
  if (snapshot.after.lines.length > 0) {
    parts.push(`Lines after the selection (lines ${snapshot.after.startLine}-${snapshot.after.startLine + snapshot.after.lines.length - 1}):\n${numbered(snapshot.after.startLine, snapshot.after.lines, width)}`);
  }
  parts.push(`Instruction: ${instruction.trim()}`);
  return parts.join("\n\n");
}

/** What the transcript shows as the user's message for an inline edit. */
export function inlineDisplayText(snapshot: SelectionSnapshot, instruction: string): string {
  const range = snapshot.startLine === snapshot.endLine ? `${snapshot.startLine}` : `${snapshot.startLine}-${snapshot.endLine}`;
  return `Edit ${snapshot.path}:${range}: ${instruction.trim()}`;
}

export const MAX_HISTORY = 20;

/** Instruction history: most recent first, no duplicates, no blanks, at most `max` entries. */
export function pushHistory(history: readonly string[], instruction: string, max = MAX_HISTORY): string[] {
  const text = instruction.trim();
  if (text === "") return [...history].slice(0, max);
  return [text, ...history.filter((h) => h !== text)].slice(0, max);
}
