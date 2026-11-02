import { diffArrays } from "diff";

/**
 * Pure (vscode-free) diff/hunk logic for the review UI.
 *
 * Text is handled as an array of lines that KEEP their terminators ("a\n", "b\r\n", and a last line with
 * no newline at all). That makes CRLF, mixed line endings and a missing trailing newline round-trip exactly
 * with no EOL special-casing: joining the lines gives the text back.
 *
 * A hunk is one decision unit: a minimal block of changed lines, merged with its neighbour when only one
 * unchanged line separates them. Starts are 0-based line indexes.
 */

export interface HunkLine {
  /** " " unchanged context inside a merged hunk, "-" only in the original, "+" only in the proposal. */
  type: " " | "-" | "+";
  /** The line including its terminator. */
  text: string;
}

export interface Hunk {
  id: number;
  origStart: number;
  origLines: number;
  newStart: number;
  newLines: number;
  lines: HunkLine[];
}

export type Decision = "accepted" | "rejected" | "pending";

/** Decisions by hunk index, or a function of the hunk. */
export type Decisions = readonly Decision[] | ((hunk: Hunk) => Decision);

export const MAX_REVIEW_LINES = 20_000;
export const MAX_REVIEW_CHARS = 2_000_000;
/** Changed blocks separated by at most this many unchanged lines are one hunk. */
export const MERGE_GAP_LINES = 1;

export class ReviewTooLargeError extends Error {
  constructor() {
    super(`The file is too large to review safely (limit ${MAX_REVIEW_LINES} lines / ${MAX_REVIEW_CHARS} characters). Propose a smaller change or edit a smaller file.`);
    this.name = "ReviewTooLargeError";
  }
}

/** Splits text into lines that keep their terminator. `splitLines("a\nb")` is `["a\n", "b"]`; `""` gives `[]`. */
export function splitLines(text: string): string[] {
  return text.match(/[^\n]*\n|[^\n]+$/g) ?? [];
}

function decisionOf(decisions: Decisions, hunk: Hunk): Decision {
  return typeof decisions === "function" ? decisions(hunk) : (decisions[hunk.id] ?? "pending");
}

interface Block {
  aStart: number;
  aEnd: number;
  bStart: number;
  bEnd: number;
  lines: HunkLine[];
}

/** Computes the hunks that turn `original` into `proposed`. Throws ReviewTooLargeError for huge inputs. */
export function computeHunks(original: string, proposed: string): Hunk[] {
  if (original.length > MAX_REVIEW_CHARS || proposed.length > MAX_REVIEW_CHARS) throw new ReviewTooLargeError();
  const a = splitLines(original);
  const b = splitLines(proposed);
  if (a.length > MAX_REVIEW_LINES || b.length > MAX_REVIEW_LINES) throw new ReviewTooLargeError();
  if (original === proposed) return [];

  // 1. changed blocks from the diff
  const blocks: Block[] = [];
  let ai = 0;
  let bi = 0;
  let cur: Block | undefined;
  for (const part of diffArrays(a, b)) {
    const count = part.value.length;
    if (!part.added && !part.removed) {
      if (cur) blocks.push(cur);
      cur = undefined;
      ai += count;
      bi += count;
      continue;
    }
    cur ??= { aStart: ai, aEnd: ai, bStart: bi, bEnd: bi, lines: [] };
    for (const text of part.value) cur.lines.push({ type: part.added ? "+" : "-", text });
    if (part.added) {
      bi += count;
      cur.bEnd = bi;
    } else {
      ai += count;
      cur.aEnd = ai;
    }
  }
  if (cur) blocks.push(cur);

  // 2. merge blocks separated by at most MERGE_GAP_LINES unchanged lines
  const merged: Block[] = [];
  for (const block of blocks) {
    const last = merged[merged.length - 1];
    if (last && block.aStart - last.aEnd <= MERGE_GAP_LINES) {
      for (const text of a.slice(last.aEnd, block.aStart)) last.lines.push({ type: " ", text });
      last.lines.push(...block.lines);
      last.aEnd = block.aEnd;
      last.bEnd = block.bEnd;
    } else {
      merged.push({ ...block, lines: [...block.lines] });
    }
  }

  const hunks = merged.map(
    (m, id): Hunk => ({ id, origStart: m.aStart, origLines: m.aEnd - m.aStart, newStart: m.bStart, newLines: m.bEnd - m.bStart, lines: m.lines }),
  );
  // Self-check: accepting everything must reproduce the proposal exactly.
  if (composeText(original, hunks, () => "accepted") !== proposed) throw new Error("internal error: hunks do not reproduce the proposed text");
  return hunks;
}

/** The original with only the ACCEPTED hunks applied. Rejected and pending hunks keep the original lines. */
export function composeText(original: string, hunks: readonly Hunk[], decisions: Decisions): string {
  const a = splitLines(original);
  const out: string[] = [];
  let idx = 0;
  for (const hunk of hunks) {
    out.push(...a.slice(idx, hunk.origStart));
    if (decisionOf(decisions, hunk) === "accepted") {
      for (const line of hunk.lines) if (line.type !== "-") out.push(line.text);
    } else {
      out.push(...a.slice(hunk.origStart, hunk.origStart + hunk.origLines));
    }
    idx = hunk.origStart + hunk.origLines;
  }
  out.push(...a.slice(idx));
  return out.join("");
}

export interface LineRange {
  /** 0-based first line. */
  start: number;
  /** 0-based exclusive end; equal to `start` when the hunk contributes no lines (a pure deletion). */
  end: number;
}

export interface Layout {
  /** What the proposal side of the diff shows: everything except REJECTED hunks (pending ones show as proposed). */
  text: string;
  /** Where each hunk sits in `text`. */
  ranges: LineRange[];
}

