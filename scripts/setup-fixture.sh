#!/usr/bin/env bash
# Creates the Flask fixture the three fixed tasks run on: Flask 3.1.3 (commit 22d92470) with its own virtualenv.
#
#   scripts/setup-fixture.sh                 # creates ../fixtures/flask (next to this repository)
#   FIXTURE_DIR=/some/dir scripts/setup-fixture.sh
#   PYTHON=python3.12 scripts/setup-fixture.sh
#
# Needs: git, Python >= 3.9 with the venv module, network access to github.com and PyPI.
# Idempotent: an existing fixture at the pinned commit is left alone (only a missing virtualenv is created);
# it never deletes or resets anything.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="${FIXTURE_DIR:-$HERE/../../fixtures/flask}"
mkdir -p "$(dirname "$FIXTURE")"
FIXTURE="$(cd "$FIXTURE" 2>/dev/null && pwd || (cd "$(dirname "$FIXTURE")" && echo "$(pwd)/$(basename "$FIXTURE")"))" # absolute, without ..
PY="${PYTHON:-python3}"
PIN="22d924701a6ae2e4cd01e9a15bbaf3946094af65"

if ! command -v git >/dev/null 2>&1; then echo "git is required" >&2; exit 1; fi
if ! command -v "$PY" >/dev/null 2>&1; then echo "$PY not found: install Python >= 3.9 or set PYTHON=/path/to/python" >&2; exit 1; fi
if ! "$PY" -c 'import sys; sys.exit(0 if sys.version_info >= (3, 9) else 1)'; then
  echo "$PY is too old: Flask 3.1 needs Python >= 3.9 ($("$PY" --version 2>&1))" >&2
  exit 1
fi

mkdir -p "$(dirname "$FIXTURE")"
if [ -d "$FIXTURE/.git" ]; then
  echo "Fixture exists: $FIXTURE"
else
  git clone --quiet https://github.com/pallets/flask.git "$FIXTURE"
fi
if [ "$(git -C "$FIXTURE" rev-parse HEAD)" != "$PIN" ]; then
  git -C "$FIXTURE" checkout --quiet "$PIN"
fi
# the virtualenv must be ignored so scripts/reset-fixture.sh can never delete it
grep -qx '.venv/' "$FIXTURE/.git/info/exclude" 2>/dev/null || echo '.venv/' >> "$FIXTURE/.git/info/exclude"

if [ ! -x "$FIXTURE/.venv/bin/python" ]; then
  "$PY" -m venv "$FIXTURE/.venv"
  "$FIXTURE/.venv/bin/python" -m pip install --quiet --upgrade pip
  "$FIXTURE/.venv/bin/python" -m pip install --quiet -e "$FIXTURE" pytest
fi

echo "Flask fixture ready: $FIXTURE ($(git -C "$FIXTURE" rev-parse --short HEAD), $("$FIXTURE/.venv/bin/python" --version))"
"$FIXTURE/.venv/bin/python" -c "import flask, sys; print('import flask ->', flask.__file__)"
