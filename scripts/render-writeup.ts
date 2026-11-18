/**
 * Renders docs/writeup/WRITEUP.md to the committed PDF `Forge-writeup.pdf` (repo root) and checks it against the rules:
 * at most 3 pages, exactly the 8 required headings in order, no clipped content, no placeholder text (other than the video
 * URL before it is known), fonts embedded, links clickable.
 *
 *   npm run writeup:pdf                                      # render + checks (the video URL placeholder is allowed)
 *   npm run writeup:set-url -- <VIDEO_URL> [--college "X"] [--team-name "Y"]   # fill the URL, re-render, re-check
 *   WRITEUP_PNG=1 npm run writeup:pdf                        # also writes e2e-output/writeup-pages/page-N.png (to look at)
 *
 * Markdown -> HTML (marked) -> PDF (headless Chrome via Playwright). Page text, links and PNGs are read back with the
 * macOS PDFKit helper scripts/pdf-tool.swift (compiled on first use), so the checks look at the real PDF, not at the HTML.
 * Facts that may change late (team name, college, video URL) live in docs/writeup/team.json and are substituted for the
 * {{TOKENS}} in the Markdown; the literal `<VIDEO_URL>` is the one placeholder allowed before the video is uploaded.
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { marked } from "marked";
import { chromium } from "playwright-core";

const exec = promisify(execFile);
const ROOT = join(__dirname, "..");
const SOURCE = join(ROOT, "docs", "writeup", "WRITEUP.md");
const TEAM_FILE = join(ROOT, "docs", "writeup", "team.json");
const DIAGRAM = join(ROOT, "docs", "writeup", "architecture.svg");
export const OUTPUT = join(ROOT, "Forge-writeup.pdf");
const MAX_PAGES = 3;
export const HEADINGS = [
  "Team",
  "Starting point",
  "Architecture on TrueForge",
  "How context is selected",
  "Model setup",
  "Scorecard",
  "Tools used",
  "Known limitations and what we would do with another month",
];

export interface TeamFacts {
  team: string;
  teamId: string;
  competitionId: string;
  member: string;
  github: string;
  college: string;
  repo: string;
  videoUrl: string;
}

export async function readTeam(): Promise<TeamFacts> {
  return JSON.parse(await readFile(TEAM_FILE, "utf8")) as TeamFacts;
}
export async function writeTeam(t: TeamFacts): Promise<void> {
  await writeFile(TEAM_FILE, `${JSON.stringify(t, null, 2)}\n`, "utf8");
}

const INK = "#1b1612";
const AMBER = "#e8a33d";
const CSS = `
@page { size: A4; margin: 0; }
* { box-sizing: border-box; }
html { -webkit-print-color-adjust: exact; print-color-adjust: exact; }
body { font: 9.6pt/1.36 "Helvetica Neue", Helvetica, Arial, sans-serif; color: ${INK}; margin: 0; background: #fff; counter-reset: sec; }
.band { background: ${INK}; color: #fff7ea; margin: -14mm -15mm 4.5mm; padding: 10mm 15mm 6mm; display: flex; justify-content: space-between; align-items: flex-end; }
.band .name { font-size: 27pt; font-weight: 800; letter-spacing: .5pt; color: ${AMBER}; line-height: 1; }
.band .tag { font-size: 10pt; color: #d9c9ad; margin-top: 3pt; }
.band .team { text-align: right; font-size: 11pt; font-weight: 700; line-height: 1.35; }
.band .team span { display: block; font-weight: 400; font-size: 9pt; color: #d9c9ad; }
p { margin: 0 0 3.5pt; }
h2 { counter-increment: sec; font-size: 11.5pt; margin: 8pt 0 3.5pt; padding-bottom: 1.5pt; border-bottom: 1.2pt solid ${AMBER}; break-after: avoid; display: flex; align-items: center; gap: 6pt; color: ${INK}; }
h2::before { content: counter(sec); display: inline-flex; align-items: center; justify-content: center; width: 14pt; height: 14pt; border-radius: 50%; background: ${AMBER}; color: ${INK}; font-size: 9pt; font-weight: 800; flex: none; }
h2:first-of-type { margin-top: 4pt; }
ul { margin: 1.5pt 0 3.5pt; padding-left: 12pt; } li { margin: 0 0 1.8pt; }
table { border-collapse: collapse; width: 100%; margin: 3pt 0 5pt; font-size: 9pt; line-height: 1.28; }
th, td { border: 0.5pt solid #cdbf9f; padding: 1.6pt 3.5pt; text-align: left; vertical-align: top; }
thead th { background: ${INK}; color: #fff7ea; border-color: ${INK}; }
tbody tr:nth-child(even) td { background: #faf4e6; }
tr { break-inside: avoid; }
thead { display: table-header-group; }
pre { font: 8.6pt/1.25 Menlo, "SF Mono", Consolas, monospace; background: #f6f1e6; padding: 3pt 5pt; margin: 3pt 0 4pt; white-space: pre; overflow: hidden; border-left: 2.5pt solid ${AMBER}; }
code { font: 8.6pt Menlo, "SF Mono", Consolas, monospace; background: #f3ecdc; padding: 0 1.2pt; border-radius: 2pt; }
pre code { background: none; padding: 0; font-size: inherit; }
a { color: #8a4b00; text-decoration: underline; text-decoration-color: ${AMBER}; text-underline-offset: 1.5pt; word-break: break-all; }
mark { background: #ffe39a; padding: 0 1pt; }
figure.diagram { margin: 3pt 0 4pt; } figure.diagram svg { width: 100%; height: auto; display: block; }
.keep { break-inside: avoid; }
`;

async function pdfTool(): Promise<string> {
  const bin = join(ROOT, "e2e-output", "bin", "pdf-tool");
  if (!existsSync(bin)) {
    await mkdir(join(ROOT, "e2e-output", "bin"), { recursive: true });
    await exec("swiftc", ["-O", join(ROOT, "scripts", "pdf-tool.swift"), "-o", bin], { timeout: 300_000 });
  }
  return bin;
}

export interface RenderResult {
  pages: number;
  headingsOk: boolean;
  headingsFound: string[];
  placeholders: string[];
  clipped: string[];
  links: string[];
  fontsEmbedded: boolean;
  pngs: string[];
  ok: boolean;
}

export async function render(options: { png?: boolean } = {}): Promise<RenderResult> {
  const team = await readTeam();
  let md = await readFile(SOURCE, "utf8");
  const found = [...md.matchAll(/^## (.+)$/gm)].map((m) => m[1] as string);
  const headingsOk = found.length === HEADINGS.length && found.every((h, i) => h === HEADINGS[i]);
  const sub: Record<string, string> = { TEAM: team.team, TEAM_ID: team.teamId, COMPETITION_ID: team.competitionId, MEMBER: team.member, GITHUB: team.github, COLLEGE: team.college, REPO: team.repo };
  md = md.replace(/\{\{([A-Z_]+)\}\}/g, (m, k: string) => sub[k] ?? m);
  const videoToken = "\u0001VIDEOURL\u0001";
  md = md.split("<VIDEO_URL>").join(videoToken);
  let html = await marked.parse(md);
  const videoHtml = team.videoUrl ? `<a href="${team.videoUrl}">${team.videoUrl}</a>` : `<mark>&lt;VIDEO_URL&gt;</mark>`;
  html = html.split(videoToken).join(videoHtml);
  const diagram = existsSync(DIAGRAM) ? await readFile(DIAGRAM, "utf8") : "";
  html = html.replace("<!--DIAGRAM-->", `<figure class="diagram">${diagram}</figure>`);
  const band = `<div class="band"><div><div class="name">Forge</div><div class="tag">A coding agent for VS Code whose agent loop runs on TrueForge</div></div><div class="team">Team ${team.team} · ${team.teamId}<span>TrueFoundry Forge-a-thon · Techfest IIT Bombay 2026-27</span></div></div>`;
  const page = `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>Forge write-up · Team ${team.team}</title><style>${CSS}</style></head><body>${band}${html}</body></html>`;

  const exe = process.env["CHROME_EXE"];
  const browser = await chromium.launch(exe ? { executablePath: exe } : { channel: "chrome" }).catch((err: unknown) => {
    throw new Error(`could not start Chrome (${err instanceof Error ? err.message.split("\n")[0] : String(err)}). Install Google Chrome or set CHROME_EXE=/path/to/a/Chromium-based/browser.`);
  });
  let clipped: string[] = [];
  try {
    const tab = await browser.newPage({ viewport: { width: 680, height: 1000 } });
    await tab.setContent(page, { waitUntil: "load" });
    await tab.emulateMedia({ media: "print" });
    clipped = (await tab.evaluate(
      `[...document.querySelectorAll("pre, table, td, th, code, figure svg")].filter((e) => e.scrollWidth > e.clientWidth + 1).map((e) => e.tagName.toLowerCase() + ": " + (e.textContent || "").slice(0, 40))`,
    )) as string[];
    const footer = `<div style="font-family:Helvetica,Arial,sans-serif;font-size:8pt;color:#6b5f50;width:100%;padding:0 15mm;display:flex;justify-content:space-between;-webkit-print-color-adjust:exact"><span>Forge · Team ${team.team} · Techfest 2026-27 TrueFoundry Forge-a-thon</span><span><span class="pageNumber"></span> / <span class="totalPages"></span></span></div>`;
    await tab.pdf({ path: OUTPUT, format: "A4", printBackground: true, margin: { top: "14mm", bottom: "15mm", left: "15mm", right: "15mm" }, displayHeaderFooter: true, headerTemplate: "<div></div>", footerTemplate: footer });
  } finally {
    await browser.close();
  }

  const tool = await pdfTool();
  const pages = Number((await exec(tool, ["pages", OUTPUT])).stdout.trim());
  const text = (await exec(tool, ["text", OUTPUT], { maxBuffer: 20_000_000 })).stdout;
  const links = [...new Set((await exec(tool, ["links", OUTPUT])).stdout.split("\n").filter(Boolean).map((l) => l.split("\t")[1] ?? ""))];
  const placeholders = [...new Set([...text.matchAll(/<[A-Za-z_]{3,}>|\{\{[A-Z_]+\}\}|\[\[[^\]]+\]\]|TODO|TBD|XXX/g)].map((m) => m[0]))];
  const raw = (await readFile(OUTPUT)).toString("latin1");
  const fontsEmbedded = /\/FontFile[23]?\b/.test(raw);
  const pngs: string[] = [];
  if (options.png) {
    const outDir = join(ROOT, "e2e-output", "writeup-pages");
    pngs.push(...(await exec(tool, ["png", OUTPUT, outDir, "110"])).stdout.split("\n").filter(Boolean));
  }
  const allowed = team.videoUrl ? [] : ["<VIDEO_URL>"];
  const unexpected = placeholders.filter((p) => !allowed.includes(p));
  const result: RenderResult = { pages, headingsOk, headingsFound: found, placeholders, clipped, links, fontsEmbedded, pngs, ok: pages >= 1 && pages <= MAX_PAGES && headingsOk && clipped.length === 0 && unexpected.length === 0 && fontsEmbedded };
  console.log(`Headings (${found.length}): ${headingsOk ? "OK, the 8 required headings in order" : `WRONG. Found: ${found.join(" | ")}`}`);
  console.log(clipped.length === 0 ? "Overflow check: nothing is wider than its box." : `Overflow check: ${clipped.length} element(s) clipped: ${clipped.join(" | ")}`);
  console.log(`Rendered ${OUTPUT.replace(`${ROOT}/`, "")}: ${pages} page${pages === 1 ? "" : "s"} (limit ${MAX_PAGES}); fonts embedded: ${fontsEmbedded}; size ${((await readFile(OUTPUT)).length / 1024).toFixed(0)} KB`);
  console.log(`Placeholder text in the PDF text layer: ${placeholders.length === 0 ? "none" : placeholders.join("  ")}${team.videoUrl ? "" : " (the video URL is not set yet: npm run writeup:set-url -- <URL>)"}`);
  console.log(`Links in the PDF (${links.length}): ${links.join("  ")}`);
  if (pngs.length) console.log(`Page images:\n${pngs.join("\n")}`);
  return result;
}

if (process.argv[1]?.endsWith("render-writeup.ts")) {
  render({ png: process.env["WRITEUP_PNG"] === "1" }).then(
    (r) => process.exit(r.ok ? 0 : 1),
    (err: unknown) => {
      console.error(err instanceof Error ? err.message : String(err));
      process.exit(2);
    },
  );
}
