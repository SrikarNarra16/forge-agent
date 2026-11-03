import { describe, expect, it } from "vitest";
import type { TrueForge } from "@truefoundry/trueforge-sdk";
import { ContextIndex } from "../src/context/indexer";
import type { CommandResult, CommandRunner } from "../src/mcp/commandRunner";
import { EXTRAS_TOOL_NAMES, runFindReferences, runGitDiff, runGitStatus, runOpenInEditor } from "../src/mcp/tools/extras";
import { TOOL_NAMES } from "../src/mcp/tools/index";
import { createToolDeps } from "../src/mcp/tools/common";
import { registerMcpServers } from "../src/trueforge/mcpRegistration";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

const ok = (output: string, exitCode = 0): CommandResult => ({ exitCode, output, timedOut: false, aborted: false, durationMs: 5 });

function deps(runner?: CommandRunner, index?: ContextIndex) {
  return createToolDeps({ log: () => undefined, events: makeRig().deps.events, commands: runner, index });
}

describe("git tools", () => {
  it("git_status runs a fixed command without the user's prefix and reports clean trees", async () => {
    const seen: Array<{ c: string; prefix: boolean | undefined }> = [];
    const runner: CommandRunner = { run: (c, o) => (seen.push({ c, prefix: o.usePrefix }), Promise.resolve(ok("## main\n M src/a.py\n"))) };
    const host = new FakeHost({});
    expect(textOf(await runGitStatus(host, deps(runner)))).toBe("## main\n M src/a.py");
    expect(seen).toEqual([{ c: "git --no-pager status --porcelain=v1 --branch", prefix: false }]);
    expect(textOf(await runGitStatus(host, deps({ run: () => Promise.resolve(ok("## main\n")) })))).toContain("(working tree clean)");
  });
  it("git_diff validates and quotes the path, caps output and explains an empty diff", async () => {
    const cmds: string[] = [];
    const runner: CommandRunner = { run: (c) => (cmds.push(c), Promise.resolve(ok("diff --git a/x b/x\n+line\n"))) };
    const host = new FakeHost({});
    await runGitDiff(host, deps(runner), { path: "src/it's.py" });
    expect(cmds[0]).toBe("git --no-pager diff --no-color --no-ext-diff HEAD -- 'src/it'\\''s.py'");
    expect((await runGitDiff(host, deps(runner), { path: "../etc/passwd" })).isError).toBe(true);
    expect(textOf(await runGitDiff(host, deps({ run: () => Promise.resolve(ok("")) }), {}))).toMatch(/No changes compared with HEAD/);
    const big = Array.from({ length: 5000 }, (_, i) => `+line ${i}`).join("\n");
    expect(textOf(await runGitDiff(host, deps({ run: () => Promise.resolve(ok(big)) }), {}))).toMatch(/diff truncated/);
    expect(textOf(await runGitDiff(host, deps({ run: () => Promise.resolve(ok("fatal: not a git repository", 128)) }), {}))).toMatch(/git failed \(exit 128\)/);
    expect((await runGitDiff(host, deps(undefined), {})).isError).toBe(true);
  });
});

describe("find_references / open_in_editor", () => {
  it("finds whole-word usages from the index and is honest about being lexical", async () => {
    const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
    const index = new ContextIndex();
    await index.build(host);
    const text = textOf(await runFindReferences(deps(undefined, index), { symbol: "get_debug_flag" }));
    expect(text).toContain("src/app/helpers.py:4: def get_debug_flag() -> bool:");
    expect(text).toContain("tests/test_helpers.py:2: assert get_debug_flag() is False");
    expect(text).toMatch(/lexical word match/);
    expect(textOf(await runFindReferences(deps(undefined, index), { symbol: "get_debug" }))).toMatch(/No references/); // not a whole word of the others
    expect((await runFindReferences(deps(undefined, index), { symbol: "not valid!" })).isError).toBe(true);
    expect(textOf(await runFindReferences(deps(), { symbol: "x" }))).toMatch(/still building/);
  });
  it("opens a file for the user through the editor UI and validates input", async () => {
    const host = new FakeHost({ "a.py": "x\n" });
    const revealed: Array<[string, number | undefined]> = [];
    const editor = { reveal: (p: string, l?: number) => (revealed.push([p, l]), Promise.resolve()) };
    expect(textOf(await runOpenInEditor(host, deps(), editor, { path: "a.py", line: 3 }))).toMatch(/Opened a\.py at line 3/);
    expect(revealed).toEqual([["a.py", 3]]);
    expect((await runOpenInEditor(host, deps(), editor, { path: "missing.py" })).isError).toBe(true);
    expect((await runOpenInEditor(host, deps(), editor, { path: "a.py", line: 0 })).isError).toBe(true);
    expect((await runOpenInEditor(host, deps(), undefined, { path: "a.py" })).isError).toBe(true);
    expect((await runOpenInEditor(host, deps(), editor, { path: "../x" })).isError).toBe(true);
  });
});

describe("registerMcpServers (bootstrap)", () => {
  function fakeClient(listed: Record<string, string[]>, failOn?: string) {
    const upserts: Array<{ name: string; url: string }> = [];
    const client = {
      settings: { mcpServers: { createOrUpdate: (req: { manifest: { name: string; url: string } }) => (failOn === req.manifest.name ? Promise.reject(new Error("422 bad")) : (upserts.push({ name: req.manifest.name, url: req.manifest.url }), Promise.resolve({}))) } },
      mcpServers: { listTools: (name: string) => Promise.resolve({ data: (listed[name] ?? []).map((n) => ({ name: n })) }) },
    } as unknown as TrueForge;
    return { client, upserts };
  }
  const handle = { url: "http://127.0.0.1:1/mcp", extrasUrl: "http://127.0.0.1:1/mcp-extras" };
  const all = { "forge-editor": [...TOOL_NAMES], "forge-editor-extras": [...EXTRAS_TOOL_NAMES] };

  it("registers both servers with their own URLs and verifies both tool lists", async () => {
    const { client, upserts } = fakeClient(all);
    const logs: string[] = [];
    expect(await registerMcpServers(client, handle, "tok", (m) => logs.push(m))).toEqual({ ok: true });
    expect(upserts).toEqual([{ name: "forge-editor", url: handle.url }, { name: "forge-editor-extras", url: handle.extrasUrl }]);
    expect(logs.join("\n")).toContain("forge-editor-extras: git_status, git_diff");
    expect(logs.join("\n")).not.toContain("tok");
  });
  it("fails verification when TrueForge does not list an extras tool", async () => {
    const { client } = fakeClient({ ...all, "forge-editor-extras": ["git_status"] });
    const r = await registerMcpServers(client, handle, "tok", () => undefined);
    expect(r).toMatchObject({ ok: false, stage: "mcp-verify", url: handle.extrasUrl });
    expect(String((r as { error: Error }).error.message)).toMatch(/git_diff, find_references, open_in_editor/);
  });
  it("reports a register failure with the failing server's URL", async () => {
    const { client } = fakeClient(all, "forge-editor-extras");
    expect(await registerMcpServers(client, handle, "tok", () => undefined)).toMatchObject({ ok: false, stage: "mcp-register", url: handle.extrasUrl });
  });
});
