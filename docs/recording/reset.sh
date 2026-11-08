#!/usr/bin/env bash
# Returns to the START STATE of a take: the Flask fixture is reset to its pinned commit (changes discarded, untracked
# files removed, the virtualenv is never touched), and the things only you can do in VS Code are listed.
#
#   docs/recording/reset.sh
#
# It does not touch your VS Code settings, TrueForge, or any other repository. Run docs/recording/preflight.sh afterwards.
set -euo pipefail
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
FIXTURE="${FIXTURE_DIR:-$ROOT/../fixtures/flask}"

echo "1. Resetting the Flask fixture ($FIXTURE)"
FIXTURE_DIR="$FIXTURE" "$ROOT/scripts/reset-fixture.sh"
if [ -n "$(git -C "$FIXTURE" status --porcelain)" ]; then
  echo "FAIL: the fixture is not clean after the reset" >&2
  exit 1
fi

cat <<'EOF'

2. In VS Code (these cannot be scripted from here):
   [ ] Close every editor tab (Command Palette: "View: Close All Editors"), so no diff or file from the last take is open.
       If a file shows a dot (unsaved), choose "Don't Save": the fixture was just reset on disk.
   [ ] Clear the Forge panel: click "New chat" in the panel header, or run "Developer: Reload Window"
       (reloading also re-registers Forge's agents in TrueForge and clears the review queue).
   [ ] Models for the take:
         Tasks A and B  ->  forge.models = ["deepseek/flash", "deepseek/v4-pro"]   (Command Palette: "Forge: Switch Model")
         Task C         ->  forge.models = ["broken-endpoint/broken", "deepseek/flash"]
       Change it back after Task C, and re-run the preflight, which refuses a chain that starts with a demo model.
   [ ] Open src/flask/helpers.py (Task A starts from it); the Forge panel can stay in the side bar.
   [ ] Warm-up rule: run ONE throwaway diff before recording: Command Palette -> "Forge: Fake Proposal", wait for the
       "Accept hunk" buttons, then "Reject all" in the panel (nothing is written). Then run this script again.

3. Check: docs/recording/preflight.sh must print GO.
EOF
