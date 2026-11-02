import type { ChunkDraft, ChunkKind } from "./types";

/**
 * Splits a file into retrievable chunks (vscode-free, pure):
 *   Python  = def / class / method blocks found by indentation, with decorators and leading comments; a class
 *             is a header chunk plus one chunk per method (`Class.method`), so a 1000-line class is not one chunk
 *   TS / JS = function / class / method / interface / type blocks found by regex
 *   .rst / .md = sections split at headings, so docs are retrievable by topic
 *   anything else = 60-line windows with 10 lines of overlap
 * Big blocks are windowed too, and uncovered module-level code gets windows, so every non-blank line is in
 * at least one chunk.
 */
export const WINDOW_LINES = 60;
export const WINDOW_OVERLAP = 10;
/** A block longer than this is cut into windows. */
export const MAX_BLOCK_LINES = 120;

/** Splits like an editor does (CRLF/LF/CR; a trailing newline adds no line). */
export function splitPlainLines(text: string): string[] {
  if (text === "") return [];
  const lines = text.split(/\r\n|\r|\n/);
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  return lines;
}

const blank = (line: string | undefined): boolean => (line ?? "").trim() === "";

function indentOf(line: string): number {
  let n = 0;
  for (const ch of line) {
    if (ch === " ") n++;
    else if (ch === "\t") n += 4;
    else break;
  }
  return n;
}

class Emitter {
  readonly drafts: ChunkDraft[] = [];
  readonly covered: boolean[];
  constructor(
    private readonly path: string,
    private readonly lines: readonly string[],
  ) {
    this.covered = lines.map(() => false);
  }

  /** Emits lines [from, to] (0-based, inclusive), trimmed of blank edges, windowed when too long. */
  range(from: number, to: number, kind: ChunkKind, symbol?: string, signature?: string, maxBlock = MAX_BLOCK_LINES): void {
    let start = from;
    let end = Math.min(to, this.lines.length - 1);
    while (start <= end && blank(this.lines[start])) start++;
    while (end >= start && blank(this.lines[end])) end--;
    if (start > end) return;
    if (end - start + 1 <= maxBlock) {
      this.push(start, end, kind, symbol, signature);
      return;
    }
    for (let s = start; s <= end; s += WINDOW_LINES - WINDOW_OVERLAP) {
      const e = Math.min(end, s + WINDOW_LINES - 1);
      this.push(s, e, kind, symbol, signature);
      if (e === end) break;
    }
  }

  private push(start: number, end: number, kind: ChunkKind, symbol?: string, signature?: string): void {
    for (let i = start; i <= end; i++) this.covered[i] = true;
    this.drafts.push({
      path: this.path,
      startLine: start + 1,
      endLine: end + 1,
      kind,
      ...(symbol ? { symbol } : {}),
      ...(signature ? { signature } : {}),
      text: this.lines.slice(start, end + 1).join("\n"),
    });
  }

  /** Windows every contiguous uncovered run that contains something other than blank lines. */
  coverRest(kind: ChunkKind): void {
    let i = 0;
    while (i < this.lines.length) {
      if (this.covered[i]) {
        i++;
        continue;
      }
      let j = i;
      while (j + 1 < this.lines.length && !this.covered[j + 1]) j++;
      this.range(i, j, kind, undefined, undefined, WINDOW_LINES);
      i = j + 1;
    }
  }
}

// --- Python -------------------------------------------------------------------------------------------------

const PY_DEF = /^(\s*)(async\s+def|def|class)\s+([A-Za-z_]\w*)/;

interface PyDef {
  line: number;
  start: number;
  end: number;
  indent: number;
  name: string;
  isClass: boolean;
  signature: string;
}

