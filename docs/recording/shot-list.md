# Shot list: the 4-minute demo

Target length **3:55** (hard limit 4:00). Tasks A, B, C in order, each followed by its verification, editor visible throughout, **no cuts between an instruction and its first diff**. The timings come from the live run of 8 Nov 2026 on the recorded build (`docs/e2e-results.md`, "Final verification"): instruction -> first diff was 3.5 s (A), 36.3 s (B) and 2.7 s (C); the previous run had 43.6 s for B, so plan for up to 45 s there.

Mechanics (setup, export, upload) are in `recording-notes.md`. Before every take: `docs/recording/preflight.sh` (GO), `docs/recording/reset.sh`, one throwaway Fake Proposal diff (warm-up rule).

**Before you press record (off camera)**
- In the terminal you will show: `PS1='$ '` and `export FORGE=<path of the forge-agent repository>` (so the commands below are short and no home path is visible), then `cd` into the Flask fixture. Open the terminal panel, then hide it again (it appears when needed).
- VS Code: fixture open, `src/flask/helpers.py` open, Forge panel visible in the side bar, `forge.models` = `["deepseek/flash", "deepseek/v4-pro"]`, zoomed for 1080p.

## Timeline

| Time | Scene | On screen | Narration (short, factual) | Cut? |
|---|---|---|---|---|
| **0:00-0:10** | **Title + pitch** | VS Code with the Forge panel, a one-line title overlay (add it in the editor or hold a title card) | "Forge is a VS Code coding agent whose agent loop runs on TrueForge. Every change goes through a per-hunk diff review before anything touches disk." (one breath, under 10 s) | can be trimmed |
| **0:10-0:50** | **Task A: inline edit (about 40 s)** | | | |
| 0:10-0:18 | select and instruct | In `helpers.py`, select the `get_debug_flag` function (keyboard: click on `def`, Shift+Down to the end), press **Cmd+Alt+K**, paste instruction A, Enter | "Task A. I select get_debug_flag and ask for the change." | the typing can be sped up 2x; **do not cut after Enter** |
| 0:18-0:22 | **instruction -> diff (3.5 s)** | the review diff opens | (silent, or "one request to the agent on TrueForge") | **UNCUTTABLE** |
| 0:22-0:30 | the diff | two hunks: the docstring and the code; point at "Accept hunk / Reject hunk" above each | "Two hunks: the docstring and the code. Each can be accepted or rejected on its own." | no |
| 0:30-0:34 | accept and apply | **Accept all**, then **Cmd+Enter** (or the panel's "Accept all and apply") | "Accept, apply. One edit, one undo step." | no |
| 0:34-0:44 | verify | terminal: the two commands below; output `False` and `RESULT: PASS (19/19 checks)` | "FLASK_DEBUG=off now gives False; the verify script checks 19 cases." | the second command can be sped up |
| 0:44-0:50 | undo is one step (B2) | back in `helpers.py`: **Cmd+Z** once (both hunks revert), **Cmd+Shift+Z** (back) | "One Cmd+Z restores the whole edit." | no |
| **0:50-0:54** | reset (on camera) | terminal: `$FORGE/scripts/reset-fixture.sh` | "Reset the fixture for the next task." | yes, 4 s, may be cut or sped up |
| **0:54-2:44** | **Task B: agent mode (about 110 s)** | | | |
| 0:54-1:00 | prompt, no files named | Forge panel: click the box, paste prompt B, Enter | "Task B. Agent mode, no files named: add a flask config command, with a test and docs." | the pasting can be sped up; **do not cut after Enter** |
| 1:00-1:12 | Context section | the panel's **Context** section (it opens by itself): groups **Pinned / Auto-retrieved / Read by the agent**, each item with its reason (`matches: ...`), the token budget bar | "Before the model answers, Forge retrieved context with BM25: these locations, why each was picked, inside a 6000-token budget." | **UNCUTTABLE** (part of the instruction -> diff gap) |
| 1:12-1:36 | the agent works | streamed text, tool cards (`search_code`, `read_file` with a "why"), the Context section filling with "Read by the agent" | "It searches, then reads only what it needs; every read carries a reason." | **UNCUTTABLE** until the first diff |
| 1:36-1:42 | **first diff** (36-45 s after the instruction) | the review diff of `src/flask/cli.py`, the review queue in the panel ("Review (N changes in M files)") | "First proposal. The agent has not written anything: this is a request that needs my approval." | UNCUTTABLE up to here |
| 1:42-1:52 | review and apply | accept the hunks, **Apply** (panel button or Cmd+Enter); the queue entry turns to "applied" | "I review per hunk, then apply." | can be sped up 2x |
| 1:52-2:02 | run_command approval | the approval card for `pytest`; click **Allow** | "Running tests needs approval too. The exact command is shown." | wait can be sped up |
| 2:02-2:20 | more diffs | `tests/test_cli.py` and `docs/cli.rst` (and any other file): accept, apply | "Code, test and documentation: three files, each reviewed." | **speed up 2x** (about 25 s of real time) |
| 2:20-2:26 | the agent's own test run | the panel shows the pytest result (`... passed`) | "The agent runs the tests and sees them pass." | no |
| 2:26-2:44 | verification | terminal: the commands below: `flask --help` (with `--app`) lists `config`; pytest passes; `verify-task-b.sh` prints `RESULT: PASS (7/7 checks)` | "flask --help now lists config; the project's tests pass; the verify script checks the masking, the test and the docs: 7 of 7." | the commands' output can be sped up |
| **2:44-2:48** | reset (on camera) | `$FORGE/scripts/reset-fixture.sh` | | yes |
| **2:48-3:28** | **Task C: resilience (about 40 s)** | | | |
| 2:48-2:52 | the broken model | the panel header shows the model name: the first model is `broken-endpoint/broken` (set it BEFORE recording with **Forge: Switch Model**) | "Task C. The first model's endpoint is dead." | no |
| 2:52-3:00 | repeat Task A | select `get_debug_flag`, **Cmd+Alt+K**, paste instruction A (the same), Enter | "Same request as Task A." | typing can be sped up |
| 3:00-3:03 | **instruction -> notice and diff (2.7 s)** | the panel notice "... unreachable (connection refused) -> switched to deepseek/flash", then the diff | "Forge sees the refusal, switches to the second model through TrueForge, and carries on. The editor never blocked." | **UNCUTTABLE** |
| 3:03-3:10 | nothing written yet | terminal: `git status` -> `nothing to commit, working tree clean` | "Nothing has been written: the workspace is clean." | no |
| 3:10-3:20 | accept, apply, verify | accept all, apply; terminal: `$FORGE/scripts/verify-task-a.sh \| tail -1` -> `RESULT: PASS (19/19 checks)` | "Accept and verify: the same 19 of 19." | can be sped up |
| 3:20-3:40 | buffer | (use only if needed; trim otherwise; set the chain back to `deepseek/flash` later, off camera) | | trim |
| **3:40-3:55** | **Closing: TrueForge depth (B4)** | click **Open in TrueForge** in the panel header (or open the Sessions page): the Task B session. Scroll to: the `tool.approval_required` pauses; `list_tools`, `get_tool_info`, `call_tool` (deferred loading of `forge-editor-extras`, then `git_diff`) | "The same session in TrueForge: tool approval pauses drive the diff review, and the extra tools are loaded on demand: list_tools, get_tool_info, call_tool." | no |
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

## Exact terminal commands (cwd = the Flask fixture, `$FORGE` = the forge-agent repository)
```bash
# Task A
FLASK_DEBUG=off .venv/bin/python -c "import flask.helpers as h; print(h.get_debug_flag())"     # prints False
$FORGE/scripts/verify-task-a.sh | tail -1                                                       # RESULT: PASS (19/19 checks)

# between tasks
$FORGE/scripts/reset-fixture.sh

# Task B
.venv/bin/flask --app tests/test_apps/cliapp/app:testapp --help | sed -n '/^Commands:/,$p'         # lists config (plain `flask --help` prints an app-not-found error first)
.venv/bin/python -m pytest tests/test_cli.py -q | tail -3                                       # passed
.venv/bin/flask --app tests/test_apps/cliapp/app:testapp config | grep -E '"(SECRET_KEY|DEBUG)"'  # SECRET_KEY is "***" (rehearse once: it depends on the app config)
$FORGE/scripts/verify-task-b.sh | tail -9                                                       # RESULT: PASS (7/7 checks)

# Task C
git status                                                                                      # clean, BEFORE applying
$FORGE/scripts/verify-task-a.sh | tail -1                                                       # RESULT: PASS (19/19 checks), after applying
```

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
