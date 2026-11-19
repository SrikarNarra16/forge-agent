/**
 * Renders README.md the way GitHub does (GitHub's own markdown API, `mode: gfm`, with this repository as context) inside GitHub's
 * light and dark styles, and saves PNGs of the top of the page and of the full page, so the banner, badges, screenshots and the
 * Mermaid diagram can be checked on both colour schemes. Relative images are pointed at the local files.
 *
 *   npx tsx scripts/readme-preview.ts [outDir]        # default e2e-output/readme-preview (needs network: markdown API, CSS, mermaid.js)
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const ROOT = resolve(__dirname, "..");

async function main(): Promise<void> {
  const out = resolve(process.argv[2] ?? join(ROOT, "e2e-output", "readme-preview"));
  await mkdir(out, { recursive: true });
  const text = await readFile(join(ROOT, "README.md"), "utf8");
  const res = await fetch("https://api.github.com/markdown", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ text, mode: "gfm", context: "SrikarNarra16/forge-agent" }) });
  if (!res.ok) throw new Error(`GitHub markdown API: ${res.status}`);
  let html = await res.text();
  html = html.replace(/(src|href)="(docs\/[^"]+|LICENSE|Forge-writeup\.pdf)"/g, (_m, a: string, p: string) => `${a}="file://${join(ROOT, p)}"`);
  html = html.replace(/<pre lang="mermaid"[^>]*>([\s\S]*?)<\/pre>/g, (_m, code: string) => `<pre class="mermaid">${code}</pre>`);
  const browser = await chromium.launch({ channel: "chrome" });
  try {
    for (const scheme of ["light", "dark"] as const) {
      const page = await browser.newPage({ viewport: { width: 1100, height: 1000 }, colorScheme: scheme });
      const bg = scheme === "light" ? "#ffffff" : "#0d1117";
      const doc = `<!doctype html><html data-color-mode="${scheme}"><head><meta charset="utf-8">
        <link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/github-markdown-css@5.5.1/github-markdown-${scheme}.css">
        <style>body{margin:0;background:${bg}} .markdown-body{box-sizing:border-box;max-width:980px;margin:0 auto;padding:45px} img[src^="file"]{max-width:100%}</style></head>
        <body><article class="markdown-body">${html}</article>
        <script type="module">import mermaid from "https://cdn.jsdelivr.net/npm/mermaid@11/dist/mermaid.esm.min.mjs"; mermaid.initialize({ startOnLoad: false, theme: "${scheme === "dark" ? "dark" : "default"}" }); await mermaid.run({ querySelector: ".mermaid" }); window.__done = true;</script></body></html>`;
      const file = join(out, `preview-${scheme}.html`);
      await writeFile(file, doc, "utf8"); // a file: page may load file: images (about:blank may not)
      await page.goto(`file://${file}`, { waitUntil: "networkidle" });
      await page.waitForFunction("window.__done === true", undefined, { timeout: 60_000 });
      const errors = await page.evaluate(`[...document.querySelectorAll(".mermaid")].filter((e) => !e.querySelector("svg") || /Syntax error/i.test(e.textContent || "")).length`);
      const broken = await page.evaluate(`[...document.images].filter((i) => !i.complete || i.naturalWidth === 0).map((i) => i.getAttribute("src"))`);
      const blocks = await page.evaluate(`document.querySelectorAll(".mermaid").length`);
      console.log(`${scheme}: mermaid blocks: ${blocks}, failing: ${errors}; images that did not load: ${JSON.stringify(broken)}`);
      await page.screenshot({ path: join(out, `readme-top-${scheme}.png`), clip: { x: 0, y: 0, width: 1100, height: 1000 } });
      await page.screenshot({ path: join(out, `readme-full-${scheme}.png`), fullPage: true });
      await page.close();
    }
  } finally {
    await browser.close();
  }
  console.log(`previews in ${out}`);
}

main().catch((err: unknown) => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
