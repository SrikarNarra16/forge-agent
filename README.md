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

`npm run tf:setup -- --with-broken` also registers the demo-only `broken-endpoint` provider (used for the resilience demo).

## Development

`npm run build | typecheck | lint | test | package`

Licence: MIT.
