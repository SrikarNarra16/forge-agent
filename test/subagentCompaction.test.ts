import { describe, expect, it } from "vitest";
import { TurnReducer, type StreamEvent } from "../src/trueforge/events";
import { Transcript } from "../src/ui/transcript";
import { metaToolHeadline, toolCardModel, type ToolItem } from "../src/ui/webview/format";
import { at, modelMessage, turnCreated } from "./helpers/events";

/** Synthetic events shaped like the SDK types (thread.created / thread.done / thread.context_compaction_*). */
const threadCreated = (threadId: string, title: string): StreamEvent =>
  ({ type: "thread.created", id: `e-${threadId}`, threadId, title, createdAt: at(2), parent: { threadId: "main", toolCallId: "call_sub" }, agentInfo: { model: { name: "m" } } }) as unknown as StreamEvent;
const threadDone = (threadId: string, status: "done" | "error", title = "scout"): StreamEvent =>
  ({ type: "thread.done", id: `d-${threadId}`, threadId, title, createdAt: at(9), state: { status } }) as unknown as StreamEvent;
const compaction = (kind: "started" | "finished", durationMs = 2500): StreamEvent =>
  ({ type: `thread.context_compaction_${kind}`, id: `c-${kind}`, threadId: "main", createdAt: at(5), ...(kind === "finished" ? { durationMs } : {}) }) as unknown as StreamEvent;

function feed(events: StreamEvent[], reducer = new TurnReducer(), transcript = new Transcript()) {
  for (const e of events) {
    const change = reducer.apply(e);
    transcript.applyTurn(reducer.view, change);
  }
  return { reducer, transcript };
}

describe("subagent blocks", () => {
  const events = [
    turnCreated(),
    modelMessage({ id: "m1", calls: [{ id: "call_sub", name: "create_sub_agent", args: '{"instructions":"find similar built-ins"}' }], finish: "tool_calls" }),
    threadCreated("t-scout", "scout"),
    modelMessage({ id: "m2", threadId: "t-scout", calls: [{ id: "call_s1", name: "search_code", args: '{"query":"routes_command"}' }], finish: "tool_calls" }),
    modelMessage({ id: "m3", threadId: "t-scout", content: "tests/test_cli.py:446 - TestRoutes", finish: "stop" }),
    threadDone("t-scout", "done"),
  ];

  it("creates one subagent item per thread, tags its messages and tool calls with the thread, and updates its state", () => {
    const { transcript } = feed(events);
    const sub = transcript.items.find((i) => i.kind === "subagent");
    expect(sub).toEqual({ kind: "subagent", id: "sub-t-scout", thread: "t-scout", title: "scout", state: "done" });
    const children = transcript.items.filter((i) => (i.kind === "tool" || i.kind === "assistant") && i.thread === "t-scout");
    expect(children.map((c) => c.kind)).toEqual(["tool", "assistant"]);
    // the root agent's create_sub_agent call is a normal card without a thread
    expect(transcript.items.find((i) => i.kind === "tool" && i.name === "create_sub_agent")).not.toHaveProperty("thread");
    // the subagent block precedes its children
    const order = transcript.items.map((i) => i.id);
    expect(order.indexOf("sub-t-scout")).toBeLessThan(order.indexOf("call_s1"));
  });
  it("shows a running subagent and an errored one", () => {
    const running = feed(events.slice(0, 3)).transcript.items.find((i) => i.kind === "subagent");
    expect(running).toMatchObject({ state: "running" });
    const failed = feed([...events.slice(0, 3), threadDone("t-scout", "error")]).transcript.items.find((i) => i.kind === "subagent");
    expect(failed).toMatchObject({ state: "error" });
  });
});

describe("compaction divider", () => {
  it("adds one 'Context compacted' divider per finished compaction, with its duration", () => {
    const { transcript } = feed([turnCreated(), compaction("started"), modelMessage({ id: "m1", content: "hi", finish: "stop" }), compaction("finished", 2500), compaction("started"), compaction("finished", 1000)]);
    const dividers = transcript.items.filter((i) => i.kind === "divider");
    expect(dividers.map((d) => (d.kind === "divider" ? d.text : ""))).toEqual(["Context compacted (2.5 s)", "Context compacted (1.0 s)"]);
    expect(new Set(dividers.map((d) => d.id)).size).toBe(2);
  });
  it("does not add a divider while a compaction is only running, and a new run starts counting again", () => {
    const transcript = new Transcript();
    feed([turnCreated(), compaction("started")], new TurnReducer(), transcript);
    expect(transcript.items.filter((i) => i.kind === "divider")).toHaveLength(0);
    feed([compaction("finished")], new TurnReducer(), transcript); // run 1 ends with 1 compaction
    transcript.addUser("second request"); // a new run starts with a fresh reducer
    feed([compaction("finished")], new TurnReducer(), transcript); // and also compacts once
    expect(transcript.items.filter((i) => i.kind === "divider")).toHaveLength(2);
  });
  it("clear() forgets dividers and subagents", () => {
    const { transcript } = feed([turnCreated(), compaction("finished"), threadCreated("t", "x")]);
    transcript.clear();
    expect(transcript.items).toEqual([]);
  });
});

describe("deferred-loading meta tools (shapes recorded from a live TrueForge run)", () => {
  const tool = (name: string, args: unknown): ToolItem => ({ kind: "tool", id: name, name, argsSummary: "", args: JSON.stringify(args), status: "done" });
  it("show which tool they list, describe or call", () => {
    expect(metaToolHeadline(tool("list_tools", { mcp_server: "forge-editor-extras" }))).toBe("list tools of forge-editor-extras");
    expect(metaToolHeadline(tool("get_tool_info", { mcp_server: "forge-editor-extras", tool_name: "git_diff" }))).toBe("describe git_diff via forge-editor-extras");
    expect(metaToolHeadline(tool("call_tool", { mcp_server: "forge-editor-extras", tool_name: "git_diff", input: { path: "src/flask/cli.py" } }))).toBe("git_diff via forge-editor-extras");
    expect(metaToolHeadline(tool("read_file", { path: "a" }))).toBeUndefined();
    expect(metaToolHeadline({ name: "call_tool", args: "{" })).toBeUndefined();
    expect(toolCardModel(tool("call_tool", { mcp_server: "s", tool_name: "git_status" })).headline).toBe("git_status via s");
  });
});
