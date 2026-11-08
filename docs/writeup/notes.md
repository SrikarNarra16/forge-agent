# Write-up notes (raw material for the PDF and README)

Short facts worth including later. Keep each one verifiable.

## Review UI
- The per-hunk review UI is built on CodeLens in VS Code's diff editor. VS Code only renders CodeLens in
  diff editors when `diffEditor.codeLens` is `true`, so Forge ships `contributes.configurationDefaults`
  with `"diffEditor.codeLens": true` (see `package.json`). The lenses therefore work on a clean install
  without the user touching settings. Fallbacks that do not depend on it: editor-title buttons (Accept all /
  Reject all / Apply), Cmd/Ctrl+Enter to apply, Esc to reject all, and the `Forge: Review Hunks…` QuickPick.
  If a user has explicitly turned the setting off, Forge offers once to turn it back on.
- The right-hand side of the review diff is a read-only in-memory document (`forge-proposal:` scheme).
  Rejecting a hunk reverts those lines in it, so the diff visibly shrinks.

## Why the extension applies the edit (not the MCP tool)
- TrueForge gates `propose_edit` / `create_file` by tool NAME in `require_approval_for_tools`. The approval
  pause ends the turn; the tool only runs after the resume turn. If the tool applied the edit, two proposals
  to the same file would deadlock (review 2 waits for a resume turn that waits for decision 2).
- So the ApprovalHandler runs the review, applies the accepted hunks itself in ONE `WorkspaceEdit` (a single
  undo step), records the decision, and returns `allow`; the tool then only reports what was applied.
- No file is written without a review: a unit test scans all sources and fails if anything other than
  `src/review/applier.ts` can write or apply an edit.

## Safety properties (each has tests)
- Hunks keep line terminators, so CRLF/mixed endings and a missing final newline round-trip exactly.
- `old_text` must match exactly once; otherwise the agent gets a teaching error.
- The review remembers a hash of the text it was computed on; if the file changed meanwhile nothing is written.
- A checkpoint of the original is taken before the first write to a file in a run; "Undo run" restores it
  (and deletes files the run created). Cmd+Z after an apply is one undo step.
- Same-file proposals are serialised and the later one is recomputed against the new text; different files
  are reviewable at the same time.

## Live verification of the edit path (2 Nov 2026)
- Product tools, decision store, review handler and controller were driven against a real TrueForge and
  `deepseek/flash` (in-memory workspace, scripted accept/reject in place of the human, throwaway names
  `forge-spike-edit*`, TrueForge state identical before and after). Four scenarios, all passing:
  single edit applied; three-hunk edit with hunk 2 rejected (tool reported `applied 2 of 3 hunks ...;
  rejected: hunk 2 (line 6): ...` and the agent told the user which hunk was not applied); full rejection
  (the agent saw `User denied tool call: User rejected all changes to <file>` and did not retry);
  create_file (`created src/util.py (+3 lines)`).
- This proves the join that matters: the decision recorded from the model's raw approval arguments is found
  by the tool call TrueForge sends afterwards (0 decisions left unconsumed in every scenario).
- The agent followed the instructions: read before editing, small anchors, cited file:line, acknowledged
  the rejected hunk. Recordings: `test/fixtures/edit/*.jsonl`, replayed by `test/recordedEdits.test.ts`.

## Task A (inline edit): what made it reliable (2 Nov 2026)
Headless runs against a real TrueForge with the product `forge-inline` agent, product tools and review handler,
an in-memory copy of Flask 3.1.3 and an auto-accept-all presenter (`scripts/run-task-a-headless.ts`; results in
`docs/task-a-runs.md`): deepseek/flash passed 19/19 (five selection styles), deepseek/v4-pro 5/5. The instructions
needed no tuning; what made it work:
- **The user message carries the code.** Numbered selected lines plus about 20 lines of context on each side mean
  the agent usually needs no tool call before editing (one `propose_edit` in 3-4 s). The instructions allow at
  most two reads for the rare case where it wants more.
