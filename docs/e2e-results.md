# End-to-end results

Results of `npm run test:e2e` (Layer 1, extension host), `npm run e2e:rehearsal` / `npm run test:ui` (Layer 2, Playwright). How to run them and what they prove: docs/e2e.md. Hermetic = no model, no spend; live = real TrueForge + model. Earlier development runs (failures caused by bugs in the tests themselves, such as a stale transcript or a hung command) were removed from this file; the findings they led to are listed at the end. New runs of the scripts append blocks below the marker line.

## Layer 1, hermetic (4 Nov 2026, VS Code 1.143.1, temp profile, temp Flask clone, no model)
| # | Result | Time | Scenario | Detail |
|---|---|---|---|---|
| 0 | PASS | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted), ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | 0.3 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | 0.4 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |
| 11 | PASS | 3.2 s | Reject hunk 1, accept the rest, apply: 10 times in a row, target file not open in any editor, no model | 10 of 10 rounds: 2 of 3 hunks applied and found on disk (BEFORE the applier fix: 0 of 10, every round failed with "Document has been closed") |

Not in the hermetic set: scenarios 7 (Stop) and 9 (broken endpoint) have no model-free variant, because that would need a fake TrueForge (kept out of scope on purpose); they run in the live pass.

## Layer 1, live (one full pass, `E2E_LIVE=1`, deepseek/flash, real TrueForge, `e2e-<pid>-` resources)
Estimated spend of the pass: **$0.11** (1,405,035 tokens at $0.08 per million; limit for one pass $0.60). TrueForge: only `e2e-<pid>-` resources were added and all four were deleted afterwards; your `forge-*` resources were never touched.

| # | Result | Time | Scenario | Detail |
|---|---|---|---|---|
| 1 | PASS | 5.9 s | Task A inline edit, accept all -> verify-task-a PASS | 6,296 tokens |
| 2 | PASS | 7.6 s | Task A partial accept (reject the code hunk) -> only the docstring changed | code hunk kept, docstring updated (1 of 2 hunks applied) |
| 5 | PASS | 136.5 s | Task B via the panel, accept all -> verify-task-b PASS | 70 tool calls, 51 model calls, 1,398,739 tokens; 59 context items |
| 6 | **FAIL** | 142.7 s (rerun) | Task B with one rejected hunk -> the agent is told and the result is reported | product finding 1 below |
| 7 | PASS | 8.3 s | Stop mid-run -> state cancelled, workspace pristine | cancelled 21 ms after the click; "Cancelled. Rolled back 1 file from this run: src/flask/cli.py" |
| 8 | PASS | 3.7 s | Task C: chain [broken-endpoint/broken, deepseek/flash] | "unreachable (connection refused) -> switched to deepseek/flash (after 27 ms)"; clean before the first apply; Task A PASS |
| 9 | PASS | 0.3 s | Task C: chain [broken-endpoint/broken] only | "No model could answer. broken-endpoint/broken (unreachable: connection refused)..."; workspace pristine |

Scenario 6 failed twice in that pass. The first failure was a bug in the test (it read a `propose_edit` left over from an earlier scenario) and was fixed by scoping assertions to the current scenario. The second was the applier race (finding 1, now fixed). Scenario 6 itself was NOT re-run live after the fix (no live spend was approved for it); its failure mechanism is covered by scenario 11 (the same reject-a-hunk-and-apply path without a model, 10 of 10) and by the unit tests of the retry logic. A live re-run of scenario 6 is still worth doing once.

## Layer 2, UI rehearsal with Playwright (real clicks in the real VS Code, 1920x1080 video + screenshots)
`npm run e2e:rehearsal`, Tasks A, B, C in order in one VS Code window (about 3 minutes, estimated $0.09):

