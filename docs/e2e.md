# End-to-end tests in a real VS Code

Two layers, deliberately separate. Both launch the REAL extension (from `dist/`, so run `npm run build` first) inside your installed VS Code, against a temp copy of Flask, with a temp VS Code profile and TrueForge resources that carry a unique prefix. Results: docs/e2e-results.md.

| Layer | Command | What it drives | Model needed |
|---|---|---|---|
| 1 | `npm run test:e2e` | the extension host (VS Code API, real commands, real review UI, real applier) | no (hermetic set) |
| 1 live | `E2E_LIVE=1 npm run test:e2e` | the same, plus the three fixed tasks with a real model | yes (about $0.11 per pass) |
| 2 | `npm run test:ui` | the workbench UI with Playwright: Task B through the Forge panel with real clicks | yes (about $0.08) |
| 2 hermetic | `npm run test:ui:panel` | the panel's review controls, command-prefix line and Open in TrueForge button, with real clicks on Fake Proposal | no (and no TrueForge: the extension is pointed at a dead port) |
| 2 | `npm run e2e:rehearsal` | Tasks A, B, C in order, with 1080p video and screenshots | yes (about $0.09-0.12) |

## Prerequisites
- Node >= 22.14; `npm install`; `npm run build` (the tests load `dist/extension.js`).
- VS Code: found at `/Applications/Visual Studio Code.app/Contents/MacOS/Code`; set `VSCODE_EXE` for another install. Nothing is downloaded.
- The Flask fixture with its virtualenv (`fixtures/flask`, see docs/PROGRESS.md P00). It is only cloned from.
- Live runs: TrueForge running via `npm run tf:start`, the model providers registered, and for Task C the demo providers (`npm run tf:setup -- --only-demo`).
- Layer 2 only (one time): `npx playwright-core install ffmpeg` (Playwright's recorder; without it VS Code's window never attaches when video is on).

## Environment variables
| Variable | Meaning |
|---|---|
| `VSCODE_EXE` | VS Code executable to launch |
| `E2E_LIVE=1` | also run the live (real model) scenarios of Layer 1 |
| `E2E_ONLY=3,10` | run only these Layer 1 scenario ids |
| `FORGE_E2E=1` | set by the runner INSIDE the test VS Code only: registers the `forge.e2e.*` hooks (see below) |
| `FORGE_RESOURCE_PREFIX` | prefix for the TrueForge resources; the runner sets `e2e-<pid>-` (also settable as `forge.resourcePrefix`) |
| `TRUEFORGE_BASE_URL` | TrueForge address (default http://localhost:8790) |

## Safety design (why this cannot hurt your setup)
- **Your TrueForge resources**: the extension registers `<prefix>forge-editor`, `<prefix>forge-editor-extras`, `<prefix>forge-agent`, `<prefix>forge-inline`. With the runner's prefix `e2e-<pid>-` nothing collides with your `forge-*` resources. A name guard (`assertThrowaway`) only ever allows `e2e-<pid>-forge-*` (and the eval harness' `forge-eval-*`) to be deleted; the product names are refused. TrueForge is snapshotted before and after a live run, and the prefixed resources are deleted on every exit path, including errors and Ctrl-C.
- **Your VS Code profile and extensions**: a temp `--user-data-dir` and `--extensions-dir` with a temp `settings.json` are used; your own settings are never read or written. `forge.models` changes made by scenarios go to that temp profile.
- **Your running VS Code window**: the runner scrubs `ELECTRON_RUN_AS_NODE` and every `VSCODE_*` variable it may have inherited, so the test instance cannot run as plain Node or attach to your window.
- **`fixtures/flask`**: only cloned (`git clone --local`, pinned commit 22d92470, verified clean, and `import flask` verified to resolve into the copy). Tests run on the copy.
- **No hidden entry points**: the `forge.e2e.*` commands exist only when `FORGE_E2E=1`; they are not in `package.json` (so the packaged `.vsix` does not advertise them), and `test/e2eHooks.test.ts` checks that they are registered only behind that check. The scenario `0` of the e2e run starts VS Code WITHOUT `FORGE_E2E` and asserts that no `forge.e2e.*` command exists.
- **The hooks only drive the real product**: `forge.e2e.sendPanel` (the panel's Send path), `forge.e2e.inlineEdit` (a real selection in a real editor, then the function that follows the instruction QuickPick), `forge.e2e.state` (reads), `forge.e2e.decide` (an autopilot that uses the real `forge.review*` commands and the webview's own message handler for command cards). A source scan test asserts they contain no applier, `WorkspaceEdit`, `save`, CodeLens-registration or file-write code.
- **Cost guard**: a live pass prints its estimated cost first, uses the shared dollar ledger (`eval-output/ledger.jsonl`, $0.08 per million tokens, stop at an estimated $3 in total) and the live scenarios count their tokens into it. One pass is limited to an estimated $0.60.

