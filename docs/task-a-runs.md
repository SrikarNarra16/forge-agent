# Task A run log

Task A (Flask 3.1.3 @ 22d92470): select `get_debug_flag` in `src/flask/helpers.py` and instruct
*"treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value"*.
Pass = `scripts/verify-task-a.sh` prints `RESULT: PASS` (runtime checks for off/OFF/n/N/0/false/no/on/1 and the
docstring listing 0, false, no, off, n). Reset between runs with `scripts/reset-fixture.sh`.

## Manual runs (Extension Development Host, real GUI)
| Run | Model | Result | Notes |
|---|---|---|---|
|  |  |  |  |

## Headless runs (`npx tsx scripts/run-task-a-headless.ts`)
Real controller + SDK + product tools + review handler against the live TrueForge; in-memory copy of the
fixture; an auto-accept-all presenter in place of the human; throwaway agent `forge-inline-test`.
