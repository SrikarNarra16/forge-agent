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
