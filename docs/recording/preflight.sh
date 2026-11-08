#!/usr/bin/env bash
# Preflight for recording the demo video. Read-only: it changes nothing (no TrueForge write, no file write, no git
# command that modifies anything) and never prints a key or any environment variable except the three TrueForge
# settings it checks. Prints a table of checks and finishes with GO or NO-GO (exit code 0 / 1).
#
#   docs/recording/preflight.sh
#
# Environment (all optional):
#   TRUEFORGE_BASE_URL   default http://localhost:8790
#   FIXTURE_DIR          default ../fixtures/flask (next to this repository, as in scripts/setup-fixture.sh)
#   VSCODE_CLI           path of the `code` command if it is not on PATH
#
# Run it with VS Code already open on the Flask fixture and Forge activated, so Forge has registered its agents.
set -u
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
BASE_URL="${TRUEFORGE_BASE_URL:-http://localhost:8790}"
BASE_URL="${BASE_URL%/}"
FIXTURE="${FIXTURE_DIR:-$ROOT/../fixtures/flask}"
PIN="22d92470"

FAILS=""
WARNS=""
ok()   { printf '  OK    %-34s %s\n' "$1" "$2"; }
warn() { printf '  WARN  %-34s %s\n' "$1" "$2"; WARNS="${WARNS}
    - $1: $2"; }
bad()  { printf '  FAIL  %-34s %s\n' "$1" "$2"; FAILS="${FAILS}
    - $1: $2"; }
section() { printf '\n%s\n' "$1"; }

json() { # json <expression over `d`> reads JSON from stdin; prints the result, or nothing on any error
  node -e 'let s="";process.stdin.on("data",c=>s+=c).on("end",()=>{try{const d=JSON.parse(s);const r=('"$1"');if(r!==undefined)console.log(r)}catch(e){}})' 2>/dev/null
}

echo "Forge recording preflight ($(date '+%Y-%m-%d %H:%M'))"

# ---------------------------------------------------------------------------------------------------------------
section "TrueForge"
CAP="$(curl -s -m 4 -o /dev/null -w '%{http_code}' "$BASE_URL/api/v1/capabilities" 2>/dev/null || true)"
if [ "$CAP" = "200" ]; then ok "TrueForge reachable" "$BASE_URL"; else bad "TrueForge reachable" "no answer at $BASE_URL (start it: npm run tf:start)"; fi

PORT="$(printf '%s' "$BASE_URL" | sed -n 's|^[a-z]*://[^:/]*:\([0-9][0-9]*\).*|\1|p')"
PID=""
if [ -n "$PORT" ] && command -v lsof >/dev/null 2>&1; then PID="$(lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1)"; fi
envvar() { # envvar <NAME>: value of that variable in the TrueForge process, nothing else is ever read out
  if [ -r "/proc/$PID/environ" ]; then tr '\0' '\n' < "/proc/$PID/environ" | sed -n "s/^$1=//p" | head -1
  else ps eww -p "$PID" 2>/dev/null | tr ' ' '\n' | sed -n "s/^$1=//p" | head -1; fi
}
if [ -z "$PID" ]; then
  warn "TrueForge environment" "cannot find the process listening on port ${PORT:-?}; make sure it was started with npm run tf:start"
else
  HOSTS="$(envvar OUTBOUND_URL_ALLOWED_HOSTS)"
  TMO="$(envvar MODEL_HTTP_CONNECT_TIMEOUT_MS)"
  RET="$(envvar MODEL_HTTP_MAX_RETRIES)"
  if [ -z "$HOSTS$TMO$RET" ]; then
    warn "TrueForge environment" "cannot read the process environment; make sure it was started with npm run tf:start"
  else
    case "$HOSTS" in *localhost*127.0.0.1*|*127.0.0.1*localhost*) ok "OUTBOUND_URL_ALLOWED_HOSTS" "$HOSTS" ;; *) bad "OUTBOUND_URL_ALLOWED_HOSTS" "is '${HOSTS:-unset}': loopback MCP is blocked (start with npm run tf:start)" ;; esac
    if [ "$TMO" = "3000" ]; then ok "MODEL_HTTP_CONNECT_TIMEOUT_MS" "3000"; else warn "MODEL_HTTP_CONNECT_TIMEOUT_MS" "is '${TMO:-unset}', expected 3000: the Task C fallback would take longer to show"; fi
    if [ "$RET" = "1" ]; then ok "MODEL_HTTP_MAX_RETRIES" "1"; else warn "MODEL_HTTP_MAX_RETRIES" "is '${RET:-unset}', expected 1"; fi
  fi
