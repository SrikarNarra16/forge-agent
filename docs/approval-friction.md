# Approval friction in Task B (measured, no new live run)

Source: the eval harness records of the 15 Task B runs that used the final (tuned, frozen) instructions: `eval-output/2026-11-04-11172-r1..r5` and `8383-r1..r5` (deepseek/flash) and `12187-r1..r5` (deepseek/v4-pro). The harness auto-approves, but the agent's tool calls are the same as in the panel, so the number of approvals a person would face is the number of those calls. The one real-UI Task B run (Playwright rehearsal) applied 8 reviews; its command-card count (16) was over-counted by a since-fixed counter, and the live scenario 5 record was overwritten by a later hermetic run, so it is not used.

| Approval | Total (15 runs) | Per run: mean / median / min-max | What the user does for each |
|---|---|---|---|
| `propose_edit` | 67 | 4.5 / 4 / 3-7 | review the diff, accept hunks, apply (at least 2 actions: Accept all + Apply; 1 more to open the diff when it is not the first) |
| `create_file` | 0 | 0 | (the agent put the new test into the existing test file every time) |
| `run_command` | 57 (53 distinct) | 3.8 / 3 / 1-6 | one Allow click (a repeated identical command needs none after "Allow this exact command for this run") |

So by count, `run_command` is 46% of approvals (57 of 124), but by clicks it does not dominate: a command is exactly 1 click, an edit is at least 2 (about 135 vs 57). **The edit reviews are the larger friction, and that is what the panel's Apply accepted / Reject all buttons address.** The command approvals do not meet the "dominate" bar, so nothing below is implemented; it is only offered for your decision.

## What the 57 commands were
- 39 (68%): `python -m pytest ...`, `ruff check`, `mypy` (verification of the agent's own change).
- 3: purely read-only (`git log`, `git status`, `grep`) plus about 5 more `grep`/`head` lines my simple classifier counted as other because of quoted pipes.
- About 10: `python -m flask --help` / `flask --app ... config` (the agent trying its new command; this executes project code).

## Proposal (not implemented): a small opt-in allow-list for read-only and verification commands
A setting `forge.autoAllowCommands` (default **off**), with two tiers, applied AFTER the existing denylist (`checkCommand`), never instead of it:
1. **Read-only, no project code executed**: `git status`, `git diff`, `git log`, `git show`, `git ls-files`, `ls`, `pwd`, `cat`/`head`/`tail`/`wc`/`grep`/`rg` on workspace paths. Safe because they cannot change anything and `read_file`/`search_code` already expose the same content.
2. **Verification, runs the project's own code**: `pytest` / `python -m pytest`, `ruff check` (without `--fix`), `mypy`. These write only caches (`.pytest_cache`, `__pycache__`, already ignored) but they DO execute workspace code, including tests the agent just wrote and you approved in a diff. That is the same risk as running the tests yourself, so I would make tier 2 a separate switch.

Safety rules for both: the whole command must match, not just its first word. Any `;`, `&&`, `||`, `|` to something outside the list, redirections (`>`, `>>`), `$(...)`/backticks, `sudo`, `rm`, `--fix`/`--write`/`-i` style flags, `-exec`/`-delete`, or a path outside the workspace falls back to the normal Allow card. The auto-allowed command still appears in the transcript with its output and is still subject to the timeout and Stop. A command the user denied earlier in the run is never auto-allowed.

Expected effect on Task B: tier 1 alone saves about 0-1 click per run (almost nothing); tier 1 + 2 would remove about 2.6 of 3.8 clicks per run. Your call whether tier 2 is worth the extra trust.

## Another option, cheaper and safer: "Accept all and apply"
An optional third button in the review card would turn the common path (accept every hunk) from 2 actions into 1. It uses the same commands (`forge.reviewAcceptAll` then `forge.reviewApply`). Not added because the request asked for exactly Apply accepted / Reject all.
