# End-to-end results

One block per run of `npm run test:e2e` (docs/e2e.md). Hermetic = no model; live = real TrueForge + model.

## 2026-11-04 05:49 (hermetic run, pid 16645)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | FAIL | hermetic | 0.0 s | nohooks suite | no result file was written (VS Code did not start the suite) |
| - | FAIL | hermetic | 0.0 s | scenarios suite | no result file was written (VS Code did not start the suite) |

## 2026-11-04 06:08 (hermetic run, pid 17346)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.4 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | FAIL | hermetic | 20.1 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | timed out after 20000 ms waiting for the review to be shown |
| 4 | FAIL | hermetic | 20.1 s | Undo run restores the files (Fake Proposal) | timed out after 20000 ms waiting for the review to be shown |
| 1 | SKIP | live | 0.0 s | Task A inline edit, accept all -> verify-task-a PASS | needs E2E_LIVE=1 (real model) |
| 2 | SKIP | live | 0.0 s | Task A partial accept (reject the code hunk) -> only the docstring changed | needs E2E_LIVE=1 (real model) |
| 5 | SKIP | live | 0.0 s | Task B via the panel, accept all -> verify-task-b PASS | needs E2E_LIVE=1 (real model) |
| 6 | SKIP | live | 0.0 s | Task B with one rejected hunk -> the agent is told and the result is reported | needs E2E_LIVE=1 (real model) |
| 7 | SKIP | live | 0.0 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | needs E2E_LIVE=1 (real model) |
| 8 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | needs E2E_LIVE=1 (real model) |
| 9 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | needs E2E_LIVE=1 (real model) |

## 2026-11-04 06:09 (hermetic run, pid 17686)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.3 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | FAIL | hermetic | 20.2 s | Undo run restores the files (Fake Proposal) | timed out after 20000 ms waiting for the review to be applied |
| 1 | SKIP | live | 0.0 s | Task A inline edit, accept all -> verify-task-a PASS | needs E2E_LIVE=1 (real model) |
| 2 | SKIP | live | 0.0 s | Task A partial accept (reject the code hunk) -> only the docstring changed | needs E2E_LIVE=1 (real model) |
| 5 | SKIP | live | 0.0 s | Task B via the panel, accept all -> verify-task-b PASS | needs E2E_LIVE=1 (real model) |
| 6 | SKIP | live | 0.0 s | Task B with one rejected hunk -> the agent is told and the result is reported | needs E2E_LIVE=1 (real model) |
| 7 | SKIP | live | 0.0 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | needs E2E_LIVE=1 (real model) |
| 8 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | needs E2E_LIVE=1 (real model) |
| 9 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | needs E2E_LIVE=1 (real model) |

## 2026-11-04 06:10 (hermetic run, pid 17940)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.3 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | FAIL | hermetic | 20.2 s | Undo run restores the files (Fake Proposal) | timed out after 20000 ms waiting for the review to be applied |
| 1 | SKIP | live | 0.0 s | Task A inline edit, accept all -> verify-task-a PASS | needs E2E_LIVE=1 (real model) |
| 2 | SKIP | live | 0.0 s | Task A partial accept (reject the code hunk) -> only the docstring changed | needs E2E_LIVE=1 (real model) |
| 5 | SKIP | live | 0.0 s | Task B via the panel, accept all -> verify-task-b PASS | needs E2E_LIVE=1 (real model) |
| 6 | SKIP | live | 0.0 s | Task B with one rejected hunk -> the agent is told and the result is reported | needs E2E_LIVE=1 (real model) |
| 7 | SKIP | live | 0.0 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | needs E2E_LIVE=1 (real model) |
| 8 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | needs E2E_LIVE=1 (real model) |
| 9 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | needs E2E_LIVE=1 (real model) |

## 2026-11-04 06:10 (hermetic run, pid 18223)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.4 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | hermetic | 0.3 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |
| 1 | SKIP | live | 0.0 s | Task A inline edit, accept all -> verify-task-a PASS | needs E2E_LIVE=1 (real model) |
| 2 | SKIP | live | 0.0 s | Task A partial accept (reject the code hunk) -> only the docstring changed | needs E2E_LIVE=1 (real model) |
| 5 | SKIP | live | 0.0 s | Task B via the panel, accept all -> verify-task-b PASS | needs E2E_LIVE=1 (real model) |
| 6 | SKIP | live | 0.0 s | Task B with one rejected hunk -> the agent is told and the result is reported | needs E2E_LIVE=1 (real model) |
| 7 | SKIP | live | 0.0 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | needs E2E_LIVE=1 (real model) |
| 8 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | needs E2E_LIVE=1 (real model) |
| 9 | SKIP | live | 0.0 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | needs E2E_LIVE=1 (real model) |

## 2026-11-04 06:14 (live run, pid 19283)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 10 | PASS | hermetic | 0.3 s | Forge panel view resolves and posts its init state; CodeLens provider returns Accept/Reject lenses | panel resolved (ready x1); 9 lenses: Accept all, Reject all, Apply (0 of 3 accepted) ▸, ✓ Accept hunk, ✗ Reject hunk |
| 3 | PASS | hermetic | 0.4 s | After an apply, ONE real `undo` restores the pre-apply text (single undo step) | one undo restored the exact pre-apply text (3 hunks applied as one undo step) |
| 4 | PASS | hermetic | 0.3 s | Undo run restores the files (Fake Proposal) | git status clean after Undo run |
| 1 | PASS | live | 5.9 s | Task A inline edit, accept all -> verify-task-a PASS | PASS in 6 s; 6296 tokens |
| 2 | PASS | live | 7.6 s | Task A partial accept (reject the code hunk) -> only the docstring changed | code hunk kept as it was, docstring updated (1 of 2 hunks applied) |
| 5 | PASS | live | 136.5 s | Task B via the panel, accept all -> verify-task-b PASS | PASS in 136 s; 70 tool calls, 51 model calls, 1398739 tokens; context items 59 |
| 6 | FAIL | live | 43.7 s | Task B with one rejected hunk -> the agent is told and the result is reported | the agent was not told about the rejected hunk; first propose_edit result: applied 2 of 2 hunks (+3 -1 lines) to src/flask/helpers.py |
| 7 | PASS | live | 8.3 s | Stop mid-run -> state cancelled, workspace pristine (git status clean) | cancelled 21 ms after the click, workspace pristine; notice: Cancelled. Rolled back 1 file from this run: src/flask/cli.py |
| 8 | PASS | live | 3.7 s | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, pristine before the first apply, Task A PASS | broken-endpoint/broken unreachable (connection refused) -> switched to deepseek/flash (after 27 ms).; clean before the first apply; Task A PASS |
| 9 | PASS | live | 0.3 s | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | Cancelled. Rolled back 1 file from this run: src/flask/cli.py \| No model could answer. broken-endpoint/broken (unreachable: connection refused). Check Settings -> Models in TrueForge (is the provider  |

## 2026-11-04 06:17 (live run, pid 20175)

| # | Result | Kind | Time | Scenario | Detail |
|---|---|---|---|---|---|
| 0 | PASS | hermetic | 0.0 s | Normal activation (no FORGE_E2E) registers no forge.e2e.* command | 23 forge.* commands, none of them forge.e2e.* |
| 6 | FAIL | live | 142.7 s | Task B with one rejected hunk -> the agent is told and the result is reported | the agent was not told about the rejected hunk; first propose_edit result: {"error":[{"type":"text","text":"{\"error\":\"User denied tool call: Could not write the change to src/flask/cli.py: Document has been closed. Nothing was applied.\"}"}]} |

