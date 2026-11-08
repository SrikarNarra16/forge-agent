# Terminal helpers for the recording. SOURCE this off camera, in the terminal you will show, from the Flask fixture folder:
#
#   export FORGE=<path of the forge-agent repository>
#   cd <the Flask fixture>
#   PS1='$ '
#   source "$FORGE/docs/recording/terminal-prep.sh"
#
# On camera you then type a short name instead of a 90-character command; each helper PRINTS the real command line before
# it runs it, so the viewer sees exactly what is verified. Typing the full commands live would add about 3 minutes
# (docs/recording/estimate-timing.mjs --type).
#
#   vA   Task A: FLASK_DEBUG=off prints False, then verify-task-a.sh (RESULT line)
#   vB   Task B: flask --help lists config, a demo app whose secrets come out as "***", then verify-task-b.sh (RESULT line; its check (b) runs the project's pytest)
#   vC   Task C: git status (must be clean BEFORE you apply), run it first; then vA after applying
#   rs   reset the fixture between tasks (scripts/reset-fixture.sh)
: "${FORGE:?set FORGE to the forge-agent repository first (export FORGE=...)}"
[ -x .venv/bin/python ] || { echo "run this from the Flask fixture folder (it needs ./.venv)"; return 1 2>/dev/null || exit 1; }

_say() { printf '$ %s\n' "$*"; }

vA() {
  _say 'FLASK_DEBUG=off .venv/bin/python -c "import flask.helpers as h; print(h.get_debug_flag())"'
  FLASK_DEBUG=off .venv/bin/python -c "import flask.helpers as h; print(h.get_debug_flag())"
  _say '$FORGE/scripts/verify-task-a.sh | tail -1'
  "$FORGE/scripts/verify-task-a.sh" | tail -1
}

vB() {
  _say '.venv/bin/flask --app tests/test_apps/cliapp/app:testapp --help | sed -n "/^Commands:/,\$p"'
  .venv/bin/flask --app tests/test_apps/cliapp/app:testapp --help | sed -n '/^Commands:/,$p'
  # masking: a 3-line demo app OUTSIDE the fixture with real-looking secrets; the config command must print *** for them
  local flaskbin="$PWD/.venv/bin/flask" demo="${TMPDIR:-/tmp}/forge-demo-app"
  mkdir -p "$demo"
  printf '%s\n' 'from flask import Flask' 'app = Flask(__name__)' 'app.config.update(SECRET_KEY="hunter2", API_TOKEN="abc123", DB_PASSWORD="s3cret", PAGE_SIZE=20)' > "$demo/demo_app.py"
  _say 'cat demo_app.py'
  cat "$demo/demo_app.py"
  _say '.venv/bin/flask --app demo_app.py config | grep -E "SECRET|TOKEN|PASSWORD|PAGE"'
  (cd "$demo" && "$flaskbin" --app demo_app.py config | grep -E 'SECRET|TOKEN|PASSWORD|PAGE')
  _say '$FORGE/scripts/verify-task-b.sh | tail -9'
  "$FORGE/scripts/verify-task-b.sh" | tail -9
}

vC() {
  _say 'git status'
  git status
}

rs() {
  _say '$FORGE/scripts/reset-fixture.sh'
  "$FORGE/scripts/reset-fixture.sh" | tail -3
}