## Layer 1 scenarios
| # | Scenario | Kind |
|---|---|---|
| 0 | normal activation registers no `forge.e2e.*` command (a second launch without `FORGE_E2E`) | hermetic |
| 10 | the Forge panel view resolves and posts its init state; the CodeLens provider returns Accept/Reject lenses for a proposal | hermetic |
| 3 | after an apply, ONE real `undo` restores the pre-apply text (single undo step) | hermetic (Fake Proposal) |
| 4 | Undo run restores the files | hermetic (Fake Proposal) |
| 11 | reject hunk 1, accept the rest, apply, 10 times in a row with the file not open in any editor (the applier race that scenario 6 found) | hermetic (Fake Proposal) |
| 12 | the panel buttons: "Apply accepted" with 2 of 3 hunks (1 undecided) writes 2, a double click applies once, ONE undo restores; "Reject all" writes nothing; a stale click is ignored | hermetic (Fake Proposal) |
| 1 | Task A inline, accept all -> `verify-task-a.sh` PASS | live |
| 2 | Task A, reject the code hunk -> only the docstring changed | live |
| 5 | Task B via the panel, accept all -> `verify-task-b.sh` PASS (time, tool and model call counts, tokens recorded) | live |
| 6 | Task B with one rejected hunk -> the agent is told and the result reported | live (failed once because of the applier race, now fixed; not re-run live yet, see docs/e2e-results.md finding 1) |
| 7 | Stop mid-run -> `cancelled`, workspace pristine | live |
| 8 | Task C: chain [broken-endpoint/broken, deepseek/flash] -> fallback notice, clean before the first apply, Task A PASS | live |
| 9 | Task C: chain [broken-endpoint/broken] only -> clear error, pristine workspace | live |

Scenarios 7 and 9 have no model-free variant: that would need a fake TrueForge server, which was kept out of scope (the plan said not to build a TrueForge clone). Each scenario has a hard time limit, so a hung command cannot hang the run. Between scenarios the temp workspace is reset with `git checkout` after reverting unsaved buffers.

## Layer 2 (Playwright) steps
Automated with real clicks and keystrokes, no test hooks: open the Forge view (command palette), find the webview by traversing the nested iframes (the one containing the composer textarea), type the Task B prompt and press Enter, wait for streamed text, click **Allow** on every `run_command` card, click each **Review diff** queue entry, assert the text **"Accept hunk"** is visible in the diff editor (CodeLens), jump to the top of the proposal and click the **Accept all** lens, click **Apply accepted** in the panel (Cmd+Enter only as a fallback; the log says how many reviews used the button), wait for the panel to say Done, run `verify-task-b.sh`. Rehearsal Task A: Quick Open `src/flask/helpers.py:<line>`, keyboard selection of `get_debug_flag`, **Cmd+Alt+K**, type the instruction. Rehearsal Task C: the temp profile's `forge.models` is rewritten to [broken, flash], the notice "switched to deepseek/flash" is awaited in the panel, `git status` is checked before the first apply.
Artifacts: `e2e-output/screens/NN-name.png` at each key moment (cleared at the start of each run) and `e2e-output/video/ui-<mode>-<timestamp>.webm` at 1920x1080 (Playwright's screencast recorder).

## Known limits
- Layer 2 is best effort: selectors depend on VS Code's workbench DOM (class names, `a[role=button]` CodeLens anchors) and may need maintenance after VS Code updates (written against 1.143.1). All waits are conditions; the only unconditional pauses are 300 ms poll ticks.
- Not covered by automation: native OS dialogs, the QuickPick's history navigation (Up/Down), the Switch Model QuickPick, the status bar item click-to-stop, a real network drop (use `scripts/flaky-proxy.ts` and docs/cancel-tests.md), and anything involving two windows. The manual protocols are docs/cancel-tests.md and docs/task-c-demo.md.
- Live scenarios depend on the model: a different answer can fail scenario 2 (it needs the edit to produce two hunks) or scenario 6. The failure detail says what happened.
- Playwright video requires its ffmpeg build (see Prerequisites); VS Code opens its window on the primary display, so keep the machine awake and the screen unlocked during a rehearsal.
- The Layer 2 token spend is an estimate (about 1.0-1.1M tokens per run); the exact tokens are not read back from the UI.
- Two VS Code windows can now run side by side against one TrueForge: give each a different `forge.resourcePrefix` (or `FORGE_RESOURCE_PREFIX`) and reload the window. The e2e runner does this automatically.

## Panel controls smoke (`npm run test:ui:panel`, hermetic)
Real clicks in the real workbench, no model, no TrueForge (`forge.trueforge.baseUrl` points at a port nobody listens on, so no TrueForge resource is created or touched). The temp clone gets a `.venv/bin/activate` and no explicit `forge.commandPrefix`, so the Context section must say the venv was auto-detected. Then: Fake Proposal -> card says "0 of 3 hunks accepted, 3 undecided" and Apply is disabled -> CodeLens "Accept hunk" -> "1 of 3 hunks accepted, 2 undecided" + the note that undecided hunks are not applied -> click **Apply accepted** in the panel -> "Applied 1 of 3 hunks; 2 not applied (rejected or undecided)." and exactly one edit on disk -> Fake Proposal again -> click **Reject all** -> "Rejected: nothing was written.". "Open in TrueForge" is checked for presence only; it is never clicked because it would open your browser. Why only one hunk is accepted through the lens: the other hunks are far down the file and their lenses are out of view in the collapsed diff; 2 of 3 is covered by Layer 1 scenario 12, which drives the panel's own message handler.
