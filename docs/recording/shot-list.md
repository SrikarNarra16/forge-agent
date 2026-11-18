# Shot list: the submitted video (automated take, captions only)

The submission video is **not** a human screen recording: `npm run video:take` drives the real extension in a real VS Code (Playwright, 1920x1080, VS Code zoom +1), captures the screen as frames, draws captions into the page, and encodes an H.264 MP4 with a small macOS Swift tool (`scripts/video/assemble.swift`). No face, no voice, no narration, no e-mail, no git identity, no key, no notification, no other window (the temp VS Code profile has no account; the terminal prompt is `$ `; toasts are hidden; git blame in the status bar is off).

Run it (macOS, Google Chrome and VS Code installed, TrueForge running via `npm run tf:start`, models configured, about $0.05 of tokens; the cumulative $3 ledger cap is enforced):

```bash
npm run package                     # the take installs the .vsix into its own temp profile and runs THAT build
npm run video:take                  # one take; prints PASS/FAIL, the duration and the timestamp table
KEEP_FRAMES=1 TAKE=mytake npm run video:take     # keep the frames of a passing take, name the folder
npx tsx scripts/video/make-facts.ts e2e-output/video/take-<n>    # video timestamps etc. -> docs/writeup/facts.json
npx tsx scripts/video/inspect.ts "$PWD/e2e-output/video/take-<n>/forge-round1-submission.mp4" e2e-output/video/final-check 20 40 44   # PNGs at those seconds
```
A take passes only if every check passes: `verify-task-a` and `verify-task-b` (7/7), Cmd+Z changed the editor once and redo restored it, `pytest tests/test_cli.py -q` passed, `flask --help` lists `config`, the masked JSON shows `"***"`, the Sessions page shows approval pauses and `list_tools` / `get_tool_info` / `call_tool`, Task C switched to the second model with `git status` clean before apply and `verify-task-a` passing, Stop reached the stopped state within 2 s with `git status` clean, and the total is under 3:55. Takes are not edited: the only time manipulation is the labelled x3 (below). Task B varies from run to run (a failed check or a long run means a new take: the first take of 18 Nov failed `verify-task-b` check (g) and ran 4:13; the second passed at 3:30 and is the submitted one).

## Rules the take follows
- **Never a cut between an instruction and its first diff.** The real model wait stays at real speed.
- **x3 only after the first applied diff of Task B** (waiting, and the repeated review/approval cycles), always with an **"x3"** badge on screen. Everything else is real time.
- Captions per phase (text drawn in the page). Title card first: "Forge", "Team Monarch", Team ID, "automated, scripted run - captions only, no narration".
- The Task B terminal commands run in a plain `$ ` shell (zsh -f, no profile) with the Flask checkout's venv on PATH, and a demo app (`FLASK_APP=demo_app`, outside the checkout) whose config has `SECRET_KEY`, `API_TOKEN`, `DB_PASSWORD`, `SERVICE_KEY`.

## Timeline (take of 18 Nov 2026, 3:30; the exact times in the SUBMITTED file are in `docs/writeup/facts.json` and the write-up's scorecard)
| Clip | What is on screen | Caption(s) |
|---|---|---|
| Title card (3.5 s) | Forge, Team Monarch, Team ID, hashtags | |
| **Task A** (about 47 s) | `get_debug_flag` selected, **Cmd+Alt+K**, instruction typed, Enter; the review diff with two hunks and the CodeLens **Accept hunk / Reject hunk** (A1); both hunks accepted, applied; terminal: `FLASK_DEBUG=off python -c "...get_debug_flag()"` prints **False**; back in the editor **Cmd+Z once** (the file is restored, the tab shows the unsaved dot), then **Cmd+Shift+Z** (the edit is back, tab clean) | "Task A: inline edit", "Task A: per-hunk review", "Task A: verify - FLASK_DEBUG=off -> False", "Undo: one step (Cmd+Z once)", "Redo: ..." |
| **Task B** (about 1:35) | Forge panel, prompt with no file named, the agent searches and reads, `run_command` approval card (Allow), the first diff (`cli.py`, three hunks) accepted one hunk at a time then the rest, the **Context** section (auto-retrieved items with reasons, the token budget bar) right after the first diff, then the remaining reviews and approvals at x3; terminal: `pytest tests/test_cli.py -q` (passed), `flask --help \| tail -n 10` (lists `config`), `flask config \| python -m json.tool \| grep -E "SECRET\|TOKEN\|PASSWORD\|KEY\|APP_NAME"` (secret values `"***"`, `APP_NAME` unmasked) | "Task B: agent mode, no files named", "Task B: the first diff - per-hunk review", "Task B: Context - the files chosen and why", "run_command needs your approval", "reviews, approvals and waiting at x3", "pytest ...", "flask --help ...", "masked JSON" |
| **TrueForge Sessions page** (10 s, headless Chrome, this run's session) | stats (turns, tokens, tool calls, sub-agents 0), the **Approved** pills (approval pauses), the **Agent steps** group open: `Listing tools` (list_tools), `get_tool_info: git_diff`, `call_tool: git_diff` | "TrueForge Sessions: this run's turns and tool calls", "Approval pauses ...", "Agent steps: list_tools -> get_tool_info -> call_tool" |
| **Task C** (about 33 s) | model chain `[broken-endpoint/broken, deepseek/flash]`; same instruction; the editor stays responsive (scrolling) while the first endpoint refuses the connection; the panel notice "broken-endpoint/broken unreachable (connection refused) -> switched to deepseek/flash (after 45 ms)"; terminal `git status`: "nothing to commit, working tree clean"; review, apply, verify **False**; **Forge: Switch Model** -> `deepseek/flash` (chain switched back) | "Task C: unreachable endpoint -> automatic fallback", "git status: clean", "Switch the chain back ..." |
| **Stop** (about 10 s) | the Task B prompt again; the panel streams; **Stop** clicked; "Stopped: Cancelled. Nothing had been changed." after about 0.1 s; terminal `git status` clean | "Stop: immediate, nothing half-applied" |

## Not in the video (covered elsewhere)
Compaction (configured, never triggered: `docs/writeup/WRITEUP.md`, section 3), the scout subagent (never spawned: the Sessions page shows "Sub-agents 0"), rejecting a single hunk (`docs/e2e-results.md`, scenarios 2, 6, 11-13), a bad API key (`test/modelFallback.test.ts`).

## Fallback: a human recording
If the automated video cannot be used, the older kit still works: `preflight.sh` (GO / NO-GO), `reset.sh`, `terminal-prep.sh`, `estimate-timing.mjs`, `recording-notes.md` (screen-recording and export mechanics; ffmpeg or QuickTime). The rules there (no cut between an instruction and its first diff, x3 labelled, nothing sensitive on screen) are the same.
