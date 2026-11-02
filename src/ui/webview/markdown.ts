/**
 * Minimal, safe markdown for streamed model output: fenced code blocks (unterminated ones too, while
 * streaming), inline code, **bold**, bullet and numbered lists, paragraphs. The result is a plain AST of
 * strings; the renderer builds DOM with textContent only, so nothing the model writes can become markup.
 * Links, images and HTML are intentionally not interpreted.
 */
export type Inline = { t: "text"; text: string } | { t: "code"; text: string } | { t: "bold"; children: Inline[] };

export type Block =
  | { t: "p"; inline: Inline[] }
  | { t: "code"; lang: string; text: string; closed: boolean }
  | { t: "ul"; items: Inline[][] }
  | { t: "ol"; items: Inline[][] };

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let text = "";
  const flushText = (): void => {
    if (text) out.push({ t: "text", text });
    text = "";
  };
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (ch === "`") {
      const end = src.indexOf("`", i + 1);
      if (end > i + 1) {
        flushText();
        out.push({ t: "code", text: src.slice(i + 1, end) });
        i = end + 1;
        continue;
      }
    } else if (ch === "*" && src[i + 1] === "*") {
      const end = src.indexOf("**", i + 2);
      if (end > i + 2) {
        flushText();
        out.push({ t: "bold", children: parseInline(src.slice(i + 2, end)) });
        i = end + 2;
        continue;
      }
    }
    text += ch;
    i++;
  }
  flushText();
  return out;
}

const FENCE_OPEN = /^\s*```\s*([\w+#.-]*)\s*$/;
const FENCE_CLOSE = /^\s*```\s*$/;
const BULLET = /^\s*[-*+]\s+(.*)$/;
const NUMBERED = /^\s*\d+[.)]\s+(.*)$/;
const HEADING = /^\s{0,3}#{1,6}\s+(.*)$/;

export function parseMarkdown(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r\n?/g, "\n").split("\n");
  let paragraph: string[] = [];
  const flushParagraph = (): void => {
    if (paragraph.length > 0) blocks.push({ t: "p", inline: parseInline(paragraph.join("\n")) });
    paragraph = [];
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? "";
    const open = FENCE_OPEN.exec(line);
    if (open) {
      flushParagraph();
      const code: string[] = [];
      let closed = false;
      for (i++; i < lines.length; i++) {
        if (FENCE_CLOSE.test(lines[i] ?? "")) {
          closed = true;
          break;
        }
        code.push(lines[i] ?? "");
      }
      blocks.push({ t: "code", lang: open[1] ?? "", text: code.join("\n"), closed });
      continue;
    }
    const bullet = BULLET.exec(line);
    const numbered = bullet ? null : NUMBERED.exec(line);
    if (bullet || numbered) {
      flushParagraph();
      const kind = bullet ? "ul" : "ol";
      const last = blocks[blocks.length - 1];
      const items = last && last.t === kind ? last.items : [];
      if (!last || last.t !== kind) blocks.push({ t: kind, items });
      items.push(parseInline(((bullet ?? numbered) as RegExpExecArray)[1] ?? ""));
      continue;
    }
    if (line.trim() === "") {
      flushParagraph();
      continue;
    }
    const heading = HEADING.exec(line);
    if (heading) {
      flushParagraph();
      blocks.push({ t: "p", inline: [{ t: "bold", children: parseInline(heading[1] ?? "") }] });
      continue;
    }
    paragraph.push(line);
  }
  flushParagraph();
  return blocks;
}
