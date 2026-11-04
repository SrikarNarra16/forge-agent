#!/usr/bin/env bash
# Verifies Task A on the REAL fixture, using the fixture's own virtualenv (the code under test is the editable
# install of fixtures/flask/src). Prints PASS/FAIL per check and an overall result; the exit code is 0 only if
# everything passes. Read-only: it never modifies the fixture.
#
#   scripts/verify-task-a.sh
set -uo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="${FIXTURE_DIR:-$HERE/../../fixtures/flask}"
# PYTHON overrides the interpreter (a temp copy has no .venv of its own); PYTHONPATH makes `import flask` resolve to
# the checked directory's src/ (harmless for the real fixture, whose editable install points at the same place).
PY="${PYTHON:-$FIXTURE/.venv/bin/python}"
export PYTHONPATH="$FIXTURE/src${PYTHONPATH:+:$PYTHONPATH}"
export PYTHONDONTWRITEBYTECODE=1

if [ ! -x "$PY" ]; then
  echo "FAIL: $PY not found. Create the fixture's virtualenv first (see docs/PROGRESS.md, P00)." >&2
  exit 2
fi

echo "Fixture: $FIXTURE ($(git -C "$FIXTURE" rev-parse --short HEAD 2>/dev/null || echo 'not a git repo'))"
echo "Changed files:"
git -C "$FIXTURE" status --short 2>/dev/null | sed 's/^/  /'
echo
"$PY" "$HERE/task_a_check.py" --installed
