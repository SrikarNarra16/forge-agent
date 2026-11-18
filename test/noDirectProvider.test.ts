import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hard rule: the extension never calls a model provider itself; all LLM traffic goes through TrueForge sessions and
 * turns. This scans every source file under src/ for provider hostnames, provider SDK imports and any network API
 * other than the two known, TrueForge-only uses.
 */
const SRC = join(__dirname, "..", "src");

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const p = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(p)));
    else if (/\.(ts|js|css|html)$/.test(entry.name)) out.push(p);
  }
  return out;
}

const PROVIDER_HOSTS = /api\.openai\.com|api\.anthropic\.com|generativelanguage\.googleapis\.com|api\.groq\.com|api\.deepseek\.com|openrouter\.ai|api\.mistral\.ai|api\.cohere|api-inference\.huggingface/i;
const PROVIDER_SDKS = /from\s+["'](?:openai|@anthropic-ai\/[^"']+|@google\/genai|@google\/generative-ai|groq-sdk|@ai-sdk\/[^"']+|ai|langchain[^"']*|ollama|cohere-ai|@mistralai\/[^"']+)["']/;
const NETWORK_API = /\b(?:fetch\(|XMLHttpRequest|WebSocket\(|http\.request|https\.request|http\.get|https\.get|axios|undici|node-fetch)/;
/** The only file that opens a network connection itself: the TrueForge health check (the SDK does the rest). */
const NETWORK_ALLOWED = new Set(["ui/statusBar.ts"]);

describe("no direct model provider calls", () => {
  it("has no provider hostnames or provider SDK imports anywhere in src/", async () => {
    const hits: string[] = [];
    for (const file of await sources(SRC)) {
      const text = await readFile(file, "utf8");
      if (PROVIDER_HOSTS.test(text)) hits.push(`${file}: provider host`);
      if (PROVIDER_SDKS.test(text)) hits.push(`${file}: provider SDK import`);
    }
    expect(hits).toEqual([]);
  });

  it("opens network connections only in the TrueForge health check (everything else goes through the TrueForge SDK)", async () => {
    const hits: string[] = [];
    for (const file of await sources(SRC)) {
      const rel = file.slice(SRC.length + 1).split("\\").join("/");
      if (NETWORK_ALLOWED.has(rel)) continue;
      if (NETWORK_API.test(await readFile(file, "utf8"))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("the health check only requests the TrueForge capabilities URL", async () => {
    const text = await readFile(join(SRC, "ui", "statusBar.ts"), "utf8");
    expect(text).toMatch(/capabilitiesUrl\(this\.baseUrl\)/);
    expect(text.match(/fetch\(/g)).toHaveLength(1);
  });

  it("the only dependencies that can reach a model are the TrueForge SDK and the MCP SDK", async () => {
    const pkg = JSON.parse(await readFile(join(__dirname, "..", "package.json"), "utf8")) as { dependencies: Record<string, string> };
    expect(Object.keys(pkg.dependencies).sort()).toEqual(["@modelcontextprotocol/sdk", "@truefoundry/trueforge-sdk", "diff", "ignore", "zod"]);
  });
});
