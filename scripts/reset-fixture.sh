#!/usr/bin/env bash
# Resets the Flask fixture to its pinned commit between Task A / B / C runs: discards tracked changes and
# removes untracked files. It REFUSES to run unless .venv is git-ignored in the fixture, so `git clean` can
# never delete the virtualenv (ignored files are also never touched, because we do not pass -x).
#
#   scripts/reset-fixture.sh
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
FIXTURE="${FIXTURE_DIR:-$HERE/../../fixtures/flask}"

if ! git -C "$FIXTURE" rev-parse --git-dir >/dev/null 2>&1; then
  echo "Refusing: $FIXTURE is not a git repository." >&2
  exit 1
fi
if ! git -C "$FIXTURE" check-ignore -q .venv; then
  echo "Refusing: .venv is not ignored by git in $FIXTURE, so 'git clean' could delete the virtualenv." >&2
  echo "Add '.venv/' to $FIXTURE/.git/info/exclude (or its .gitignore) and run again." >&2
  exit 1
fi

git -C "$FIXTURE" checkout -- .
git -C "$FIXTURE" clean -fd
echo "Fixture reset at $(git -C "$FIXTURE" rev-parse --short HEAD). Status:"
status="$(git -C "$FIXTURE" status --short)"
if [ -z "$status" ]; then echo "  (clean)"; else echo "$status" | sed 's/^/  /'; fi
if [ -d "$FIXTURE/.venv" ]; then echo ".venv still present."; fi
