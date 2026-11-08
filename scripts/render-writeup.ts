/**
 * Renders docs/writeup/WRITEUP.md to docs/writeup/WRITEUP.pdf and checks it against the competition rules: at most 3
 * pages and exactly the 8 required headings in order. Placeholders written as [[...]] are highlighted in the PDF and
 * listed, so nothing is submitted unfilled by accident.
 *
 *   npm run writeup:pdf                 # prints the page count; exits 1 if it is more than 3 or a heading is wrong
 *
 * Markdown -> HTML with `marked`, HTML -> PDF with headless Chrome through Playwright (no pandoc or LaTeX needed). Uses
 * the installed Google Chrome (`channel: "chrome"`); CHROME_EXE=/path/to/chrome selects another Chromium-based browser.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { marked } from "marked";
import { chromium } from "playwright-core";

const ROOT = join(__dirname, "..");
const SOURCE = join(ROOT, "docs", "writeup", "WRITEUP.md");
const OUTPUT = join(ROOT, "docs", "writeup", "WRITEUP.pdf");
const MAX_PAGES = 3;
export const HEADINGS = ["Team", "Starting point", "Architecture on TrueForge", "How context is selected", "Model setup", "Scorecard with timestamps", "Tools used", "Known limitations"];

const CSS = `
@page { size: A4; margin: 13mm 14mm 13mm 14mm; }
* { box-sizing: border-box; }
body { font: 9.8pt/1.38 -apple-system, "Helvetica Neue", Arial, sans-serif; color: #1a1a1a; margin: 0; }
p { margin: 0 0 4pt; }
p:first-child strong { font-size: 13pt; }
h2 { font-size: 11.5pt; margin: 10pt 0 4pt; padding-bottom: 1.5pt; border-bottom: 0.6pt solid #888; }
ul { margin: 2pt 0 4pt; padding-left: 13pt; } li { margin: 0 0 2pt; }
table { border-collapse: collapse; width: 100%; margin: 3pt 0 5pt; font-size: 8.6pt; line-height: 1.28; }
th, td { border: 0.5pt solid #999; padding: 1.5pt 3pt; text-align: left; vertical-align: top; }
th { background: #eee; }
pre { font: 7.6pt/1.22 "SF Mono", Menlo, Consolas, monospace; background: #f4f4f4; padding: 3pt 4pt; margin: 3pt 0 4pt; white-space: pre; overflow: hidden; }
code { font: 8.6pt "SF Mono", Menlo, Consolas, monospace; background: #f1f1f1; padding: 0 1pt; }
pre code { background: none; padding: 0; font-size: inherit; }
mark { background: #ffe066; padding: 0 1pt; }
a { color: #0b57d0; text-decoration: none; }
`;

async function main(): Promise<number> {
  const md = await readFile(SOURCE, "utf8");
  const found = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);
  const headingsOk = found.length === HEADINGS.length && found.every((h, i) => h === HEADINGS[i]);
  console.log(`Headings (${found.length}): ${headingsOk ? "OK, the 8 required headings in order" : `WRONG. Found: ${found.join(" | ")}`}`);

  const placeholders = [...new Set([...md.matchAll(/\[\[[^\]]+\]\]/g)].map((m) => m[0]))];
  const html = (await marked.parse(md)).replace(/\[\[([^\]]+)\]\]/g, "<mark>[[$1]]</mark>");
  const page = `<!doctype html><html><head><meta charset="utf-8"><title>Forge write-up</title><style>${CSS}</style></head><body>${html}</body></html>`;

  const exe = process.env["CHROME_EXE"];
  const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: "chrome" }).catch((err: unknown) => {
    throw new Error(`could not start Chrome (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). Install Google Chrome or set CHROME_EXE=/path/to/a/Chromium-based/browser.`);
  });
  try {
    const tab = await browser.newPage({ viewport: { width: 688, height: 1024 } }); // A4 content box (182 x 271 mm) in CSS px
    await tab.setContent(page, { waitUntil: "load" });
    await tab.emulateMedia({ media: "print" });
    const contentHeight = (await tab.evaluate("document.body.scrollHeight")) as number; // evaluated in the page (no DOM typings in this project)
    console.log(`Content length: ${(contentHeight / 1024).toFixed(2)} pages of text height (a rough measure of the headroom left)`);
    const clipped = (await tab.evaluate(
      `[...document.querySelectorAll("pre, table, td, code")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.tagName.toLowerCase() + ": " + (e.textContent || "").slice(0, 40))`,
    )) as string[];
    console.log(clipped.length === 0 ? "Overflow check: nothing is wider than the page." : `Overflow check: ${clipped.length} element(s) wider than the page (clipped): ${clipped.join(" | ")}`);
    await tab.pdf({ path: OUTPUT, format: "A4", printBackground: true, preferCSSPageSize: true });
  } finally {
    await browser.close();
  }

  // page count: the /Count of the page tree (Chrome writes a plain, uncompressed page tree)
  const pdf = (await readFile(OUTPUT)).toString("latin1");
  const counts = [...pdf.matchAll(/\/Type\s*\/Pages[^>]*?\/Count\s+(\d+)/g)].map((m) => Number(m[1]));
  const pages = counts.length > 0 ? Math.max(...counts) : (pdf.match(/\/Type\s*\/Page[^s]/g) ?? []).length;
  console.log(`Rendered ${OUTPUT.replace(`${ROOT}/`, "")}: ${pages} page${pages === 1 ? "" : "s"} (limit ${MAX_PAGES}).`);
  console.log(placeholders.length === 0 ? "Placeholders left: none." : `Placeholders left (${placeholders.length}): ${placeholders.join("  ")}`);
  await writeFile(join(ROOT, "docs", "writeup", ".last-render.txt"), `${new Date().toISOString()} pages=${pages} headingsOk=${headingsOk} placeholders=${placeholders.length}\n`, "utf8");
  return pages >= 1 && pages <= MAX_PAGES && headingsOk ? 0 : 1;
}

main().then(
  (code) => process.exit(code),
  (err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(2);
  },
);
