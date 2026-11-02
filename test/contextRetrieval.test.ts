import { describe, expect, it } from "vitest";
import { budgetTokens } from "../src/context/budget";
import { ContextIndex } from "../src/context/indexer";
import { fuzzyScore, mergeMentions, parseMentions, resolveMentions, stripMentions, suggestFiles, suggestSymbols } from "../src/context/mentions";
import { diversify, intentBoost, isDocPath, isTestPath, retrieve } from "../src/context/retrieval";
import { FakeHost } from "./helpers/fakeHost";

const FILES: Record<string, string> = {
  "src/app/cli.py": [
    "import click",
    "",
    "",
    "class Group:",
    '    """Command group."""',
    "",
    "    def __init__(self):",
    "        self.add_command(run_command)",
    "        self.add_command(routes_command)",
    "",
    "    def add_command(self, cmd):",
    "        pass",
    "",
    "",
    "@click.command('routes')",
    "def routes_command(sort):",
    '    """Show all registered routes."""',
    "    return sort",
    "",
    "",
    "def run_command():",
    '    """Run the development server."""',
    "    return 1",
    "",
  ].join("\n"),
  "src/app/config.py": ["class Config(dict):", '    """Holds config values."""', "", "    def from_file(self, path):", "        return path", "", "    def from_pyfile(self, path):", "        return path", ""].join("\n"),
  "src/app/helpers.py": ["def get_debug_flag():", '    """Whether debug is on."""', "    return False", ""].join("\n"),
  "tests/test_cli.py": ["from app.cli import routes_command", "", "", "def test_routes_command():", "    assert routes_command('endpoint')", ""].join("\n"),
  "tests/test_config.py": ["def test_from_file():", "    assert True", ""].join("\n"),
  "docs/cli.rst": ["Command Line Interface", "======================", "", "Flask has built-in commands and a --help screen.", "", "Open a Shell", "------------", "", "Use the shell command.", ""].join("\n"),
  "docs/config.rst": ["Configuration Handling", "======================", "", "Config values load from a file with from_file.", ""].join("\n"),
};

async function build(files: Record<string, string> = FILES) {
  const host = new FakeHost({ ...files });
  const index = new ContextIndex();
  await index.build(host);
  return { host, index };
}

describe("retrieve", () => {
  it("surfaces code, tests and docs for a request and explains each hit with matched terms", async () => {
    const { index } = await build();
    const { plan } = retrieve(index, { query: "add a built-in command to the cli and a test and docs", budgetTokens: 6000 });
    const paths = plan.items.map((i) => i.path);
    expect(paths).toEqual(expect.arrayContaining(["src/app/cli.py", "tests/test_cli.py", "docs/cli.rst"]));
    for (const item of plan.items) {
      expect(item.source).toBe("auto");
      expect(item.reason).toMatch(/^matches: \w+/);
    }
  });

  it("the plan always fits the budget and the first items carry bodies", async () => {
    const { index } = await build();
    for (const budget of [300, 800, 2000, 6000]) {
      const { plan } = retrieve(index, { query: "routes command cli", budgetTokens: budget });
      expect(budgetTokens(plan.text)).toBeLessThanOrEqual(budget);
    }
    const { plan } = retrieve(index, { query: "routes command cli", budgetTokens: 6000 });
    expect(plan.items.filter((i) => i.form === "body").length).toBeLessThanOrEqual(2);
    expect(plan.items[0]?.form).toBe("body");
  });

  it("prefers the chunk whose symbol matches the query within a file", async () => {
    const { index } = await build();
    const { plan } = retrieve(index, { query: "routes_command", budgetTokens: 6000 });
    expect(plan.items[0]).toMatchObject({ path: "src/app/cli.py", symbol: "routes_command" });
  });

  it("reports timing and how many hits it considered", async () => {
    const { index } = await build();
    const result = retrieve(index, { query: "config from_file", budgetTokens: 4000 });
    expect(result.considered).toBeGreaterThan(0);
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
    expect(result.timing.totalMs).toBeLessThan(500);
    expect(result.timing.totalMs).toBeCloseTo(result.timing.searchMs + result.timing.packMs, 5);
  });

  it("excludes chunks that overlap pinned items", async () => {
    const { index } = await build();
    const pinnedChunk = index.search("routes_command")[0]!.chunk;
    const { plan } = retrieve(index, {
      query: "routes command",
      budgetTokens: 6000,
      pinned: [{ path: pinnedChunk.path, startLine: pinnedChunk.startLine, endLine: pinnedChunk.endLine, symbol: pinnedChunk.symbol ?? "x", kind: pinnedChunk.kind, text: pinnedChunk.text, source: "mention", score: 0, reason: "pinned" }],
    });
    const autoItems = plan.items.filter((i) => i.source === "auto");
    expect(autoItems.some((i) => i.path === pinnedChunk.path && i.startLine === pinnedChunk.startLine)).toBe(false);
    expect(plan.items[0]?.source).toBe("mention");
  });

  it("extra terms (symbols of @mentions) widen the query", async () => {
    const { index } = await build();
    const without = retrieve(index, { query: "something unrelated zzz", budgetTokens: 3000 }).plan.items;
    const withTerms = retrieve(index, { query: "something unrelated zzz", extraTerms: ["from_file"], budgetTokens: 3000 }).plan.items;
    expect(without).toEqual([]);
    expect(withTerms[0]?.path).toBe("src/app/config.py");
  });

  it("an index that is not ready yields an empty but valid block", () => {
    const { plan } = retrieve(new ContextIndex(), { query: "anything", budgetTokens: 2000 });
    expect(plan.items).toEqual([]);
    expect(plan.text).toContain("- (none found)");
  });
});

