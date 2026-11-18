# Forge: one-page walkthrough (for a live judging call)

Forge is a VS Code extension; the agent loop runs on **TrueForge (local mode)**. The extension is only a client: it creates sessions/turns with `@truefoundry/trueforge-sdk`, renders the streamed events, and serves the editor's capabilities as MCP tools on `127.0.0.1`. Nothing is written to disk until the user has reviewed the diff.

## 1. Architecture, rubric item by rubric item
| Rubric item | Where it lives |
|---|---|
| Agent runs on TrueForge, not in the extension | `src/trueforge/agentController.ts` (turns, SSE stream, approvals, Stop, resume), `client.ts` / `sdkAdapter.ts` (SDK only), agent definitions `agents/forge-agent.json`, `agents/forge-inline.json`. Guard: `test/noDirectProvider.test.ts` (no provider URL or SDK, only the TrueForge health check opens a socket) |
| Editor capabilities are MCP tools | `src/mcp/server.ts` (HTTP, bearer token), tools in `src/mcp/tools/` (`read_file`, `search_code`, `repo_map`, `list_dir`, `get_symbols`, `get_diagnostics`, `run_command`, `propose_edit`, `create_file`; extras `git_status`, `git_diff`, `find_references`, `open_in_editor` as a second, on-demand server); registered by `src/trueforge/mcpRegistration.ts` |
| A1 inline edit | `src/inline/` (selection + instruction -> `forge-inline` agent), `review/codeLens.ts` (per-hunk Accept/Reject) |
| A2 agent mode, multi-file | panel `src/ui/panel.ts` + `src/ui/webview/`; Task B touches `src/flask/cli.py`, `tests/test_cli.py`, `docs/cli.rst` |
| A3 streaming and cancel | `agentController.ts` (stream -> `trueforge/events.ts` reducer -> `ui/batcher.ts`); Stop = `sessions.cancel` then wait for `turn.done: cancelled`, then rollback (`review/checkpoints.ts`) |
| B1 context assembly | `src/context/` (BM25 index, ranking, token budget, @mentions), shown in the panel's Context section (`ui/webview/contextView.ts`) |
| B2 diff safety | `review/reviewHandler.ts` (TrueForge approval -> review), `review/applier.ts` (the only writer; one `WorkspaceEdit` = one undo step), `review/hunks.ts`; `test/writeIsolation.test.ts` |
| B3 resilience | `trueforge/modelChain.ts` + `agentController.ts` (retry 0.5 s / 1.5 s, then the next model in a new session) |
| B4 TrueForge depth | `require_approval_for_tools` per tool name, deferred tool loading (`forge-editor-extras` has `preload:false`, so the agent uses `list_tools` / `get_tool_info` / `call_tool`), dynamic-subagent permission in the instructions, compaction configured in `agents/forge-agent.json`; the Sessions page shows all of it |
| C1 video / write-up | `docs/SUBMISSION.md`, `docs/writeup/WRITEUP.md`, `Forge-writeup.pdf` |

## 2. Repeat Task A live with a model the organisers choose
1. TrueForge running: `npm run tf:start` (pinned 0.183.1, loopback allowed for the MCP server). Open http://localhost:8790 .
2. Make the model available to TrueForge. If the organiser gives a provider and key: `export <VAR>=<key>`, add the provider and model to `trueforge/models.local.json` (copy of `models.example.json`; keys are read from environment variables only) and run `npm run tf:setup`. Or add it in the TrueForge web UI (model providers settings); either way it appears as `provider/model`.
3. In VS Code (Flask 3.1.3 checkout open, Forge installed): Command Palette -> **Forge: Switch Model** -> pick `provider/model` (it becomes the first entry of `forge.models`; the next message starts a new session on it).
4. Open `src/flask/helpers.py`, select the function `get_debug_flag` (all lines), press **Cmd+Alt+K** (Ctrl+Alt+K elsewhere), type: *treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value*, Enter.
5. A diff opens with **Accept hunk / Reject hunk** above each change. Accept both (or **Accept all**), **Apply accepted** in the panel (or Cmd+Enter).
6. Verify in a terminal: `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` prints `False` (or `scripts/verify-task-a.sh`: 19 checks).
7. Show the run in TrueForge: panel -> **Open in TrueForge** opens the session in the Sessions page (turns, tool calls, the approval pause on `propose_edit`).
8. If the model fails: the panel names the model and the provider message; the workspace is untouched (`git status` clean). Known results per model: `docs/model-matrix.md`.

