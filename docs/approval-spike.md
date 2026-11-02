# TrueForge tool approvals: what really happens (P04 spike)

Captured on 2 Nov 2026 against a live local TrueForge (v0.182.x) with model `deepseek/flash`, driving the real `AgentController` plus a recording client. Everything below is quoted from `test/fixtures/approval/*.jsonl` (one JSON object per line: `{"turn":N,"input":[...]}` marks a turn and its request body, `{"turn":N,"event":{...}}` is a streamed event). Session ids and the MCP URL/token are redacted; ids/timestamps are otherwise untouched. Long `usage`/`metrics` objects are trimmed in this document only.

**Setup.** A throwaway MCP server `forge-spike-mcp` (tools `echo_write(text)` and `echo_read()`) and a throwaway agent `forge-spike` whose spec has `require_approval_for_tools: ["echo_write"]` (a name, not a `@write` label). The user's `forge-agent`/`forge-editor` were never touched; the script snapshots agents/MCP servers/sessions before and after and reported identical state. About 14 model calls. The script (`scripts/spike-approval.ts`) is kept only in git history.

## Summary

| Question | Answer |
|---|---|
| How does a gated call surface? | The turn **ends normally**: `tool.approval_required` is streamed, then `turn.done` with `state.status = "done"`, `output = null` and the same event inside `state.requiredActions`. There is **no `paused` status** on `turn.done` (the SDK's `TurnStatePaused` type is not what this path produces). |
| Resume | A NEW turn whose input is only `user.tool_approval` items. The new turn's `previousTurnId` is the paused turn. Works. |
| Allow | TrueForge runs the tool, streams `tool.response`, the agent continues in the same resumed turn (even calling further ungated tools without another pause). |
| Deny + reason | The tool does not run. `tool.response` carries `{"error": ... "User denied tool call: <reason>"}` and the model reports it. |
| Parallel calls | Two calls in one model message produce **one** `tool.approval_required` with two `toolCalls` (same `sourceEventId`) and one resume turn with two approval items. |
| Timeout while waiting | None observed: the paused turn is unchanged after 65 s and approving then works. Longer waits are untested. |
| New message while paused | **Accepted.** The session continues; the abandoned call can never be approved afterwards (HTTP 422). |

## a. Allow: approval_required -> allow -> tool runs -> agent continues

Turn 1 stream (non-delta events, `d_paused_state.jsonl`; the same shape appears in every scenario):

```json
{"type":"turn.created","id":"01m6d7gv6c9045bjb7fcmdsy75","turnId":"01m6d7gv6a84kd15zm48d82f5q","previousTurnId":null,"input":[{"type":"user.message","content":"Call echo_write exactly once with text 'delta', then tell me the result."}],"state":{"status":"running"},"createdAt":"2026-11-02T04:15:45.867Z","threadId":null}
{"type":"mcp.initialize","id":"01m6d7gv6j59j2qan3dv7ej8qe","createdAt":"2026-11-02T04:15:45.874Z","threadId":"main","mcpServers":[{"name":"forge-spike-mcp","id":"forge-spike-mcp","transportType":"streamable-http"}]}
{"type":"model.message","threadId":"main","createdAt":"2026-11-02T04:15:45.875Z","id":"01m6d7gv6kng7rqydxced16nr4","model":{"name":"deepseek/flash","params":{"maxTokens":8000}}}
... model.message.delta x N (tool call fragments, see "Tool-call deltas") ...
{"type":"tool.approval_required","id":"01m6d7gvy34vaq8f1r2jmmqwqw","createdAt":"2026-11-02T04:15:46.627Z","threadId":"main","toolCalls":[{"id":"call_00_ET_AnyemnTe2ygJLA6KsWHz9233","sourceEventId":"01m6d7gv6kng7rqydxced16nr4"}]}
{"type":"turn.done","id":"01m6d7gvy34vaq8f1r2jmmqwqx","createdAt":"2026-11-02T04:15:46.627Z","state":{"status":"done","output":null,"requiredActions":[{"type":"tool.approval_required","id":"01m6d7gvy34vaq8f1r2jmmqwqw","createdAt":"2026-11-02T04:15:46.627Z","threadId":"main","toolCalls":[{"id":"call_00_ET_AnyemnTe2ygJLA6KsWHz9233","sourceEventId":"01m6d7gv6kng7rqydxced16nr4"}]}],"completedAt":"2026-11-02T04:15:46.627Z"},"threadId":null}
```

Resume request body (SDK camelCase; wire is snake_case) and the resumed stream:

```json
{"input":[{"type":"user.tool_approval","threadId":"main","toolCallId":"call_00_ET_AnyemnTe2ygJLA6KsWHz9233","approval":{"status":"allow"}}]}
```
```json
{"type":"turn.created","turnId":"01m6d7jvdy9k6rjx0q5x1afsm4","previousTurnId":"01m6d7gv6a84kd15zm48d82f5q","input":[{"type":"user.tool_approval","threadId":"main","toolCallId":"call_00_ET_AnyemnTe2ygJLA6KsWHz9233","approval":{"status":"allow"}}],"state":{"status":"running"},"threadId":null}
{"type":"mcp.initialize", ...}
{"type":"tool.response","id":"01m6d7jveeq9axj0472kddvc0n","createdAt":"2026-11-02T04:16:51.662Z","threadId":"main","toolCallId":"call_00_ET_AnyemnTe2ygJLA6KsWHz9233","content":"appended \"delta\"; list is now [\"one\",\"two\",\"delta\"]"}
{"type":"model.message", ...}  ... deltas ...
{"type":"turn.done","state":{"status":"done","output":{"content":"The echo_write tool ran once and returned: appended \"delta\"; list is now [\"one\",\"two\",\"delta\"].","type":"model.message", ...,"finishReason":"stop"}, ...}}
```

Notes: `mcp.initialize` is emitted at the start of **every** turn. The `user.tool_approval` items are **not** echoed as events; they appear only in `turn.created.input`. Scenario `a_allow` shows the agent continuing past the approval and calling the ungated `echo_read` in the same resumed turn with no second pause (`tool.response` x2 in turn 2), proving gating is by tool name.

## b. Deny with a reason

Resume request (`b_deny.jsonl`, turn 2):

```json
{"input":[{"type":"user.tool_approval","threadId":"main","toolCallId":"call_00_ET_gf24O6puo5ow6QazQaVy5240","approval":{"status":"deny","reason":"User rejected: writes are not allowed in this test"}}]}
```

The tool did not run (`echo_write` list stayed empty). The agent's final answer: *"The echo_write call did not run — it returned an error saying "User denied tool call: User rejected: writes are not allowed in this test," so 'beta' was never appended."* So the reason string reaches the model verbatim: write it as an instruction the agent can act on (P05: e.g. "User rejected all hunks" / "User rejected hunks 2 and 3 because ...").

## c. Two parallel calls in one model message

One round, two items, same order as TrueForge listed them (`c_parallel.jsonl`):

```json
{"type":"tool.approval_required","threadId":"main","toolCalls":[{"id":"call_00_ET_QZEEiKPBou8i4iSO13R43809","sourceEventId":"01m6d7grj54b3f9fe935c3ervv"},{"id":"call_01_ET_Uy5xwyvTlr0jKGEQNTsV1611","sourceEventId":"01m6d7grj54b3f9fe935c3ervv"}]}
```
```json
{"input":[{"type":"user.tool_approval","threadId":"main","toolCallId":"call_00_ET_QZEEiKPBou8i4iSO13R43809","approval":{"status":"allow"}},{"type":"user.tool_approval","threadId":"main","toolCallId":"call_01_ET_Uy5xwyvTlr0jKGEQNTsV1611","approval":{"status":"allow"}}]}
```
In this run the two `decide()` calls started at the same instant (gap 0 ms) and finished out of order (the second one first, by design); the controller still sent the items in TrueForge's order. `tool.response` events then arrived in call order (`call_00` then `call_01`). deepseek/flash does emit parallel tool calls when asked.

## d. What the paused turn looks like, and does waiting matter

- **Stream** (non-delta): `turn.created, mcp.initialize, model.message, (deltas), tool.approval_required, turn.done`.
- **`turn.done.state`**: `{"status":"done","output":null,"requiredActions":[<the tool.approval_required event>],"completedAt":...}`. So a pause is detected by `requiredActions` / the streamed event, **not** by a `paused` status. `output` is `null` for a paused turn. (`metrics` are also present; trimmed.)
- **`GET turn`** right after: `status: "done"`, `output: null`, `requiredActions` length 1. **65 seconds later**: byte-for-byte the same state. Nothing expired.
- **Resuming after the 65 s wait** worked normally (`written: ["one","two","delta"]` shows the tool ran).

## e. `tool.response` for a denied call

```json
{"type":"tool.response","id":"01m6d7gqe7h39zs7cnhskjzmkf","createdAt":"2026-11-02T04:15:42.023Z","threadId":"main","toolCallId":"call_00_ET_gf24O6puo5ow6QazQaVy5240","content":"{\"error\":[{\"type\":\"text\",\"text\":\"{\\\"error\\\":\\\"User denied tool call: User rejected: writes are not allowed in this test\\\"}\"}]}"}
```
`content` is a (double-encoded) JSON error string. There is no dedicated "denied" field, so the UI must mark a call denied from **our own decision** (the reducer does: `noteApproval`), not from parsing this string.

## f. A new user message while a turn is paused (what Stop-during-approval leaves behind)

- Sending `{"type":"user.message", ...}` to the session while its last turn is paused on an approval is **accepted**: the new turn has `previousTurnId` = the paused turn and ends `done` with a normal answer (`f_new_message_while_paused.jsonl`).
- The old paused turn's recorded state is **unchanged** afterwards (`status: "done"`, `requiredActions` length 1); it is not marked cancelled/abandoned.
- Approving the abandoned call afterwards fails: `HTTP 422: thread main: messages[0] no pending approval for tool_call_id 'call_00_3KJQbhY8BPe2niv2mnFx5827'`.
- The abandoned tool never executed (`foxtrot` was never written).

**Decision:** after Stop during an approval pause (or an unsupported pause) the controller **continues the same session** (`DEFAULT_AFTER_PAUSE = "continue"`), and silently falls back to a new session if TrueForge ever rejects it. Not verified: how the model's history represents the abandoned call (the answer to "never mind, say hello" was sensible).

## Tool-call deltas (reducer input)

The first delta of a tool call carries everything needed to name it; later deltas only append argument text:

```json
{"type":"model.message.delta","id":"01m6d7gm45cac6kd5g0hj1xqrr","threadId":"main","toolCalls":[{"toolInfo":{"type":"mcp","name":"echo_write","serverId":"forge-spike-mcp","serverName":"forge-spike-mcp"},"index":0,"id":"call_00_VeZegE5WDnQTzeM0nxbB5575","type":"function","function":{"name":"echo_write","arguments":""}}]}
{"type":"model.message.delta","id":"...","threadId":"main","toolCalls":[{"index":0,"function":{"arguments":"{\""}}]}
```
`toolInfo.name` is the bare tool name (not namespaced by server), the same as `function.name`.

## Consequences for the implementation

1. Detect a pause from `tool.approval_required` / `turn.done.state.requiredActions` (deduplicate: it is the same event in both places). Never wait for a `paused` status.
2. Decide all pending calls concurrently, then send ONE resume turn with the items in the order TrueForge listed them.
3. A denied call's reason goes straight to the model: make it actionable. Mark denials from our own decision.
4. Stop during a pause needs no server-side cleanup: just stop asking. The next user message continues the session.
5. Waiting for a human (at least a minute) is safe. Re-test with a much longer wait before relying on it for, say, an hour-long review.
6. Every turn re-emits `mcp.initialize`; ignore it for UI purposes.

## Gotchas hit while doing the spike

- `sessions.list` rejects `limit > 25` (agents allow 100).
- Agents are deleted by **id**; MCP servers/providers cannot be deleted while a saved agent references them (delete the agent first).
- A bodyless request (TrueForge probes the MCP URL) crashed my first spike server's `JSON.parse`, which also skipped the script's cleanup: the leftovers (`forge-spike`, `forge-spike-mcp`) were removed by name afterwards and the script now cleans up on uncaught errors and signals too.
