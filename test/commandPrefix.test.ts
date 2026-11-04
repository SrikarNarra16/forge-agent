import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CommandPrefixResolver, detectVenvPrefix, effectivePrefix } from "../src/host/commandPrefix";
import { HostError } from "../src/mcp/host";

/** A WorkspaceHost stand-in: only readText matters, like the real host (it reads files even inside ignored folders such as .venv). */
function host(files: string[]): { readText(p: string): Promise<string>; reads: string[] } {
  const reads: string[] = [];
  return {
    reads,
    readText: (p) => {
      reads.push(p);
      return files.includes(p) ? Promise.resolve("# activate script\n") : Promise.reject(new HostError("ENOENT", p));
    },
  };
}

describe("detectVenvPrefix", () => {
  it("uses .venv/bin/activate", async () => {
    expect(await detectVenvPrefix(host([".venv/bin/activate"]))).toBe(". .venv/bin/activate &&");
  });
  it("falls back to venv/bin/activate", async () => {
    expect(await detectVenvPrefix(host(["venv/bin/activate"]))).toBe(". venv/bin/activate &&");
  });
  it("prefers .venv when both exist, and does not look further than needed", async () => {
    const h = host([".venv/bin/activate", "venv/bin/activate"]);
    expect(await detectVenvPrefix(h)).toBe(". .venv/bin/activate &&");
    expect(h.reads).toEqual([".venv/bin/activate"]);
  });
  it("finds nothing in a workspace without an environment", async () => {
    expect(await detectVenvPrefix(host(["src/app.py"]))).toBeUndefined();
  });
  it("does NOT detect a Windows-style environment (Scripts\\activate): documented as unsupported", async () => {
    expect(await detectVenvPrefix(host([".venv/Scripts/activate", ".venv/Scripts/activate.bat", "venv/Scripts/activate"]))).toBeUndefined();
  });
  it("treats any host error as 'not there' (no workspace, binary, too big, ...)", async () => {
    const failing = { readText: () => Promise.reject(new HostError("ENOWORKSPACE", "no folder")) };
    expect(await detectVenvPrefix(failing)).toBeUndefined();
  });
});

describe("effectivePrefix: an explicit setting always wins", () => {
  const detected = ". .venv/bin/activate &&";
  it("setting beats detection", () => {
    expect(effectivePrefix("conda activate x &&", detected)).toEqual({ prefix: "conda activate x &&", source: "setting" });
  });
  it("the no-op prefix turns activation off while a venv exists", () => {
    expect(effectivePrefix("true &&", detected)).toEqual({ prefix: "true &&", source: "setting" });
  });
  it("an empty or blank setting falls back to the detected prefix, else none", () => {
    expect(effectivePrefix("", detected)).toEqual({ prefix: detected, source: "auto" });
    expect(effectivePrefix("   ", detected)).toEqual({ prefix: detected, source: "auto" });
    expect(effectivePrefix("", undefined)).toEqual({ prefix: "", source: "none" });
  });
  it("trims the setting", () => {
    expect(effectivePrefix("  make env &&  ", detected).prefix).toBe("make env &&");
  });
});

describe("CommandPrefixResolver", () => {
  it("is 'none' until the first refresh, then reports the detected prefix", async () => {
    const r = new CommandPrefixResolver(host([".venv/bin/activate"]), () => "");
    expect(r.effective()).toEqual({ prefix: "", source: "none" });
    expect(await r.refresh()).toEqual({ prefix: ". .venv/bin/activate &&", source: "auto" });
    expect(r.effective().source).toBe("auto");
  });
  it("reads the setting at every call, so a settings change applies without a refresh", async () => {
    let setting = "";
    const r = new CommandPrefixResolver(host([".venv/bin/activate"]), () => setting);
    await r.refresh();
    setting = "my-env &&";
    expect(r.effective()).toEqual({ prefix: "my-env &&", source: "setting" });
    setting = "";
    expect(r.effective().source).toBe("auto");
  });
  it("notifies listeners only when the effective value changes, and again on notify()", async () => {
    const files: string[] = [];
    const h = { readText: (p: string) => (files.includes(p) ? Promise.resolve("x") : Promise.reject(new HostError("ENOENT", p))) };
    const r = new CommandPrefixResolver(h, () => "");
    const seen: string[] = [];
    r.onChange((e) => seen.push(`${e.source}:${e.prefix}`));
    await r.refresh(); // still nothing: no event
    expect(seen).toEqual([]);
    files.push("venv/bin/activate"); // the user created a venv meanwhile
    await r.refresh();
    expect(seen).toEqual(["auto:. venv/bin/activate &&"]);
    await r.refresh(); // unchanged: no event
    expect(seen).toHaveLength(1);
    r.notify();
    expect(seen).toHaveLength(2);
  });
  it("an explicit setting stays in force after a refresh finds a venv", async () => {
    const r = new CommandPrefixResolver(host([".venv/bin/activate"]), () => "export A=1 &&");
    expect(await r.refresh()).toEqual({ prefix: "export A=1 &&", source: "setting" });
  });
});

describe("the auto-detected prefix really works in a POSIX shell", () => {

  const shells = ["/bin/sh", "/bin/dash", "/bin/bash", "/bin/zsh"].filter((s) => existsSync(s));

  for (const shell of shells) {
    it(`${shell}: '. .venv/bin/activate && <command>' runs the command after activation (no 'source' needed)`, () => {
      const dir = mkdtempSync(join(tmpdir(), "forge-prefix-"));
      try {
        mkdirSync(join(dir, ".venv", "bin"), { recursive: true });
        writeFileSync(join(dir, ".venv", "bin", "activate"), "FORGE_TEST_VENV=active\nexport FORGE_TEST_VENV\n");
        const out = execFileSync(shell, ["-c", '. .venv/bin/activate && echo "$FORGE_TEST_VENV"'], { cwd: dir, encoding: "utf8" });
        expect(out.trim()).toBe("active");
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    });
  }

  it("the prefix string itself has no bashism", async () => {
    const prefix = await detectVenvPrefix(host([".venv/bin/activate"]));
    expect(prefix).toBe(". .venv/bin/activate &&");
    expect(prefix).not.toMatch(/\bsource\b/);
  });
});
