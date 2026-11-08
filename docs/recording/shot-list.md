# Shot list: the 4-minute demo

Target length **3:45-3:55** (hard limit 4:00; `node docs/recording/estimate-timing.mjs` projects 3:45 for a median Task B take, 3:31 for a fast one and 3:49 for a slow one with a 3x speed-up). Tasks A, B, C in order, each followed by its verification, editor visible throughout, **no cuts between an instruction and its first diff**. The timings come from the live run of 8 Nov 2026 on the recorded build (`docs/e2e-results.md`, "Final verification"): instruction -> first diff was 3.5 s (A), 36.3 s (B) and 2.7 s (C); the other two takes had 43.6 s and 46.1 s for B, so plan for up to 46 s there. **Task B varies a lot between takes** (first diff -> verified: 65.9, 74.4 and 115.6 s; whole task 102, 118 and 162 s): see "Take selection" below.

Mechanics (setup, export, upload) are in `recording-notes.md`. Before every take: `docs/recording/preflight.sh` (GO), `docs/recording/reset.sh`, one throwaway Fake Proposal diff (warm-up rule).

**Before you press record (off camera)**
- In the terminal you will show: `PS1='$ '` and `export FORGE=<path of the forge-agent repository>` (so the commands below are short and no home path is visible), then `cd` into the Flask fixture. Open the terminal panel, then hide it again (it appears when needed).
- VS Code: fixture open, `src/flask/helpers.py` open, Forge panel visible in the side bar, `forge.models` = `["deepseek/flash", "deepseek/v4-pro"]`, zoomed for 1080p.

## Timeline

