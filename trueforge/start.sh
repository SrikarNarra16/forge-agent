#!/usr/bin/env bash
# Starts a local TrueForge (UI + API on http://localhost:8790, SQLite) configured so it may call our
# loopback MCP server: TrueForge's SSRF guard blocks loopback URLs unless they are allow-listed.
# Node >= 22.14 is required by TrueForge.
set -euo pipefail

# Fast failure for the model fallback (Task C):
#   MODEL_HTTP_CONNECT_TIMEOUT_MS=3000  a model endpoint that cannot be reached fails in ~3 s instead of hanging, so the
#                                       extension can fall back to the next model quickly.
#   MODEL_HTTP_MAX_RETRIES=1            TrueForge retries a failed model call once; the extension does its own retrying with
#                                       backoff (0.5 s, 1.5 s) and then falls back, so more retries here would only add delay.
OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]' \
MODEL_HTTP_CONNECT_TIMEOUT_MS=3000 \
MODEL_HTTP_MAX_RETRIES=1 \
exec npx @truefoundry/trueforge@latest "$@"
