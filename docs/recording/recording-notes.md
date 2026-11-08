# Recording notes

How to record, export and publish the demo video (max 4:00, editor visible, Tasks A, B, C in order, each followed by its verification, no cuts between instruction and diff). The plan of what to show and say is in `shot-list.md`; this file is the mechanics. Written for macOS; the Linux/Windows equivalents are in brackets.

## 0. The sequence on the day
0. **After any code change, rebuild and reinstall the extension before recording:** `npm run package`, then `"/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" --install-extension forge-agent-0.0.1.vsix --force`, then reload the VS Code window (Command Palette -> "Developer: Reload Window"). The window runs the INSTALLED copy, not the source; the preflight shows the installed version but cannot tell a stale build. (Last installed: the build that contains the "Open in TrueForge" link to the Sessions page.)
1. `docs/recording/preflight.sh` must print **GO** (it lists what is wrong when it does not). Run it with VS Code open on the Flask fixture, so Forge has registered its agents.
2. `docs/recording/reset.sh` returns the fixture to the start state; follow the checklist it prints (close editors, new chat, models, the terminal helpers). The chain for Task C and the switch back are described in `shot-list.md` ("Switching the model chain for Task C, and back").
3. **Warm-up rule: run one throwaway diff before recording.** Command Palette -> **Forge: Fake Proposal**, wait until the "Accept hunk" buttons are drawn above the changes, then click **Reject all** in the Forge panel (nothing is written). One cold diff showed no CodeLens once in a live run (not reproducible in 120 warm and 20 cold test launches, see `docs/e2e.md` "Known risks"); a throwaway diff makes sure you see a problem before the camera does. Then run `reset.sh` once more.
4. Start the recording, follow the shot list, stop the recording.
5. Export, check the duration, upload, test the link, fill in the scorecard (sections 4 to 6).

**TrueForge version.** `npm run tf:start` runs the version everything was tested with (0.183.1, set in `trueforge/start.sh`); a plain `npx @truefoundry/trueforge@latest` moved to 0.184.2 on 8 Nov 2026 and, started while an older TrueForge was still running, replaced the web UI files that one was serving: its Sessions page went blank (the API kept working). If the preflight reports a blank Sessions page, stop TrueForge (Ctrl+C in its terminal) and start it again with `npm run tf:start`; its data (SQLite) is kept. Back up the database folder first if you want to be careful. Do not start a second TrueForge with `@latest` while recording.

## 1. Recording setup
**Screen and size**
- Record at **1920x1080**. Cleanest: System Settings -> Displays -> choose the scaled resolution "1920 x 1080" (or the closest "Larger Text" option), so the capture is natively 1080p. On a Retina display at its default scaling the capture is larger (for example 2880x1800); that is fine, scale it down at export (section 3).
- Tool: **Cmd+Shift+5** -> "Record Entire Screen" (or "Record Selected Portion" around the VS Code window) -> Options: save to a folder you can find, **Microphone: your external mic or the built-in one**, "Show Mouse Clicks" on. Alternative: **QuickTime Player** -> File -> New Screen Recording. [Linux: OBS Studio. Windows: OBS Studio or Xbox Game Bar, Win+G.]
- Hide the **Dock**: Cmd+Option+D. Auto-hide the menu bar: System Settings -> Control Center -> "Automatically hide and show the menu bar: Always".
- **Do Not Disturb**: Control Center -> Focus -> Do Not Disturb, on until the video is exported. This hides notification banners (calendar, chat, mail, updates). Quit Slack, Mail, Messages, browsers with tabs you do not want to show.
- Keep the Mac awake: run `caffeinate -dis &` in a terminal you will not show (stop it afterwards with `kill %1`), and plug in the power.
- Close every unrelated window. One VS Code window, on the primary display, full screen (Ctrl+Cmd+F) or maximised.

**VS Code legibility** (use the zoom commands, do not edit `settings.json` on camera)
- Command Palette -> **View: Zoom In** twice (about 120%), so text is readable at 1080p after YouTube compression. Editor font about 15-16 px: **Cmd+=** while a text editor is focused does the same for the whole window.
- Hide what is not needed: Minimap off (View -> Appearance), Activity Bar visible (the Forge icon), Status Bar visible (it shows `TrueForge: connected` and the model), bottom panel closed except for the verification terminal in Task B and C.
- Layout: Forge panel in the side bar wide enough for the Context section, editor on the right. Do not open Settings or the Extensions view.
- Theme: a dark theme with good contrast; the Forge panel follows it.

**Audio**
- Mic check before every session: record 10 seconds, play it back, peaks around -12 dB (QuickTime shows the level while recording), no keyboard thumping, no fan noise. Use the narration lines in `shot-list.md`; it is fine to record with no narration and add text titles instead, but then the video must still be legible without sound.

## 2. While recording
- Do not touch the mouse between the moment you press Enter on an instruction and the moment the diff appears (no cuts allowed there; the model wait is real and must stay).
- If something goes wrong (provider 503, a stray notification), stop, run `reset.sh`, and start a new take. Do not patch it in the editor.
- Do not show: API keys, the shell environment (`env`, `printenv`), your settings file, other windows, notifications, your home folder path in a prompt (use a short prompt such as `PS1='$ '` in the terminal you show).