describe("diversify", () => {
  it("allows at most 2 chunks per file unless a further chunk scores close to the best", async () => {
    const body = Array.from({ length: 6 }, (_, i) => `def handler_${i}():\n    """handle widgets ${i}"""\n    return ${i}\n`).join("\n\n");
    const { index } = await build({ "src/widgets.py": body, "src/other.py": "def handler_other():\n    return 0\n" });
    const hits = index.search("handler widgets", { limit: 60 });
    expect(hits.filter((h) => h.chunk.path === "src/widgets.py").length).toBe(6);
    const spread = diversify(hits, { maxPerFile: 2, nearTopRatio: 2 }); // ratio > 1: nothing counts as "near the top"
    expect(spread.filter((h) => h.chunk.path === "src/widgets.py")).toHaveLength(2);
    const loose = diversify(hits, { maxPerFile: 2, nearTopRatio: 0 }); // everything counts as near the top
    expect(loose.filter((h) => h.chunk.path === "src/widgets.py")).toHaveLength(6);
  });

  it("drops chunks that overlap an already chosen chunk of the same file", async () => {
    const big = Array.from({ length: 150 }, (_, i) => `value_${i} = ${i}`).join("\n");
    const { index } = await build({ "data.toml": big });
    const hits = index.search("value", { limit: 60 });
    const chosen = diversify(hits, { maxPerFile: 10 });
    const ranges = chosen.map((h) => [h.chunk.startLine, h.chunk.endLine]);
    for (const [i, a] of ranges.entries()) for (const b of ranges.slice(i + 1)) {
      const overlap = Math.min(a[1]!, b[1]!) - Math.max(a[0]!, b[0]!) + 1;
      expect(overlap / 60).toBeLessThanOrEqual(0.5);
    }
  });
});

describe("intent hints", () => {
  it("test words boost test paths and doc words boost docs, others are untouched", () => {
    const boost = intentBoost("add a command, a test and document it");
    expect(boost("tests/test_cli.py")).toBeGreaterThan(1);
    expect(boost("docs/cli.rst")).toBeGreaterThan(1);
    expect(boost("src/app/cli.py")).toBe(1);
    expect(intentBoost("refactor the parser")("tests/test_x.py")).toBe(1);
    expect(isTestPath("src/pkg/test_x.py")).toBe(true);
    expect(isTestPath("src/pkg/x_test.go")).toBe(true);
    expect(isTestPath("src/pkg/latest.py")).toBe(false);
    expect(isDocPath("README.md")).toBe(true);
    expect(isDocPath("src/a.py")).toBe(false);
  });
});

describe("parseMentions / stripMentions / mergeMentions", () => {
  it("parses @file, @#symbol and @symbol:name tokens", () => {
    expect(parseMentions("look at @src/flask/cli.py and @#routes_command, also @symbol:FlaskGroup.add_command please")).toEqual([
      { kind: "file", value: "src/flask/cli.py" },
      { kind: "symbol", value: "routes_command" },
      { kind: "symbol", value: "FlaskGroup.add_command" },
    ]);
  });
  it("ignores emails and trailing punctuation, and de-duplicates", () => {
    expect(parseMentions("mail me at a@b.com; see @cli.py. Also (@cli.py) and @cli.py")).toEqual([{ kind: "file", value: "cli.py" }]);
    expect(parseMentions("no mentions here @ alone")).toEqual([]);
  });
  it("strips mention tokens from the retrieval query", () => {
    expect(stripMentions("fix @src/a.py and @#run now")).toBe("fix and now");
  });
  it("merges chips and typed mentions without duplicates", () => {
    expect(mergeMentions([{ kind: "file", value: "a.py" }], [{ kind: "file", value: "a.py" }, { kind: "symbol", value: "f" }])).toEqual([{ kind: "file", value: "a.py" }, { kind: "symbol", value: "f" }]);
  });
});

