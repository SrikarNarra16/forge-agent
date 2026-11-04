# Eval results

One row per headless eval run (`npm run eval`). Full JSON per run is in eval-output/ (gitignored).

| Run id | Date | Task | Model | Result | Checks | Tokens (in/out) | Notes |
|---|---|---|---|---|---|---|---|
| 2026-11-03-60404-r1 | 2026-11-03 | A | deepseek/flash | FAIL | a✗ b✗ | n/a | 2s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-60564-r1 | 2026-11-03 | A | deepseek/flash | FAIL | a✗ b✗ | n/a | 181s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: client-cancelled |
| 2026-11-03-61059-r1 | 2026-11-03 | A | deepseek/flash | FAIL | a✗ b✗ | n/a | 2s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-61185-r1 | 2026-11-03 | A | deepseek/v4-pro | PASS | a✓ b✓ | 6125/617 | 30s; 2 model calls; propose_edit×1 |
| 2026-11-03-61347-r1 | 2026-11-03 | A | deepseek/flash | FAIL | a✗ b✗ | n/a | 2s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-61347-r2 | 2026-11-03 | A | deepseek/flash | FAIL | a✗ b✗ | n/a | 2s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-61347-r3 | 2026-11-03 | A | deepseek/flash | PASS | a✓ b✓ | 2689/375 | 151s; 2 model calls; propose_edit×1; error: client-cancelled |
| 2026-11-03-62476-r1 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | 135370/3627 | 118s; 11 model calls; repo_map×1 search_code×7 read_file×13; key files in context 3/3, read 3/3; PROVIDER ERROR; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-62476-r2 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | 19341/573 | 9s; 4 model calls; repo_map×1 search_code×1 read_file×3; key files in context 3/3, read 1/3; PROVIDER ERROR; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-62476-r3 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | 21312/687 | 11s; 4 model calls; repo_map×1 search_code×2 read_file×3; key files in context 3/3, read 1/3; PROVIDER ERROR; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: [Model Error] Request failed (503): Service is too busy. We advise users to temp |
| 2026-11-03-63115-r1 | 2026-11-03 | B | deepseek/v4-pro | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | 12901/528 | 50s; 3 model calls; read_file×3 repo_map×1 list_dir×1; key files in context 3/3, read 1/3; PROVIDER ERROR; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: [Model Error] Request failed (500): Internal Server Error (request_id: 23fed3a0- |

## Notes on the first batch (3 Nov 2026)
- The first eight rows were produced while bringing the harness up. Rows marked PROVIDER ERROR failed because the model provider returned 503 "Service is too busy" / 500, or stalled until the client timeout. They measure the provider, not the agent or the context pipeline.
- The only clean agent results: Task A passed with deepseek/v4-pro (30 s, one `propose_edit`) and once with deepseek/flash (the edit was applied and scored; the run was then cancelled at the timeout because the second model call stalled).
- No Task B run completed on either model, so there is no Task B pass rate yet. What the Task B rows do show: the three key files (cli.py, tests/test_cli.py, docs/cli.rst) were in the injected context in 4/4 runs (59 items, 2054 of 6000 tokens, ~7 ms), and the agent read cli.py in every run.
| 2026-11-03-67851-r1 | 2026-11-03 | A | google-gemini/gemini-3-8-flash | FAIL | a✗ b✗ | n/a | 2s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (400): API key not valid. Please pass a valid API k |
| 2026-11-03-67851-r2 | 2026-11-03 | A | google-gemini/gemini-3-8-flash | FAIL | a✗ b✗ | n/a | 1s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (400): API key not valid. Please pass a valid API k |
| 2026-11-03-67851-r3 | 2026-11-03 | A | google-gemini/gemini-3-8-flash | FAIL | a✗ b✗ | n/a | 1s; 1 model calls; no tools; FAIL a: FLASK_DEBUG=off -> False; FLASK_DEBUG=OFF -> False; FLASK_DEBUG=Off -> False; FL; FAIL b: nothing changed; error: [Model Error] Request failed (400): API key not valid. Please pass a valid API k |
| 2026-11-03-77804-r1-a2 | 2026-11-03 | B | deepseek/flash | FAIL | a✓ b✓ c✓ d✓ e✓ f✓ g✗ | 466806/7497 | 217s; 23 model calls; get_symbols×1 read_file×15 search_code×5 run_command×3 propose_edit×4 list_tools×1 get_tool_info×1 call_tool×1 get_diagnostics×2; key files in context 3/3, read 3/3; 2 attempts (provider>agent); tests yes, deferred yes, scout no; FAIL g: unrelated: docs/api.rst |

## Baseline correction to scoring check (g) (3 Nov 2026) — scoring is frozen from here on
Check (g) used to fail on any file other than cli.py, tests/test_cli.py, docs/cli.rst (and CHANGES.rst). That is stricter than the competition rule (>= 3 files changed). It now FAILS only if a file outside `src/`, `tests/` and `docs/` is modified or any file is deleted; other touched files are reported as a note ("also touched: docs/api.rst") and do not fail the run. No other check changed. Unit-tested in test/evalScoring.test.ts.

Re-scoring every recorded Task B report (`npx tsx scripts/eval/rescore.ts`, from the recorded changedFiles; deletions were not recorded before, so they could not be re-checked):

| Run | Model | Check (g) before -> after | Overall before -> after | Note |
|---|---|---|---|---|
| 2026-11-03-62476-r1..r3 | deepseek/flash | PASS -> PASS | FAIL -> FAIL | provider errors (503), nothing edited |
| 2026-11-03-63115-r1 | deepseek/v4-pro | PASS -> PASS | FAIL -> FAIL | provider error (500), nothing edited |
| 2026-11-03-77804-r1-a2 | deepseek/flash | FAIL -> PASS (also touched: docs/api.rst) | FAIL -> PASS | the only answered run so far: 7/7 after the correction |
| 2026-11-03-79515-r1 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✓ d✓ e✓ f✗ g✓ | 335706/8992 | 366s; 19 model calls; search_code×5 get_symbols×1 read_file×16 run_command×3 propose_edit×2; key files in context 3/3, read 3/3; tests yes, deferred no, scout no; FAIL a: changed 2 file(s); missing docs/cli.rst; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: terminated |
| 2026-11-03-79515-r2 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | 61643/1250 | 375s; 7 model calls; repo_map×1 search_code×4 read_file×4 run_command×1; key files in context 3/3, read 3/3; tests no, deferred no, scout no; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: [Model Error] Response stream ended without a finish reason. |
| 2026-11-03-79515-r3 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | n/a | 302s; 1 model calls; no tools; key files in context 3/3, read 0/3; tests no, deferred no, scout no; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: terminated |
| 2026-11-03-79515-r4-a3 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | n/a | 303s; 1 model calls; no tools; key files in context 3/3, read 0/3; 3 attempts (provider>provider>agent); tests no, deferred no, scout no; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: terminated |
| 2026-11-03-79515-r5 | 2026-11-03 | B | deepseek/flash | FAIL | a✗ b✓ c✗ d✗ e✗ f✗ g✓ | n/a | 302s; 1 model calls; no tools; key files in context 3/3, read 0/3; tests no, deferred no, scout no; FAIL a: changed 0 file(s); missing src/flask/cli.py, tests/test_cli.py, docs/cli.rst; FAIL c: config not in the command list; FAIL d: flask config exited 2: Error: No such command 'config'.; FAIL e: new tests do not reference the config command; FAIL f: docs/cli.rst gained no section/entry for `flask config`; error: terminated |

## Baseline attempt, flash, Task B x5 (3 Nov 2026): NO USABLE BASELINE — tuning NOT started
Command: `npm run eval -- --task b --model deepseek/flash --runs 5` (harness before the outage rules). The table rows above (`79515-r1..r5`) say FAIL, but the failures are the provider's:

| Run | What happened | Real model answer? |
|---|---|---|
| r1 | 19 model calls, edited cli.py + test_cli.py, ran pytest, then the stream was dropped (`terminated`) after 365 s; docs/cli.rst not yet edited, so (a) and (f) fail | partial (cut off mid-run) |
| r2 | 7 calls of orientation, then `Response stream ended without a finish reason` | no |
| r3, r5 | no byte from the model for ~300 s, then `terminated` | no |
| r4 | two 503 "Service is too busy" in 3 s, then `terminated` after 303 s | no |

The old classifier labelled `terminated` and `stream ended without a finish reason` as agent failures; both are provider/stream drops and are now classified as provider failures (test added). Re-classified, **0 of 5 runs got a usable answer**. Together with the earlier single answered run (7/7 after the (g) correction, see above) there are **1 answered flash Task B run in total, below the gate of 4**, so the agent instructions were not touched.

What the real runs show about the agent (not the provider): it orients with repo_map/search_code, states a Context plan, reads cli.py/test_cli.py/docs/cli.rst (all three were in the injected context in every run), edits several files, runs pytest through run_command, and in the one complete run reviewed its work with git_diff discovered through list_tools / get_tool_info / call_tool. It sometimes tries to read docs through `grep` in run_command (denied by the harness allowlist: the tool description says not to use it for reading; to watch). It did not use a scout in any run.

Cost guard: 881,894 tokens (864,155 in / 17,739 out) over 3 attempts that used tokens, plus 6 provider-failed attempts with no tokens (not counted toward the 40-attempt cap). Limit 4,000,000.

To complete the baseline when DeepSeek is back (the harness now pauses 10 minutes after 3 provider failures in a row and stops after 3 such pauses; provider failures without tokens do not count):

    cd forge-agent && npm run eval -- --task b --model deepseek/flash --runs 5 --timeout 480

then, if at least 4 runs got a real answer, ask me to start the tuning loop.
| 2026-11-03-96101-r1 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ | 520045/9990 | 117s; 27 model calls; repo_map×1 search_code×11 read_file×13 run_command×6 propose_edit×6 list_tools×1 call_tool×2; key files in context 3/3, read 3/3; tests yes, deferred yes, scout no; error: Cancelled. Rolled back 4 files from this run: docs/api.rst, docs/cli.rst, tests/ |
| 2026-11-03-96101-r2 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ | 272381/6176 | 69s; 18 model calls; get_symbols×1 search_code×10 read_file×12 propose_edit×3 run_command×1; key files in context 3/3, read 3/3; tests yes, deferred no, scout no; error: Cancelled. Rolled back 3 files from this run: docs/cli.rst, tests/test_cli.py, s |
| 2026-11-03-96101-r3 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ | n/a | 3s; 1 model calls; no tools; key files in context 3/3, read 0/3; tests no, deferred no, scout no; error: Cancelled. Nothing had been changed. |
| 2026-11-03-96101-r4 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ | 14633/633 | 9s; 3 model calls; repo_map×1 search_code×2 read_file×3; key files in context 3/3, read 1/3; tests no, deferred no, scout no; error: Cancelled. Nothing had been changed. |
| 2026-11-03-96101-r5 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ | 189071/4227 | 40s; 13 model calls; get_symbols×2 search_code×8 read_file×10 run_command×1 propose_edit×1; key files in context 3/3, read 3/3; tests no, deferred no, scout no; error: Cancelled. Nothing had been changed. |

## Cancel trials (3 Nov 2026): Stop through the real controller at random points
Command: `npm run eval -- --task b --model deepseek/flash --cancel-at random --runs 5 --timeout 480` (seed 7; stratified cut points; the harness' simulated user takes 4 s per review so cuts can land on an open diff). Everything else is the product pipeline: real `controller.stop()`, registry, command tickets, in-flight apply tracking, rollback with the non-interactive restorer. After each Stop the harness asserts `git status --porcelain` is empty in the temp copy, the state is `cancelled`, and `stop()`/`send()` returned within 1 s; at the end the TrueForge snapshot diff must be empty.

| Trial | Cut | What the agent was doing | Rolled back | Workspace | stop() / send() after click |
|---|---|---|---|---|---|
| 1 | 116.5 s | after 40 tool calls (last read_file), several reviews already applied | 4 files (docs/api.rst, docs/cli.rst, tests/test_cli.py, src/flask/cli.py) | clean | 6 ms / 6 ms |
| 2 | 68 s | after 27 tool calls (last propose_edit) | 3 files (docs/cli.rst, tests/test_cli.py, src/flask/cli.py) | clean | 5 ms / 5 ms |
| 3 | 2.1 s | before the first tool call | nothing changed | clean | 1 ms / 1 ms |
| 4 | 8.7 s | after 6 tool calls (last search_code) | nothing changed | clean | 1 ms / 1 ms |
| 5 | 39.5 s | awaiting approval, a diff open | nothing changed | clean | 2 ms / 2 ms |

Result: **5/5** on all three checks; TrueForge resources identical before/after ("CLEANUP OK"). The state sequence in the log shows `... running > cancelling > cancelled` every time.
Cost: these 5 trials plus the resume spike used about 1.0M of the cost guard (ledger total now 1,902,214 tokens over 9 counted attempts; provider failures without tokens are logged separately: 7). Limits 4,000,000 tokens / 40 counted attempts.
Honest limits: 5 trials on one model/task; a cut during the exact milliseconds of an apply was not hit live (covered by the unit tests with a slow, gated apply); the "user edited the file after Forge" case is covered by unit tests and the manual protocol, not by these trials.
| 2026-11-03-1921-r1 | 2026-11-03 | B | deepseek/flash | FAIL | a✓ b✓ c✓ d✓ e✓ f✗ g✓ | 630968/9383 | 70s; 27 model calls; get_symbols×1 search_code×5 read_file×13 run_command×6 propose_edit×6 list_tools×1 get_diagnostics×1 get_tool_info×1 call_tool×3; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no; FAIL f: docs/cli.rst gained no section/entry for `flask config` |
| 2026-11-03-1921-r2 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 677967/10725 | 79s; 29 model calls; repo_map×1 get_symbols×1 read_file×13 search_code×9 run_command×8 propose_edit×4 list_tools×1 get_tool_info×1 call_tool×2 get_diagnostics×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-03-1921-r3 | 2026-11-03 | B | deepseek/flash | FAIL | a✓ b✓ c✓ d✓ e✓ f✗ g✓ | 519702/10423 | 70s; 25 model calls; repo_map×1 search_code×6 read_file×14 run_command×9 propose_edit×4 list_tools×1 get_tool_info×1 call_tool×3 get_diagnostics×2; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no; FAIL f: docs/cli.rst gained no section/entry for `flask config` |
| 2026-11-03-1921-r4 | 2026-11-03 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 405944/6748 | 50s; 20 model calls; get_symbols×1 search_code×3 read_file×13 propose_edit×6 run_command×5 list_tools×2 get_tool_info×1 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-3036-r1 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 5892/520 | 5s; 2 model calls; propose_edit×1; chain broken-endpoint/broken > deepseek/flash; fallback after 0.0 s |
| 2026-11-04-3036-r2 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 5901/537 | 4s; 2 model calls; propose_edit×1; chain broken-endpoint/broken > deepseek/flash; fallback after 0.0 s |
| 2026-11-04-3036-r3 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 9356/703 | 5s; 3 model calls; read_file×1 propose_edit×1; chain broken-endpoint/broken > deepseek/flash; fallback after 0.0 s |
| 2026-11-04-3423-r1 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ | n/a | 1s; 1 model calls; no tools; chain broken-endpoint/broken; error: No model could answer. broken-endpoint/broken (unreachable: connection refused). |
| 2026-11-04-3423-r2 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ | n/a | 1s; 1 model calls; no tools; chain broken-endpoint/broken; error: No model could answer. broken-endpoint/broken (unreachable: connection refused). |
| 2026-11-04-3423-r3 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ | n/a | 1s; 1 model calls; no tools; chain broken-endpoint/broken; error: No model could answer. broken-endpoint/broken (unreachable: connection refused). |
| 2026-11-04-3650-r1 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 5793/423 | 4s; 2 model calls; propose_edit×1; chain badkey-deepseek/flash > deepseek/flash; fallback after 0.2 s |
| 2026-11-04-3650-r2 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 5982/603 | 5s; 2 model calls; propose_edit×1; chain badkey-deepseek/flash > deepseek/flash; fallback after 0.2 s |
| 2026-11-04-3650-r3 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ c✓ d✓ | 5745/373 | 4s; 2 model calls; propose_edit×1; chain badkey-deepseek/flash > deepseek/flash; fallback after 0.2 s |
| 2026-11-04-3955-r1 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ | 5897/515 | 4s; 2 model calls; propose_edit×1 |
| 2026-11-04-3955-r2 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ | 5768/392 | 3s; 2 model calls; propose_edit×1 |
| 2026-11-04-3955-r3 | 2026-11-04 | A | deepseek/flash | PASS | a✓ b✓ | 5972/597 | 5s; 2 model calls; propose_edit×1 |
| 2026-11-04-4186-r1 | 2026-11-04 | A | deepseek/v4-pro | PASS | a✓ b✓ | 6375/874 | 10s; 2 model calls; propose_edit×1 |
| 2026-11-04-4186-r2 | 2026-11-04 | A | deepseek/v4-pro | PASS | a✓ b✓ | 6393/888 | 9s; 2 model calls; propose_edit×1 |
| 2026-11-04-4186-r3 | 2026-11-04 | A | deepseek/v4-pro | PASS | a✓ b✓ | 6220/721 | 8s; 2 model calls; propose_edit×1 |

## Task C live scenarios (4 Nov 2026): automatic model fallback, Task A, deepseek/flash as the real model
Cost-guard limit raised to 4.6M tokens for these runs only (`--token-limit 4600000`); no Task B or tuning runs. TrueForge had stopped overnight and was restarted with `npm run tf:start` (the documented fast-failure settings); models, demo providers and agents had persisted.

| Scenario (chain) | Runs | Result | Time to fallback | Workspace |
|---|---|---|---|---|
| `broken-endpoint/broken -> deepseek/flash` (`--fail-primary`) | 3 | 3/3 PASS: switched automatically, Task A scorer passed, only `helpers.py` changed | 39, 13, 11 ms (unreachable endpoint refuses at once, no retries) | clean at the moment of the switch (checked before the fallback applied anything) |
| `broken-endpoint/broken` only | 3 | 3/3 PASS: ended `error` with "No model could answer. broken-endpoint/broken (unreachable: connection refused). Check Settings -> Models in TrueForge ... forge.models", chain event `exhausted` | n/a | pristine (`git status` empty) |
| `badkey-deepseek/flash -> deepseek/flash` (invalid key on the real DeepSeek URL) | 3 | 3/3 PASS: classified as authentication failure (`401: authentication fails, your api key`), switched with no retries, Task A passed | 187, 218, 246 ms | clean at the switch |

TrueForge resources identical before/after every invocation. Notes: the unreachable endpoint refuses connections instantly, so the 3 s connect timeout of `tf:start` is not exercised by it (it bounds hosts that do not answer at all, which this demo cannot produce); real provider 503 retries/backoff are covered by unit tests with the real error strings, not by a live outage.

### Stall-timing measurement (Task A only; arrival time recorded per stream event)
`npx tsx scripts/eval/timing.ts` over the successful turns of today's runs (Task A: a short prompt, 2-3 model calls per run, tool results in between):

| Model | Successful turns | Time to first token (median / p95 / max) | Longest silence between progress events, no tool in flight (max) |
|---|---|---|---|
| deepseek/flash | 18 | 679 ms / 1459 ms / 1459 ms | 1459 ms |
| deepseek/v4-pro | 6 | 884 ms / 1254 ms / 1254 ms | 1240 ms |

Reading: for these small prompts both models answer within ~1.5 s and never go silent for more than ~1.5 s, a >30x margin below the 45 s / 90 s defaults. This does NOT validate the defaults for Task B (hundreds of thousands of input tokens per run, long reasoning): that needs the same measurement on Task B runs, which were excluded here. The only silences observed so far that would matter were provider stalls of ~300 s. Defaults unchanged (45 / 90); no data argues for a change.

Cost-guard ledger after these runs: 4,256,514 tokens (4,173,124 in / 83,390 out) over 25 counted attempts (limit for this batch 4.6M; the standing limit is 4.0M).
| 2026-11-04-8383-r1 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 617495/8863 | 64s; 25 model calls; read_file×12 get_symbols×1 search_code×7 run_command×3 propose_edit×5 list_tools×1 call_tool×1 get_diagnostics×1; changed 3 (3 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-8383-r2 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 445493/8061 | 58s; 24 model calls; search_code×8 get_symbols×1 read_file×12 run_command×3 propose_edit×4 list_tools×1 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-8383-r3 | 2026-11-04 | B | deepseek/flash | FAIL | a✓ b✓ c✓ d✓ e✓ f✗ g✓ | 358967/8381 | 56s; 19 model calls; get_symbols×1 search_code×9 read_file×9 propose_edit×5 run_command×6 list_tools×1 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no; FAIL f: docs/cli.rst WAS changed (17 non-blank line(s) added) but none contains the lite |
| 2026-11-04-8383-r4 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 331320/6291 | 44s; 19 model calls; search_code×5 get_symbols×1 read_file×11 propose_edit×5 run_command×3 list_tools×1 call_tool×1 get_diagnostics×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-8383-r5 | 2026-11-04 | B | deepseek/flash | FAIL | a✓ b✓ c✓ d✓ e✓ f✗ g✓ | 370487/8120 | 54s; 20 model calls; search_code×7 read_file×12 propose_edit×4 run_command×6 list_tools×1 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no; FAIL f: docs/cli.rst WAS changed (13 non-blank line(s) added) but none contains the lite |

## Task B tuning loop, deepseek/flash (4 Nov 2026). Scoring frozen; cost guard now in dollars ($0.08 per million tokens, stop at an estimated $3)
Baseline (runs `1921-r1..r4`, started by the user, no instruction changes since P08): **2/4** pass, ~559k tokens and 27-29 model calls per run. Both failures were check (f) only.

### Iteration 1: FEATURES step (change: `agents/forge-agent.json` instructions only)
- Change: a new FEATURES paragraph. Code, test and documentation are one job; find where similar features are documented and add the entry there in the same style, in the same step as code and test; name the feature the way users type it; before finishing check with `git_diff` that a docs file is in the diff; do not touch other files; work economically (use the Relevant locations, read each file range once, one search per question).
- Why: both baseline failures were attributed to "docs not updated".
- Result: **3/5** pass (a, b, c, d, e, g 5/5; f 3/5). Spend of the 5 runs about $0.17 (estimated total $0.51 of $3.00, 6.42M tokens).
- Efficiency: 332k-617k tokens per run (mean 425k, down 24% from 559k) and 19-25 model calls (was 27-29), 44-64 s per run. Behaviour: ran tests 5/5, git_diff via deferred loading 5/5, scout 0/5.
- **Finding: the two (f) failures are false negatives of the scorer, in both the baseline and iteration 1.** I read the recorded `propose_edit` arguments for all four failing runs (`1921-r1`, `1921-r3`, `8383-r3`, `8383-r5`). Every one of them DID update `docs/cli.rst` with a proper section ("Show the Config" / "Show the Configuration": a heading, 13-17 lines, the `$ flask --app hello config` example output, the masking rule, and a link `:func:\`config <cli.config_command>\``), exactly in the style of the existing "Open a Shell" section, which the repo writes as `:func:\`shell <cli.shell_command>\`` and `$ flask --app hello shell`. Check (f) only accepts the literal text `flask config`, ``` ``config`` ``` or `` `config` `` in an added line, so `flask --app hello config` and `:func:\`config <...>\`` fail it. The (f) failure detail now says whether the file was changed. Nothing was changed in the pass/fail rule.
- Decision requested (scoring is frozen, so I stopped the loop after one iteration instead of tuning prose to the regex): a corrected (f) such as "an added line matches `flask( --app \S+)? config`, ``` ``config`` ```, or `:func:` roles naming `config_command`, and >= 2 non-blank lines were added". Re-scored on recorded data it would turn the baseline from 2/4 into 4/4 and iteration 1 from 3/5 into 5/5 (the same kind of baseline correction as (g) on 3 Nov). Instructions that force the literal `flask config` into the prose would go against the file's own style, so I did not tune for it.

### Scorer correction after human review of the failing runs (4 Nov 2026): check (f). Scoring is frozen again from here.
Reason: reading the recorded edits of all four runs that failed (f) (baseline `1921-r1`, `1921-r3`, iteration 1 `8383-r3`, `8383-r5`) showed they DID document the command in `docs/cli.rst`, in the file's own style (`$ flask --app hello config`, `:func:\`config <cli.config_command>\``), but the old rule only accepted the literal text `flask config` / ``` ``config`` ``` / `` `config` ``.
New rule (`DOCS_ENTRY_PATTERNS` in `scripts/eval/score-task-b.ts`): the change must be in **docs/cli.rst**, add **>= 2 non-blank lines**, and an added line must match `flask( --app \S+)? config`, ` ``config`` `, or a `:func:` role naming `config_command`. Nothing else changed. A related bug in the scorer's diff reader was fixed at the same time: a tracked file WITHOUT changes was read as "every line added" (it could not have produced a false pass on any recorded run, but it gave wrong details); an unchanged tracked file now has no added lines.
Tests: the real added texts of the four runs are positive fixtures (`test/fixtures/task-b/docs-added/*.diff`); negative fixtures: an unrelated docs change, a one-line and a whitespace-only change, a mention of "config" in an unrelated context (`app.config[...]`, "the config file", `:class:\`Config\``), and a change to a DIFFERENT docs file (`docs-other-file.patch`, run against a real clone).

Re-scored from the recorded events (`npx tsx scripts/eval/rescore.ts`; the reconstruction of the added lines reproduced the recorded OLD result in every run that has events):

| Runs that got an answer | Before | After |
|---|---|---|
| Baseline `1921-r1..r4` (flash) | 2/4 | **4/4** (r1, r3: f FAIL -> PASS) |
| Iteration 1 `8383-r1..r5` (flash) | 3/5 | **5/5** (r3, r5: f FAIL -> PASS) |
| `77804-r1-a2` (flash, first complete run) | FAIL (g, fixed on 3 Nov) | PASS |
| Provider-error runs (`62476-*`, `63115-r1`, `79515-*`) | FAIL | FAIL (no usable answer) |

### Iteration 2 = confirming run: instructions UNCHANGED from iteration 1 (consistency check under the corrected scorer)
| 2026-11-04-11172-r1 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 396025/6904 | 52s; 21 model calls; repo_map×1 search_code×4 read_file×10 propose_edit×5 run_command×4 list_tools×1 get_tool_info×1 call_tool×1 get_diagnostics×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-11172-r2 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 326369/6984 | 46s; 17 model calls; get_symbols×1 search_code×4 read_file×9 propose_edit×4 run_command×3 list_tools×1 get_tool_info×1 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-11172-r3 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 516871/10955 | 74s; 23 model calls; run_command×5 search_code×8 get_symbols×1 read_file×14 propose_edit×4 list_tools×1 get_tool_info×1 call_tool×1 get_diagnostics×2; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-11172-r4 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 663504/9856 | 71s; 27 model calls; list_tools×1 repo_map×1 read_file×14 search_code×6 get_symbols×1 run_command×5 propose_edit×7 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |
| 2026-11-04-11172-r5 | 2026-11-04 | B | deepseek/flash | PASS | a✓ b✓ c✓ d✓ e✓ f✓ g✓ | 529714/9608 | 72s; 27 model calls; list_tools×1 get_symbols×1 read_file×13 search_code×10 propose_edit×4 run_command×6 call_tool×1; changed 4 (4 surfaced in context); key files in context 3/3, read 3/3; tests yes, deferred yes, scout no |

Result of iteration 2 (instructions unchanged, scorer as corrected): **5/5** pass (a-g all 5/5), 24-37 tool calls and 17-27 model calls per run, 326k-664k tokens, 46-74 s. Spend about $0.20 (estimated total $0.71 of $3.00, 8.90M tokens). Behaviour: ran tests 5/5, git_diff via deferred loading 5/5, scout 0/5.
**Stop rule met**: iteration 1 re-scored 5/5 and iteration 2 5/5, i.e. >= 4/5 twice in a row. Two tuning iterations were enough (of the 6 allowed); the instructions of iteration 1 are final.

| Stage (flash, Task B) | Pass (corrected scorer) | Pass (scorer as it was) | Tokens/run (mean) | Model calls/run | Tool calls/run (min / mean / max) | Seconds/run | Spend |
|---|---|---|---|---|---|---|---|
| Baseline, instructions of P08 (`1921-r1..r4`) | 4/4 | 2/4 | 568k | 20-29 (mean 25.3) | 32 / 37.8 / 41 | 67 | $0.18 |
| Iteration 1: FEATURES step (`8383-r1..r5`) | 5/5 | 3/5 | 433k | 19-25 (mean 21.4) | 28 / 30.4 / 32 | 55 | $0.17 |
| Iteration 2: unchanged, confirming (`11172-r1..r5`) | 5/5 | 5/5 | 495k | 17-27 (mean 23.0) | 24 / 32.2 / 37 | 63 | $0.20 |
