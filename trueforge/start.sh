#!/usr/bin/env bash
# Starts a local TrueForge (UI + API on http://localhost:8790, SQLite) configured so it may call our
# loopback MCP server: TrueForge's SSRF guard blocks loopback URLs unless they are allow-listed.
# Node >= 22.14 is required by TrueForge.
set -euo pipefail

OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' \
MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 \
MODEL_HTTP_MAX_RETRIES=1 \
exec npx @truefoundry/trueforge@latest "$@"