- **"ONCE ... code AND its docstring"** makes the agent put both parts of the change into a single
  `propose_edit`, which becomes one review with two hunks instead of two separate approvals.
- **The tool contract does the policing:** `old_text` must match exactly once (teaching error otherwise), and
  nothing is written unless a human accepts a hunk, so a model that misbehaves costs a retry, not a bad write.
- **One checker for everything:** `scripts/task_a_check.py` (runtime behaviour for off/OFF/n/N/0/false/no/on/1,
  empty and unset, plus the docstring) is used by `verify-task-a.sh` on the real fixture and by the headless
  runner on in-memory results, so a pass means the same thing everywhere.
- **Model portability is limited by the provider layer, not the prompt:** groq/gpt-oss-120b fails because
  TrueForge replays `reasoning_content` and Groq rejects it (HTTP 400), plus a 8000 TPM cap (HTTP 429). That is a
  concrete, reproducible candidate for the Round-2 PR (strip `reasoning_content` for providers that reject it) and
  a motivating case for the model fallback chain.

## Context engine (rubric B1: retrieval + size budget + stated strategy + visible) (2 Nov 2026)
**Strategy in one paragraph.** A local, deterministic, lexical index (no embeddings, no provider call). Files are cut
into chunks that follow the code: Python `def`/`class` blocks by indentation (a class is a header chunk plus one chunk
per method, `Class.method`), TS/JS by regex, `.rst`/`.md` by section heading, anything else 60-line windows with 10
lines overlap. BM25 (k1 1.2, b 0.75) over an inverted index with field weights (symbol x3, path x2, signature x2,
body x1), an identifier-aware tokenizer (the whole identifier `get_debug_flag` plus its parts) and light stemming.
On top of BM25 only things the benchmark justified: query bigrams (`test client` also searches `test_client`), an
exact-symbol boost gated by rarity (a word naming a symbol counts only if it is identifier-shaped or in under 5% of
chunks, so `command` does not boost every `.command`), penalties for window chunks and changelog files, x1.25 for
test/doc paths when the request asks for tests/docs, question-framing words ("where is ... implemented") removed, and
reciprocal-rank fusion over the sentences of a multi-sentence request. Every selected item carries its reason, the
top matched words in the user's own words (`matches: cli, command, routes`).

**Budget.** `forge.contextBudgetTokens` (default 6000). Tokens are estimated as chars/4 times a 1.15 safety factor.
Pinned (@mentioned) items go first but may use at most 50% of the budget; a pinned file contributes its body if it
fits, else an outline. Then ranked auto items: full bodies for the top 2, a one-line location for the rest. The
rendered block is re-measured and items are shed until it fits, so it never exceeds the budget (a 400-case property
test enforces this). The block is sent with the user's request; the transcript shows only what was typed (+ chips).

