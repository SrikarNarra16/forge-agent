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

## Implemented (4 Nov 2026): `forge.autoAllowCommands.readOnly` and `.tests`, both default OFF
Code: `src/mcp/commandAllow.ts`, wired in `CommandApprovalHandler` (`src/trueforge/commandApprovals.ts`). 138 table-driven tests (`test/commandAllow.test.ts`, 100+ explicit command cases) plus handler tests.

**Order of checks**: denylist (`checkCommand`) first, then, only if a switch is on, the allow pattern, otherwise the normal Allow card. A command that matches is allowed with a ticket exactly as if you had clicked Allow, so the run_command tool and the instant-Stop path behave the same.

**Matching is on the whole command, as the agent wrote it.** The venv prefix (`. .venv/bin/activate &&`) is added by the command runner after approval, so it cannot break or fake a match.

| Tier | Recognised (nothing else) | Why it is safe, and what is the risk |
|---|---|---|
| 1 `readOnly` | `git status/diff/log/show/ls-files` with whitelisted options, `ls`, `pwd`, `cat`, `head -n`, `tail -n`, `wc`, `grep` (no `-r/-R/-e/-f`), `rg` (no `--pre/-r/-L`), on workspace paths | change nothing, execute no project code. They can read any non-secret workspace file, which `read_file` can too. Paths with `.env*`, `.git`, `.ssh`, `.venv`, `node_modules`, key files are refused. |
| 2 `tests` | `pytest` / `python -m pytest` (whitelisted options, `-k`/`-m` expressions, workspace paths and node ids), `ruff check` (never `--fix`), `mypy` / `python -m mypy` on workspace paths | **They run workspace code.** pytest imports and executes your tests and `conftest.py`, including tests the agent just wrote and you approved in a diff; mypy loads plugins named in its config. They write only caches. This is the same risk as running them yourself, but without a prompt. A malicious repository could use this; that is why tier 2 is a separate switch and off by default. |

**Always falls back to the Allow card**: `&&`, `;`, `|`, `&`, newlines, any redirect (`>`, `<`, `2>&1`), `$( )`, `$VAR`, backticks, backslashes, `!`, `#`, parentheses/braces, unquoted globs, `~`, leading `VAR=value`, `env`/`sudo`, unknown programs or options, write flags (`--fix`, `--add-noqa`, `-o`, `--output`, `--junitxml`, `--basetemp`, `--cache-dir`), code-loading flags (`-p`, `-c`, `--pyargs`, `-p` for mypy, `--pre`, `git -c`, `--ext-diff`), absolute paths, `..` segments, secrets, and a quoted `|` or `;` (strict on purpose). A command you denied earlier in the same run always asks again.

**Shown, never hidden**: the command card carries an `auto-allowed (tier N)` badge and says "Auto-allowed (tier N: ...) by your forge.autoAllowCommands setting; you were not asked." Each one is also logged in the Forge output ("run_command auto-allowed (tier 1: read-only, git status): ...").

**Known limits**: a symlink inside the workspace that points outside it is not detected (the matcher has no file-system access); repository-level git configuration (`diff.<driver>.textconv`) would run a program on `git diff`, but that lives in `.git/config`, which a clone does not bring.

**How much it helps (measured on the 57 recorded Task B commands)**: with both tiers on, 19 of 57 (33%) would be auto-allowed, all of them tier 2 (plain `pytest ...`, `ruff check ...`); tier 1 matched 0, because the agent's reads go through `read_file`/`search_code`. 38 still ask, and 35 of those end in `2>&1 | tail -N` or `| head -N`, which the strict rule refuses on purpose. Allowing exactly one trailing `2>&1 | tail -N` / `| head -N` would lift the coverage to 38 of 57 (67%), measured by re-classifying the same commands with that suffix removed; that is a decision for you because it relaxes the "no pipes" rule. Changing the agent's instructions to run `python -m pytest <path> -q` without the pipe would do the same without touching the matcher, but the instructions are frozen and tagged (`task-b-tuned`), so I did not.

## "Accept all and apply" (implemented)
The review card has a third button that accepts every UNDECIDED hunk (a hunk you rejected stays rejected) and then runs the same apply as "Apply accepted", turning the common path from 2 actions into 1 click.