## 3. Export (MP4, H.264, under 4:00)
QuickTime and Cmd+Shift+5 save a `.mov`. Convert to MP4/H.264 at 1080p with ffmpeg (`brew install ffmpeg` once):
```bash
ffmpeg -i take.mov -vf "scale=1920:1080:flags=lanczos" -c:v libx264 -preset slow -crf 20 -pix_fmt yuv420p \
       -c:a aac -b:a 128k -movflags +faststart forge-demo.mp4
```
Check the result:
```bash
ffprobe -v error -show_entries format=duration -of default=nw=1:nk=1 forge-demo.mp4     # seconds, must be < 240
ffprobe -v error -select_streams v:0 -show_entries stream=codec_name,width,height -of csv=p=0 forge-demo.mp4   # h264,1920,1080
ls -lh forge-demo.mp4
```
If `brew install ffmpeg` fails with "directories are not writable", Homebrew belongs to another macOS user: run the install as that user, or fix the ownership yourself (`sudo chown -R "$(whoami)" /opt/homebrew`), or download a static build of ffmpeg. Without ffmpeg: QuickTime -> File -> Export As -> 1080p gives an H.264 `.mov`, which YouTube accepts; the duration is shown in QuickTime's title bar / Movie Inspector (Cmd+I).

**Trimming.** Cut only the dead time you are allowed to cut (shot list column "Cut?"): QuickTime -> Edit -> Trim (Cmd+T), or `ffmpeg -ss 00:00:05 -to 00:03:50 -i in.mp4 -c copy out.mp4` for a head/tail trim (no re-encode; cuts at keyframes). Never cut between an instruction and its first diff. Speeding up a stretch is better than cutting it: `ffmpeg -i in.mp4 -filter_complex "[0:v]setpts=0.25*PTS[v]" -map "[v]" -an out.mp4` plays at 4x (mute it, say so with an on-screen title).

## 4. Upload (YouTube, unlisted)
1. studio.youtube.com -> **Create** -> **Upload videos** -> choose `forge-demo.mp4`.
2. Title: `Forge: a VS Code agent on TrueForge (Forge-a-thon demo)`. Description: one line, plus the repo URL (https://github.com/SrikarNarra16/forge-agent). Audience: "No, it's not made for kids".
3. Visibility: **Unlisted** (anyone with the link can watch; NOT "Private", which judges cannot open). Save/Publish.
4. Wait until processing says HD is available, then copy the link (`https://youtu.be/...`).
5. **Test the link**: open it in a private/incognito window while logged out, check that it plays at 1080p, that the length shows 3:5x or less, and that the first frame is the title. The rule for the round: the link must be reachable by judges at the 20 Nov 2026 deadline.
6. Alternative if YouTube is not an option: Google Drive -> upload -> Share -> "Anyone with the link" -> Viewer; test it logged out, too.
Put the URL in `docs/writeup/WRITEUP.md` (placeholder `VIDEO_URL`) and in the registration form.

## 5. Post-recording checklist (fills in the scorecard)
Scrub the exported video (QuickTime or YouTube) and write down the timestamp `m:ss` of each item in the table below; copy the table into section 6 of `docs/writeup/WRITEUP.md`. Only claim what is visible at that second.

| Rubric item | What must be visible | Timestamp |
|---|---|---|
| A1 Inline edit | Task A: selection, shortcut, instruction typed; the diff with two hunks (code + docstring) and per-hunk Accept/Reject | `__:__` |
| A1 / B2 | Task A: accepting, the file changes, `False` printed by the verify command | `__:__` |
| A2 Agent mode | Task B: prompt with no files named; the agent's tool calls; edits to cli.py, tests/test_cli.py and docs/cli.rst (3+ files) | `__:__` |
| B1 Context assembly | Task B: the Context section open: items with source badges (pinned / auto-retrieved / read by the agent), reasons, the token budget bar | `__:__` |
| B2 Diff safety | Task B: the review queue, one hunk rejected or reviewed, Apply, and **one Cmd+Z** (or Undo run) restoring the file | `__:__` |
| run_command approval | Task B: the approval card, Allow, the pytest result | `__:__` |
| A3 Streaming / cancel | streamed text visible while the agent works (Task B); Stop, if you included the optional insert | `__:__` |
| B3 Resilience | Task C: the unreachable endpoint, the clear message or the switch to the second model, then `git status` clean | `__:__` |
| B4 TrueForge depth | the closing shot: the TrueForge Sessions page with the Task B session, the approval pauses, `list_tools` / `get_tool_info` / `call_tool` (deferred loading) | `__:__` |
| C1 Video | total duration `__:__` (< 4:00); tasks in order A, B, C, each followed by its verification | `__:__` |

Also check, once: the video shows no key, no settings file, no other window, no notification; the editor is visible at all times; each verification command output is readable.

## 6. If something is off after upload
YouTube lets you replace nothing in place (a re-upload creates a new link). Re-record rather than patch: the preflight, reset and warm-up make a new take cheap (about 10 minutes).