**Where it is visible.** A collapsed "Context" section (opens on a new run) with a budget bar, rows grouped Pinned /
Auto-retrieved / Read by the agent, each with its reason (the agent's FULL `why` for reads), "retrieved in N ms" and
"model input tokens: N". If the index is still building at send time the send waits at most 1.5 s, then proceeds without
auto context and says so in the section. Not verified in a real editor window (see PROGRESS).

**Benchmark** (`scripts/bench-context.ts`, `test/context-bench.json`, Flask 3.1.3: 222 indexable files, ~1600 chunks,
~292k tokens of text; reads the fixture from disk, no editor, no network):
| | target | result |
|---|---|---|
| index build, cold | < 1500 ms | ~120-155 ms |
| top-3 hit rate, tuned queries (14) | >= 10/12 | 14/14 |
| top-3 hit rate, held-out queries (8) | n/a | 5/8 |
| Task B: cli.py + tests/test_cli.py + docs/cli.rst in top 8 | all three | yes (docs/cli.rst rank 1, tests/test_cli.py rank 7, src/flask/cli.py rank 8) |
| retrieval latency (search + packing) | < 50 ms | median 1.0 ms, p95 3.4 ms, max 3.7 ms |

**Honest caveats.** (1) I tuned on the 14 queries, including Task B itself; the untouched held-out set (written after
the retrieval design was fixed) is the generalisation evidence: 5/8. Its misses: a teardown-hook question (first match
rank 23), "make `jsonify` accept a status argument" (first match rank 4; docs about JSON errors outrank the function) and
the SameSite cookie task (docs/config.rst ranks first but `src/flask/sessions.py` is missing from the top 8). (2) Task B
passes narrowly: the cli.py chunk found is `FlaskGroup.list_commands` at rank 8 (right file, not the registration site
`FlaskGroup.__init__`). (3) The bare Task A instruction without the function name ("treat 'off' and 'n' as false...")
cannot be solved lexically; with a selection or the function name it ranks first. It is kept in the benchmark as a known
limit (`countInRate:false`). (4) The benchmark measures where the right file lands, not whether the agent then does the
task better; that is the next prompt's live run.

**What was tried and rejected (measured on the benchmark).** A grid over BM25 field boosts, b and per-file diversity
(flat at 10/14: misses were structural, not parameters); propagating file-level evidence to chunks (made things worse);
extra weight for `code spans` in the request (no effect). Fixes that did work, in order of effect: stemming
(`pushed`/`push`), rarity-gated exact-symbol boost, window/changelog penalties, intent regex limited to requests that
PRODUCE tests/docs, question-framing stopwords, bigrams, sentence fusion, scoring the file name separately in the fuzzy
@file matcher.

**Estimated vs actual input tokens (method).** TrueForge reports per model call `usage.inputTokens` and
`inputTokensBreakdown.messages` (the part that is conversation messages, excluding harness, instructions and tool
definitions). After each panel run that injected a block, the extension logs to the Forge output channel:
`context usage: block ~N budget tokens; message estimate E (x1.15 = B); TrueForge first call input I, message tokens
M; actual/estimate R`. E is chars/4 of the whole model-facing message (block + request). For the first turn of a chat M
is exactly that message, so R = M / E is the honest ratio; on later turns M also contains history, so the log subtracts
the previous run's last M and marks the number approximate. The panel shows `inputTokens` of the run's first model call
as "model input tokens". OBSERVED RATIO: not measured yet; no live panel run has happened in this prompt (the new
panel needs a real editor window). Record the first ratios here after the manual steps in docs/cancel-tests.md. The 1.15 factor
is a guess until then (code tokenizes at roughly 3-3.5 characters per token on common tokenizers, so chars/4 tends to
under-count code by 10-30%).

## B4 harness features: what is built and what a real run showed (3 Nov 2026)
- **Deferred tool loading.** A second MCP server, `forge-editor-extras` (git_status, git_diff, find_references, open_in_editor; all read-only), is served by the same HTTP server on /mcp-extras with the same bearer token and attached to the agent with `preload:false`. The agent only sees the server's name; in a real run it called TrueForge's meta tools `list_tools {mcp_server}`, `get_tool_info {mcp_server, tool_name}` and `call_tool {mcp_server, tool_name, input}` (tool type `truefoundry-system`) and then `git_diff` to review its own changes. They appear as normal tool cards (the panel shows "git_diff via forge-editor-extras") and in the TrueForge session.
- **Dynamic subagents.** Enabled; instructions describe an OPTIONAL read-only scout (only by instruction: TrueForge subagents share the root agent's tools, and approvals inside them still pause for the user). Rendered as a collapsible "subagent" block holding that thread's messages and tool calls. Not used by the agent in any real run so far; rendering is tested with synthetic events only.
- **Compaction.** `context_management.compaction` (input_tokens trigger 80000) and `large_tool_response` are in both agent specs; the panel shows a "Context compacted (N s)" divider. TrueForge accepted the config; no run reached the trigger yet, rendering is tested with synthetic events.
- **run_command.** Gated by name; a denylist is checked before the approval card and again before running; the card shows the exact command with "Allow this exact command for this run"; the node runner kills the whole process group on timeout/Stop. A real run used it to execute pytest after editing.
- **Eval harness lesson.** Provider outages (503, dropped streams, 300 s silences) dominated the first batches; the harness now retries with backoff, pauses 10 minutes after 3 failures in a row, and reports provider failures separately from agent failures. Without that, a flaky provider would have looked like a bad prompt.

## A3: Stop is instant and the workspace is consistent (3 Nov 2026)
**Design.** One state machine, with a real `cancelling` state: Stop enters it synchronously (the panel shows "Stopping…" in the same tick; nothing in that path touches the network). The flow, in order: (a) mark `cancelling` and the run cancelled in a shared run registry; (b) abort the local stream reader and fire `sessions.cancel` WITHOUT awaiting it (3 s bound, errors only logged); (c) reject every pending approval (diffs close, command cards disappear, review entries become "cancelled"); (d) kill running command process groups, drop decisions and command tickets, abort in-flight tool calls; (e) wait for an apply that already started (an apply is atomic per file, so it is allowed to finish); (f) roll the run back to its checkpoints (`forge.rollbackOnCancel`), then `cancelled` with an explicit message. `send()` returns when the flow ends even if the provider never answers; late stream events, approval requests and tool calls for the run are ignored.
**Nothing can act for a cancelled run.** The review handler checks the registry before showing a diff and again before applying; tools return "this run was cancelled" and never look up decisions; `run_command` only runs commands that hold an approval ticket issued by the approval handler (a late call from TrueForge has none).
**Rollback default (`forge.rollbackOnCancel` = true) and why.** The rubric asks for "immediate cancellation with a consistent workspace", and a half-finished multi-file change (cli.py edited, test and docs missing) is the inconsistent state we want to avoid. The trade-off: a user who already ACCEPTED edits earlier in the same run loses them on Stop. So the final message is explicit and actionable ("Cancelled. Rolled back N files from this run: <paths>"), files the user edited after Forge wrote them are never overwritten (they are listed as "left as you edited them"), "Undo run" keeps its behaviour, and the setting turns the rollback off ("Cancelled. N applied files kept: <paths>").
**Streaming resilience, from a live spike** (`npx tsx scripts/spike-resume.ts`, throwaway agent, ~2 k tokens): `afterSequenceNumber` is the number of events already received from that turn (turn.created, model.message, every delta and turn.done each count: `after=1` starts at the model.message, `after=N` returns only turn.done when N = total-1). `listTurnEvents` returns only the compact log (turn.created, the merged model.message, turn.done), which is exactly enough to rebuild a finished turn. A client-side drop does NOT stop the server turn: `getTurn` still says running and a re-attach continues from the right place. The controller therefore, on a drop without turn.done: asks `getTurn`; running -> re-attach once after the events seen; finished -> rebuild from the log; otherwise end with the real reason. Replayed non-delta events are idempotent in the reducer.
**Honest limits.** Not verified in a real editor window: the 200 ms "Stopping…" label timing in the webview (the controller and panel state are tested; the webview paint is not), the diff actually closing, the modal-free rollback with a real unsaved buffer. `docs/cancel-tests.md` is the protocol for those.

## B3: automatic model fallback (Task C) (3 Nov 2026)
**What it is.** TrueForge has no native model fallback, so the extension implements it. `forge.models` is the ordered chain. A failed attempt is classified from the text TrueForge really returns (`[Model Error] Request failed (503): ... high demand`, `Cannot connect to API`, `Request failed (400): API key not valid`, 429, `terminated`, `Response stream ended without a finish reason`, and ~300 s silences): transient (retry the same model twice, 0.5 s then 1.5 s with jitter), unreachable and auth (advance at once), stall (watchdog: one retry, then advance), fatal (agent/tool errors: never a fallback) and TrueForge-down (our own call to TrueForge fails: stop and say so). Advance = the SAME user text and context block in a NEW TrueForge session on the next model (the committed agent definition stays the source of truth; only `model.name` is overridden in the session spec). Attempts are bounded (3 per model, 8 overall). Stop cancels the whole chain, also during a backoff.
**Safety rule and its limitation.** A fallback or retry only happens when the failed attempt had no side effects: no edit applied, no file created, no `run_command` executed (even a read-only pytest counts). Otherwise Forge does not replay (it could repeat edits or commands), ends the run, lists what was already applied and offers Undo run. So a provider failure in the middle of a long multi-file run is not recovered automatically; it is reported clearly. A second limitation: a fallback starts a new session, so earlier turns of a longer chat are not visible to the model (the notice says so). Both are deliberate trade-offs for a workspace that is never left in a surprising state.
**Stall defaults (45 s to the first token, 90 s between outputs).** The watchdog counts model output (tokens, tool results, thread events), not bookkeeping events (`turn.created` and the start of a `model.message` arrive instantly even from a silent model). It is paused while a tool call is running, an approval is pending or compaction is active. Observed in real runs: provider stalls were silent for ~300 s until the HTTP layer gave up ("terminated"), far above both limits, and healthy runs had a model call every 2-12 s on average (Task A on v4-pro: ~15 s per call including a reasoning phase; Task B on flash: ~9 s per call including tool time). The per-event arrival timestamps that would give the exact time-to-first-token and longest healthy silence were not recorded before 3 Nov; the harness now records them (`eval-output/*.events.jsonl`, field `t`) and `npx tsx scripts/eval/timing.ts` prints the numbers per model. Measured on 4 Nov 2026 over successful Task A turns: time to first token median 679 ms / max 1459 ms on deepseek/flash (18 turns) and median 884 ms / max 1254 ms on deepseek/v4-pro (6 turns); longest silence between progress events 1.5 s / 1.2 s. That is a >30x margin for small prompts, but Task B (very large inputs) has not been measured, so the defaults stay 45/90 and the Task B numbers are still to be added.
**Fast failure.** `npm run tf:start` sets `MODEL_HTTP_CONNECT_TIMEOUT_MS=3000` and `MODEL_HTTP_MAX_RETRIES=1`: a dead endpoint fails in about 3 s and TrueForge's own retry does not stack on top of ours. Measured time-to-fallback: 11-39 ms for the unreachable demo endpoint (it refuses at once) and 187-246 ms for an invalid API key; 9/9 live fallback scenarios passed with a clean workspace (docs/eval-results.md).


## Task B tuning: final instructions and numbers (4 Nov 2026), tag `task-b-tuned`
**Method.** deepseek/flash, the real product pipeline in the eval harness (docs/eval-results.md), Task B with the exact prompt and no files named, 5 runs per iteration, seven frozen checks (a-g). Only the agent instructions (`agents/forge-agent.json`) were tuned, model-agnostically (no model names, no provider-specific phrasing), and the tool descriptions were left as they were.
**Results.** Baseline (P08 instructions): 4/4 under the corrected scorer (2/4 under the original). Iteration 1 (added the FEATURES step): 5/5 (3/5 under the original). Iteration 2 (unchanged instructions, to measure consistency): 5/5. Stop rule (>= 4/5 on flash twice in a row) met after two iterations. Mean per run: ~568k tokens / 25 model calls / 38 tool calls / 67 s at baseline, ~433k-495k tokens / 21-23 model calls / 30-32 tool calls / 55-63 s afterwards. The whole tuning (both iterations and the baseline) cost about $0.55 (estimated, $0.08 per million tokens).
**What the tuning changed, and what it did not.** Iteration 1 added one paragraph that makes code, test and documentation one job (find where similar features are documented, update that file in the same step, check with `git_diff` that a docs file is in the diff, do not touch unrelated files, read economically). The agent was already documenting the command in most baseline runs; the tuning mainly made the step explicit and cut tokens by about a quarter. The headline pass rate moved from 2/4 to 5/5 mostly because of the scorer correction below, not because of the instructions, and I say so openly: on the corrected scorer the baseline was already 4/4, so the confirmed gain from the instructions is efficiency and consistency, on a small sample (4 + 5 + 5 runs).
**Honesty note: scorer correction after human review of the failing runs.** The original check (f) ("docs/cli.rst documents `flask config`") only accepted the literal text `flask config` / ``` ``config`` ```. Four runs (two at baseline, two in iteration 1) failed it although they had added a proper section to `docs/cli.rst` in the file's own style (`$ flask --app hello config`, `:func:\`config <cli.config_command>\``). After reading the recorded edits, the rule was corrected (it still requires the change in docs/cli.rst, >= 2 non-blank added lines and a line naming the command as `flask( --app \S+)? config`, ``` ``config`` ``` or a `:func:` role naming `config_command`), all recorded runs were re-scored (baseline 2/4 -> 4/4, iteration 1 3/5 -> 5/5), unit tests with the real texts as positive fixtures and several negative fixtures were added, and the scorer was frozen again before the confirming iteration. An earlier correction (3 Nov) relaxed check (g) from "only the three required files" to "no file outside src/tests/docs modified, nothing deleted", because the competition only requires >= 3 files. Both corrections were made after looking at failures, which is a form of tuning the benchmark; they are documented here so the write-up can state it. A related bug in the diff reader (an unchanged tracked file was read as fully added) was also fixed.
**Limitations.** One model family, one repository, one task; 14 answered flash runs in total; the checks are executable (pytest, `flask --help`, masked JSON from a generated app) except (e) and (f), which are text patterns. v4-pro is reported separately (docs/eval-results.md). No scout subagent was used in any run (0/14), so the scout wording is untested in practice.

**Final instructions (`agents/forge-agent.json`, tag `task-b-tuned`):**

```text
You are Forge, a coding agent inside VS Code working on the user's workspace. Orient with repo_map/search_code, read only what you need with read_file ranges, always give a short why. Answer concisely and cite file:line.

EDITING. Before changing a file, read the part you will change with read_file. Change code only with propose_edit (existing files) or create_file (new files): one file per call, small edits whose old_text is a short unique anchor copied exactly from the file, in the project's existing style. The user reviews every hunk and may accept or reject each one. A tool result starting with 'applied' or 'created' tells you what was really written; anything listed as rejected was NOT applied. Never say a change is made until the result says so, and do not re-propose a change the user rejected. When you are done, summarise what changed in a few lines (file:line). Combine ALL changes to one file into a SINGLE propose_edit call (several edits in its edits[] array). Never send two propose_edit calls for the same file in one step. If a hunk was rejected by the user, do not re-propose it; ask what they want or continue with the rest.

CONTEXT. A <context> block with pinned files and auto-retrieved locations may precede the user's request. Start every task with a short Context plan (2-4 lines): which files and symbols you expect to matter and why, using the Relevant locations provided as a starting point. Prefer search_code and repo_map to reading whole files; read ranges; always give a one-sentence why for read_file. Look at neighbouring code, tests and docs before inventing new structure.

FEATURES. When asked to add a feature, the code, its test and its documentation are ONE job; do not stop until all three exist. (1) Code: follow how similar features are registered and written. (2) Test: add it next to the existing tests for that code. (3) Documentation: find where the existing, similar features are documented (search_code kind=docs, or the docs/ folder) and add the entry to that same file, in the same style, in the same step as the code and the test; name the feature the way users type it (for a command line tool, the command exactly as typed). Before you finish, call git_diff and check that a documentation file is in it next to the code and test files; if one is missing, add it now. Do not change files other than the code, its test and its documentation unless the task needs it. Work economically: use the Relevant locations you were given instead of searching for the same thing again, read each file range once, and make one search_code call per question.

TESTING. After you have made your edits, run the project's own tests for the code you changed with run_command (for example pytest on the relevant test file, or npm test), read the failures and fix them with propose_edit, then run them again. Keep commands short and non-interactive. Never use run_command to edit files.

REVIEW. Before you finish, review your own changes with git_diff from forge-editor-extras. Those extra tools (git_status, git_diff, find_references, open_in_editor) are loaded on demand: if you do not see them in your tool list, find them with list_tools and get_tool_info, then call them with call_tool.

SCOUT (optional). If the Relevant locations are not enough to see where similar built-ins, tests and docs live in an unfamiliar part of the repo, you may spawn ONE read-only scout subagent. Tell it to use only search_code, repo_map, list_dir and read_file (never edit files or run commands) and to return a compact list of `path:lines - why`. Then do the editing yourself. Skip the scout when the locations you already have are enough.
```

**v4-pro with the same final instructions (once, 5 runs):** 5/5 pass under the same frozen scorer; mean 899k tokens, 31 model calls, 41 tool calls and 167 s per run (flash after tuning: ~433k-495k tokens, 21-23 model calls, 30-32 tool calls, 55-63 s). Full table in docs/eval-results.md.

## Testing strategy (4 Nov 2026)
Four layers, each answering a different question. (1) **Unit tests** (vitest, ~830): pure logic (retrieval, budget, review hunks, the model chain, cancel flow, the scorers) with fakes and real recorded TrueForge events. (2) **Headless eval harness** (`npm run eval`): the real product pipeline (index, MCP tools, review handler, controller, SDK) against a live TrueForge with a model, on a temp copy of Flask, scored by executable checks; used to tune and to measure. (3) **End-to-end in a real VS Code** (`npm run test:e2e`, docs/e2e.md): the real extension in the installed VS Code with a temp profile, driven through test hooks that exist only with `FORGE_E2E=1` and that call the same commands and handlers a user triggers; it checks what the other layers cannot see: the CodeLens provider, the real review UI, the single-undo-step claim, the panel webview, Stop in the real UI. (4) **UI smoke with Playwright** (`npm run e2e:rehearsal`): real clicks and keystrokes in the workbench, no hooks, with screenshots and a 1080p video, used to rehearse the three fixed tasks before recording. Isolation is the design: unique `e2e-<pid>-` TrueForge resource names (a feature, `forge.resourcePrefix`, not a test hack), a temp VS Code profile, a temp Flask clone, a name guard on every delete, a dollar guard on every live run.
**What the e2e layer found.** The single-undo-step claim for per-hunk apply is true in a real editor (3 hunks applied, one `undo` restored the exact pre-apply text). A real defect, found by this suite and fixed: "Document has been closed" in the applier (docs/e2e-results.md, finding 1). It was reproduced deterministically (10 of 10) without a model: the review's diff editor was closed in parallel with the apply, VS Code disposed the document object between `applyEdit` and `save`, the apply was reported as failed, and the new text stayed behind as an unsaved hidden buffer, so "Nothing was applied" was not even strictly true. The fix opens the document right before each use, re-opens and decides from the live text after a closed-document error (retry / only save / abort as changed), and puts the original text back if the retry fails; unit tests with a fake closing document and a 10x loop in the real VS Code cover it. It was missed by every unit test because it needs a real editor, which is the argument for this layer. Honest limits: the UI layer depends on VS Code's workbench DOM and ran against 1.143.1 only; Stop (scenario 7) and the broken endpoint (scenario 9) are tested live only, there is no model-free variant; scenario 6 (live) was re-run live on 8 Nov 2026 after the fix and passed (docs/e2e-results.md), and its failure path is also covered by hermetic scenario 11 (10 of 10).
