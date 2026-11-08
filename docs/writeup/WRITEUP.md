**Forge: a coding agent for VS Code whose agent loop runs on TrueForge**

## Team

**Team name:** [[TEAM NAME]] · **Members:** [[MEMBERS]] · **Video (unlisted):** [[VIDEO URL]] · **Repository (public, MIT):** https://github.com/SrikarNarra16/forge-agent

## Starting point

Written from scratch in TypeScript (project rule: own code only): no fork and no upstream code, so there is no upstream URL or commit to declare. Size today: 102 source files (11,881 lines, extension host plus webview) and 9,536 lines of tests (1,029 unit tests, run in CI on every push). Runtime dependencies are the MCP SDK, the TrueForge SDK (`@truefoundry/trueforge-sdk`), `diff`, `ignore` and `zod`; the production dependency tree (94 packages) is MIT, ISC or BSD. TrueForge is v0.183.1 in local mode (SQLite), started by `npm run tf:start`, which sets `OUTBOUND_URL_ALLOWED_HOSTS` so its SSRF guard lets it reach the extension's loopback MCP server. The tasks run on Flask 3.1.3 at commit 22d92470.

## Architecture on TrueForge

```
 VS Code extension (client only)                         TrueForge, local mode           model provider
 panel + inline edit -> AgentController -- SDK/SSE ----> agent loop, sessions  ---------> DeepSeek (BYO key)
 review UI (diff + CodeLens)  <--- approval pause ------ tool approval by name
 applier (only writer) <- accepted hunks                       |  MCP over HTTP (bearer token)
 MCP server on 127.0.0.1  <------------------------------------+  tool calls
```

