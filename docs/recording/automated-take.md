# The automated take: a rehearsal and a backup, not the submission video

`npm run e2e:rehearsal` drives the real VS Code with Playwright through Tasks A, B and C, with the product's default settings, and records the window at 1920x1080. At the end of the same run a second short clip shows the TrueForge Sessions page for that run's Task B session.

**What it is:** a rehearsal (it proves the whole path works on the build you will record) and a backup (something to fall back on, or to compare your timing with).

**What it is not:**
- It has **no narration**, no title, and no voice. A robot types and clicks; nothing explains what the viewer sees.
- It is **not** the submission video. The rules want a human-led demo of the three tasks with the editor visible; this does not replace one, and nothing here is uploaded anywhere.
- It is not edited: every wait (the model, the approvals) runs at real speed, and the driver's clicks are instant, so its timing is NOT a human's timing (`estimate-timing.mjs` projects that).

## The files
Written under `e2e-output/video/` (gitignored; older takes stay there until you delete them):

| File | What it shows |
|---|---|
| `backup-take-rehearsal-<date>-<time>.webm` | the VS Code window, 1920x1080: Task A (inline edit), Task B (agent panel), Task C (broken model, fallback), each applied and verified |
| `backup-take-closing-sessions-<date>-<time>.webm` | headless Chrome, 1920x1080: the Sessions page, then this run's Task B session: the stats and timeline, an "Approved" pause, and the deferred tool loading (`Listing tools`, `get_tool_info`, `call_tool`) |

Durations are printed at the end of the run and written into `docs/e2e-results.md`; to read any video's duration without ffmpeg: `npm run video:duration -- <file.webm>` (headless Chrome). For your own exported `.mp4` / `.mov`: `mdls -name kMDItemDurationSeconds -raw <file>`.

## Why the Sessions page is a second clip
The first idea was to show it inside the same VS Code video. VS Code 1.145 opens web pages in a new native "Integrated Browser", which the page automation cannot read and which pauses itself while any notification is showing; the old Simple Browser panel is gone from the Command Palette. So the closing shot is recorded separately, in headless Chrome, from the same TrueForge. In the real recording you click **Open in TrueForge** in the panel header and use your own browser (`shot-list.md`).

## If you want to use it
You could play it back and record a voice-over, but then it is a screen-recording of a recording: say so, and check the rules before submitting anything like that. The safe use is the one above: proof that the path works, and a timing reference.
