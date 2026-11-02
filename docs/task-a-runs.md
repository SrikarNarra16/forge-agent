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

All headless batches used the committed `agents/forge-inline.json` **unchanged** (no tuning was needed), the exact
instruction *"treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false
value"* and an auto-accept-all presenter. "Selection" is what the emulated user selected in `get_debug_flag`.
Pass = `scripts/task_a_check.py` on the resulting file: 19 checks (off/OFF/Off/n/N/0/false/False/no/NO -> False,
on/1 -> True, empty/unset -> False, docstring lists 0, false, no, off, n).

| Batch | Model | Selection | Runs | Passed | Notes |
|---|---|---|---|---|---|
| H1 | deepseek/flash | whole function | 5 | **5/5** | 3-4 s each; one `propose_edit` (2 hunks: docstring + code); no reads needed |
| H2 | deepseek/flash | whole function | 5 | **5/5** | same; recordings saved in `test/fixtures/task-a/` and replayed by `test/recordedTaskA.test.ts` |
| H3 | deepseek/flash | only the `return` line | 3 | **3/3** | one run read the file first (allowed by the instructions) |
| H4 | deepseek/flash | the two code lines | 3 | **3/3** | |
| H5 | deepseek/flash | only the docstring | 3 | **3/3** | |
| H6 | deepseek/v4-pro | whole function | 5 | **5/5** | 7-12 s each |
| H7 | groq/gpt-oss-120b | whole function | 5 | 2/5 | runs 1-2 applied the edit but the run ended in `error`; runs 3-5 failed. Provider errors, see below |
| H8 | groq/gpt-oss-120b | whole function | 4 | 0/4 | 3 x HTTP 400 `reasoning_content`, 1 x HTTP 429 (tokens per minute) |
| H9 | groq/gpt-oss-120b + `include_reasoning:false` | whole function | 2 | 0/2 | same HTTP 400; the parameter does not help |

**deepseek/flash: 19/19 headless runs across five selection styles.**

### Why groq/gpt-oss-120b fails (not a prompt problem)
- After the first tool result the next model request is rejected by Groq: `HTTP 400 'messages.2' : for
  'role:assistant' ... property 'reasoning_content' is unsupported`. TrueForge replays the assistant message with
  its reasoning and this OpenAI-compatible endpoint refuses that field. The edit is still applied when the
  failure comes after the approval (batch H7 runs 1-2), but the run ends in `error` and the agent never reports.
- Groq's free tier has an 8000 tokens-per-minute cap, so back-to-back runs hit `HTTP 429`.
- Relevant code: `packages/trueforge-core/src/core/llm/toOpenAIChatMessage.ts` (forwards `reasoning_content`
  unchanged) and `core/runtime/AgentThread.ts` (strips it for some paths only).