fi

# ---------------------------------------------------------------------------------------------------------------
section "Models, agents, MCP servers (registered in TrueForge)"
if [ "$CAP" = "200" ]; then
  MODELS="$(curl -s -m 8 "$BASE_URL/api/v1/models" | json 'd.data.map(m=>m.name).sort().join(" ")')"
  AGENTS="$(curl -s -m 8 "$BASE_URL/api/v1/agents?limit=100" | json 'd.data.map(a=>a.name).sort().join(" ")')"
  MCPS="$(curl -s -m 8 "$BASE_URL/api/v1/settings/mcp-servers" | json 'd.data.map(m=>m.name).sort().join(" ")')"
  PROVS="$(curl -s -m 8 "$BASE_URL/api/v1/settings/model-providers" | json 'd.data.map(m=>m.name).sort().join(" ")')"
  has() { case " $1 " in *" $2 "*) return 0 ;; *) return 1 ;; esac; }
  echo "        providers: ${PROVS:-(none)}"
  echo "        models:    ${MODELS:-(none)}"
  echo "        agents:    ${AGENTS:-(none)}"
  echo "        MCP:       ${MCPS:-(none)}"
  if has "$MODELS" "deepseek/flash"; then ok "model deepseek/flash" "registered"; else bad "model deepseek/flash" "missing (export DEEPSEEK_API_KEY=... && npm run tf:setup)"; fi
  if has "$MODELS" "broken-endpoint/broken"; then ok "demo model for Task C" "broken-endpoint/broken registered"; else bad "demo model for Task C" "broken-endpoint/broken missing (npm run tf:setup -- --only-demo)"; fi
  for a in forge-agent forge-inline; do
    if has "$AGENTS" "$a"; then ok "agent $a" "registered"; else bad "agent $a" "missing: open the fixture in VS Code with Forge installed (it registers the agents on activation), then run this again"; fi
  done
  for m in forge-editor forge-editor-extras; do
    if has "$MCPS" "$m"; then ok "MCP server $m" "registered"; else bad "MCP server $m" "missing: open VS Code with Forge installed so it registers on activation"; fi
  done
  SESS="$(curl -s -m 5 -H 'Accept: text/html' -o /dev/null -w '%{http_code}' "$BASE_URL/sessions" 2>/dev/null || true)"
  # the page is a single-page app: it also needs the script it points at (it went missing once when `npx` replaced the
  # files of a TrueForge that was still running, which leaves a blank page)
  ASSET="$(curl -s -m 5 -H 'Accept: text/html' "$BASE_URL/sessions" 2>/dev/null | grep -o '/assets/[A-Za-z0-9._-]*\.js' | head -1)"
  ASSET_CODE=""; [ -n "$ASSET" ] && ASSET_CODE="$(curl -s -m 15 -o /dev/null -w '%{http_code}' "$BASE_URL$ASSET" 2>/dev/null || true)"
  if [ "$SESS" = "200" ] && [ "$ASSET_CODE" = "200" ]; then ok "TrueForge Sessions page" "$BASE_URL/sessions (UI script loads)";
  elif [ "$SESS" = "200" ]; then bad "TrueForge Sessions page" "the page loads but its script ${ASSET:-?} returns HTTP ${ASSET_CODE:-none}: the UI is blank. TrueForge's files were replaced while it ran; restart it with npm run tf:start (pinned to the tested version)";
  else bad "TrueForge Sessions page" "HTTP ${SESS:-none}; the closing shot needs it"; fi
else
  bad "models, agents, MCP servers" "skipped: TrueForge is not reachable"
fi

# ---------------------------------------------------------------------------------------------------------------
section "API keys (names and presence only; values are never printed)"
for k in DEEPSEEK_API_KEY; do
  v="$(printenv "$k" 2>/dev/null || true)"
  if [ -n "$v" ]; then ok "$k" "set in this shell (${#v} characters)"; else warn "$k" "not set in this shell: fine while the provider is already registered, needed to re-run npm run tf:setup"; fi
done
if [ -n "${PROVS:-}" ]; then
  case " $PROVS " in *" deepseek "*) ok "provider deepseek" "registered in TrueForge (it holds the key)" ;; *) bad "provider deepseek" "not registered: export DEEPSEEK_API_KEY=... && npm run tf:setup" ;; esac
