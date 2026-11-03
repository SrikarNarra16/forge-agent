#!/usr/bin/env bash
# Scores Task B on a Flask checkout (default: the fixture). Read-only.
#   scripts/verify-task-b.sh [path/to/flask] [--json]
set -euo pipefail
here="$(cd "$(dirname "$0")/.." && pwd)"
root="${1:-$here/../fixtures/flask}"
shift || true
exec npx --prefix "$here" tsx "$here/scripts/eval/score-task-b.ts" --root "$root" "$@"
