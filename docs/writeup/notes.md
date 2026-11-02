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
