import { afterEach, describe, expect, it, vi } from "vitest";
import { Bm25Index, FIELD_BOOSTS, K1, B } from "../src/context/bm25";
import { ContextIndex, MAX_FILE_CHARS } from "../src/context/indexer";
import { stem, tokenize } from "../src/context/tokenize";
import { SYMBOL_KINDS } from "../src/context/types";
import { FakeHost } from "./helpers/fakeHost";

afterEach(() => vi.restoreAllMocks());

const fields = (over: Partial<Record<"symbol" | "path" | "signature" | "body", string>> = {}) => ({
  symbol: tokenize(over.symbol ?? ""),
  path: tokenize(over.path ?? ""),
  signature: tokenize(over.signature ?? ""),
  body: tokenize(over.body ?? ""),
});

describe("Bm25Index", () => {
  it("ranks the document with more distinctive matching terms first", () => {
    const idx = new Bm25Index();
    idx.add(1, fields({ body: "routes command lists all routes of the application" }));
    idx.add(2, fields({ body: "config loads values from a file" }));
    idx.add(3, fields({ body: "the application context is pushed" }));
    const hits = idx.search(["routes", "command"].map(stem));
    expect(hits.map((h) => h.id)).toEqual([1]);
    expect(hits[0]?.terms).toEqual(["routes", "command"].map(stem));
  });

  it("symbol matches outrank body matches, and path/signature outrank body (field boosts)", () => {
    expect(FIELD_BOOSTS).toEqual({ symbol: 3, path: 2, signature: 2, body: 1 });
    const idx = new Bm25Index();
    idx.add(1, fields({ body: "xyzzy appears only in the body" }));
    idx.add(2, fields({ symbol: "xyzzy", body: "plain text" }));
    idx.add(3, fields({ path: "src/xyzzy.py", body: "plain text" }));
    idx.add(4, fields({ signature: "def xyzzy(a)", body: "plain text" }));
    const order = idx.search([stem("xyzzy")]).map((h) => h.id);
    expect(order[0]).toBe(2);
    expect(order.slice(1, 3).sort()).toEqual([3, 4]);
    expect(order[3]).toBe(1);
  });

  it("rare terms count more than common ones (idf)", () => {
    const idx = new Bm25Index();
    for (let i = 1; i <= 20; i++) idx.add(i, fields({ body: "common words appear everywhere" }));
    idx.add(21, fields({ body: "common unicorn" }));
    expect(idx.search(["common", "unicorn"])[0]?.id).toBe(21);
    expect(idx.docFrequency("common")).toBe(21);
  });

  it("reports at most 3 matched terms, ordered by contribution", () => {
    const idx = new Bm25Index();
    for (let i = 1; i <= 10; i++) idx.add(i, fields({ body: `filler ${i}` }));
    idx.add(11, fields({ symbol: "alpha", body: "alpha beta gamma delta epsilon" }));
    const [hit] = idx.search(["alpha", "beta", "gamma", "delta", "epsilon"]);
    expect(hit?.id).toBe(11);
    expect(hit?.terms).toHaveLength(3);
    expect(hit?.terms[0]).toBe("alpha"); // boosted by the symbol field
  });

  it("is deterministic: equal scores order by id; same query gives the same result", () => {
    const idx = new Bm25Index();
    for (let i = 1; i <= 5; i++) idx.add(i, fields({ body: "same text here" }));
    const a = idx.search(["text"]).map((h) => h.id);
    expect(a).toEqual([1, 2, 3, 4, 5]);
    expect(idx.search(["text"]).map((h) => h.id)).toEqual(a);
  });

  it("supports remove (incrementally) and re-add of a changed document", () => {
    const idx = new Bm25Index();
    idx.add(1, fields({ body: "alpha" }));
    idx.add(2, fields({ body: "beta" }));
    idx.remove(1);
    expect(idx.size).toBe(1);
    expect(idx.search(["alpha"])).toEqual([]);
    idx.add(2, fields({ body: "gamma" })); // replaces
    expect(idx.search(["beta"])).toEqual([]);
    expect(idx.search(["gamma"]).map((h) => h.id)).toEqual([2]);
    idx.remove(99); // unknown: no-op
  });

  it("applies the filter and boost options and the limit", () => {
    const idx = new Bm25Index();
    idx.add(1, fields({ body: "needle" }));
    idx.add(2, fields({ body: "needle" }));
    idx.add(3, fields({ body: "needle" }));
    expect(idx.search([stem("needle")], { filter: (id) => id !== 1 }).map((h) => h.id)).toEqual([2, 3]);
    expect(idx.search([stem("needle")], { boost: (id) => (id === 3 ? 2 : 1) })[0]?.id).toBe(3);
    expect(idx.search([stem("needle")], { limit: 2 })).toHaveLength(2);
  });

  it("returns nothing for empty queries, unknown terms or an empty index", () => {
    const idx = new Bm25Index();
    expect(idx.search(["x"])).toEqual([]);
    idx.add(1, fields({ body: "a b" }));
    expect(idx.search([])).toEqual([]);
    expect(idx.search(["zzz"])).toEqual([]);
    expect(K1).toBe(1.2);
    expect(B).toBe(0.75);
  });
});

