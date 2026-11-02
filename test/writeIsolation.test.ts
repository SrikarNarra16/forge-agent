import { readFile, readdir } from "node:fs/promises";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";

/**
 * Hard rule: no file is written without a review. All writes live in src/review/applier.ts (one
 * WorkspaceEdit per apply, then save). This scans every source file for anything that could write.
 */
const SRC = join(__dirname, "..", "src");
const APPLIER = join("review", "applier.ts");

async function sources(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await sources(full)));
    else if (entry.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

function stripComments(text: string): string {
  return text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "").replace(/\s\/\/ .*$/gm, "");
}

/** Calls and imports that can change the file system. (A FileSystemProvider *method definition* is not a call.) */
const FORBIDDEN_EVERYWHERE: Array<[string, RegExp]> = [
  ["node fs write/append/rm/rename/copy/mkdir/truncate call", /\b(?:fs|fsp|promises)\s*\.\s*(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|rmdir|unlink|unlinkSync|rename|renameSync|copyFile|copyFileSync|mkdir|mkdirSync|truncate|truncateSync|createWriteStream)\b/],
  ["workspace.fs write", /\bworkspace\s*\.\s*fs\s*\.\s*(?:writeFile|delete|rename|copy|createDirectory)\b/],
  ["write function imported from node:fs", /import\s*(?:type\s*)?\{[^}]*\b(?:writeFile|writeFileSync|appendFile|appendFileSync|rm|rmSync|unlink|rename|copyFile|mkdir|createWriteStream)\b[^}]*\}\s*from\s*["'](?:node:)?fs(?:\/promises)?["']/],
  ["writeFileSync/appendFileSync anywhere", /\b(?:writeFileSync|appendFileSync|createWriteStream)\b/],
];

/** Only the applier may use these. */
const APPLIER_ONLY: Array<[string, RegExp]> = [
  ["workspace.applyEdit", /\bapplyEdit\s*\(/],
  ["document.save", /\.\s*save\s*\(\s*\)/],
  ["WorkspaceEdit", /\bnew\s+(?:vscode\.)?WorkspaceEdit\b/],
];

describe("write isolation", () => {
  it("scans a meaningful number of source files", async () => {
    expect((await sources(SRC)).length).toBeGreaterThan(40);
  });

  it("no source file can write to disk by itself", async () => {
    for (const file of await sources(SRC)) {
      const text = stripComments(await readFile(file, "utf8"));
      for (const [what, pattern] of FORBIDDEN_EVERYWHERE) expect(pattern.test(text), `${relative(SRC, file)}: ${what}`).toBe(false);
    }
  });

  it("only src/review/applier.ts applies edits, builds WorkspaceEdits or saves documents", async () => {
    for (const file of await sources(SRC)) {
      if (relative(SRC, file) === APPLIER) continue;
      const text = stripComments(await readFile(file, "utf8"));
      for (const [what, pattern] of APPLIER_ONLY) expect(pattern.test(text), `${relative(SRC, file)}: ${what}`).toBe(false);
    }
  });

  it("the applier does contain the write path (guards against a vacuous test)", async () => {
    const text = await readFile(join(SRC, APPLIER), "utf8");
    for (const [, pattern] of APPLIER_ONLY) expect(pattern.test(text)).toBe(true);
  });

  it("the MCP tools and the review handler have no way to write: they import neither vscode nor fs", async () => {
    for (const file of [...(await sources(join(SRC, "mcp"))), join(SRC, "review", "reviewHandler.ts"), join(SRC, "review", "session.ts"), join(SRC, "review", "hunks.ts")]) {
      const text = stripComments(await readFile(file, "utf8"));
      expect(/from\s+["'](?:node:)?fs(?:\/promises)?["']|from\s+["']vscode["']/.test(text), relative(SRC, file)).toBe(false);
    }
  });
});
