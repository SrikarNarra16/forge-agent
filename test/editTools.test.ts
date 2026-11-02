import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { DecisionStore, decisionKey, type EditDecision } from "../src/mcp/decisions";
import { formatDecision, keyForCall, parseEditArgs, runCreateFile, runProposeEdit } from "../src/mcp/tools/editTools";
import { registerTools } from "../src/mcp/tools/index";
import { FakeHost, makeRig, textOf } from "./helpers/fakeHost";

const ARGS = { path: "src/a.py", edits: [{ old_text: "return 1", new_text: "return 2" }], summary: "bump" };
const decision = (over: Partial<EditDecision> = {}): EditDecision => ({ path: "src/a.py", kind: "edit", applied: 1, total: 1, added: 1, removed: 1, rejected: [], ...over });

function rigWithStore() {
  const rig = makeRig();
  const decisions = new DecisionStore();
  return { ...rig, decisions, deps: { ...rig.deps, decisions } };
}

describe("formatDecision", () => {
  it("reports applied hunks with line stats", () => {
    expect(formatDecision(decision({ applied: 3, total: 3, added: 12, removed: 4 }))).toBe("applied 3 of 3 hunks (+12 -4 lines) to src/a.py");
  });
  it("lists what was rejected", () => {
    expect(formatDecision(decision({ applied: 2, total: 3, rejected: ["hunk 2 (line 40): + foo", "hunk 3 (line 90): - bar"] }))).toBe(
      "applied 2 of 3 hunks (+1 -1 lines) to src/a.py; rejected: hunk 2 (line 40): + foo; hunk 3 (line 90): - bar",
    );
  });
  it("reports created files", () => {
    expect(formatDecision(decision({ kind: "create", path: "src/new.py", added: 7, removed: 0, applied: 1, total: 1 }))).toBe("created src/new.py (+7 lines)");
  });
});

describe("parseEditArgs / keyForCall", () => {
  it("parses objects and JSON strings, stripping unknown keys, so the key is the same either way", () => {
    const fromString = keyForCall("propose_edit", JSON.stringify({ summary: "bump", edits: [{ new_text: "return 2", old_text: "return 1", extra: 1 }], path: "src/a.py", unknown_field: true }));
    expect(fromString).toBe(keyForCall("propose_edit", ARGS));
    expect(fromString).toBe(decisionKey("propose_edit", ARGS));
  });
  it("gives a different key for different arguments or tools", () => {
    expect(keyForCall("propose_edit", { ...ARGS, summary: "other" })).not.toBe(keyForCall("propose_edit", ARGS));
    expect(keyForCall("create_file", { path: "a", content: "x", summary: "s" })).not.toBe(keyForCall("propose_edit", ARGS));
  });
  it("teaches on invalid JSON, wrong shapes and empty values", () => {
    expect(parseEditArgs("propose_edit", "{not json")).toMatchObject({ ok: false, error: expect.stringContaining("not valid JSON") });
    expect(parseEditArgs("propose_edit", { path: "a" })).toMatchObject({ ok: false, error: expect.stringContaining("Invalid arguments for propose_edit") });
    expect(parseEditArgs("propose_edit", { ...ARGS, edits: [] })).toMatchObject({ ok: false, error: expect.stringContaining("at least one edit") });
    expect(parseEditArgs("propose_edit", { ...ARGS, summary: "  " })).toMatchObject({ ok: false, error: expect.stringContaining("`summary` is required") });
    expect(parseEditArgs("create_file", { path: "a", summary: "s" })).toMatchObject({ ok: false, error: expect.stringContaining("Invalid arguments for create_file") });
    expect(keyForCall("propose_edit", { nope: 1 })).toBeUndefined();
  });
});