## 3. Likely questions (short, accurate answers)
1. **Where does the agent loop run?** In TrueForge. The extension creates a session on the `forge-agent` (or `forge-inline`) agent and sends turns; TrueForge calls the model and the tools.
2. **How does the model touch my files?** Only through MCP tools served by the extension. Reads are direct; edits are `propose_edit` / `create_file`, which TrueForge pauses for approval (`require_approval_for_tools` lists the tool names explicitly).
3. **What is the approval flow?** The stream ends with `tool.approval_required`; the extension shows a diff (or a command card), the user decides, and the extension resumes with a NEW turn carrying `user.tool_approval` items (allow / deny + reason). A rejected hunk is reported back to the model in the tool result.
4. **How is context chosen?** BM25 over identifier-aware tokens (symbol x3, path x2, signature x2), at most 2 chunks per file, test/doc intent boosts, fitted to a token budget (default 6000, safety factor 1.15, pinned @mentions up to half). The Context section lists each item with its reason and the budget. The agent can read more with its own tools.
5. **Is there an index/embeddings?** A local BM25 index built in the extension, no network, no embeddings (deterministic, fast). Rebuild with **Forge: Rebuild Context Index**.
6. **How is undo one step?** The applier applies all accepted hunks of a file in one `WorkspaceEdit`, so one Cmd+Z reverts it (tested in the real editor: `docs/e2e-results.md`). **Undo run** restores every file of a run from checkpoints.
7. **How does Stop work?** `sessions.cancel(sessionId)`; the stream ends itself with `turn.done` (status `cancelled`); pending reviews are closed and, with `forge.rollbackOnCancel` (default on), edits of the run are rolled back.
8. **What if the provider fails?** Transient errors are retried twice (0.5 s, 1.5 s); unreachable / bad key move on at once. TrueForge has no built-in fallback, so Forge retries the request in a new session on the next model of `forge.models` (still via TrueForge) and says so in the panel; the earlier conversation turns are not carried over.
9. **Can the editor freeze?** No synchronous file or CPU work on the extension host path; streaming updates are batched; large files are refused instead of diffed.
10. **What does `run_command` do?** Runs a shell command in the workspace (venv auto-activated) after an Allow click. Opt-in settings auto-allow read-only and test commands by strict patterns; anything with pipes, redirects or secrets always asks.
11. **Is anything sent to a provider directly?** No. All LLM traffic goes through TrueForge (guard test). Keys live in TrueForge's provider settings / environment variables, never in the repo.
12. **Which TrueForge features are used?** Sessions, turns, streaming (SSE), per-tool approvals, MCP servers (one preloaded, one deferred, loaded with `list_tools`/`get_tool_info`/`call_tool`), model overrides per session, cancel, turn resume (re-attach after a dropped stream), compaction configured (not triggered in our runs: largest call about 24k input tokens versus the 80,000 trigger), dynamic-subagent permission (the Task B instructions allow one read-only scout; see the write-up for whether it ran).
13. **What are the Task results?** Task A passes 19/19 checks on the DeepSeek models (headless 19/19 on `deepseek/flash`; real editor runs in `docs/e2e-results.md`); Task B passes its 7 checks in the measured runs but varies between runs (`docs/eval-results.md`).
14. **What is not done?** Local TrueForge only; POSIX shells only (no Windows commands); no embeddings; fallback does not carry the earlier turns; Task B evaluated on DeepSeek only; the demo video is an automated run (no narration); compaction was configured but never triggered in our runs.
15. **How was it built?** From scratch in TypeScript with Claude Code as the coding assistant (see the write-up); no upstream fork.

## 4. Troubleshooting
| Symptom | Fix |
|---|---|
| Status bar `TrueForge: disconnected` | `npm run tf:start`; check `forge.trueforge.baseUrl` |
| MCP / tool errors | TrueForge was not started with `npm run tf:start` (needs `OUTBOUND_URL_ALLOWED_HOSTS`); Node >= 22.14 |
| Sessions page blank | A newer TrueForge replaced the UI files; stop it, `npm run tf:start` (data is kept) |
| No Accept/Reject buttons | `diffEditor.codeLens` must be on (Forge enables it); fall back to the panel buttons or Cmd+Enter |
| Model 503 / 429 / 400 | Provider-side; pick another model (**Forge: Switch Model**); see `docs/model-matrix.md` |
| Key invalid | re-export the key, `npm run tf:setup` |
| Commands fail with "No module named flask" | open the Flask checkout that has `.venv` (or set `forge.commandPrefix`) |
| Stale extension after a code change | `npm run package`, `code --install-extension forge-agent-0.0.1.vsix --force`, reload the window |
