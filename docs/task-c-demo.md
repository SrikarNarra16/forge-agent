# Task C demo: provider failure -> automatic fallback (Extension Development Host)

Prerequisites: TrueForge running via `npm run tf:start` (fast-failure settings), the demo providers registered (`npm run tf:setup -- --only-demo`, already done on this machine: `broken-endpoint/broken` and `badkey-deepseek/flash` exist), `npm run build`, F5. Use a CLEAN scratch checkout of Flame 3.1.3 (`git status` must be empty first).
Settings are changed in USER settings (never the workspace): command palette -> **Forge: Switch Model**, or Settings -> `forge.models`.

## 1. Fallback (chain [broken, flash])
1. `forge.models` = `["broken-endpoint/broken", "deepseek/flash"]`.
2. Select `get_debug_flag` in `src/flask/helpers.py`, run **Forge: Edit Selection** (Cmd+Alt+K), type the Task A instruction: *treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value*.
3. Expected within about 3-5 s: the panel shows **"broken-endpoint/broken unreachable (connection refused) -> switched to deepseek/flash (after N s)"** (also in the status bar for 8 s); no error toast; then the diff opens.
4. **Before accepting any hunk** run `git status --porcelain` in the checkout: expected empty (the failed attempt changed nothing). Accept the hunks, then `FLASK_DEBUG=off python -c "from flask.helpers import get_debug_flag; print(get_debug_flag())"` -> `False`.
5. Output -> Forge shows `attempt 1: model=broken-endpoint/broken failed class=unreachable ... session=... url=...`, `fallback: ... -> deepseek/flash after N ms`.

## 2. Clear error (chain [broken] only)
1. `forge.models` = `["broken-endpoint/broken"]`; repeat step 2 above.
2. Expected: a toast and a panel notice: *No model could answer. broken-endpoint/broken (unreachable: connection refused). Check Settings -> Models in TrueForge ... forge.models.*; the editor stays responsive; `git status --porcelain` empty; the next request can be sent.

## 3. Invalid key (chain [badkey-deepseek/flash, deepseek/flash])
Expected: classified as an authentication failure (`rejected the API key (400: api key not valid)`), switched at once with no retries.

## 4. Freezing TrueForge (not a model failure)
1. Chain [deepseek/flash, deepseek/v4-pro]. Start a request, then `kill -STOP $(lsof -ti :8790)`.
2. Press **Stop**: "Stopped" within about a second (P09). `kill -CONT <pid>`.
3. Quit TrueForge instead (Ctrl-C) and send a request: expected **"TrueForge is not reachable ... npm run tf:start"**, no fallback attempted, no misleading "model failed" text.

## 5. Stall (optional)
Set `forge.stallFirstEventSeconds` to 5 and use a slow model or freeze TrueForge's provider call: after 5 s the panel shows a retry, then a switch ("stopped responding"). A pending approval or a running `run_command` never triggers it. Reset the setting to 45.

## 6. Side effects block replay
Send Task B; accept the first file's diff; kill the provider connection (stop TrueForge's network or use `kill -STOP` plus the stall setting at 5 s). Expected: no replay; the message lists the applied file and offers **Undo run**.

Results table (fill in): | # | Case | PASS/FAIL | Notes |
