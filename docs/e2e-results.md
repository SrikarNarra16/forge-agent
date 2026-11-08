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

Scenario 6 failed twice in that pass. The first failure was a bug in the test (it read a `propose_edit` left over from an earlier scenario) and was fixed by scoping assertions to the current scenario. The second was the applier race (finding 1, now fixed). Scenario 6 was re-run live on 8 Nov 2026 after the fix and passed (see "Final verification" below).

## Layer 2, UI rehearsal with Playwright (real clicks in the real VS Code, 1920x1080 video + screenshots)
`npm run e2e:rehearsal`, Tasks A, B, C in order in one VS Code window (about 3 minutes, estimated $0.09):

| Result | Step | Time | Detail |
|---|---|---|---|
| PASS | Task A (inline) | 16 s | Quick Open `file:line`, keyboard selection, Cmd+Alt+K, instruction typed; 1 review applied through the lens and Cmd+Enter; verify-task-a PASS |
| PASS | Task B (panel) | 143 s | prompt typed in the panel, 8 reviews applied via the "Accept all" lens + Cmd+Enter, "Accept hunk" CodeLens text asserted in the real diff editor; verify-task-b PASS (that run's "16 command cards allowed" over-counted clicks on already-decided cards; the counter was fixed afterwards) |
| PASS | Task C (fallback) | 6 s | broken primary -> the panel shows the "switched to deepseek/flash" notice; `git status` clean before the first apply; verify-task-a PASS |

`npm run test:ui` runs only the Task B leg (the same code as the rehearsal's Task B step); it was not run separately, to save tokens.

## Final verification on the build that is recorded (8 Nov 2026, HEAD 4bb0f31)
One live pass, in the real VS Code 1.145.0 (macOS arm64), with the product's DEFAULT settings: `forge.commandPrefix` empty (so the auto-detected `. .venv/bin/activate &&` is used; the temp Flask clone has a real `.venv`), both `forge.autoAllowCommands.*` OFF (so every run_command card needs a click), chain `deepseek/flash`, `deepseek/v4-pro`. TrueForge 8790 with throwaway `e2e-<pid>-` resources (the user's `forge-*` resources untouched). `npm run e2e:rehearsal` (Tasks A, B, C with real clicks) then `E2E_LIVE=1 E2E_ONLY=6 E2E_DEFAULT_SETTINGS=1 npm run test:e2e` (scenario 6, its original live form). Model calls = `model.message` events and tool calls = `tool.response` events in TrueForge's session records; tokens = the turn metrics there.

| Task | Instruction -> first diff | First diff -> verified | Instruction -> verified | Model calls | Tool calls | Tokens | Allow clicks | Verify |
|---|---|---|---|---|---|---|---|---|
| A (inline) | 3.5 s | 1.6 s | 5.1 s | 2 | 1 | 6,214 | 0 | `verify-task-a.sh` PASS 19/19 |
| B (panel) | 36.3 s | 65.9 s | 102.2 s | 19 | 29 | 332,857 | 3 (3 run_command cards, all asked) | `verify-task-b.sh` PASS 7/7 (a-g); pytest 58 passed, 3 skipped |
| C (fallback) | 2.7 s | 1.7 s | 4.3 s | 2 | 1 | 6,177 | 0 | `git status` clean before the first apply, then `verify-task-a.sh` PASS 19/19 |
| **A+B+C** | **42.4 s** | **69.2 s** | **111.7 s** | 23 | 31 | 345,248 | 3 | |

Uncuttable instruction->diff gaps in total: 42.4 s. Whole script wall-clock (launch to close): 116 s. Lens retries (diff reopened): 0. Spend: **345,248 tokens = $0.028**.

**Scenario 6 (live, original form): PASS** in 79.6 s. The first propose_edit with hunk 1 rejected: the tool result told the agent (`applied 2 of 3 hunks (+15 -0 lines) to src/flask/cli.py; rejected: hunk 1 (line 7): + impo...`), the final message was written (1,531 chars), 6 run_command cards (all answered by the autopilot's Allow message, which is not a real click), 6 reviews decided; `verify-task-b.sh` RESULT FAIL (6/7), which is expected with a rejected hunk (the failing check was not recorded). TrueForge records: 1 session, 12 turns, 28 model messages, 38 tool calls, **604,057 tokens = $0.048**. This closes the open item from finding 1 below: the scenario that exposed the applier race now passes live.

**Pass total: 949,305 tokens = $0.076** (ledger: $1.745 of the $3 cap).

Evidence that the auto-detected prefix was in effect (from the Task B session in TrueForge): the agent's `python -m pytest tests/test_cli.py -q` ran with the clone's own venv (58 passed, 3 skipped: the 55 existing tests plus the 3 the agent added), and its `python -m ruff ...` failed with `<temp clone>/flask/.venv/bin/python: No module named ruff`.
The Task B session also shows what the closing shot needs: 6 `tool.approval_required` pauses, `list_tools`, `get_tool_info`, `call_tool` once each (deferred loading of `forge-editor-extras`), and NO compaction (largest model call 24,269 input tokens; the trigger is 80,000). Of the 3 Task B commands none matched the (disabled) allow-list anyway: 2 end in `2>&1 | tail`, 1 is chained.
Caveats: one run of each; Task B varies from run to run (the previous rehearsal on 4 Nov: 118 s, 24 model messages, 37 tool calls, 6 commands). VS Code was 1.145.0 here, 1.143.1 in the earlier results.

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

## 2026-11-08 04:29 (UI layer, rehearsal A+B+C, Playwright)

| Result | Step | Time | Detail |
|---|---|---|---|
| PASS | Task A (inline) | 6 s | 1 review(s) applied (1 with the panel button); verify-task-a: RESULT: PASS (19/19 checks) |
| PASS | Task B (panel) | 102 s | 3 command card(s) allowed, 4 review(s) applied (4 with the panel's "Apply accepted" button, the rest with Meta+Enter), CodeLens text seen: true; verify-task-b: RESULT: PASS (7/7 checks) |
| PASS | Task C (fallback) | 5 s | fallback notice shown; workspace pristine before the first apply; 1 review(s) applied; verify-task-a: RESULT: PASS (19/19 checks) |

| Task | Instruction -> first diff | First diff -> verified | (of which verify script) | Instruction -> verified | Model calls | Tool calls | Tokens | Commands auto-allowed | Allow clicks | Diff reopened (lens retry) |
|---|---|---|---|---|---|---|---|---|---|---|
| Task A | 3.5 s | 1.6 s | 0.2 s | 5.1 s | 2 | 1 | 6,214 | 0 | 0 | 0 |
| Task B | 36.3 s | 65.9 s | 1.1 s | 102.2 s | 19 | 29 | 332,857 | 0 | 3 | 0 |
| Task C | 2.7 s | 1.7 s | 0.1 s | 4.3 s | 2 | 1 | 6,177 | 0 | 0 | 0 |
| **A+B+C** | **42.4 s** | **69.2 s** | 1.4 s | **111.7 s** | 23 | 31 | 345,248 | 0 | 3 | 0 |

Commands (no-pipes rule unchanged):
- Task A (inline): 0 run_command call(s): 0 auto-allowed, 0 asked (n/a)
- Task B (panel): 3 run_command call(s): 0 auto-allowed, 3 asked (100%) - why they asked: 2 x pipe or redirect (e.g. `2>&1 | tail`); 1 x chained commands
- Task C (fallback): 0 run_command call(s): 0 auto-allowed, 0 asked (n/a)

Spend of this run: counted from TrueForge session records (3 session(s), 11 turn(s)): 345,248 tokens = $0.03 at $0.08 per million tokens. Auto-allow switches: off.

## 2026-11-08 04:31 (live run, pid 77654)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 24 forge.* commands, none of them forge.e2e.* |
| 6 | PASS | live | 79.6 s | Task B with one rejected hunk -> the agent is told and the result is reported | agent told ("applied 2 of 3 hunks (+15 -0 lines) to src/flask/cli.py; rejected: hunk 1 (line 7): + impo"); final message 1531 chars; 6 run_command card(s), 6 allowed (autopilot sends the Allow message), 6 review(s) decided; verify-task-b: RESULT: FAIL (6/7 che |

## 2026-11-08 04:39 (hermetic run, pid 79437)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 24 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.3 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | hermetic | 0.4 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |
| 11 | PASS | hermetic | 3.3 s | Reject hunk 1, accept the rest, apply: 10 times in a row with the file not open in any editor (no model) | 10 of 10 rounds: hunk 1 rejected, 2 of 3 hunks applied and found on disk; the applier logged 0 closed-document retries (0 where the edit had already landed and only needed saving); 38 Forge log lines read |
| 12 | PASS | hermetic | 0.6 s | Panel buttons: 'Apply accepted' with 2 of 3 hunks (1 undecided) writes 2, one undo restores; 'Reject all' writes nothing | Apply accepted: "2 of 3 hunks accepted, 1 undecided", 2 hunks on disk (hunk 1 absent), a double click applied once, ONE undo restored the exact text; Reject all: state rejected, git clean, a stale Apply click ignored |
| 13 | PASS | hermetic | 0.8 s | Panel 'Accept all and apply': undecided hunks accepted, a rejected one stays rejected, ONE undo restores | round 1: hunk 1 rejected, 2+3 undecided -> applied 2 of 3, hunk 1 absent on disk, a stale click ignored; round 2: all undecided -> applied 3 of 3, ONE undo restored the exact text |
| 14 | PASS | hermetic | 38.5 s | CodeLens provider answers for a freshly opened review diff: 30 of 30 rounds, right after the open and after 1.1 s | 30 of 30 rounds: Accept all, Reject all, Apply (n of 3 accepted) and 3 Accept hunk lenses offered right after the open and again after 1.1 s; none offered after the review finished |