| Time | Scene | On screen | Narration (short, factual) | Cut? |
|---|---|---|---|---|
| **0:00-0:10** | **Title + pitch** | VS Code with the Forge panel, a one-line title overlay (add it in the editor or hold a title card) | "Forge is a VS Code coding agent on TrueForge. Nothing is written until you review the diff." (one breath, 9 s including pauses) | can be trimmed |
| **0:10-0:50** | **Task A: inline edit (about 40 s)** | | | |
| 0:10-0:18 | select and instruct | In `helpers.py`, select the `get_debug_flag` function (keyboard: click on `def`, Shift+Down to the end), press **Cmd+Alt+K**, paste instruction A, Enter | "Task A. I select get_debug_flag and ask for the change." | the typing can be sped up 2x; **do not cut after Enter** |
| 0:18-0:22 | **instruction -> diff (3.5 s)** | the review diff opens | (silent, or "one request to the agent on TrueForge") | **UNCUTTABLE** |
| 0:22-0:30 | the diff | two hunks: the docstring and the code; point at "Accept hunk / Reject hunk" above each | "Two hunks: the docstring and the code. Each can be accepted or rejected on its own." | no |
| 0:30-0:34 | accept and apply | **Accept all**, then **Cmd+Enter** (or the panel's "Accept all and apply") | "Accept, apply. One edit, one undo step." | no |
| 0:34-0:44 | verify | terminal: the two commands below; output `False` and `RESULT: PASS (19/19 checks)` | "FLASK_DEBUG=off now gives False; the verify script checks 19 cases." | the second command can be sped up |
| 0:44-0:50 | undo is one step (B2) | back in `helpers.py`: **Cmd+Z** once (both hunks revert), **Cmd+Shift+Z** (back) | "One Cmd+Z restores the whole edit." | no |
| **0:50-0:54** | reset (on camera) | terminal: `$FORGE/scripts/reset-fixture.sh` | (silent) | yes, 4 s, may be cut or sped up |
| **0:54-2:44** | **Task B: agent mode (about 110 s)** | | | |
| 0:54-1:00 | prompt, no files named | Forge panel: click the box, paste prompt B, Enter | "Task B. Agent mode, no files named: add a flask config command, with a test and docs." | the pasting can be sped up; **do not cut after Enter** |
| 1:00-1:12 | Context section | the panel's **Context** section (it opens by itself): groups **Pinned / Auto-retrieved / Read by the agent**, each item with its reason (`matches: ...`), the token budget bar | "Before the model answers, Forge retrieved context with BM25: these locations, why each was picked, inside a 6000-token budget." | **UNCUTTABLE** (part of the instruction -> diff gap) |
| 1:12-1:36 | the agent works | streamed text, tool cards (`search_code`, `read_file` with a "why"), the Context section filling with "Read by the agent" | "It searches, then reads only what it needs; every read carries a reason." | **UNCUTTABLE** until the first diff |
| 1:36-1:42 | **first diff** (36-45 s after the instruction) | the review diff of `src/flask/cli.py`, the review queue in the panel ("Review (N changes in M files)") | "First proposal. The agent has not written anything: this is a request that needs my approval." | UNCUTTABLE up to here |
| 1:42-1:52 | review and apply | accept the hunks, **Apply** (panel button or Cmd+Enter); the queue entry turns to "applied" | "I review per hunk, then apply." | read this first diff for 8 s (uncut); later diffs 2 s each |
| 1:52-2:02 | run_command approval | the approval card for `pytest`; click **Allow** | "Running tests needs approval too. The exact command is shown." | wait: speed up 3x |
| 2:02-2:20 | more diffs | `tests/test_cli.py` and `docs/cli.rst` (and any other file): accept, apply | "Code, test and documentation: three files, each reviewed." | **speed up 3x** (about 25-70 s of real time depending on the take) |
| 2:20-2:26 | the agent's own test run | the panel shows the pytest result (`... passed`) | "The agent runs the tests and sees them pass." | no |
| 2:26-2:44 | verification | terminal: type `vB` (below): `flask --help` (with `--app`) lists `config`; a demo app whose secrets print as `"***"`; `verify-task-b.sh` prints `RESULT: PASS (7/7 checks)` (its check (b) runs the project's pytest) | "flask --help lists config. A demo app's secrets come out as three stars. The verify script passes 7 of 7, tests included." | the commands' output can be sped up |
| **2:44-2:48** | reset (on camera) | `$FORGE/scripts/reset-fixture.sh` | | yes |
| **2:48-3:28** | **Task C: resilience (about 40 s)** | | | |
| 2:48-2:52 | the broken model | the panel header shows the model name: the first model is `broken-endpoint/broken` (set it BEFORE recording with **Forge: Switch Model**) | "Task C. The first model's endpoint is dead." | no |
| 2:52-3:00 | repeat Task A | select `get_debug_flag`, **Cmd+Alt+K**, paste instruction A (the same), Enter | "Same request as Task A." | typing can be sped up |
| 3:00-3:03 | **instruction -> notice and diff (2.7 s)** | the panel notice "... unreachable (connection refused) -> switched to deepseek/flash", then the diff | "Refused at once: Forge switches to the second model, through TrueForge." | **UNCUTTABLE** |
| 3:03-3:10 | nothing written yet | terminal: `git status` -> `nothing to commit, working tree clean` | "Nothing written yet: the workspace is clean." | no |
| 3:10-3:20 | accept, apply, verify | accept all, apply; terminal: `$FORGE/scripts/verify-task-a.sh \| tail -1` -> `RESULT: PASS (19/19 checks)` | "Accept and verify: the same 19 of 19." | can be sped up |
| 3:20-3:40 | buffer | (use only if needed; trim otherwise). **Right after the take, off camera: switch the chain back** (**Forge: Switch Model** -> `deepseek/flash`, section above) | | trim |
| **3:40-3:55** | **Closing: TrueForge depth (B4)** | **Click path (rehearsed, `docs/recording/sessions-*.png`):** (1) in the Forge panel header click **Open in TrueForge**: the browser opens the Sessions page on the CURRENT session (Task C's); (2) in the left list click the session titled `<context> Relevant locations ...` (agent `forge-agent`, about 11 turns): that is **Task B** (screenshot `sessions-2-detail-timeline.png`: stats, timeline of the turns); (3) scroll the right pane down to the last two turns: the purple **Approved** pills between turns are the approval pauses (`sessions-3-approvals.png`), and the last "Agent steps" group lists **`Listing tools · forge-editor-extras`** (list_tools), **`get_tool_info: git_diff (...)`** and **`call_tool: git_diff (...)`** (`sessions-4-deferred-loading-collapsed.png`; no need to expand anything) | "The same session in TrueForge. Each Approved is a pause where I reviewed the diff. And the extra tools were loaded on demand: Listing tools, get_tool_info, call_tool." | no |
| 3:55 | stop the recording | | | |

If the total is over 3:55, trim in this order: title (0:10 -> 0:07), the typing of the prompts (speed up), the reset segments, the second half of the Task B approvals (speed up). Never touch an UNCUTTABLE stretch.

## Exact text to type or paste
**Task A** (from `CLAUDE.md`, verbatim; also used for Task C):
```
treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value
```
**Task B** (the task statement of `CLAUDE.md` as a sentence: agent panel, no files named; this exact text is what passed the live runs):
```
Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "***". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.
```
**Task C** (from `CLAUDE.md`: break the endpoint/key, repeat A): set `forge.models` to `["broken-endpoint/broken", "deepseek/flash"]` before the take (Command Palette -> **Forge: Switch Model**, or the setting), then paste the Task A instruction again. `docs/task-c-demo.md` also describes the bad-key variant (`badkey-deepseek/flash`).

## Exact terminal commands (cwd = the Flask fixture)
Off camera, once, in the terminal you will show (see the header of `terminal-prep.sh`):
```bash
export FORGE=<path of the forge-agent repository>
cd <the Flask fixture>
PS1='$ '
source "$FORGE/docs/recording/terminal-prep.sh"
```
On camera you type the short names; each helper PRINTS the real command line before it runs it (typing the full commands live would add about 3 minutes):

| Type | Runs (and shows) | Expected |
|---|---|---|
| `vA` | `FLASK_DEBUG=off .venv/bin/python -c "import flask.helpers as h; print(h.get_debug_flag())"`, then `$FORGE/scripts/verify-task-a.sh \| tail -1` | `False`, then `RESULT: PASS (19/19 checks)` |
| `vB` | `.venv/bin/flask --app tests/test_apps/cliapp/app:testapp --help \| sed -n "/^Commands:/,\$p"`; then `cat demo_app.py` and `.venv/bin/flask --app demo_app.py config \| grep -E "SECRET\|TOKEN\|PASSWORD\|PAGE"`; then `$FORGE/scripts/verify-task-b.sh \| tail -9` | `config  Show the config for the app.` under Commands; `"API_TOKEN": "***"`, `"DB_PASSWORD": "***"`, `"SECRET_KEY": "***"`, `"PAGE_SIZE": 20`; `RESULT: PASS (7/7 checks)` |
| `vC` | `git status` (run it BEFORE applying in Task C) | `nothing to commit, working tree clean` |
| `rs` | `$FORGE/scripts/reset-fixture.sh` | `(clean)` |

Rehearsed on 8 Nov 2026 against a real Task B result (the output above is what it printed; `"DEBUG"` is left out of the grep on purpose: Flask's CLI prints `false` for it whatever the app sets). The demo app is created outside the fixture, so the fixture stays clean. After Task C's apply, run `vA` again for its verification.

## Take selection (Task B varies)
Three measured takes of Task B took 102, 118 and 162 seconds from Enter to verified (36-46 s to the first diff, then 66-116 s). The plan fits 3:50 with a median take (3:45) or a fast one (3:31); a slow take fits only with a 3x speed-up of the waits after the first diff (3:49). So: record Task B (steps from `reset` to the `vB` output) up to three times and keep the take whose Enter -> verified time is closest to two minutes or shorter. Record each task as its own clip if you like; the only rule is that nothing is cut between an instruction and its first diff.

## Switching the model chain for Task C, and back
`Forge: Switch Model` moves the model you pick to the front of `forge.models` and keeps the others.
- **To the broken chain (before Task C, off camera):** Command Palette -> **Forge: Switch Model** -> pick `broken-endpoint/broken` (not `badkey-deepseek/flash`). The chain is now `["broken-endpoint/broken", "deepseek/flash", "deepseek/v4-pro"]`: exactly Task C (broken first, `deepseek/flash` as the fallback).
- **Back (right after Task C, and `reset.sh` reminds you):** Command Palette -> **Forge: Switch Model** -> pick `deepseek/flash`. The chain is `["deepseek/flash", "broken-endpoint/broken", "deepseek/v4-pro"]`: Tasks A and B work (flash first), and `preflight.sh` accepts it. For the original clean chain, remove the `broken-endpoint/broken` line from `forge.models` in your user settings (Command Palette -> "Preferences: Open User Settings (JSON)"; do this off camera).
- Either way the preflight prints the chain it found and refuses one that starts with a demo model.

## What cannot be cut, what can be sped up
- **Cannot be cut** (the rule: no cuts between an instruction and its first diff): Task A 0:18-0:22, Task B 0:59-1:42 (the model wait, 36-45 s: use it for the Context section and the tool cards), Task C 3:00-3:03.
- **Can be sped up 2x or trimmed**: typing and pasting the prompts, the second and later diffs of Task B, the run_command wait, terminal output after the first line, the reset segments, the buffer.
- Speeding up is better than cutting: say so with a small on-screen "2x" label.

## Do not
- Do not show API keys, `env`/`printenv`, `~/.forge-keys` or any file that contains a key; do not open Settings (UI or JSON), the Extensions view, or the Providers page of TrueForge (it lists provider settings).
- Do not show other windows, other desktops, the Dock, the menu bar clock with notifications, browser tabs other than the TrueForge Sessions page, or your home folder path (`PS1='$ '`).
- Do not edit a file by hand during a task; do not use Undo/Cmd+Z except in the one place planned for it.
- Do not retry a task on camera after a provider error: stop, `reset.sh`, preflight, new take.
- Do not claim what the video does not show: compaction is NOT shown (the Task B session never reaches the 80,000-token trigger); Stop is not part of the three tasks (add an optional 10 s Stop insert only if there is time, and only then mention it in the scorecard).
