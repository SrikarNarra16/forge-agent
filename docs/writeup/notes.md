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
panel needs a real editor window). Record the first ratios here after the manual steps in PROGRESS.md. The 1.15 factor
is a guess until then (code tokenizes at roughly 3-3.5 characters per token on common tokenizers, so chars/4 tends to
under-count code by 10-30%).