fi

# ---------------------------------------------------------------------------------------------------------------
section "Flask fixture"
if [ ! -d "$FIXTURE/.git" ]; then
  bad "fixture present" "$FIXTURE not found (scripts/setup-fixture.sh)"
else
  HEADSHA="$(git -C "$FIXTURE" rev-parse --short=8 HEAD 2>/dev/null)"
  if [ "$HEADSHA" = "$PIN" ]; then ok "fixture commit" "$HEADSHA (Flask 3.1.3)"; else bad "fixture commit" "$HEADSHA, expected $PIN (scripts/reset-fixture.sh does not change commits: scripts/setup-fixture.sh)"; fi
  ST="$(git -C "$FIXTURE" status --porcelain 2>/dev/null)"
  if [ -z "$ST" ]; then ok "fixture git status" "clean"; else bad "fixture git status" "changed files, run scripts/reset-fixture.sh:$(printf '%s' "$ST" | head -5 | sed 's/^/ /' | tr '\n' ';')"; fi
  VP="$FIXTURE/.venv/bin/python"
  if [ -x "$VP" ]; then
    PV="$("$VP" -m pytest --version 2>&1 | head -1)"
    case "$PV" in pytest*) ok "fixture .venv + pytest" "$PV" ;; *) bad "fixture .venv + pytest" "pytest does not run: $PV" ;; esac
    RV="$("$VP" -m ruff --version 2>&1 | head -1)"
    case "$RV" in ruff*) ok "fixture ruff" "$RV (the agent's lint call works)" ;; *) warn "fixture ruff" "not installed: the agent's ruff call would fail (the fixture .venv: pip install ruff)" ;; esac
    FL="$("$VP" -c 'import flask,sys;print(flask.__file__)' 2>&1 | tail -1)"
    case "$FL" in "$FIXTURE"/*|*/fixtures/flask/src/flask/__init__.py) ok "import flask" "resolves into the fixture" ;; *) warn "import flask" "resolves to $FL" ;; esac
  else
    bad "fixture .venv" "missing: scripts/setup-fixture.sh"
  fi
fi

# ---------------------------------------------------------------------------------------------------------------
section "VS Code and Forge settings"
CODE="${VSCODE_CLI:-}"
if [ -z "$CODE" ]; then
  if command -v code >/dev/null 2>&1; then CODE="code"
  elif [ -x "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code" ]; then CODE="/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code"; fi
fi
if [ -n "$CODE" ]; then
  VSV="$("$CODE" --version 2>/dev/null | head -1)"
  MAJ="$(printf '%s' "$VSV" | cut -d. -f1)"; MIN="$(printf '%s' "$VSV" | cut -d. -f2)"
  if [ -n "$VSV" ] && { [ "${MAJ:-0}" -gt 1 ] || { [ "${MAJ:-0}" -eq 1 ] && [ "${MIN:-0}" -ge 95 ]; }; }; then ok "VS Code" "$VSV (Forge needs >= 1.95)"; else bad "VS Code" "version '${VSV:-unknown}' (needs >= 1.95)"; fi
  EXT="$("$CODE" --list-extensions --show-versions 2>/dev/null | grep -i '^forge-local\.forge-agent@' | head -1)"
  if [ -n "$EXT" ]; then ok "Forge extension installed" "$EXT"; else warn "Forge extension installed" "not listed for the default profile (fine if you run it from source with F5)"; fi
else
  bad "VS Code" "the code command was not found (set VSCODE_CLI)"
fi

# only the forge.models value of the user's settings is read; nothing else from that file is printed
SETTINGS=""
for f in "${VSCODE_SETTINGS:-}" "$HOME/Library/Application Support/Code/User/settings.json" "$HOME/.config/Code/User/settings.json" "${APPDATA:-/nonexistent}/Code/User/settings.json"; do
  if [ -n "$f" ] && [ -f "$f" ]; then SETTINGS="$f"; break; fi
done
if [ -z "$SETTINGS" ]; then
  warn "forge.models chain" "no VS Code user settings.json found: the default chain applies (deepseek/flash, deepseek/v4-pro)"
