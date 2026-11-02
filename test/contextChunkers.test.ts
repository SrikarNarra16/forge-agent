import { describe, expect, it } from "vitest";
import { MAX_BLOCK_LINES, chunkFile, chunkMarkdown, chunkPython, chunkRst, chunkScript, chunkWindows, splitPlainLines } from "../src/context/chunkers";
import type { ChunkDraft } from "../src/context/types";

/** 1-based line number of the first line containing `needle`. */
const lineOf = (text: string, needle: string): number => text.split("\n").findIndex((l) => l.includes(needle)) + 1;
const bySymbol = (chunks: ChunkDraft[], symbol: string): ChunkDraft | undefined => chunks.find((c) => c.symbol === symbol);
const textOfLines = (text: string, start: number, end: number): string => text.split("\n").slice(start - 1, end).join("\n");

const PY = [
  "import os",
  "",
  "",
  "@decorator",
  "def alpha(x):",
  '    """Doc."""',
  "    return x",
  "",
  "",
  "class Foo(Base):",
  '    """Foo docs."""',
  "",
  "    attr = 1",
  "",
  "    def __init__(self):",
  "        self.a = 1",
  "",
  "    @property",
  "    def prop(self):",
  "        return 2",
  "",
  "    @click.command(",
  '        "routes",',
  '        help="x",',
  "    )",
  "    def routes(self):",
  "        pass",
  "",
  "    class Inner:",
  "        def deep(self):",
  "            pass",
  "",
  "",
  "async def beta(",
  "    a,",
  "    b,",
  ") -> int:",
  "    return a + b",
  "",
  "X = 1",
  "",
].join("\n");

describe("chunkPython", () => {
  const chunks = chunkPython("m.py", PY);

  it("makes a chunk per function, class header and method with qualified names", () => {
    expect(chunks.map((c) => `${c.kind}:${c.symbol ?? "-"}`)).toEqual([
      "module:-", // import os
      "function:alpha",
      "class:Foo",
      "method:Foo.__init__",
      "method:Foo.prop",
      "method:Foo.routes",
      "class:Foo.Inner",
      "method:Foo.Inner.deep",
      "function:beta",
      "module:-", // X = 1
    ]);
  });

  it("includes decorators (also multi-line ones) in the definition's chunk", () => {
    expect(bySymbol(chunks, "alpha")?.startLine).toBe(lineOf(PY, "@decorator"));
    expect(bySymbol(chunks, "Foo.prop")?.startLine).toBe(lineOf(PY, "@property"));
    const routes = bySymbol(chunks, "Foo.routes");
    expect(routes?.startLine).toBe(lineOf(PY, "@click.command("));
    expect(routes?.text).toContain('"routes",');
    expect(routes?.endLine).toBe(lineOf(PY, "        pass") );
  });

  it("splits a class into its header (docstring and attributes) and one chunk per method", () => {
    const header = bySymbol(chunks, "Foo");
    expect(header?.startLine).toBe(lineOf(PY, "class Foo"));
    expect(header?.endLine).toBe(lineOf(PY, "attr = 1"));
    expect(header?.text).toContain('"""Foo docs."""');
    expect(header?.text).not.toContain("__init__");
    expect(header?.signature).toBe("class Foo(Base):");
  });

  it("records the signature, including multi-line signatures", () => {
    expect(bySymbol(chunks, "alpha")?.signature).toBe("def alpha(x):");
    expect(bySymbol(chunks, "beta")?.signature).toBe("async def beta( a, b, ) -> int:");
  });

  it("chunk text is exactly the lines startLine..endLine", () => {
    for (const c of chunks) expect(c.text, `${c.symbol}`).toBe(textOfLines(PY, c.startLine, c.endLine));
  });

  it("every non-blank line is in at least one chunk", () => {
    const covered = new Set<number>();
    for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    PY.split("\n").forEach((line, i) => {
      if (line.trim() !== "") expect(covered.has(i + 1), `line ${i + 1}: ${line}`).toBe(true);
    });
  });

  it("nested helpers stay inside their parent's chunk", () => {
    const src = "def outer():\n    def helper():\n        return 1\n    return helper()\n";
    const out = chunkPython("n.py", src);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ symbol: "outer", kind: "function", startLine: 1, endLine: 4 });
  });

  it("windows a very long function but keeps its symbol", () => {
    const body = Array.from({ length: 300 }, (_, i) => `    x${i} = ${i}`).join("\n");
    const out = chunkPython("big.py", `def big():\n${body}\n`);
    expect(out.length).toBeGreaterThan(3);
    expect(out.every((c) => c.symbol === "big" && c.kind === "function")).toBe(true);
    expect(Math.max(...out.map((c) => c.endLine - c.startLine + 1))).toBeLessThanOrEqual(60);
    expect(out[0]?.startLine).toBe(1);
    expect(out.at(-1)?.endLine).toBe(301);
  });

  it("handles a class with no methods, empty files and CRLF", () => {
    expect(chunkPython("c.py", "class A:\n    x = 1\n")).toEqual([expect.objectContaining({ symbol: "A", kind: "class", startLine: 1, endLine: 2 })]);
    expect(chunkPython("e.py", "")).toEqual([]);
    expect(chunkPython("w.py", "def f():\r\n    return 1\r\n").map((c) => c.symbol)).toEqual(["f"]);
  });

  it("indexes defs under `if TYPE_CHECKING:`-style blocks", () => {
    const out = chunkPython("t.py", "if t.TYPE_CHECKING:\n    def helper(x): ...\n\n\ndef real():\n    return 1\n");
    expect(out.map((c) => c.symbol).filter(Boolean)).toEqual(["helper", "real"]);
  });
});

