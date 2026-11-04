import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(__dirname, "..", "src");

async function files(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const e of await readdir(dir, { withFileTypes: true })) {
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...(await files(full)));
    else if (e.name.endsWith(".ts")) out.push(full);
  }
  return out;
}

describe("e2e hooks are inert unless FORGE_E2E=1", () => {
  it("package.json declares no forge.e2e command, activation event or keybinding", async () => {
    const pkg = await readFile(join(__dirname, "..", "package.json"), "utf8");
    expect(pkg).not.toMatch(/forge\.e2e/);
  });

  it("forge.e2e.* commands are registered only in src/e2e/hooks.ts, and that module is only used behind the FORGE_E2E check", async () => {
    const offenders: string[] = [];
    for (const f of await files(SRC)) {
      const text = await readFile(f, "utf8");
      if (/["']forge\.e2e\./.test(text) && !f.endsWith(join("e2e", "hooks.ts"))) offenders.push(f);
    }
    expect(offenders).toEqual([]);
    const ext = await readFile(join(SRC, "extension.ts"), "utf8");
    expect(ext).toMatch(/const e2e = process\.env\["FORGE_E2E"\] === "1"/);
    expect(ext).toMatch(/const recorder = e2e \? new E2eRecorder\(\) : undefined;/);
    // the only call of registerE2eHooks sits inside `if (recorder)`, and the recorder joins the UI sinks only when it exists
    expect(ext).toMatch(/if \(recorder\) \{[\s\S]{0,200}registerE2eHooks\(/);
    expect(ext.match(/registerE2eHooks\(/g)).toHaveLength(1);
    expect(ext).toMatch(/\.\.\.\(recorder \? \[recorder\] : \[\]\)/);
  });

  it("the hooks only drive the real extension: no applier, WorkspaceEdit, save, CodeLens provider, fs writes or handler bypass", async () => {
    const text = (await readFile(join(SRC, "e2e", "hooks.ts"), "utf8")).replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    for (const forbidden of [/\bapplyEdit\b/, /WorkspaceEdit/, /\.save\s*\(/, /registerCodeLensProvider/, /node:fs/, /writeFile/, /VscodeApplier|VscodeReviewEditor|VscodeRestorer/, /applyAccepted|checkpoints/, /decisions\.(put|clear)/]) {
      expect(forbidden.test(text), String(forbidden)).toBe(false);
    }
  });
});