describe("propose_edit / create_file handlers: they report decisions and never write", () => {
  it("reports an applied decision and consumes it (a second identical call is not approved)", async () => {
    const { deps, decisions } = rigWithStore();
    decisions.put(keyForCall("propose_edit", ARGS)!, decision({ applied: 2, total: 3, added: 5, removed: 2, rejected: ["hunk 2 (line 9): + x"] }));
    const first = await runProposeEdit(deps, ARGS);
    expect(first.isError).toBeFalsy();
    expect(textOf(first)).toBe("applied 2 of 3 hunks (+5 -2 lines) to src/a.py; rejected: hunk 2 (line 9): + x");
    const second = await runProposeEdit(deps, ARGS);
    expect(second.isError).toBe(true);
    expect(textOf(second)).toMatch(/^not approved/);
  });

  it("identical calls get their decisions in FIFO order", async () => {
    const { deps, decisions } = rigWithStore();
    const key = keyForCall("propose_edit", ARGS)!;
    decisions.put(key, decision({ applied: 1, total: 2 }));
    decisions.put(key, decision({ applied: 2, total: 2 }));
    expect(textOf(await runProposeEdit(deps, ARGS))).toContain("applied 1 of 2");
    expect(textOf(await runProposeEdit(deps, ARGS))).toContain("applied 2 of 2");
  });

  it("without a recorded decision it is an error 'not approved' that teaches, and changes nothing", async () => {
    const { deps } = rigWithStore();
    const r = await runProposeEdit(deps, ARGS);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toMatch(/^not approved.*nothing was changed.*Do not retry the identical call/s);
  });

  it("a decision that applied nothing reports the rejection as an error", async () => {
    const { deps, decisions } = rigWithStore();
    decisions.put(keyForCall("propose_edit", ARGS)!, decision({ applied: 0, total: 2 }));
    const r = await runProposeEdit(deps, ARGS);
    expect(r.isError).toBe(true);
    expect(textOf(r)).toBe("User rejected all changes to src/a.py");
  });

  it("does not use a decision recorded for different arguments", async () => {
    const { deps, decisions } = rigWithStore();
    decisions.put(keyForCall("propose_edit", { ...ARGS, summary: "something else" })!, decision());
    expect((await runProposeEdit(deps, ARGS)).isError).toBe(true);
  });

  it("create_file reports created files", async () => {
    const { deps, decisions } = rigWithStore();
    const args = { path: "src/new.py", content: "x = 1\n", summary: "new module" };
    decisions.put(keyForCall("create_file", args)!, decision({ kind: "create", path: "src/new.py", added: 1, removed: 0 }));
    expect(textOf(await runCreateFile(deps, args))).toBe("created src/new.py (+1 lines)");
  });

  it("malformed arguments are not approved either", async () => {
    const { deps } = rigWithStore();
    expect((await runProposeEdit(deps, { garbage: true })).isError).toBe(true);
    expect((await runCreateFile(deps, undefined)).isError).toBe(true);
  });

  it("honours an aborted signal and logs only a content-free summary", async () => {
    const { deps, logs, decisions } = rigWithStore();
    decisions.put(keyForCall("propose_edit", ARGS)!, decision());
    const ctrl = new AbortController();
    ctrl.abort();
    expect(textOf(await runProposeEdit(deps, ARGS, ctrl.signal))).toBe("Cancelled.");
    await runProposeEdit(deps, ARGS);
    expect(logs.join("\n")).not.toContain("return 1");
    expect(logs.at(-1)).toMatch(/^tool propose_edit \d+ms ok path="src\/a\.py" edits=1$/);
  });
});

describe("edit tools over MCP (what TrueForge actually sends)", () => {
  let client: Client;
  let server: McpServer;
  let decisions: DecisionStore;

  beforeEach(async () => {
    const rig = makeRig();
    decisions = new DecisionStore();
    server = new McpServer({ name: "forge-editor", version: "0" });
    registerTools(server, new FakeHost({}), { ...rig.deps, decisions });
    client = new Client({ name: "t", version: "0" });
    const [a, b] = InMemoryTransport.createLinkedPair();
    await Promise.all([server.connect(a), client.connect(b)]);
  });
  afterEach(async () => {
    await client.close();
    await server.close();
  });

  it("the decision recorded from the model's raw JSON string is found by the tool call the SDK parsed", async () => {
    // The approval handler sees the model's raw argument string (different key order, extra field) ...
    const rawFromModel = JSON.stringify({ summary: "bump", unknown: 1, edits: [{ new_text: "return 2", old_text: "return 1" }], path: "src/a.py" });
    decisions.put(keyForCall("propose_edit", rawFromModel)!, decision());
    // ... and the tool is called with the arguments after the SDK's own validation.
    const res = await client.callTool({ name: "propose_edit", arguments: JSON.parse(rawFromModel) as Record<string, unknown> });
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res.content)).toContain("applied 1 of 1 hunks");
  });

  it("is not approved without a decision, and writes nothing (the host has no write API at all)", async () => {
    const res = await client.callTool({ name: "create_file", arguments: { path: "x.py", content: "x", summary: "s" } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("not approved");
  });

  it("describes the tools in a way that teaches (what the model reads)", async () => {
    const { tools } = await client.listTools();
    const propose = tools.find((t) => t.name === "propose_edit")!;
    for (const phrase of ["EXACTLY ONCE", "ONE existing file", "read_file", "conventions", "Never tell the user a change is made until the result says 'applied'"]) expect(propose.description).toContain(phrase);
    const create = tools.find((t) => t.name === "create_file")!;
    for (const phrase of ["already exists", "propose_edit", "conventions", "result says 'created'"]) expect(create.description).toContain(phrase);
    expect(propose.inputSchema.required).toEqual(expect.arrayContaining(["path", "edits", "summary"]));
    expect(create.inputSchema.required).toEqual(expect.arrayContaining(["path", "content", "summary"]));
  });
});
