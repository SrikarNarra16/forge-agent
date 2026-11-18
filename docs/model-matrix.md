# Which models work (Task A, headless, one run per model)

**What was run.** `npx tsx scripts/model-matrix.ts` (18 Nov 2026): for every model registered in this TrueForge (except the two Task C fault-injection doubles `broken-endpoint/broken` and `badkey-deepseek/flash`) the real controller, SDK, MCP tools and review handler ran Task A once (`scripts/run-task-a-headless.ts --runs 1 --model <m>`: Flask `get_debug_flag`, the committed `agents/forge-inline.json`, an auto-accept presenter, 19 checks) with an 8-minute limit per model. The matrix was run **twice** (pass 1 did not record tokens; pass 2 did) because several providers answered 503 "high demand" at different moments. The workspace is an in-memory copy of the fixture, so a failing model cannot leave anything half-applied on disk; in the editor, the panel shows the provider's message (see Task C and `docs/e2e-results.md`: unreachable endpoint, workspace pristine, `git status` clean).

| Model | Pass 1 | Pass 2 | Verdict | Failure text (provider message) |
|---|---|---|---|---|
| deepseek/flash | PASS 11 s | PASS 4 s | **supported** (default; 19/19 headless runs earlier, Task A and B evaluated) | |
| deepseek/v4-pro | PASS 11 s | PASS 14 s | **supported** (second model of the default chain) | |
| google-gemini/gemini-3-1-flash-lite | PASS 18 s | PASS 4 s | **supported** | |
| google-gemini/gemini-3-5-flash-lite | PASS 5 s | PASS 21 s | **supported** | |
| google-gemini/gemini-flash-lite-latest | PASS 11 s | PASS 10 s | **supported** | |
| google-gemini/gemma-4-26b-a4b-it | FAIL 503 | PASS 131 s | works, slow and intermittent (provider overload) | `[Model Error] Request failed (503): This model is currently experiencing high demand.` |
| google-gemini/gemma-4-31b-it | PASS 151 s | FAIL 503 | works, slow and intermittent (provider overload) | same 503 |
| google-gemini/gemini-3-5-flash | FAIL | FAIL | not usable right now: provider 503 | `Request failed (503): ... high demand` |
| google-gemini/gemini-3-6-flash | FAIL | FAIL | not usable right now: provider 503 | same |
| google-gemini/gemini-3-7-flash | FAIL | FAIL | not usable right now: provider 503 | same |
| google-gemini/gemini-3-8-flash | FAIL (no answer in 3 min) | FAIL 503 | not usable right now: provider 503 / stall | same |
| google-gemini/gemini-flash-latest | FAIL (no answer in 3 min) | FAIL 503 | not usable right now: provider 503 / stall | same |
| google-gemini/gemini-3-1-pro-preview | FAIL | FAIL | **unsupported with this key**: free-tier quota is 0 | `Request failed (429): You exceeded your current quota ... generate_content_free_tier_input_token_count, limit: 0` |
| groq/gpt-oss-120b | FAIL | FAIL | **unsupported** (TrueForge replays the assistant turn with `reasoning_content`, Groq rejects it) | `Request failed (400): 'messages.2' : for 'role:assistant' ... property 'reasoning_content' is unsupported` |

Reading the table:
- The 503 and 429 rows are provider-side conditions (overload, free-tier quota), not Forge failures; they show in the panel as one clear message naming the model and the provider's text, and with a fallback chain configured Forge continues on the next model (`docs/e2e-results.md`, Task C). A model that passes in one pass and fails in the other (`gemma-*`) is listed as intermittent.
- The `groq/gpt-oss-120b` failure is a TrueForge-to-Groq protocol issue (see `docs/task-a-runs.md`, H7-H9), not something the extension can fix; it was not worked around.
- Task B (multi-file agent run, ~500k tokens) was evaluated only on `deepseek/flash` (and `deepseek/v4-pro` partially), see `docs/eval-results.md`. The matrix above is Task A only.
- Spend of the matrix: pass 2 used about 41,000 tokens (about $0.003 at the ledger's $0.08 per million); pass 1 used the same order of magnitude (its tokens were not recorded, a bug fixed before pass 2) and is counted in the ledger as an estimate equal to pass 2.