export function layoutText(original: string, hunks: readonly Hunk[], decisions: Decisions): Layout {
  const a = splitLines(original);
  const out: string[] = [];
  const ranges: LineRange[] = [];
  let idx = 0;
  for (const hunk of hunks) {
    out.push(...a.slice(idx, hunk.origStart));
    const start = out.length;
    if (decisionOf(decisions, hunk) === "rejected") {
      out.push(...a.slice(hunk.origStart, hunk.origStart + hunk.origLines));
    } else {
      for (const line of hunk.lines) if (line.type !== "-") out.push(line.text);
    }
    ranges.push({ start, end: out.length });
    idx = hunk.origStart + hunk.origLines;
  }
  out.push(...a.slice(idx));
  return { text: out.join(""), ranges };
}

export interface HunkStats {
  added: number;
  removed: number;
}

export function hunkStats(hunk: Hunk): HunkStats {
  let added = 0;
  let removed = 0;
  for (const line of hunk.lines) {
    if (line.type === "+") added++;
    else if (line.type === "-") removed++;
  }
  return { added, removed };
}

export function totalStats(hunks: readonly Hunk[], decisions: Decisions, which: Decision = "accepted"): HunkStats {
  const total = { added: 0, removed: 0 };
  for (const hunk of hunks) {
    if (decisionOf(decisions, hunk) !== which) continue;
    const s = hunkStats(hunk);
    total.added += s.added;
    total.removed += s.removed;
  }
  return total;
}

function clip(text: string, max: number): string {
  const flat = text.replace(/[\r\n]+$/, "").trim();
  return flat.length > max ? `${flat.slice(0, max - 1)}…` : flat;
}

/** Short description of a hunk for the agent and the UI: `hunk 2 (line 40): + return val.lower() not in …`. */
export function hunkSummary(hunk: Hunk): string {
  const first = hunk.lines.find((l) => l.type === "+") ?? hunk.lines.find((l) => l.type === "-");
  const preview = first ? ` ${first.type} ${clip(first.text, 60)}` : "";
  return `hunk ${hunk.id + 1} (line ${hunk.origStart + 1}):${preview}`;
}

// --- edits (propose_edit) ---------------------------------------------------------------------------

export interface TextEdit {
  old_text: string;
  new_text: string;
}

export type ApplyEditsResult = { ok: true; text: string } | { ok: false; error: string };

function toEol(text: string, eol: string): string {
  return text.replace(/\r\n|\n/g, eol);
}

function countOccurrences(haystack: string, needle: string): { count: number; first: number } {
  let count = 0;
  let first = -1;
  let from = 0;
  for (;;) {
    const at = haystack.indexOf(needle, from);
    if (at === -1) break;
    if (first === -1) first = at;
    count++;
    from = at + 1; // overlapping matches count too: an ambiguous anchor must be rejected
  }
  return { count, first };
}

/**
 * Applies search/replace edits in order. Every `old_text` must match EXACTLY ONCE in the text as it is
 * after the earlier edits. Newlines in the edits are converted to the file's line ending, so a CRLF file
 * can be edited with LF snippets. Errors are written to teach the model how to fix its next call.
 */
export function applyEdits(text: string, edits: readonly TextEdit[], fileLabel: string): ApplyEditsResult {
  const eol = text.includes("\r\n") ? "\r\n" : "\n";
  let current = text;
  for (const [i, edit] of edits.entries()) {
    const prefix = edits.length > 1 ? `Edit ${i + 1} of ${edits.length}: ` : "";
    const oldText = toEol(edit.old_text, eol);
    const newText = toEol(edit.new_text, eol);
    if (oldText === "") {
      return { ok: false, error: `${prefix}old_text is empty. Give the exact existing text to replace (a few lines including unique context). To create a new file use create_file.` };
    }
    if (oldText === newText) return { ok: false, error: `${prefix}old_text and new_text are identical, so this edit changes nothing. Provide the corrected new_text.` };
    const { count, first } = countOccurrences(current, oldText);
    if (count !== 1) {
      return {
        ok: false,
        error: `${prefix}old_text matched ${count} ${count === 1 ? "time" : "times"} in ${fileLabel}. Re-read the file and include more surrounding context so old_text matches exactly once.`,
      };
    }
    current = current.slice(0, first) + newText + current.slice(first + oldText.length);
  }
  if (current === text) return { ok: false, error: `These edits leave ${fileLabel} unchanged. Re-read the file and propose a real change.` };
  return { ok: true, text: current };
}

// --- ranged edits (how accepted hunks are written) -----------------------------------------------------

/** Replace original lines [startLine, endLine) with `text`. Coordinates refer to the ORIGINAL text. */
export interface RangedEdit {
  startLine: number;
  endLine: number;
  text: string;
}

/** One edit per accepted hunk, all in original coordinates, so they can go into a single WorkspaceEdit. */
export function hunkEdits(hunks: readonly Hunk[], acceptedIds: readonly number[]): RangedEdit[] {
  const accepted = new Set(acceptedIds);
  return hunks
    .filter((h) => accepted.has(h.id))
    .map((h) => ({
      startLine: h.origStart,
      endLine: h.origStart + h.origLines,
      text: h.lines
        .filter((l) => l.type !== "-")
        .map((l) => l.text)
        .join(""),
    }));
}

/** Applies ranged edits to text (last to first, so earlier coordinates stay valid). Used by tests and fakes. */
export function applyRangedEdits(original: string, edits: readonly RangedEdit[]): string {
  const lines = splitLines(original);
  for (const edit of [...edits].sort((a, b) => b.startLine - a.startLine)) {
    lines.splice(edit.startLine, edit.endLine - edit.startLine, ...splitLines(edit.text));
  }
  return lines.join("");
}