- **The extension is a TrueForge client.** It creates sessions and turns through the SDK, renders the streamed events, and cancels with `sessions.cancel`. It never calls a model provider.
- **Editor capabilities are MCP tools** served by the extension: `list_dir`, `repo_map`, `search_code`, `read_file` (which requires a `why`), `get_symbols`, `get_diagnostics`, and the gated `propose_edit`, `create_file`, `run_command`. A second server, `forge-editor-extras` (`git_status`, `git_diff`, `find_references`, `open_in_editor`), is attached with `preload:false` for TrueForge's deferred tool loading.
- **Approval drives the diff review.** The three gated tools are listed by name in `require_approval_for_tools`. The turn pauses with `tool.approval_required`; the extension opens a per-hunk review (CodeLens in VS Code's diff editor), applies the accepted hunks in ONE `WorkspaceEdit` (one undo step), then resumes the turn with allow, or deny plus a reason. The tool only reports what was written (`applied 2 of 3 hunks; rejected: hunk 1 ...`), so the agent adapts. The extension applies the edit itself, not the tool, because a tool that applied would deadlock two proposals for one file (review 2 would wait for a resume that waits for decision 2). A test fails if any file other than `src/review/applier.ts` can write.
- **Stop** marks the run cancelled, calls `sessions.cancel` without waiting for it, rejects pending approvals, kills running commands, lets an in-flight apply finish, and rolls the run back (`forge.rollbackOnCancel`, default on).
- **TrueForge features used (B4):** tool approval, MCP, deferred tool loading (the agent calls `list_tools`, `get_tool_info`, `call_tool` to reach `git_diff`: 5 of 5 v4-pro runs, and in the recorded Task B session), dynamic subagents and compaction enabled in the agent spec. Honestly: the optional scout subagent was never used (0 of 14 flash runs, 0 of 5 v4-pro runs) and compaction was never triggered in the runs inspected (largest call in the recorded Task B session: 24,269 input tokens, trigger 80,000), so neither is shown.
- **Trade-offs:** search/replace edits (`old_text` must match once) instead of whole-file rewrites: fewer output tokens, hunks map one to one to the review. A lexical index instead of embeddings, because the extension may not call providers. Fallback is client-side, because TrueForge has none.

## How context is selected

A local, deterministic index, no embeddings and no provider call. Files are chunked along the code (Python `def`/`class`, `.rst`/`.md` sections, other files in 60-line windows); BM25 (k1 1.2, b 0.75) with an identifier-aware tokenizer and field weights (symbol x3, path x2, signature x2), a rarity-gated exact-symbol boost, query bigrams and reciprocal-rank fusion over the sentences of a request. Before each turn the top items are packed into a `<context>` block under a hard budget (`forge.contextBudgetTokens`, default 6,000; tokens estimated as chars/4 x 1.15; the block is re-measured and items shed until it fits, enforced by a 400-case property test). `@file`/`@symbol` mentions are pinned first (at most half the budget). Every item carries its reason (`matches: cli, command, routes`), and every agent `read_file` carries its own `why`. **It is visible:** the panel's Context section lists Pinned, Auto-retrieved and Read-by-the-agent items with reasons, the budget bar and the retrieval time. Measured on Flask (222 files, about 1,600 chunks): index build 120-155 ms, retrieval median 1.0 ms. For Task B the three needed files (cli.py, tests/test_cli.py, docs/cli.rst) are all in the top 8. Honest numbers: the 14 tuning queries hit top-3 14 of 14, the 8 held-out queries only 5 of 8; Task B passes narrowly (the cli.py chunk found is `FlaskGroup.list_commands`, rank 8, not the registration site); the bare Task A instruction with no function named cannot be solved lexically.

## Model setup

Models are configured in TrueForge (`trueforge/models.example.json`, keys only through environment variables named by `apiKeyEnv`). All real runs used DeepSeek's hosted API as a custom OpenAI-compatible TrueForge provider, called by TrueForge only.

| TrueForge model | Where it runs | Role and results |
|---|---|---|
| `deepseek/flash` | DeepSeek API, BYO key (context 64k, max output 8k) | first in `forge.models`. Task A 19/19 headless runs; Task B 5/5 and 5/5 after tuning (4/4 at baseline), about 0.43-0.57M tokens and 55-67 s per run |
| `deepseek/v4-pro` | same provider | second in the chain. Task A 5/5, Task B 5/5, about 0.9M tokens and 167 s per run (about 2x the cost, 2.7x the time) |
| `groq/gpt-oss-120b` | Groq API | registered but unusable: TrueForge replays `reasoning_content` and Groq rejects it (HTTP 400), plus an 8,000 tokens-per-minute cap (429) |
| `broken-endpoint/broken`, `badkey-deepseek/flash` | demo-only: a refused connection, and the real URL with a fake key | Task C |

**Fallback (Task C):** `forge.models` is the chain. Transient failures are retried twice (0.5 s, 1.5 s); an unreachable endpoint or a bad key advances at once; a silent model (45 s to the first token, 90 s between outputs) is retried once, then skipped. The same request goes to the next model in a new TrueForge session, only if the failed attempt had no side effects (no edit, no file, no command). Measured: 11-39 ms to switch for the unreachable endpoint, 187-246 ms for an invalid key, 9 of 9 live fallback scenarios with a clean workspace. **Cost:** all development, evaluation and test runs recorded 21.8M tokens in our spend ledger (some entries are estimates), about $1.75 at the $0.08 per million tokens used by our spend guard (an estimate; DeepSeek's billing is authoritative). One Task A costs about 6k tokens, one Task B 0.33-0.56M tokens (about $0.03-0.05); the last full live verification (Tasks A, B, C plus one more Task B scenario) used 949,305 tokens, about $0.08.

## Scorecard with timestamps

Self-assessment; each row says what the video shows at that time and where else it is tested. Timestamps refer to the video at [[VIDEO URL]]. A row says "not shown" where the video does not show it.

| Item | Shown in the video | Also tested | Time |
|---|---|---|---|
| A1 Inline edit | select `get_debug_flag`, Cmd+Alt+K, instruction, diff with two hunks, per-hunk Accept/Reject, apply, `False` | 19/19 headless, live UI rehearsal 5 s end to end | [[m:ss]] |
| A2 Agent mode | Task B with no files named: tool calls, edits to cli.py, tests/test_cli.py, docs/cli.rst, `verify-task-b` 7/7 | live: 29 tool calls, 4 files changed | [[m:ss]] |
| A3 Streaming, cancel | streamed text and tool cards in Task B; Stop is not part of the three tasks: [[shown at m:ss, or "not shown"]] | live Stop: cancelled 21 ms after the click, 1 file rolled back | [[m:ss]] |
| B1 Context assembly | the Context section: items, reasons, budget | benchmark above | [[m:ss]] |
| B2 Diff safety | per-hunk review queue, apply, one Cmd+Z restoring the file | single undo step proven in a real editor (scenario 3) | [[m:ss]] |
| B3 Resilience | Task C: unreachable endpoint, switch to `deepseek/flash`, `git status` clean before applying | 9/9 live fallback scenarios | [[m:ss]] |
| B4 TrueForge depth | the Sessions page: approval pauses, `list_tools` / `get_tool_info` / `call_tool`; compaction not shown | v4-pro 5/5 deferred loading | [[m:ss]] |
| C1 Video | tasks A, B, C in order, each verified; total length [[m:ss]] | | [[m:ss]] |

## Tools used

**AI tools:** Claude Code (Anthropic's coding agent) wrote most of the code, tests and documentation under the author's direction; the final sessions used Claude Sonnet 5.5, and earlier sessions' exact model versions are not recorded in the repository. **In the product:** DeepSeek models through TrueForge, as above. **Engineering tools:** TrueForge (local), VS Code, TypeScript, esbuild, vitest (unit tests), `@vscode/test-electron` and Playwright (end-to-end tests in a real VS Code, with a temp profile and throwaway `e2e-<pid>-` TrueForge resources), GitHub Actions (build, typecheck, lint, tests).

## Known limitations

- **One model family and one repository:** every real run used DeepSeek on Flask. Groq's gpt-oss fails on a TrueForge reasoning-replay incompatibility (a candidate TrueForge fix); Gemini models were tried briefly, were rejected for an invalid key, and were not evaluated.
- **Provider flakiness is real:** 503s, dropped streams and 300 s silences dominated the first evaluation batches; the harness retries and reports provider failures separately. A fallback happens only before side effects: a failure after an edit or command is reported, not replayed, and a fallback starts a new session, so earlier turns of a long chat are lost (the panel says so).
- **Task B is not deterministic:** tool calls ranged 24-47 over 19 evaluation runs. The scorer was corrected twice after looking at failing runs (checks (g) and (f)), which is a form of tuning the benchmark; the corrections are documented, and the confirmed gain of the instruction tuning is efficiency, on 14 flash runs.
- **Context is lexical:** it missed 3 of 8 held-out queries and cannot resolve an instruction that names no function.
- **Not shown or not verified:** compaction and the scout subagent never ran; the paint timing of the "Stopping..." label in the webview and rollback over a real unsaved buffer were not verified; Stop (scenario 7) and the broken endpoint (scenario 9) have no model-free test because no fake TrueForge was built.
- **A CodeLens did not draw once** in a live run; it could not be reproduced in 120 warm and 20 cold test launches, so the cause is unknown. The opener now nudges VS Code if it never asked for the lenses; the driver retries once.
- **Environment:** `run_command` needs a POSIX shell (macOS and Linux); everything was tested on macOS arm64, VS Code 1.143 and 1.145, Node 26, Python 3.9. The optional auto-allow of read-only and test commands is off by default and, being strict, matches only a third of the agent's real commands (the usual `2>&1 | tail` still asks); it executes workspace code when tests run.
