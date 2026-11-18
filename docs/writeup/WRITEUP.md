## Team

**Team {{TEAM}}** (Team ID {{TEAM_ID}}, competition {{COMPETITION_ID}}). **Member:** {{MEMBER}}. **College:** {{COLLEGE}}. **GitHub:** [{{GITHUB}}](https://github.com/{{GITHUB}}). **Repository (public, MIT):** [{{REPO}}]({{REPO}}). **Demo video:** <VIDEO_URL>. The video is an **automated, scripted run of the real extension** (Playwright drives VS Code, captions only, no narration); where something is not in the video, this document says "not in the video" and names the file that covers it.

## Starting point

**Built from scratch; no upstream fork.** No code from Cline, Continue, Roo Code, opencode or any other agent. {{SRC_STATS}} Runtime dependencies: the MCP SDK, `@truefoundry/trueforge-sdk`, `diff`, `ignore`, `zod`. TrueForge 0.183.1, local mode (SQLite), started by `npm run tf:start`, which sets `OUTBOUND_URL_ALLOWED_HOSTS` so its SSRF guard lets it reach the extension's loopback MCP server. Tasks run on Flask 3.1.3 (commit 22d92470).

## Architecture on TrueForge

<!--DIAGRAM-->

- **Client only.** The extension creates sessions and turns with the TrueForge SDK, renders the SSE events and cancels with `sessions.cancel`; a test (`test/noDirectProvider.test.ts`) fails if any provider URL or SDK appears in `src/`.
- **Editor capabilities are MCP tools** served on localhost with a bearer token: `list_dir`, `repo_map`, `search_code`, `read_file` (needs a `why`), `get_symbols`, `get_diagnostics`, and the gated `propose_edit`, `create_file`, `run_command`. A second server, `forge-editor-extras` (`git_status`, `git_diff`, `find_references`, `open_in_editor`), is `preload:false`, so the agent reaches it with TrueForge's **deferred tool loading** (`list_tools`, `get_tool_info`, `call_tool`).
- **Approval drives the diff review.** The three gated tools are listed by name in `require_approval_for_tools`. The turn pauses (`tool.approval_required`); the extension opens a per-hunk review, applies the accepted hunks in ONE `WorkspaceEdit` (one undo step), and resumes with a new turn carrying allow, or deny plus a reason. The tool only reports what was written. `src/review/applier.ts` is the only code that may write (`test/writeIsolation.test.ts`).
- **Stop** = `sessions.cancel`, wait for `turn.done: cancelled`, reject pending approvals, kill commands, roll the run back (`forge.rollbackOnCancel`).
- **Context-engineering features, honestly.** Deferred tool loading: used and visible on the Sessions page in the video ({{T_B4C}}). Dynamic subagents: allowed in the agent's instructions (one optional read-only scout); {{SUBAGENT_FACT}} Compaction: configured (trigger 80,000 input tokens), never triggered (largest call seen 24,269 input tokens), so not claimed as shown.
- **Trade-offs:** search/replace edits (hunks map one to one to the review) instead of whole-file rewrites; a lexical index because the extension must not call providers; fallback is client-side because TrueForge has none.

## How context is selected

A local, deterministic index: no embeddings, no provider call. Files are chunked along the code (Python `def`/`class`, `.rst`/`.md` sections, 60-line windows otherwise); BM25 (k1 1.2, b 0.75) with an identifier-aware tokenizer and field weights (symbol x3, path x2, signature x2), an exact-symbol boost, query bigrams and rank fusion over the sentences of the request; at most 2 chunks per file. Before each turn the top items are packed into a context block under a hard budget (`forge.contextBudgetTokens`, default 6,000; chars/4 x 1.15, re-measured until it fits, checked by a 400-case property test); `@file` / `@symbol` mentions are pinned first (at most half). Every item carries its reason (`matches: cli, command, routes`) and every agent `read_file` its own `why`. **It is visible:** the panel's Context section lists Pinned, Auto-retrieved and Read-by-the-agent items with reasons and the budget bar (video {{T_B1}}). Flask (222 files): index 120-155 ms, retrieval median 1.0 ms; for Task B the three needed files are in the top 8. Honest numbers: 14 of 14 tuning queries hit the top 3, only 5 of 8 held-out ones; an instruction naming no function cannot be solved lexically.

## Model setup

Models live in TrueForge (`trueforge/models.example.json`; keys only via environment variables). **All traffic goes through TrueForge**; it called DeepSeek's hosted API (BYO key) and Google's Gemini API (key in TrueForge) and Groq. Switch with **Forge: Switch Model** or the `forge.models` setting (first entry used, the rest is the fallback chain). Task A, one run per registered model (twice; `docs/model-matrix.md`):

| TrueForge model | Where it ran | Result |
|---|---|---|
| `deepseek/flash` (default), `deepseek/v4-pro` | DeepSeek API | **supported.** Task A 19/19 headless runs; Task B 5/5 flash, 5/5 v4-pro (flash about 0.43-0.57M tokens, 55-67 s; v4-pro about 0.9M tokens, 167 s) |
| `gemini-3-1-flash-lite`, `gemini-3-5-flash-lite`, `gemini-flash-lite-latest` | Google AI Studio | **supported** (Task A only, 4-21 s) |
| `gemma-4-26b-a4b-it`, `gemma-4-31b-it` | Google AI Studio | intermittent: pass in one pass (2-2.5 min), 503 in the other |
| `gemini-3-5/3-6/3-7/3-8-flash`, `gemini-flash-latest` | Google AI Studio | provider 503 "high demand" at test time |
| `gemini-3-1-pro-preview` | Google AI Studio | 429, free-tier quota 0 for this key |
| `groq/gpt-oss-120b` | Groq | **unsupported:** HTTP 400, TrueForge replays `reasoning_content` and Groq rejects it |

**Fallback (Task C):** transient errors are retried twice (0.5 s, 1.5 s); an unreachable endpoint or bad key advances at once; the request continues in a new TrueForge session on the next model, only if the failed attempt had no side effects. Measured 11-39 ms to switch for a refused connection. **Cost (estimate):** development, evaluation and test runs total about {{SPEND_TOKENS}} tokens in the spend ledger, about {{SPEND_USD}} at the $0.08 per million guard rate (DeepSeek's bill is authoritative; Gemini and Groq calls appear to be on free tiers, going by their quota messages). One Task A is about 6k tokens; one Task B 0.33-0.56M (about $0.03-0.05). The video take used {{TAKE_TOKENS}} tokens.

## Scorecard

Self-assessment. Times are positions in the submitted MP4 ({{VIDEO_LEN}}), read from the driver's event log. "Not in the video" rows name the file that covers them.

| Item | Time | One-line claim, with evidence |
|---|---|---|
| A1 Inline edit | {{T_A1}} | Select `get_debug_flag`, Cmd+Alt+K, instruction; diff with per-hunk Accept/Reject; verified `False` at {{T_A1V}} (`scripts/verify-task-a.sh` 19/19) |
| A2 Agent mode | {{T_A2}} | Task B, no files named: edits `cli.py`, `tests/test_cli.py`, `docs/cli.rst`; `pytest tests/test_cli.py -q` passes, `flask --help` lists `config`, masked JSON ({{T_A2V}}) |
| A3 Streaming, cancel | {{T_A3}} | Stop mid-stream: stopped state within {{STOP_S}} s, `git status` clean; streamed output visible throughout Task B |
| B1 Context assembly | {{T_B1}} | Context section: files chosen, reasons, token budget (BM25 + mentions + budget; benchmark above) |
| B2 Diff safety | {{T_B2}} | Per-hunk review; one Cmd+Z reverts the edit ({{T_B2U}}), redo re-applies it; single undo step also tested in a real editor (`docs/e2e-results.md`) |
| B3 Resilience | {{T_B3}} | Unreachable first model, automatic switch to `deepseek/flash`, `git status` clean before apply ({{T_B3G}}) |
| B4 TrueForge depth | {{T_B4}} | Sessions page: approval pauses, `list_tools` / `get_tool_info` / `call_tool` ({{T_B4C}}); subagents and compaction not demonstrated |
| C1 Video | 0:00 | Tasks A, B, C in order plus Stop, each verified; {{VIDEO_LEN}}; captions only |
| C2 Write-up | n/a | This document (3 pages) |

## Tools used

**Claude Code** (Anthropic's coding agent, Claude Sonnet 5.5 in the final sessions; earlier model versions are not recorded) wrote most of the code, tests and documentation under the author's direction; no penalty is claimed for it. Product: TrueForge (local), DeepSeek, Google Gemini and Groq models through TrueForge. Engineering: VS Code, TypeScript, esbuild, vitest, `@vscode/test-electron` and Playwright (real-editor tests with a temp profile and throwaway, per-run-prefixed TrueForge resources), macOS AVFoundation (a small Swift encoder turns the captured frames into the H.264 video; no ffmpeg), GitHub Actions. Repository: [{{REPO}}]({{REPO}}); TrueForge: [github.com/truefoundry/trueforge](https://github.com/truefoundry/trueforge).

## Known limitations and what we would do with another month

- **Lexical, not semantic, context;** it missed 3 of 8 held-out queries. *Next:* add an embeddings option routed through TrueForge, evaluated on more repositories than Flask.
- **Models:** Task B was evaluated on DeepSeek only; Gemini passes Task A but its free tier is overloaded or capped; Groq is blocked by a TrueForge reasoning-replay issue (a candidate upstream fix). *Next:* Task B across the matrix, paid Gemini quota, report the Groq issue.
- **Fallback only before side effects**, in a new session (earlier chat turns are lost, the panel says so). *Next:* carry a summary of the conversation across the switch.
- **Task B is not deterministic** (24-47 tool calls over 19 runs); the scorer was corrected twice after looking at failures, which is a form of benchmark tuning, documented in `docs/eval-results.md`.
- **Not shown or never triggered:** compaction and the scout subagent never ran; sandbox and Code Mode are not used; no tab completion (not scored). A CodeLens failed to draw once in a live run and could not be reproduced (120 warm, 20 cold launches); the driver retries once.
- **Environment:** POSIX shell for `run_command` (macOS, Linux); tested on macOS arm64, VS Code 1.143-1.145, Node 26. The video is automated, not a human screen recording.