const FILES: Record<string, string> = {
  "src/app/cli.py": ["import click", "", "", "@click.command('routes')", "def routes_command(sort):", '    """Show all registered routes."""', "    return sort", "", "", "class Group:", "    def add_command(self, cmd):", "        pass", ""].join("\n"),
  "src/app/config.py": ["class Config(dict):", '    """Holds config values."""', "", "    def from_file(self, path):", "        return path", ""].join("\n"),
  "tests/test_cli.py": ["def test_routes_output():", "    assert True", ""].join("\n"),
  "docs/cli.rst": ["Command Line Interface", "======================", "", "Flask has built-in commands such as run and shell.", "", "Open a Shell", "------------", "", "Use flask shell.", ""].join("\n"),
  "README.md": ["# Demo", "", "A small demo application.", ""].join("\n"),
  "data/blob.png": "\0PNG",
  "node_modules/x/index.js": "function hidden() {}",
};

describe("ContextIndex", () => {
  const make = () => {
    const host = new FakeHost({ ...FILES });
    const index = new ContextIndex();
    return { host, index };
  };

  it("builds from the host, skipping excluded and binary files, and reports stats", async () => {
    const { host, index } = make();
    expect(index.state).toBe("empty");
    const progress: Array<[number, number]> = [];
    const stats = await index.build(host, { onProgress: (p) => progress.push([p.done, p.total]) });
    expect(index.ready).toBe(true);
    expect(index.files()).toEqual(["README.md", "docs/cli.rst", "src/app/cli.py", "src/app/config.py", "tests/test_cli.py"]);
    expect(stats.files).toBe(5);
    expect(stats.chunks).toBeGreaterThanOrEqual(10);
    expect(stats.buildMs).toBeGreaterThanOrEqual(0);
    expect(progress[0]).toEqual([0, 5]);
    expect(progress.at(-1)).toEqual([5, 5]);
  });

  it("finds code by symbol, signature, body and path; docs by section", async () => {
    const { host, index } = make();
    await index.build(host);
    expect(index.search("routes_command")[0]?.chunk).toMatchObject({ path: "src/app/cli.py", symbol: "routes_command", kind: "function" });
    expect(index.search("registered routes")[0]?.chunk.symbol).toBe("routes_command");
    expect(index.search("shell").find((h) => h.chunk.kind === "doc")?.chunk).toMatchObject({ path: "docs/cli.rst", symbol: "Open a Shell" });
    expect(index.search("test routes output")[0]?.chunk.path).toBe("tests/test_cli.py");
    const hit = index.search("from_file")[0];
    expect(hit?.chunk.symbol).toBe("Config.from_file");
    expect(hit?.terms.length).toBeGreaterThan(0);
  });

  it("can restrict a search to kinds or paths", async () => {
    const { host, index } = make();
    await index.build(host);
    const docs = index.search("command", { kinds: new Set(["doc"]) });
    expect(docs.length).toBeGreaterThan(0);
    expect(docs.every((h) => h.chunk.kind === "doc")).toBe(true);
    const tests = index.search("routes", { pathFilter: (p) => p.startsWith("tests/") });
    expect(tests.map((h) => h.chunk.path)).toEqual(["tests/test_cli.py"]);
  });

  it("lists symbols (code only, not doc headings) for @symbol mentions", async () => {
    const { host, index } = make();
    await index.build(host);
    const names = index.symbols().map((c) => c.symbol);
    expect(names).toEqual(expect.arrayContaining(["routes_command", "Group", "Group.add_command", "Config", "Config.from_file", "test_routes_output"]));
    expect(names).not.toContain("Open a Shell");
    expect(index.symbols().every((c) => SYMBOL_KINDS.has(c.kind))).toBe(true);
  });

  it("skips files over 300 KB and counts them", async () => {
    const host = new FakeHost({ "big.py": `x = "${"a".repeat(MAX_FILE_CHARS + 10)}"`, "small.py": "def f():\n    pass\n" });
    const index = new ContextIndex();
    const stats = await index.build(host);
    expect(index.files()).toEqual(["small.py"]);
    expect(stats.skippedLarge).toBe(1);
  });

  it("noise files (lock files, minified, maps) are not indexed", async () => {
    const host = new FakeHost({ "uv.lock": "x = 1", "app.min.js": "var a", "a.js.map": "{}", "ok.py": "def f(): pass" });
    const index = new ContextIndex();
    await index.build(host);
    expect(index.files()).toEqual(["ok.py"]);
  });

  it("update() re-indexes a changed file from its current text and drops the old content", async () => {
    const { host, index } = make();
    await index.build(host);
    expect(index.search("brand_new_helper")).toEqual([]);
    host.files["src/app/config.py"] = "def brand_new_helper():\n    return 1\n";
    await index.update(host, "src/app/config.py");
    expect(index.search("brand_new_helper")[0]?.chunk).toMatchObject({ path: "src/app/config.py", symbol: "brand_new_helper" });
    expect(index.search("from_file")).toEqual([]);
    expect(index.files()).toContain("src/app/config.py");
  });

  it("update() of a new file adds it; of a deleted file removes it; remove() drops a file", async () => {
    const { host, index } = make();
    await index.build(host);
    host.files["src/new.py"] = "def fresh():\n    pass\n";
    await index.update(host, "src/new.py");
    expect(index.search("fresh")[0]?.chunk.path).toBe("src/new.py");
    delete host.files["src/new.py"];
    await index.update(host, "src/new.py");
    expect(index.hasFile("src/new.py")).toBe(false);
    index.remove("tests/test_cli.py");
    expect(index.hasFile("tests/test_cli.py")).toBe(false);
    expect(index.search("test_routes_output").some((h) => h.chunk.path === "tests/test_cli.py")).toBe(false);
  });

  it("an update racing a build never leaves duplicates", async () => {
    const { host, index } = make();
    const building = index.build(host);
    await index.update(host, "src/app/cli.py");
    await building;
    const count = index.search("routes_command").filter((h) => h.chunk.symbol === "routes_command").length;
    expect(count).toBe(1);
  });

  it("build is abortable and leaves an empty (not half-ready) index", async () => {
    const ctrl = new AbortController();
    const files = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}.py`, `def f${i}():\n    pass\n`]));
    const host = new FakeHost(files, { onRead: (n) => n === 10 && ctrl.abort() });
    const index = new ContextIndex();
    await expect(index.build(host, { signal: ctrl.signal })).rejects.toThrow();
    expect(index.state).toBe("empty");
    expect(index.files()).toEqual([]);
    expect(host.readCalls.length).toBeLessThan(40);
  });

  it("yields to the event loop while building many files", async () => {
    const spy = vi.spyOn(globalThis, "setImmediate");
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`f${i}.py`, `def f${i}():\n    pass\n`]));
    await new ContextIndex().build(new FakeHost(files));
    expect(spy.mock.calls.length).toBeGreaterThanOrEqual(4);
  });

  it("whenReady resolves true once built, false after the timeout, and never rejects", async () => {
    const { host, index } = make();
    expect(await index.whenReady(20)).toBe(false);
    const waiting = index.whenReady(2000);
    await index.build(host);
    expect(await waiting).toBe(true);
    expect(await index.whenReady(1)).toBe(true);
  });

  it("joins a build already in progress instead of starting another", async () => {
    const { host, index } = make();
    const a = index.build(host);
    const b = index.build(host);
    expect(a).toBe(b);
    await a;
    expect(host.readCalls.filter((p) => p === "src/app/cli.py")).toHaveLength(1);
  });

  it("honours the file and chunk caps and says so", async () => {
    const files = Object.fromEntries(Array.from({ length: 30 }, (_, i) => [`f${i}.py`, `def f${i}():\n    pass\n`]));
    const capped = new ContextIndex({ maxFiles: 10 });
    expect((await capped.build(new FakeHost(files))).truncated).toBe(true);
    expect(capped.files()).toHaveLength(10);
    const fewChunks = new ContextIndex({ maxChunks: 5 });
    const stats = await fewChunks.build(new FakeHost(files));
    expect(stats.truncated).toBe(true);
    expect(stats.chunks).toBe(5);
  });

  it("is deterministic across builds", async () => {
    const a = new ContextIndex();
    const b = new ContextIndex();
    await a.build(new FakeHost({ ...FILES }));
    await b.build(new FakeHost({ ...FILES }));
    const q = "routes command cli";
    expect(a.search(q).map((h) => [h.chunk.path, h.chunk.startLine, h.score])).toEqual(b.search(q).map((h) => [h.chunk.path, h.chunk.startLine, h.score]));
  });
});