| Result | Step | Time | Detail |
|---|---|---|---|
| PASS | Task A (inline) | 16 s | Quick Open `file:line`, keyboard selection, Cmd+Alt+K, instruction typed; 1 review applied through the lens and Cmd+Enter; verify-task-a PASS |
| PASS | Task B (panel) | 143 s | prompt typed in the panel, 8 reviews applied via the "Accept all" lens + Cmd+Enter, "Accept hunk" CodeLens text asserted in the real diff editor; verify-task-b PASS (that run's "16 command cards allowed" over-counted clicks on already-decided cards; the counter was fixed afterwards) |
| PASS | Task C (fallback) | 6 s | broken primary -> the panel shows the "switched to deepseek/flash" notice; `git status` clean before the first apply; verify-task-a PASS |

`npm run test:ui` runs only the Task B leg (the same code as the rehearsal's Task B step); it was not run separately, to save tokens.

## Findings from the e2e work
1. **Product bug found by the e2e suite and FIXED (4 Nov 2026): "Document has been closed" in the applier.** In live scenario 6 (Task B with the first hunk rejected) the apply of `src/flask/cli.py` failed with `Could not write the change to src/flask/cli.py: Document has been closed. Nothing was applied.`
   - **Cause (confirmed with temporary diagnostics, reproduced 10 of 10 without a model):** when `VscodeApplyIo.write` starts, the target file is still visible in the review's diff editor (the real file is its left side). The review handler closes that diff in parallel with the apply (`handle.close()`). `applyEdit` returns normally, but 14-23 ms after the open the `TextDocument` object is disposed (`isClosed=true`, not visible, not in `workspace.textDocuments`), so the following `document.save()` throws.
   - **A worse side effect:** after that failure the disk still had the OLD text, but VS Code kept the NEW text as an unsaved hidden buffer (re-opening the file showed the new text with `isDirty=true`). So "Nothing was applied" was not strictly true.
   - **Fix (src/review/applier.ts + the vscode-free decision logic in src/review/applyRetry.ts):** the document is opened inside each operation, right before it is used, and no reference is kept across an await; the save re-opens the document. If a closed-document error still happens, the document is re-opened and its live text decides: the text before the edit -> retry once; the new text -> the edit already landed, only save it; anything else -> abort with the "changed while it was being reviewed" conflict. If the retry also fails, the original text is put back (never over text that is neither the old nor the new one) and the clear error is reported. No raw file write was added (the write-isolation test passes unchanged); one WorkspaceEdit per apply is kept, so scenario 3 (single undo step) still passes.
   - **After the fix:** 10 of 10 rounds pass with 0 closed-document retries logged: reopening before each use removes the race by itself, and the retry path stays as a safety net (covered by unit tests with a fake document that closes: one retry and success; both attempts failing -> clear error and nothing saved; the file changing between attempts -> abort).
2. **The single-undo-step claim holds** in a real editor: one `undo` after an apply of 3 hunks restored the exact pre-apply text (scenario 3).
3. **Playwright video**: `recordVideo` makes VS Code's window never attach unless Playwright's own ffmpeg build is installed (`npx playwright-core install ffmpeg`, one time, 1.4 MB, into Playwright's cache). Without it launching hangs for 90 s with an unhelpful timeout; the UI runner now checks for it first and says what to run.
4. **Environment leak found and handled**: started from a VS Code terminal or extension host, the runner inherited `ELECTRON_RUN_AS_NODE` and `VSCODE_IPC_HOOK`; both are scrubbed before launching so the test instance can neither run as plain Node nor attach to a running window.

<!-- new runs are appended below this line -->
## 2026-11-04 10:52 (hermetic run, pid 32473)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.4 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | hermetic | 0.4 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |
| 11 | PASS | hermetic | 3.4 s | Reject hunk 1, accept the rest, apply: 10 times in a row with the file not open in any editor (no model) | 10 of 10 rounds: hunk 1 rejected, 2 of 3 hunks applied and found on disk; the applier logged 0 closed-document retries (0 where the edit had already landed and only needed saving); 38 Forge log lines read |
| 12 | PASS | hermetic | 0.6 s | Panel buttons: 'Apply accepted' with 2 of 3 hunks (1 undecided) writes 2, one undo restores; 'Reject all' writes nothing | Apply accepted: "2 of 3 hunks accepted, 1 undecided", 2 hunks on disk (hunk 1 absent), a double click applied once, ONE undo restored the exact text; Reject all: state rejected, git clean, a stale Apply click ignored |
| 1 | SKIP | live | 0.0 s | Task A inline edit, accept all -> verify-task-a PASS | needs E2E_LIVE=1 (real model) |
| 2 | SKIP | live | 0.0 s | Task A partial accept (reject the code hunk) -> only the docstring changed | needs E2E_LIVE=1 (real model) |
| 5 | SKIP | live | 0.0 s | Task B via the panel, accept all -> verify-task-b PASS | needs E2E_LIVE=1 (real model) |
| 6 | SKIP | live | 0.0 s | Task B with one rejected hunk -> the agent is told and the result is reported | needs E2E_LIVE=1 (real model) |
| 7 | SKIP | live | 0.0 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | needs E2E_LIVE=1 (real model) |
| 8 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | needs E2E_LIVE=1 (real model) |
| 9 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | needs E2E_LIVE=1 (real model) |

## 2026-11-04 10:52 (UI layer, panel controls smoke, hermetic, Playwright)

| Result | Step | Detail |
|---|---|---|
| PASS | command prefix shown | "Commands run with: source .venv/bin/activate &&" |
| PASS | Open in TrueForge button | title: No run yet: opens the TrueForge Sessions list |
| PASS | initial status line | "0 of 3 hunks accepted, 3 undecided" |
| PASS | Apply is disabled with nothing accepted | disabled |
| FAIL | UI flow | timed out after 10 s waiting for the card to say "2 of 3 hunks accepted, 1 undecided" |
| PASS | workspace after the run | git status: ?? .venv/bin/activate (the first review was applied on purpose) |

## 2026-11-04 10:53 (UI layer, panel controls smoke, hermetic, Playwright)

| Result | Step | Detail |
|---|---|---|
| PASS | command prefix shown | "Commands run with: source .venv/bin/activate &&" |
| PASS | Open in TrueForge button | title: No run yet: opens the TrueForge Sessions list |
| PASS | initial status line | "0 of 3 hunks accepted, 3 undecided" |
| PASS | Apply is disabled with nothing accepted | disabled |
| FAIL | UI flow | timed out after 30 s waiting for the card to say "2 of 3 hunks accepted, 1 undecided" |
| PASS | workspace after the run | git status: ?? .venv/bin/activate (the first review was applied on purpose) |

## 2026-11-04 10:54 (UI layer, panel controls smoke, hermetic, Playwright)

| Result | Step | Detail |
|---|---|---|
| PASS | command prefix shown | "Commands run with: source .venv/bin/activate &&" |
| PASS | Open in TrueForge button | title: No run yet: opens the TrueForge Sessions list |
| PASS | initial status line | "0 of 3 hunks accepted, 3 undecided" |
| PASS | Apply is disabled with nothing accepted | disabled |
| PASS | undecided note | "Undecided hunks count as rejected: they will not be applied." |
| FAIL | UI flow | timed out after 30 s waiting for the card to say "2 of 3 hunks accepted, 1 rejected" |
| PASS | workspace after the run | git status: ?? .venv/bin/activate (the first review was applied on purpose) |

## 2026-11-04 10:54 (UI layer, panel controls smoke, hermetic, Playwright)

| Result | Step | Detail |
|---|---|---|
| PASS | command prefix shown | "Commands run with: source .venv/bin/activate &&" |
| PASS | Open in TrueForge button | title: No run yet: opens the TrueForge Sessions list |
| PASS | initial status line | "0 of 3 hunks accepted, 3 undecided" |
| PASS | Apply is disabled with nothing accepted | disabled |
| PASS | undecided note | "Undecided hunks count as rejected: they will not be applied." |
| PASS | Apply is enabled | enabled |
| PASS | success line | "Applied 1 of 3 hunks; 2 not applied (rejected or undecided)." |
| PASS | edits on disk | hunks written: 1 (the two undecided hunks were not written) |
| PASS | no buttons left on a finished review | the card shows only its result line |
| PASS | Reject all | "Rejected: nothing was written." |
| PASS | workspace after the run | git status: M src/flask/helpers.py; ?? .venv/bin/activate (the first review was applied on purpose) |

