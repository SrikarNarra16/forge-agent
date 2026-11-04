# Forge: VS Code agent on TrueForge

A VS Code coding-agent extension whose agent loop runs on [TrueForge](https://trueforge.dev) (local mode).
The extension is a client: it creates sessions and turns through `@truefoundry/trueforge-sdk` and renders the streamed events.
Editor capabilities are exposed to the agent as MCP tools served by the extension itself over localhost HTTP (bearer-token protected).

_Work in progress._

## Smoke test (agent in TrueForge calls a tool served by this extension)

Requires Node >= 22.14.

1. **Terminal 1:** `npm run tf:start` starts TrueForge on http://localhost:8790. It must be started with `OUTBOUND_URL_ALLOWED_HOSTS` allowing `localhost`/`127.0.0.1`, otherwise TrueForge's SSRF guard blocks our loopback MCP server; the script sets this.
2. **Terminal 2:** `export DEEPSEEK_API_KEY=... GROQ_API_KEY=...` then `npm run tf:setup`. This upserts the model providers from `trueforge/models.example.json` (or `models.local.json`). Keys are read from the environment variables named by `apiKeyEnv`, never from files.
3. Press F5 ("Run Extension"). On activation the extension starts its MCP server, registers it in TrueForge as `forge-editor` and saves the agent from `agents/forge-agent.json`.
4. Open the **Forge** view in the activity bar and ask a question, or run **Forge: Smoke Test** / **Forge: Smoke Test (code question)** from the command palette (both just send a fixed prompt through the panel). The panel streams the answer and shows each tool call; the **Forge** output channel logs the TrueForge session id and URL, every tool call with its `why`, and the final answer.
5. **Forge: Show Test Approval Card** shows a fake approval request in the panel (no TrueForge call) so you can try the Allow/Deny card.

## Model fallback (Task C): when the provider fails

`forge.models` is an ordered list of TrueForge model names (default `["deepseek/flash", "deepseek/v4-pro"]`). If the first model's provider fails, Forge keeps the editor responsive and continues the SAME request on the next model, in a fresh TrueForge session (TrueForge has no native fallback and the extension never calls a provider directly):

| Failure | What Forge does |
|---|---|
| overloaded / 429 / 5xx / dropped stream | retry the same model twice (about 0.5 s, then 1.5 s, with jitter), then the next model |
| endpoint unreachable ("Cannot connect to API"), invalid API key | no retries, next model at once |
| no output (45 s to the first token, 90 s between outputs; waiting for your approval or a running tool never counts) | one retry, then the next model |
| an agent / tool error | not a model failure: no fallback, the error is shown |
| TrueForge itself unreachable | not a model failure: Forge says so, no fallback |

A fallback only happens if the failed attempt had **no side effects** (no edit applied, no file created, no command run). Otherwise Forge stops, lists what was already applied and offers **Undo run**. Every switch is shown in the panel ("deepseek/flash unreachable (connection refused) -> switched to deepseek/v4-pro (after 2.1 s)"), the failed attempt's partial text is dropped, and **Stop** cancels the whole chain (also during a backoff). A fallback starts a new session, so earlier messages of a longer chat are not visible to the model (the notice says so). Change the first model with **Forge: Switch Model** (it edits your user settings, never the workspace).

**Fast failure.** `npm run tf:start` starts TrueForge with `MODEL_HTTP_CONNECT_TIMEOUT_MS=3000` (a dead endpoint fails within about 3 s instead of hanging) and `MODEL_HTTP_MAX_RETRIES=1` (TrueForge retries once; our own backoff does the real retrying, so a stricter TrueForge setting would only delay the fallback).

**Demo scenarios.** `npm run tf:setup -- --with-broken` (all providers; needs your real keys) or `npm run tf:setup -- --only-demo` (only these two, no keys needed, touches nothing else) registers two opt-in providers that always use a built-in fake key:
`broken-endpoint/broken` (an endpoint that refuses connections) and `badkey-deepseek/flash` (the real DeepSeek URL with an invalid key). Then choose a chain with **Forge: Switch Model** or the `forge.models` setting (user settings):

1. `["broken-endpoint/broken", "deepseek/flash"]`: Task A or any request falls back automatically; `git status` of the workspace stays clean until you accept a hunk.
2. `["broken-endpoint/broken"]`: a clear error that names the model and the failure ("No model could answer ... Check Settings -> Models in TrueForge / forge.models"), the workspace is untouched.
3. `["badkey-deepseek/flash", "deepseek/flash"]`: the invalid key is classified as an authentication failure and skipped immediately.

Headless check: `npm run eval -- --task a --fail-primary --runs 3` (and `--chain broken-endpoint/broken`).

## Running two windows side by side

The TrueForge resources Forge registers (`forge-editor`, `forge-editor-extras`, `forge-agent`, `forge-inline`) can be given a prefix with the `forge.resourcePrefix` setting (or the `FORGE_RESOURCE_PREFIX` environment variable, which wins), e.g. `win2-` registers `win2-forge-editor`, `win2-forge-agent` and so on. Two VS Code windows with different prefixes can run against one TrueForge without touching each other's resources; reload the window after changing it. The committed `agents/*.json` keep the default names (the prefix is applied when they are loaded). The end-to-end tests use `e2e-<pid>-` (docs/e2e.md).

## Settings that change how commands run

| Setting | Default | What it does |
|---|---|---|
| `forge.commandPrefix` | empty | Shell prefix run before every command the agent runs. **Empty = auto-detect**: if the workspace has `.venv/bin/activate` (else `venv/bin/activate`), Forge uses `. .venv/bin/activate &&` (the POSIX dot, so it works under dash, bash and zsh). A value you set always wins; `true &&` turns activation off. The effective prefix is shown in the panel's Context section. Windows layouts (`Scripts\activate`) are not detected: commands run through a POSIX shell, so set the prefix yourself. |
| `forge.autoAllowCommands.readOnly` | **off** | Tier 1: run `git status/diff/log/show/ls-files`, `ls`, `pwd`, `cat`, `head`, `tail`, `wc`, `grep` (no `-r`) and `rg` on workspace paths without asking. They change nothing and run no project code. |
| `forge.autoAllowCommands.tests` | **off** | Tier 2: run `pytest` / `python -m pytest`, `ruff check` (never `--fix`) and `mypy` without asking. **Risk: these run workspace code** (pytest imports and executes your tests and `conftest.py`, including tests the agent just wrote; mypy loads the plugins named in its config). That is the same as running them yourself, but without a prompt. |

How the allow-list stays strict (details and measurements: docs/approval-friction.md): it is applied after the denylist; the WHOLE command must match a fixed pattern, so any chaining (`&&`, `;`, `|`, newline), redirect, `$( )`, backtick, `sudo`, `rm`, write flag (`--fix`, `-o`, `--junitxml`, `--output`...), unknown option, path outside the workspace or secrets file (`.env*`, `.git`, keys) falls back to the normal Allow card. The venv prefix Forge adds is not part of matching. Auto-allowed commands are marked `auto-allowed (tier 1|2)` on their card in the panel and logged; a command you denied earlier in the run always asks again. Known limit: a symlink inside the workspace that points outside it is not detected.

## The review card in the panel

While a change waits for review, the card above the transcript shows "N of M hunks accepted, K undecided" and three buttons: **Accept all and apply** (accepts the undecided hunks, a hunk you rejected stays rejected, then applies), **Apply accepted** (undecided hunks count as rejected and are not written) and **Reject all**. All of them run the same commands as Cmd/Ctrl+Enter and the CodeLens, so there is one way to write a file and one undo step. The header's **Open in TrueForge** opens the current run's session in the TrueForge UI.

## Development

`npm run build | typecheck | lint | test | package`; end-to-end tests in a real VS Code: `npm run test:e2e`, `npm run test:ui`, `npm run e2e:rehearsal` (docs/e2e.md).

Licence: MIT.
