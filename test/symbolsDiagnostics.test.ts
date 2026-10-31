import { describe, expect, it } from "vitest";
import type { DiagnosticInfo, SymbolInfo } from "../src/mcp/host";
import { runGetDiagnostics } from "../src/mcp/tools/getDiagnostics";
import { runGetSymbols } from "../src/mcp/tools/getSymbols";
import { FIXTURE_FILES, FIXTURE_GITIGNORE, FakeHost, makeRig, textOf } from "./helpers/fakeHost";

const SYMBOLS: Record<string, SymbolInfo[]> = {
  "src/app/helpers.py": [
    { name: "get_debug_flag", kind: "function", line: 4, endLine: 7 },
    { name: "Helper", kind: "class", line: 10, endLine: 12, children: [{ name: "run", kind: "method", line: 11, endLine: 12 }] },
  ],
};

const DIAGNOSTICS: DiagnosticInfo[] = [
  { path: "tests/test_helpers.py", line: 2, column: 3, severity: "warning", message: "unused" },
  { path: "src/app/helpers.py", line: 7, column: 12, severity: "error", message: 'Undefined name "val"', source: "pyright" },
  { path: "src/app/helpers.py", line: 1, column: 1, severity: "hint", message: "import os is unused" },
];

describe("get_symbols", () => {
  it("renders language-server symbols nested with line ranges", async () => {
    const host = new FakeHost(FIXTURE_FILES, { symbols: SYMBOLS });
    const text = textOf(await runGetSymbols(host, makeRig().deps, { path: "src/app/helpers.py" }));
    expect(text.split("\n")).toEqual([
      "Symbols in src/app/helpers.py (language server):",
      "function get_debug_flag L4-7",
      "class Helper L10-12",
      "  method run L11-12",
    ]);
  });

  it("falls back to regex when the language server returns nothing", async () => {
    const host = new FakeHost(FIXTURE_FILES, { gitignore: FIXTURE_GITIGNORE });
    const text = textOf(await runGetSymbols(host, makeRig().deps, { path: "src/app/helpers.py" }));
    expect(text).toContain("regex fallback");
    expect(text).toContain("function get_debug_flag L4");
    expect(text).toContain("class Helper L10");
  });

  it("explains files without symbols and teaches on bad paths", async () => {
    const host = new FakeHost(FIXTURE_FILES);
    const { deps } = makeRig();
    expect(textOf(await runGetSymbols(host, deps, { path: "README.md" }))).toMatch(/No symbols found in README\.md/);
    expect(textOf(await runGetSymbols(host, deps, { path: "nope.py" }))).toMatch(/Not found: nope\.py.*search_code with kind=path/s);
    expect((await runGetSymbols(host, deps, { path: ".git/config" })).isError).toBe(true);
    expect((await runGetSymbols(host, deps, { path: "" })).isError).toBe(true);
  });
});

describe("get_diagnostics", () => {
  it("lists sorted diagnostics with counts", async () => {
    const host = new FakeHost(FIXTURE_FILES, { diagnostics: DIAGNOSTICS });
    const text = textOf(await runGetDiagnostics(host, makeRig().deps, {}));
    expect(text.split("\n")).toEqual([
      "3 diagnostics in the workspace (1 errors, 1 warnings):",
      "src/app/helpers.py:1:1 hint: import os is unused",
      'src/app/helpers.py:7:12 error [pyright]: Undefined name "val"',
      "tests/test_helpers.py:2:3 warning: unused",
    ]);
  });

  it("narrows to a path", async () => {
    const host = new FakeHost(FIXTURE_FILES, { diagnostics: DIAGNOSTICS });
    const text = textOf(await runGetDiagnostics(host, makeRig().deps, { path: "tests/test_helpers.py" }));
    expect(text).toContain("1 diagnostics in tests/test_helpers.py");
    expect(host.diagnosticCalls).toEqual(["tests/test_helpers.py"]);
  });

  it("says that an empty result is not proof of correctness", async () => {
    const host = new FakeHost(FIXTURE_FILES);
    expect(textOf(await runGetDiagnostics(host, makeRig().deps, {}))).toMatch(/No diagnostics reported for the workspace.*does not prove/s);
  });

  it("caps long lists and rejects unsafe paths", async () => {
    const many: DiagnosticInfo[] = Array.from({ length: 130 }, (_, i) => ({ path: "a.py", line: i + 1, column: 1, severity: "error", message: "e" }));
    const host = new FakeHost({ "a.py": "x" }, { diagnostics: many });
    const { deps } = makeRig();
    expect(textOf(await runGetDiagnostics(host, deps, {}))).toContain("[30 more diagnostics omitted; pass a path to narrow down]");
    expect((await runGetDiagnostics(host, deps, { path: "../x" })).isError).toBe(true);
  });
});