const TS = [
  "import { x } from './x';",
  "",
  "/** Adds numbers. */",
  "export function add(a: number, b: number): number {",
  "  return a + b;",
  "}",
  "",
  "export class Greeter {",
  "  private name: string;",
  "",
  "  constructor(name: string) {",
  "    this.name = name;",
  "  }",
  "",
  "  async greet(): Promise<string> {",
  "    return `hi ${this.name}`;",
  "  }",
  "}",
  "",
  "export interface Options {",
  "  verbose: boolean;",
  "}",
  "",
  "export const double = (n: number) => n * 2;",
  "",
].join("\n");

describe("chunkScript", () => {
  const chunks = chunkScript("a.ts", TS);

  it("finds functions, classes, methods, interfaces and arrow functions", () => {
    expect(chunks.map((c) => `${c.kind}:${c.symbol ?? "-"}`)).toEqual([
      "module:-",
      "function:add",
      "class:Greeter",
      "method:Greeter.constructor",
      "method:Greeter.greet",
      "interface:Options",
      "function:double",
    ]);
  });

  it("includes the doc comment above a declaration", () => {
    expect(bySymbol(chunks, "add")?.startLine).toBe(lineOf(TS, "/** Adds numbers"));
    expect(bySymbol(chunks, "add")?.signature).toBe("export function add(a: number, b: number): number {");
  });

  it("covers every non-blank line", () => {
    const covered = new Set<number>();
    for (const c of chunks) for (let l = c.startLine; l <= c.endLine; l++) covered.add(l);
    TS.split("\n").forEach((line, i) => {
      if (line.trim() !== "") expect(covered.has(i + 1), `line ${i + 1}`).toBe(true);
    });
  });
});

const RST = [
  "Command Line Interface",
  "======================",
  "",
  "Flask installs a script with built-in commands.",
  "",
  "Run the Development Server",
  "--------------------------",
  "",
  "Use ``flask run``.",
  "",
  "Debug Mode",
  "~~~~~~~~~~",
  "",
  "Pass ``--debug``.",
  "",
  "----",
  "",
  "Open a Shell",
  "------------",
  "",
  "Use ``flask shell``.",
  "",
  ".. code-block:: text",
  "",
  "    $ flask --help",
  "    -----------",
  "",
].join("\n");

