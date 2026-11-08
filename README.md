# Forge: a coding agent for VS Code, running on TrueForge

Forge is a VS Code extension. You describe a change (in the **Forge** panel, or by selecting code and pressing `Cmd/Ctrl+Alt+K`); an agent that runs on [TrueForge](https://trueforge.dev) (local mode) reads your project, proposes edits, and **nothing is written to disk until you have reviewed the diff** hunk by hunk.

- The extension is only a client of TrueForge: it creates sessions and turns through `@truefoundry/trueforge-sdk` and renders the streamed events. It never calls a model provider itself.
- Editor capabilities (read a file, search, symbols, diagnostics, propose an edit, run a command) are MCP tools that the extension serves on localhost (bearer-token protected) and registers in TrueForge. `propose_edit` / `create_file` are gated by TrueForge's tool approval, which opens the diff review; accepting applies the hunks as ONE undo step.
- Stop is instant and leaves no half-applied edits. If a model provider fails, Forge continues the same request on the next configured model.

## Quick start (5 lines)

```bash
git clone https://github.com/SrikarNarra16/forge-agent.git && cd forge-agent
npm ci && npm run build && npm run package               # builds forge-agent-0.0.1.vsix
npm run tf:start                                          # terminal 1: TrueForge on http://localhost:8790 (leave it running)
export DEEPSEEK_API_KEY=<your key> && npm run tf:setup    # terminal 2: registers the model providers
scripts/setup-fixture.sh && code --install-extension forge-agent-0.0.1.vsix && code ../fixtures/flask   # Flask 3.1.3 + the extension
```

Then open the **Forge** view in the activity bar: the status bar should say `TrueForge: connected`. Try it without a model first: Command Palette -> **Forge: Fake Proposal** shows the whole review UI (diff, per-hunk Accept/Reject, Apply) on a made-up change; **Reject all** discards it. With a model: type a request in the panel.

## Prerequisites

| What | Version | Used for |
|---|---|---|
| Node.js + npm | **>= 22.14** (tested with 26.0) | TrueForge requires it; also builds the extension |
| VS Code | **>= 1.95** (tested with 1.143) | the `code` command must be on your PATH for the commands above (VS Code: Command Palette -> "Shell Command: Install 'code' command in PATH") |
| git | any recent | cloning Forge and the Flask fixture |
| Python | **>= 3.9** with `venv` (tested with 3.9.6) | only for the Flask tasks: `scripts/setup-fixture.sh` makes a virtualenv with Flask 3.1.3 and pytest |
| A model API key | DeepSeek (default models) and/or Groq | `DEEPSEEK_API_KEY`, optional `GROQ_API_KEY`. Keys are read from environment variables only, never from files in the repo |

## 1. Start TrueForge (local mode)

```bash
npm run tf:start
```

This runs `npx @truefoundry/trueforge@latest` (UI + API on http://localhost:8790, SQLite, no Redis) with the environment variables Forge needs, see `trueforge/start.sh`:

| Variable | Value | Why |
|---|---|---|
| `OUTBOUND_URL_ALLOWED_HOSTS` | `["localhost","127.0.0.1"]` | **Required.** TrueForge's SSRF guard blocks loopback URLs by default, which would block the extension's MCP server |
| `MODEL_HTTP_CONNECT_TIMEOUT_MS` | `3000` | an unreachable model endpoint fails in about 3 s, so the fallback is quick |
| `MODEL_HTTP_MAX_RETRIES` | `1` | Forge retries and falls back itself |

Extra arguments are passed through (`npm run tf:start -- --port 8791`). Other useful TrueForge variables: `PORT`, and `SQLITE_PATH` for a separate database.

## 2. Configure models

`trueforge/models.example.json` lists the providers (DeepSeek `flash` and `v4-pro`, Groq `gpt-oss-120b`, plus two demo-only broken ones for Task C). **API keys are never stored in it**: `apiKeyEnv` names the environment variable that holds the key.

```bash
export DEEPSEEK_API_KEY=...        # GROQ_API_KEY=... is optional
npm run tf:setup                   # idempotent: creates or replaces the providers
```

A provider whose key variable is not set is skipped with a message. To change providers or models, copy the file to `trueforge/models.local.json` (gitignored) and edit it; `tf:setup` prefers it. The model names Forge uses are `provider/model`, e.g. `deepseek/flash` (setting `forge.models`, or **Forge: Switch Model**).

## 3. Agents

The agent definitions are in the repo: `agents/forge-agent.json` (the panel agent) and `agents/forge-inline.json` (the inline edit). You do not register them by hand: when the extension activates it registers its MCP server in TrueForge (`forge-editor`, `forge-editor-extras`) and saves both agents (names `forge-agent`, `forge-inline`; `forge.resourcePrefix` adds a prefix so two windows or test runs never collide). `npm run tf:setup` also saves them once the MCP server exists. Edit the JSON and reload the window to change instructions or tool lists.

## 4. Install the extension

- **From the repo (development):** open this folder in VS Code and press `F5` ("Run Extension").
- **From a package:** `npm run package` creates `forge-agent-0.0.1.vsix`; `code --install-extension forge-agent-0.0.1.vsix`. To try it without touching your own profile: `code --user-data-dir /tmp/forge-profile --extensions-dir /tmp/forge-ext --install-extension forge-agent-0.0.1.vsix`, then start VS Code with the same two flags.

## 5. The three fixed tasks (Flask 3.1.3)

```bash
scripts/setup-fixture.sh        # clones Flask at commit 22d92470 into ../fixtures/flask, creates its .venv (idempotent)
code ../fixtures/flask          # open it with the extension installed
scripts/reset-fixture.sh        # between tasks: discards changes in the fixture (never touches .venv)
```

| Task | What you do | Verify |
|---|---|---|
| **A** | Open `src/flask/helpers.py`, select `get_debug_flag`, press `Cmd/Ctrl+Alt+K`, type: *treat 'off' and 'n' as false too, case-insensitively, and update the docstring to list every false value*. Review the diff, accept, apply (`Cmd/Ctrl+Enter`) | `scripts/verify-task-a.sh`, or by hand `FLASK_DEBUG=off ../fixtures/flask/.venv/bin/python -c "import flask.helpers as h; print(h.get_debug_flag())"` prints `False` |
| **B** | In the Forge panel, no files named: *Add a built-in CLI command `flask config` that prints the app config as JSON, masking the value of any key containing SECRET, PASSWORD, TOKEN, or KEY as "\*\*\*". It must appear in `flask --help`, have a test, and be documented with the other built-in commands.* Allow its commands, review each diff, apply | `scripts/verify-task-b.sh` (scores 7 checks) and `../fixtures/flask/.venv/bin/python -m pytest ../fixtures/flask/tests/test_cli.py -q` |
| **C** | Break the model first: `npm run tf:setup -- --only-demo` (registers two demo providers that need no key), set `forge.models` to `["broken-endpoint/broken", "deepseek/flash"]`, repeat Task A. The editor stays responsive; Forge says the first model is unreachable and continues on `deepseek/flash` (to see the clear error instead, use only `["broken-endpoint/broken"]`) | `git -C ../fixtures/flask status` is clean before you apply anything; then `scripts/verify-task-a.sh` |

`FIXTURE_DIR=/path/to/flask` overrides the fixture location for the scripts. More detail: `docs/task-c-demo.md`, `docs/cancel-tests.md`.

## Settings

| Setting | Default | What it does |
|---|---|---|
| `forge.trueforge.baseUrl` | `http://localhost:8790` | Base URL of the local TrueForge server |
| `forge.models` | `["deepseek/flash", "deepseek/v4-pro"]` | Ordered TrueForge models. The first is used; if its provider fails (unreachable, bad key, overloaded, stalled) Forge retries with backoff, then continues on the next one in a new TrueForge session. **Forge: Switch Model** changes the first |
| `forge.contextBudgetTokens` | `6000` | Token budget for automatically injected context |
| `forge.commandPrefix` | empty = auto | Shell prefix before every agent command. Empty: if the workspace has `.venv/bin/activate` (else `venv/bin/activate`), `. .venv/bin/activate &&` is used (POSIX `.`, works in dash, bash, zsh). Your value always wins; `true &&` turns it off. The effective prefix is shown in the panel's Context section. Windows layouts (`Scripts\activate`) are not detected |
| `forge.autoAllowCommands.readOnly` | **off** | Tier 1: run `git status/diff/log/show/ls-files`, `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep` (no `-r`), `rg` on workspace paths without asking |
| `forge.autoAllowCommands.tests` | **off** | Tier 2: run `pytest`, `ruff check` (never `--fix`), `mypy` without asking. **Risk: these execute workspace code** (pytest imports and runs your tests and `conftest.py`) |
| `forge.rollbackOnCancel` | `true` | Stop rolls back the edits applied during the cancelled run |
| `forge.stallFirstEventSeconds` / `forge.stallIdleSeconds` | `45` / `90` | A model silent for that long counts as stalled (retry, then next model); time waiting for your approval or a tool never counts |
| `forge.resourcePrefix` | empty | Prefix for the TrueForge resources Forge registers; reload the window after changing it. The environment variable `FORGE_RESOURCE_PREFIX` wins |

Auto-allow details (what exactly matches, what always asks): `docs/approval-friction.md`. The strict rule: the WHOLE command must match, so anything with `&&`, `;`, `|`, redirects, `$( )`, backticks, `sudo`, `rm`, write flags (`--fix`, `-o`, `--junitxml`...), an unknown option, a path outside the workspace or a secrets file still shows the normal Allow card.

Commands: **Forge: Open Agent**, **Edit Selection…** (`Cmd/Ctrl+Alt+K`), **Stop**, **Undo Last Agent Run**, **Switch Model**, **Rebuild Context Index**, **Accept/Reject Hunk(s)**, **Apply Accepted Hunks** (`Cmd/Ctrl+Enter`), **Fake Proposal** (try the review without a model).

## Architecture

```
 VS Code window                                                     your machine, localhost
┌───────────────────────────────────────────────────────────────┐
│ Forge extension (TypeScript)                                  │
│                                                               │   ┌──────────────────────────────┐
│  Agent panel (webview) ─┐                                     │   │ TrueForge (local mode)       │   ┌────────────────┐
│  Inline edit  ──────────┼─► AgentController ─ model chain ────┼──►│  agent loop, sessions, SSE   │──►│ model provider │
│  Review UI (diff,       │      (stream, approvals, Stop)      │   │  `forge-agent`, `forge-inline`│   │ (DeepSeek, …)  │
│  CodeLens, panel card) ◄┘            ▲                        │   └──────────────┬───────────────┘   └────────────────┘
│            │ accepted hunks          │ allow / deny           │                  │ MCP over HTTP (bearer token)
│            ▼                         │                        │                  ▼
│  Applier (the ONLY writer) ◄─ ReviewApprovalHandler           │   tool calls: read_file, search_code, get_symbols,
│  one WorkspaceEdit = one undo step                            │   get_diagnostics, run_command, propose_edit, create_file…
│                                                               │                  │
│  MCP server (127.0.0.1) ◄─────────────────────────────────────┼──────────────────┘
└───────────────────────────────────────────────────────────────┘
```

Rules the code enforces and tests check: no model provider is ever called from the extension; only `src/review/applier.ts` writes files (`test/writeIsolation.test.ts`); `propose_edit`/`create_file` need your per-hunk review; the edit tools only report decisions; cancellation leaves no partial edit; nothing blocks the extension host.

## Troubleshooting

| Symptom | What to do |
|---|---|
| Status bar says `TrueForge: disconnected` | TrueForge is not running or `forge.trueforge.baseUrl` is wrong. Start it with `npm run tf:start` |
| **Port 8790 is in use** (another TrueForge, or something else) | Reuse the running TrueForge, or start a second one on another port with its own database: `SQLITE_PATH=/tmp/tf.sqlite npm run tf:start -- --port 8791`, then `npm run tf:setup -- --base-url http://localhost:8791` and set `forge.trueforge.baseUrl` to `http://localhost:8791` |
| The agent cannot use its tools / "MCP server" errors | TrueForge was started without `OUTBOUND_URL_ALLOWED_HOSTS` (use `npm run tf:start`, not a plain `npx`), or Node is older than 22.14 |
| **Provider 503 / overloaded / timeouts** | Forge retries (0.5 s, 1.5 s), then continues on the next model in `forge.models` and says so in the panel. If every model fails you get one clear message naming each model and its failure; the workspace is untouched. Check the provider's status page, or add a second provider/model |
| **Key invalid** (401, "API key not valid") | The first model is skipped with a message naming it. Re-export the key and run `npm run tf:setup` again (it replaces the provider) |
| `tf:setup` says "Skipping provider ... environment variable is not set" | Export the variable named in the message, or ignore it if you do not use that provider |
| "No provider can be registered" | No key variable is set at all: `export DEEPSEEK_API_KEY=...` |
| `scripts/verify-task-*.sh` says the fixture is missing | Run `scripts/setup-fixture.sh` (needs git and Python >= 3.9) |
| Review diff shows no Accept/Reject buttons | Needs the setting `diffEditor.codeLens` (Forge enables it by default; Forge asks once if you turned it off). Fallbacks: **Forge: Review Hunks…**, the panel's buttons, `Cmd/Ctrl+Enter` |
| Where are the logs? | Output panel -> **Forge**: every tool call with its reason, the TrueForge session id and URL; **Open in TrueForge** (panel header) opens the session |

## Limitations

- Local TrueForge only (SQLite standalone mode); no remote or multi-user setup, no authentication to TrueForge beyond what local mode has.
- `run_command` uses a POSIX shell (`$SHELL -c`): macOS and Linux. Windows is not supported for commands, and the venv prefix auto-detection does not look for `Scripts\activate`.
- Tested with VS Code 1.143 on macOS (arm64), Node 26, Python 3.9. Other platforms are untested.
- Review diffs use VS Code CodeLens in the diff editor; a very large file (over the review size limit) is refused instead of blocking the editor.
- The model decides what to change: quality depends on the model. Task B results vary from run to run (see `docs/eval-results.md` for measured pass rates).
- Auto-allow cannot see through symlinks inside the workspace that point outside it.
- Model-fallback keeps the request but not the earlier turns of the conversation (a new TrueForge session is used, and the panel says so).

## Development and tests

```bash
npm run build && npm run typecheck && npm run lint && npm test     # what CI runs (no VS Code needed)
npm run test:e2e         # real VS Code, hermetic scenarios (needs VS Code; set VSCODE_EXE for another install)
npm run test:ui:panel    # Playwright clicks on the panel's review card (no model)
# install check of the packaged .vsix, against a SEPARATE TrueForge (it registers forge-agent & co. under their real names):
#   SQLITE_PATH=/tmp/tf.sqlite npm run tf:start -- --port 8791     # terminal 1
#   TRUEFORGE_BASE_URL=http://localhost:8791 npm run test:vsix -- forge-agent-0.0.1.vsix
```

Submission kit: `docs/recording/` (`preflight.sh` prints GO / NO-GO for a recording session, `reset.sh` returns to the task start state, `shot-list.md`, `recording-notes.md`) and `docs/writeup/WRITEUP.md`, rendered to PDF with `npm run writeup:pdf` (needs Google Chrome; checks the 3-page limit and the 8 headings).

`docs/e2e.md` explains the end-to-end layers, their isolation (temp profile, throwaway `e2e-<pid>-` TrueForge resources, your own resources are never touched) and known risks; `docs/eval-results.md` has the evaluation of Tasks A and B; `docs/approval-friction.md` the approval measurements.

Built with the help of AI coding tools (Claude Code); see `docs/writeup/WRITEUP.md` for what was used.

## License

MIT, see `LICENSE`.
