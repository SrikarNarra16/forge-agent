import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(__dirname, "..");
const VSCODE_IMPORT = /(?:from\s+|import\s*\(\s*|require\s*\(\s*|import\s+)["']vscode["']/;

/** Drops block and line comments so prose mentioning the import does not count. */
function stripComments(source: string): string {
  return source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
}

async function tsFilesUnder(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await tsFilesUnder(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("modules shared with scripts and tests stay free of the vscode API", () => {
  it("the pure src/trueforge modules, src/mcp/** and scripts/** do not import vscode", async () => {
    const PURE_TRUEFORGE = ["client", "providers", "events", "runState", "agentController", "sdkAdapter"];
    const files = [...PURE_TRUEFORGE.map((n) => join(root, `src/trueforge/${n}.ts`)), ...(await tsFilesUnder(join(root, "src/mcp"))), ...(await tsFilesUnder(join(root, "scripts")).catch(() => []))];
    expect(files.length).toBeGreaterThan(3);
    for (const file of files) {
      const text = stripComments(await readFile(file, "utf8"));
      expect(VSCODE_IMPORT.test(text), `${file} imports vscode`).toBe(false);
    }
  });
});