describe("chunkRst", () => {
  const chunks = chunkRst("docs/cli.rst", RST);

  it("splits at heading underlines and names chunks after their heading", () => {
    expect(chunks.map((c) => [c.kind, c.symbol, c.startLine])).toEqual([
      ["doc", "Command Line Interface", 1],
      ["doc", "Run the Development Server", lineOf(RST, "Run the Development")],
      ["doc", "Debug Mode", lineOf(RST, "Debug Mode")],
      ["doc", "Open a Shell", lineOf(RST, "Open a Shell")],
    ]);
  });

  it("keeps each section's body with its heading and does not treat transitions or indented text as headings", () => {
    expect(bySymbol(chunks, "Command Line Interface")?.text).toContain("built-in commands");
    expect(bySymbol(chunks, "Debug Mode")?.text).toContain("``--debug``");
    expect(bySymbol(chunks, "Debug Mode")?.text).toContain("----"); // the transition stays in the section text
    expect(bySymbol(chunks, "Open a Shell")?.text).toContain("$ flask --help");
    expect(chunks.map((c) => c.symbol)).not.toContain("$ flask --help");
  });

  it("requires the underline to be at least as long as the title", () => {
    expect(chunkRst("x.rst", "Title\n---\n\nbody\n").map((c) => c.symbol)).toEqual([undefined]);
  });

  it("supports overlined headings", () => {
    const out = chunkRst("o.rst", "=====\nTitle\n=====\n\nbody\n\nNext\n----\n\nmore\n");
    expect(out.map((c) => [c.symbol, c.startLine])).toEqual([["Title", 1], ["Next", 7]]);
  });
});

describe("chunkMarkdown", () => {
  it("splits at # headings and ignores # inside code fences", () => {
    const md = ["# Title", "", "intro", "", "## Usage", "", "```bash", "# not a heading", "flask run", "```", "", "## Config", "", "details"].join("\n");
    const out = chunkMarkdown("README.md", md);
    expect(out.map((c) => c.symbol)).toEqual(["Title", "Usage", "Config"]);
    expect(bySymbol(out, "Usage")?.text).toContain("# not a heading");
  });
});

describe("chunkWindows / chunkFile", () => {
  it("makes 60-line windows with 10 lines of overlap", () => {
    const text = Array.from({ length: 150 }, (_, i) => `line ${i + 1}`).join("\n");
    const out = chunkWindows("data.txt", text);
    expect(out.map((c) => [c.startLine, c.endLine])).toEqual([[1, 60], [51, 110], [101, 150]]);
    expect(out.every((c) => c.kind === "window")).toBe(true);
  });

  it("short files are a single chunk; empty files have none", () => {
    expect(chunkWindows("a.toml", "a = 1\nb = 2\n")).toHaveLength(1);
    expect(chunkWindows("a.toml", "")).toEqual([]);
  });

  it("chunkFile picks the chunker by extension", () => {
    expect(chunkFile("a.py", "def f():\n    pass\n")[0]?.kind).toBe("function");
    expect(chunkFile("a.rst", "Title\n=====\n\nx\n")[0]).toMatchObject({ kind: "doc", symbol: "Title" });
    expect(chunkFile("a.md", "# Title\n\nx\n")[0]).toMatchObject({ kind: "doc", symbol: "Title" });
    expect(chunkFile("a.ts", "export function f() {}\n")[0]).toMatchObject({ kind: "function", symbol: "f" });
    expect(chunkFile("a.toml", "k = 1\n")[0]?.kind).toBe("window");
  });

  it("splitPlainLines handles trailing newlines and CRLF", () => {
    expect(splitPlainLines("a\r\nb\r\n")).toEqual(["a", "b"]);
    expect(splitPlainLines("")).toEqual([]);
    expect(MAX_BLOCK_LINES).toBeGreaterThan(60);
  });
});
