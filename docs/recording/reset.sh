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
   [ ] Model chain for the take (Command Palette -> "Forge: Switch Model" moves the model you pick to the front):
         Tasks A and B  ->  pick deepseek/flash                (chain starts with deepseek/flash)
         Task C         ->  pick broken-endpoint/broken        (broken first, deepseek/flash as the fallback)
       SWITCH BACK after Task C: "Forge: Switch Model" -> deepseek/flash, then run the preflight, which refuses a chain that
       starts with a demo model. (The broken model then stays second in the chain, which is harmless; remove it from
       forge.models in your user settings JSON, off camera, if you want the original chain.)
   [ ] Terminal helpers: in the terminal you will show, `export FORGE=<forge-agent repository>`, `cd` into the fixture,
       `PS1='$ '`, then `source "$FORGE/docs/recording/terminal-prep.sh"` (gives vA, vB, vC and rs).
   [ ] Open src/flask/helpers.py (Task A starts from it); the Forge panel can stay in the side bar.
   [ ] Warm-up rule: run ONE throwaway diff before recording: Command Palette -> "Forge: Fake Proposal", wait for the
       "Accept hunk" buttons, then "Reject all" in the panel (nothing is written). Then run this script again.

3. Check: docs/recording/preflight.sh must print GO.
EOF