else
  CHAIN="$(node -e '
    const fs = require("fs");
    let t = fs.readFileSync(process.argv[1], "utf8"), out = "", inStr = false;
    for (let i = 0; i < t.length; i++) {            // strip // and /* */ comments, respecting strings
      const c = t[i], n = t[i + 1];
      if (inStr) { out += c; if (c === "\\") { out += n; i++; } else if (c === "\"") inStr = false; continue; }
      if (c === "\"") { inStr = true; out += c; continue; }
      if (c === "/" && n === "/") { while (i < t.length && t[i] !== "\n") i++; out += "\n"; continue; }
      if (c === "/" && n === "*") { i += 2; while (i < t.length && !(t[i] === "*" && t[i + 1] === "/")) i++; i++; continue; }
      out += c;
    }
    out = out.replace(/,(\s*[}\]])/g, "$1");
    try { const m = JSON.parse(out)["forge.models"]; console.log(Array.isArray(m) ? m.join(",") : "DEFAULT"); } catch (e) { console.log("UNREADABLE"); }
  ' "$SETTINGS" 2>/dev/null)"
  case "$CHAIN" in
    DEFAULT) ok "forge.models chain" "not set in your settings: default deepseek/flash, deepseek/v4-pro" ;;
    UNREADABLE|"") warn "forge.models chain" "could not read it from your settings" ;;
    broken-endpoint/*|badkey-deepseek/*) bad "forge.models chain" "starts with a demo model ($CHAIN): Tasks A and B would fail. Set forge.models to [\"deepseek/flash\", \"deepseek/v4-pro\"] (Command Palette: Forge: Switch Model), and switch to the broken one only for Task C" ;;
    deepseek/flash*) ok "forge.models chain" "$CHAIN" ;;
    *) warn "forge.models chain" "$CHAIN (the shot list assumes deepseek/flash first)" ;;
  esac
fi

# ---------------------------------------------------------------------------------------------------------------
section "Machine"
NODEV="$(node --version 2>/dev/null)"
NM="$(printf '%s' "$NODEV" | sed 's/^v//' | cut -d. -f1)"; NN="$(printf '%s' "$NODEV" | sed 's/^v//' | cut -d. -f2)"
if [ -n "$NODEV" ] && { [ "${NM:-0}" -gt 22 ] || { [ "${NM:-0}" -eq 22 ] && [ "${NN:-0}" -ge 14 ]; }; }; then ok "Node" "$NODEV (>= 22.14)"; else bad "Node" "'${NODEV:-missing}' (needs >= 22.14)"; fi
FREE_KB="$(df -k "$ROOT" 2>/dev/null | awk 'NR==2{print $4}')"
if [ -n "$FREE_KB" ]; then
  FREE_GB=$((FREE_KB / 1024 / 1024))
  if [ "$FREE_GB" -ge 10 ]; then ok "disk space" "${FREE_GB} GB free"; elif [ "$FREE_GB" -ge 3 ]; then warn "disk space" "${FREE_GB} GB free (a 4-minute 1080p recording needs about 1 GB)"; else bad "disk space" "only ${FREE_GB} GB free"; fi
fi
# the exported video's duration must be checkable: ffprobe if installed, else macOS Spotlight (`mdls`), which reads .mp4 / .mov
if command -v ffprobe >/dev/null 2>&1; then
  ok "video duration check" "ffprobe is available"
else
  MDLS_SAMPLE="/System/Library/Sounds/Blow.aiff"
  MDLS_OUT="$(command -v mdls >/dev/null 2>&1 && [ -f "$MDLS_SAMPLE" ] && mdls -name kMDItemDurationSeconds -raw "$MDLS_SAMPLE" 2>/dev/null)"
  case "$MDLS_OUT" in
    [0-9]*) ok "video duration check" "ffprobe is not installed; mdls works instead: mdls -name kMDItemDurationSeconds -raw <file.mp4> (checked on a system sound: ${MDLS_OUT%%.*} s)" ;;
    *) warn "video duration check" "neither ffprobe nor mdls can read durations here: use QuickTime (Cmd+I shows the duration) or brew install ffmpeg" ;;
  esac
fi
PY3="$(command -v python3 || true)"; if [ -n "$PY3" ]; then ok "python3" "$("$PY3" --version 2>&1)"; fi

# ---------------------------------------------------------------------------------------------------------------
echo
if [ -z "$FAILS" ]; then
  echo "GO"
  [ -n "$WARNS" ] && printf 'Warnings (not blocking):%s\n' "$WARNS"
  exit 0
else
  echo "NO-GO"
  printf 'Reasons:%s\n' "$FAILS"
  [ -n "$WARNS" ] && printf 'Warnings:%s\n' "$WARNS"
  exit 1
fi
