import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseInline, parseMarkdown } from "../src/ui/webview/markdown";

describe("parseInline", () => {
  it("handles inline code and bold", () => {
    expect(parseInline("use `read_file` and **be careful**")).toEqual([
      { t: "text", text: "use " },
      { t: "code", text: "read_file" },
      { t: "text", text: " and " },
      { t: "bold", children: [{ t: "text", text: "be careful" }] },
    ]);
  });
  it("leaves unmatched markers literal", () => {
    expect(parseInline("a ` b ** c")).toEqual([{ t: "text", text: "a ` b ** c" }]);
    expect(parseInline("``")).toEqual([{ t: "text", text: "``" }]);
  });
  it("does not interpret markup inside code spans", () => {
    expect(parseInline("`**x**`")).toEqual([{ t: "code", text: "**x**" }]);
  });
});

describe("parseMarkdown", () => {
  it("parses paragraphs, lists and fenced code", () => {
    const blocks = parseMarkdown("Intro line\nsecond line\n\n- one\n- **two**\n\n1. first\n2) second\n\n```python\nprint('x')\n```\ndone");
    expect(blocks.map((b) => b.t)).toEqual(["p", "ul", "ol", "code", "p"]);
    expect(blocks[0]).toEqual({ t: "p", inline: [{ t: "text", text: "Intro line\nsecond line" }] });
    expect(blocks[1]).toMatchObject({ t: "ul" });
    expect((blocks[1] as { items: unknown[] }).items).toHaveLength(2);
    expect(blocks[3]).toEqual({ t: "code", lang: "python", text: "print('x')", closed: true });
  });

  it("renders an unterminated fence as code while streaming", () => {
    expect(parseMarkdown("```ts\nconst a = 1;\nconst b")).toEqual([{ t: "code", lang: "ts", text: "const a = 1;\nconst b", closed: false }]);
  });

  it("does not parse markdown inside fences", () => {
    const [block] = parseMarkdown("```\n- not a list\n**not bold**\n```");
    expect(block).toMatchObject({ t: "code", text: "- not a list\n**not bold**" });
  });

  it("turns headings into bold paragraphs", () => {
    expect(parseMarkdown("## Title")).toEqual([{ t: "p", inline: [{ t: "bold", children: [{ t: "text", text: "Title" }] }] }]);
  });

  it("keeps HTML-looking text as plain text (the sanitiser guarantee)", () => {
    const hostile = '<img src=x onerror="alert(1)"> <script>alert(2)</script> [click](javascript:alert(3)) ![x](http://evil)';
    const [block] = parseMarkdown(hostile);
    expect(block).toEqual({ t: "p", inline: [{ t: "text", text: hostile }] });
    const [code] = parseMarkdown("```html\n<script>alert(1)</script>\n```");
    expect(code).toMatchObject({ t: "code", text: "<script>alert(1)</script>" });
  });

  it("handles empty input and CRLF", () => {
    expect(parseMarkdown("")).toEqual([]);
    expect(parseMarkdown("a\r\n\r\nb")).toHaveLength(2);
  });
});

describe("webview sources never write raw HTML", () => {
  it("no innerHTML, outerHTML, insertAdjacentHTML, document.write or eval in src/ui/webview", async () => {
    const dir = join(__dirname, "..", "src", "ui", "webview");
    const files = (await readdir(dir)).filter((f) => f.endsWith(".ts"));
    expect(files.length).toBeGreaterThan(2);
    for (const file of files) {
      const text = (await readFile(join(dir, file), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      expect(text, file).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|document\.write|\beval\s*\(|new Function\s*\(/);
    }
  });
});