function parenDelta(line: string): number {
  let depth = 0;
  for (const ch of line.replace(/#.*$/, "")) {
    if (ch === "(" || ch === "[" || ch === "{") depth++;
    else if (ch === ")" || ch === "]" || ch === "}") depth--;
  }
  return depth;
}

function findPythonDefs(lines: readonly string[]): PyDef[] {
  const defs: PyDef[] = [];
  for (let i = 0; i < lines.length; i++) {
    const m = PY_DEF.exec(lines[i] ?? "");
    if (!m || !m[2] || !m[3]) continue;
    const indent = indentOf(lines[i] ?? "");

    // the logical signature line(s)
    let sigEnd = i;
    let depth = parenDelta(lines[i] ?? "");
    while ((depth > 0 || !(lines[sigEnd] ?? "").replace(/#.*$/, "").trimEnd().endsWith(":")) && sigEnd + 1 < lines.length && sigEnd - i < 14) {
      sigEnd++;
      depth += parenDelta(lines[sigEnd] ?? "");
    }
    const signature = lines.slice(i, sigEnd + 1).map((l) => l.trim()).join(" ").replace(/\s+/g, " ").slice(0, 240);

    // the end of the body: the last line before the next non-blank line indented at most as much as the def
    let end = sigEnd;
    for (let j = sigEnd + 1; j < lines.length; j++) {
      const l = lines[j] ?? "";
      if (blank(l)) continue;
      if (indentOf(l) <= indent) break;
      end = j;
    }

    // decorators (even multi-line ones) and the comment block right above
    let start = i;
    for (let k = i - 1; k >= 0 && !blank(lines[k]); k--) {
      const t = (lines[k] ?? "").trim();
      const ind = indentOf(lines[k] ?? "");
      if (ind < indent) break;
      if (ind === indent && !(t.startsWith("@") || t.startsWith("#") || t.startsWith(")") || t.startsWith("]") || t.startsWith("}"))) break;
      start = k;
    }
    defs.push({ line: i, start, end, indent, name: m[3], isClass: m[2] === "class", signature });
  }
  return defs;
}

export function chunkPython(path: string, text: string): ChunkDraft[] {
  const lines = splitPlainLines(text);
  const out = new Emitter(path, lines);
  const defs = findPythonDefs(lines);

  const childrenOf = (parent: PyDef): PyDef[] => {
    const inside = defs.filter((d) => d.line > parent.line && d.line <= parent.end && d.indent > parent.indent);
    const minIndent = Math.min(...inside.map((d) => d.indent));
    return inside.filter((d) => d.indent === minIndent);
  };

  const emitDef = (def: PyDef, prefix: string, inClass: boolean): void => {
    const symbol = prefix ? `${prefix}.${def.name}` : def.name;
    if (!def.isClass) {
      out.range(def.start, def.end, inClass ? "method" : "function", symbol, def.signature);
      return;
    }
    const kids = childrenOf(def);
    const first = kids[0];
    if (!first) {
      out.range(def.start, def.end, "class", symbol, def.signature);
      return;
    }
    out.range(def.start, first.start - 1, "class", symbol, def.signature);
    for (const kid of kids) emitDef(kid, symbol, true);
  };

  for (const def of defs) {
    const nested = defs.some((d) => d !== def && def.line > d.line && def.line <= d.end && d.indent < def.indent);
    if (!nested) emitDef(def, "", false);
  }
  out.coverRest("module");
  return out.drafts.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

// --- TypeScript / JavaScript --------------------------------------------------------------------------------------

const TS_TOP: ReadonlyArray<[RegExp, ChunkKind]> = [
  [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, "function"],
  [/^(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, "class"],
  [/^(?:export\s+)?(?:declare\s+)?interface\s+([A-Za-z_$][\w$]*)/, "interface"],
  [/^(?:export\s+)?(?:declare\s+)?type\s+([A-Za-z_$][\w$]*)/, "type"],
  [/^(?:export\s+)?(?:declare\s+)?(?:const\s+)?enum\s+([A-Za-z_$][\w$]*)/, "enum"],
  [/^(?:export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*(?::[^=]+)?=\s*(?:async\s+)?(?:function\b|\([^)]*\)\s*(?::[^=]+)?=>|[A-Za-z_$][\w$]*\s*=>)/, "function"],
];
const TS_METHOD = /^\s+(?:(?:public|private|protected|static|readonly|async|override|abstract|get|set)\s+)*([A-Za-z_$][\w$]*)\s*(?:<[^>]*>)?\s*\([^)]*\)\s*(?::[^{]+)?\{\s*$/;

export function chunkScript(path: string, text: string): ChunkDraft[] {
  const lines = splitPlainLines(text);
  const out = new Emitter(path, lines);

  interface Top {
    line: number;
    name: string;
    kind: ChunkKind;
  }
  const tops: Top[] = [];
  for (let i = 0; i < lines.length; i++) {
    const l = lines[i] ?? "";
    if (indentOf(l) !== 0) continue;
    for (const [re, kind] of TS_TOP) {
      const m = re.exec(l);
      if (m?.[1]) {
        tops.push({ line: i, name: m[1], kind });
        break;
      }
    }
  }

  tops.forEach((top, n) => {
    // the block runs to the line before the next top-level declaration, minus trailing blanks/comments that belong to it
    const nextLine = tops[n + 1]?.line ?? lines.length;
    let end = nextLine - 1;
    while (end > top.line && (blank(lines[end]) || (lines[end] ?? "").trim().startsWith("//") || (lines[end] ?? "").trim().startsWith("/*") || (lines[end] ?? "").trim().startsWith("*"))) end--;
    // leading doc comment / decorators directly above
    let start = top.line;
    for (let k = top.line - 1; k >= 0 && !blank(lines[k]); k--) {
      const t = (lines[k] ?? "").trim();
      if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("@")) start = k;
      else break;
    }
    const signature = (lines[top.line] ?? "").trim().slice(0, 240);
    if (top.kind !== "class") {
      out.range(start, end, top.kind, top.name, signature);
      return;
    }
    const methods: Array<{ line: number; name: string }> = [];
    for (let i = top.line + 1; i <= end; i++) {
      const m = TS_METHOD.exec(lines[i] ?? "");
      if (m?.[1] && !["if", "for", "while", "switch", "catch", "function"].includes(m[1])) methods.push({ line: i, name: m[1] });
    }
    const first = methods[0];
    if (!first) {
      out.range(start, end, "class", top.name, signature);
      return;
    }
    out.range(start, first.line - 1, "class", top.name, signature);
    methods.forEach((method, k) => {
      let mStart = method.line;
      for (let j = method.line - 1; j > top.line && !blank(lines[j]); j--) {
        const t = (lines[j] ?? "").trim();
        if (t.startsWith("//") || t.startsWith("/*") || t.startsWith("*") || t.startsWith("@")) mStart = j;
        else break;
      }
      const mEnd = (methods[k + 1]?.line ?? end + 1) - 1;
      out.range(mStart, Math.min(mEnd, end), "method", `${top.name}.${method.name}`, (lines[method.line] ?? "").trim().slice(0, 240));
    });
  });
  out.coverRest("module");
  return out.drafts.sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);
}

// --- reStructuredText / Markdown ---------------------------------------------------------------------------------------

const RST_UNDERLINE = /^([=\-`:'"~^_*+#<>])\1{2,}\s*$/;

interface Heading {
  line: number;
  title: string;
}

function rstHeadings(lines: readonly string[]): Heading[] {
  const found: Heading[] = [];
  for (let i = 0; i + 1 < lines.length; i++) {
    const title = lines[i] ?? "";
    const under = lines[i + 1] ?? "";
    if (blank(title) || /^\s/.test(title) || RST_UNDERLINE.test(title) || title.startsWith("..") || !RST_UNDERLINE.test(under)) continue;
    if (under.trimEnd().length < title.trimEnd().length) continue; // a real heading underline is at least as long as its title
    // an optional overline: the heading starts one line earlier, which only matters for where the section begins
    found.push({ line: i, title: title.trim() });
  }
  return found;
}

function markdownHeadings(lines: readonly string[]): Heading[] {
  const found: Heading[] = [];
  let fence = false;
  lines.forEach((l, i) => {
    if (/^\s{0,3}(```|~~~)/.test(l)) fence = !fence;
    const m = !fence ? /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(l) : null;
    if (m?.[1]) found.push({ line: i, title: m[1] });
  });
  return found;
}

function chunkSections(path: string, lines: readonly string[], headings: readonly Heading[], underlined: boolean): ChunkDraft[] {
  const out = new Emitter(path, lines);
  const first = headings[0];
  if (!first) {
    out.range(0, lines.length - 1, "doc", undefined, undefined, MAX_BLOCK_LINES);
    return out.drafts;
  }
  // text before the first heading (rare): a preamble chunk
  const overlineOf = (h: Heading): number => (underlined && h.line > 0 && RST_UNDERLINE.test(lines[h.line - 1] ?? "") ? h.line - 1 : h.line);
  out.range(0, overlineOf(first) - 1, "doc", undefined, undefined, MAX_BLOCK_LINES);
  headings.forEach((h, n) => {
    const next = headings[n + 1];
    const end = (next ? overlineOf(next) : lines.length) - 1;
    out.range(overlineOf(h), end, "doc", h.title, h.title, MAX_BLOCK_LINES);
  });
  return out.drafts;
}

export function chunkRst(path: string, text: string): ChunkDraft[] {
  const lines = splitPlainLines(text);
  return chunkSections(path, lines, rstHeadings(lines), true);
}

export function chunkMarkdown(path: string, text: string): ChunkDraft[] {
  const lines = splitPlainLines(text);
  return chunkSections(path, lines, markdownHeadings(lines), false);
}

/** 60-line windows with 10 lines of overlap, for files with no better structure. */
export function chunkWindows(path: string, text: string): ChunkDraft[] {
  const lines = splitPlainLines(text);
  const out = new Emitter(path, lines);
  out.range(0, lines.length - 1, "window", undefined, undefined, WINDOW_LINES);
  return out.drafts;
}

export function chunkFile(path: string, text: string): ChunkDraft[] {
  const ext = path.split(".").pop()?.toLowerCase() ?? "";
  if (ext === "py") return chunkPython(path, text);
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs"].includes(ext)) return chunkScript(path, text);
  if (ext === "rst") return chunkRst(path, text);
  if (ext === "md") return chunkMarkdown(path, text);
  return chunkWindows(path, text);
}
