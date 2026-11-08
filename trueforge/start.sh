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
export OUTBOUND_URL_ALLOWED_HOSTS='["localhost","127.0.0.1"]'
export MODEL_HTTP_CONNECT_TIMEOUT_MS=3000
export MODEL_HTTP_MAX_RETRIES=1

# Pinned to the version everything here was tested with (the live runs, the evaluation and the end-to-end tests ran on
# 0.183.1). `@latest` is NOT used: on 8 Nov 2026 it moved to 0.184.2, which replaced the web UI files in the shared npx
# cache under a TrueForge that was still running (its UI went blank). Try another version with
# TRUEFORGE_VERSION=latest npm run tf:start
TRUEFORGE_VERSION="${TRUEFORGE_VERSION:-0.183.1}"

# TRUEFORGE_DRY_RUN=1 prints what would run instead of starting TrueForge (used by test/startScript.test.ts)
if [ "${TRUEFORGE_DRY_RUN:-}" = "1" ]; then
  # through `env`, so only variables that are really EXPORTED to the started process show up
  env | grep -E '^(OUTBOUND_URL_ALLOWED_HOSTS|MODEL_HTTP_CONNECT_TIMEOUT_MS|MODEL_HTTP_MAX_RETRIES)=' | sort
  printf 'COMMAND=npx @truefoundry/trueforge@%s' "$TRUEFORGE_VERSION"
  for arg in "$@"; do printf ' %s' "$arg"; done
  printf '\n'
  exit 0
fi
exec npx "@truefoundry/trueforge@${TRUEFORGE_VERSION}" "$@"