describe("fuzzy suggestions", () => {
  it("fuzzyScore: non-subsequences score 0, file-name matches beat path-only matches", () => {
    expect(fuzzyScore("zzz", "src/app/cli.py")).toBe(0);
    expect(fuzzyScore("cli", "src/app/cli.py")).toBeGreaterThan(fuzzyScore("cli", "src/client/other.py"));
    expect(fuzzyScore("cli.py", "src/app/cli.py")).toBeGreaterThan(fuzzyScore("cli.py", "src/app/client.py"));
    expect(fuzzyScore("", "anything")).toBeGreaterThan(0);
  });

  it("suggestFiles ranks the best path first and caps the list", async () => {
    const { index } = await build();
    expect(suggestFiles(index, "cli").slice(0, 2).map((f) => f.value).sort()).toEqual(["docs/cli.rst", "src/app/cli.py"]); // both are exactly "cli"
    expect(suggestFiles(index, "cli.py")[0]?.value).toBe("src/app/cli.py");
    expect(suggestFiles(index, "test_cli")[0]?.value).toBe("tests/test_cli.py");
    expect(suggestFiles(index, "", 3)).toHaveLength(3);
    expect(suggestFiles(index, "qqqq")).toEqual([]);
  });

  it("suggestSymbols finds names by prefix, last segment and substring with their location", async () => {
    const { index } = await build();
    expect(suggestSymbols(index, "routes_c")[0]).toMatchObject({ kind: "symbol", value: "routes_command", path: "src/app/cli.py" });
    expect(suggestSymbols(index, "from_f")[0]?.value).toBe("Config.from_file");
    expect(suggestSymbols(index, "add_command")[0]?.value).toBe("Group.add_command");
    expect(suggestSymbols(index, "zzzzz")).toEqual([]);
  });
});

describe("resolveMentions", () => {
  it("resolves an exact path, a suffix, a file name and a fuzzy name to the right file, with live text and an outline", async () => {
    const { host, index } = await build();
    for (const value of ["src/app/cli.py", "app/cli.py", "cli.py"]) {
      const r = await resolveMentions(index, host, [{ kind: "file", value }]);
      expect(r.pinned[0]?.path, value).toBe("src/app/cli.py");
      expect(r.warnings.filter((w) => !w.includes("several")), value).toEqual([]);
    }
    const r = await resolveMentions(index, host, [{ kind: "file", value: "src/app/cli.py" }]);
    expect(r.pinned[0]).toMatchObject({ kind: "module", source: "mention", startLine: 1, reason: "pinned by @src/app/cli.py" });
    expect(r.pinned[0]?.text).toContain("def routes_command(sort):");
    expect(r.pinned[0]?.outline?.some((l) => l.includes("def routes_command(sort):"))).toBe(true);
    expect((await resolveMentions(index, host, [{ kind: "file", value: "confg" }])).pinned[0]?.path).toBe("src/app/config.py");
  });

  it("uses the LIVE buffer text of the file", async () => {
    const { host, index } = await build();
    host.files["src/app/config.py"] = "# edited but unsaved\nclass Config(dict):\n    pass\n";
    const r = await resolveMentions(index, host, [{ kind: "file", value: "config.py" }]);
    expect(r.pinned[0]?.text).toContain("# edited but unsaved");
  });

  it("resolves symbols by qualified name, last segment and case-insensitively", async () => {
    const { host, index } = await build();
    expect((await resolveMentions(index, host, [{ kind: "symbol", value: "routes_command" }])).pinned[0]).toMatchObject({ symbol: "routes_command", path: "src/app/cli.py", source: "mention" });
    expect((await resolveMentions(index, host, [{ kind: "symbol", value: "Config.from_file" }])).pinned[0]?.symbol).toBe("Config.from_file");
    expect((await resolveMentions(index, host, [{ kind: "symbol", value: "FROM_FILE" }])).pinned[0]?.symbol).toBe("Config.from_file");
  });

  it("unresolved mentions produce a visible warning, never a silent drop", async () => {
    const { host, index } = await build();
    const r = await resolveMentions(index, host, [{ kind: "file", value: "nope_xyz.py" }, { kind: "symbol", value: "no_such_symbol_q" }, { kind: "file", value: "cli.py" }]);
    expect(r.pinned.map((p) => p.path)).toEqual(["src/app/cli.py"]);
    expect(r.warnings).toEqual([expect.stringContaining("Could not resolve @nope_xyz.py"), expect.stringContaining("Could not resolve @#no_such_symbol_q")]);
  });

  it("ambiguous mentions pick one and say which others matched", async () => {
    const { host, index } = await build({ "a/client.py": "x = 1\n", "b/client.py": "y = 2\n" });
    const r = await resolveMentions(index, host, [{ kind: "file", value: "client.py" }]);
    expect(r.pinned).toHaveLength(1);
    expect(r.warnings[0]).toMatch(/matches several files; using a\/client\.py \(also: b\/client\.py\)/);
  });

  it("while the index is still building, mentions are reported as unresolved for that reason", async () => {
    const host = new FakeHost({ ...FILES });
    const r = await resolveMentions(new ContextIndex(), host, [{ kind: "file", value: "cli.py" }]);
    expect(r.pinned).toEqual([]);
    expect(r.warnings[0]).toMatch(/Index still building/);
  });
});
