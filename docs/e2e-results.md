# End-to-end results

Results of `npm run test:e2e` (Layer 1, extension host), `npm run e2e:rehearsal` / `npm run test:ui` (Layer 2, Playwright). How to run them and what they prove: docs/e2e.md. Hermetic = no model, no spend; live = real TrueForge + model. Earlier development runs (failures caused by bugs in the tests themselves, such as a stale transcript or a hung command) were removed from this file; the findings they led to are listed at the end. New runs of the scripts append blocks below the marker line.

## Layer 1, hermetic (4 Nov 2026, VS Code 1.143.1, temp profile, temp Flask clone, no model)
| # | Result | Time | Scenario | Detail |
|---|---|---|---|---|
| 0 | PASS | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted), ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | 0.3 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | 0.4 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |

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

Scenario 6 failed twice. The first failure was a bug in the test (it read a `propose_edit` left over from an earlier scenario) and was fixed by scoping assertions to the current scenario. The second, after the fix, is a product finding. Scenario 6 is therefore **not verified**.

## Layer 2, UI rehearsal with Playwright (real clicks in the real VS Code, 1920x1080 video + screenshots)
`npm run e2e:rehearsal`, Tasks A, B, C in order in one VS Code window (about 3 minutes, estimated $0.09):

| Result | Step | Time | Detail |
|---|---|---|---|
| PASS | Task A (inline) | 16 s | Quick Open `file:line`, keyboard selection, Cmd+Alt+K, instruction typed; 1 review applied through the lens and Cmd+Enter; verify-task-a PASS |
| PASS | Task B (panel) | 143 s | prompt typed in the panel, 8 reviews applied via the "Accept all" lens + Cmd+Enter, "Accept hunk" CodeLens text asserted in the real diff editor; verify-task-b PASS (that run's "16 command cards allowed" over-counted clicks on already-decided cards; the counter was fixed afterwards) |
| PASS | Task C (fallback) | 6 s | broken primary -> the panel shows the "switched to deepseek/flash" notice; `git status` clean before the first apply; verify-task-a PASS |

`npm run test:ui` runs only the Task B leg (the same code as the rehearsal's Task B step); it was not run separately, to save tokens.

## Findings from the e2e work
1. **Product bug, NOT fixed (awaiting your decision): "Document has been closed" in the applier.** In scenario 6 the apply of `src/flask/cli.py` failed with `Could not write the change to src/flask/cli.py: Document has been closed. Nothing was applied.`; the agent was told the call was denied. It comes from `VscodeApplyIo.write` (src/review/applier.ts), which calls `openTextDocument`, then `applyEdit`, then `document.save()`; VS Code disposed the unreferenced `TextDocument` in between. This is a strong hypothesis, not a proven root cause. Proposed fix (not applied, per your rule about the applier): re-open the document right before each use and retry once on this error, or keep it open with `showTextDocument(..., { preserveFocus: true, preview: true })` for the duration of the apply. It is intermittent: the same applier wrote 8 files in scenario 5 and in the UI rehearsal.
2. **The single-undo-step claim holds** in a real editor: one `undo` after an apply of 3 hunks restored the exact pre-apply text (scenario 3).
3. **Playwright video**: `recordVideo` makes VS Code's window never attach unless Playwright's own ffmpeg build is installed (`npx playwright-core install ffmpeg`, one time, 1.4 MB, into Playwright's cache). Without it launching hangs for 90 s with an unhelpful timeout; the UI runner now checks for it first and says what to run.
4. **Environment leak found and handled**: started from a VS Code terminal or extension host, the runner inherited `ELECTRON_RUN_AS_NODE` and `VSCODE_IPC_HOOK`; both are scrubbed before launching so the test instance can neither run as plain Node nor attach to a running window.

<!-- new runs are appended below this line -->
