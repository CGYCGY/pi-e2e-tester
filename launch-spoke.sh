#!/usr/bin/env bash
# launch-spoke.sh <android> — start a pi-e2e-tester spoke (run by `just spawn` or
# the hub at bring-up).
#
# HUB_PORT: the hub passes its OWN resolved port via the inherited env; honour it
# when set (it knows its real bound port after any auto-fallback), else fall back
# to config. The spoke's own port is likewise PREFERRED — transport may
# auto-fall-back and report the resolved port to the hub via `register`.

set -euo pipefail

ROLE="${1:-}"
if [[ "$ROLE" != "android" ]]; then
  echo "launch-spoke.sh: ERROR — role must be 'android' (ios/web have no spoke yet; got: '${ROLE:-<none>}')" >&2
  echo "usage: launch-spoke.sh <android>" >&2
  exit 2
fi

# Re-export PI_CONFIG_APP (default "default") so the spoke extension's loader
# (shared/config.ts) selects the SAME configs/<app>.json this script reads.
APP="${PI_CONFIG_APP:-default}"
export PI_CONFIG_APP="$APP"

SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"
CONFIG="$PROJECT_DIR/configs/$APP.json"
EXTENSION="$PROJECT_DIR/spoke/index.ts"

if [[ ! -f "$CONFIG" ]]; then
  echo "launch-spoke.sh: ERROR — app config not found: $CONFIG (PI_CONFIG_APP=$APP)" >&2
  echo "  Create configs/$APP.json (copy configs/example.json.example) or pass a known app." >&2
  exit 1
fi
if [[ ! -f "$EXTENSION" ]]; then
  echo "launch-spoke.sh: ERROR — spoke extension not found at $EXTENSION" >&2
  exit 1
fi

if ! command -v jq >/dev/null 2>&1; then
  echo "launch-spoke.sh: ERROR — jq is required to read configs/<app>.json" >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "launch-spoke.sh: ERROR — 'pi' not on PATH. Install it or run via bash -lic so rc files load PATH." >&2
  exit 1
fi

# expandTilde mirror: config.ts expands a leading ~ against $HOME.
expand_tilde() {
  local p="$1"
  if [[ "$p" == "~" ]]; then printf '%s' "$HOME";
  elif [[ "$p" == "~/"* ]]; then printf '%s/%s' "$HOME" "${p:2}";
  else printf '%s' "$p"; fi
}

# expandPath mirror: ~ -> $HOME, relative -> project dir (for logsDir).
expand_path() {
  local p; p="$(expand_tilde "$1")"
  case "$p" in /*) printf '%s' "$p";; *) printf '%s/%s' "$PROJECT_DIR" "$p";; esac
}

HOST="$(jq -r '.host // "127.0.0.1"' "$CONFIG")"
STATE_DIR_RAW="$(jq -r '.stateDir' "$CONFIG")"
LOGS_DIR_RAW="$(jq -r '.logsDir' "$CONFIG")"

CFG_HUB_PORT="$(jq -r '.ports.hub' "$CONFIG")"
HUB_PORT="${HUB_PORT:-$CFG_HUB_PORT}"

SELF_PORT="$(jq -r --arg r "$ROLE" '.platforms[$r].spokePort' "$CONFIG")"

MODEL="$(jq -r --arg r "$ROLE" '.platforms[$r].model // empty' "$CONFIG")"
THINKING="$(jq -r --arg r "$ROLE" '.platforms[$r].thinking // empty' "$CONFIG")"

TARGET_DIR="$(expand_tilde "$(jq -r '.target.dir' "$CONFIG")")"
ANDROID_PACKAGE="$(jq -r --arg r "$ROLE" '.platforms[$r].androidPackage' "$CONFIG")"
DEVICE_SERIAL="$(jq -r --arg r "$ROLE" '.platforms[$r].device.serial' "$CONFIG")"

STATE_DIR="$(expand_tilde "$STATE_DIR_RAW")"
LOGS_DIR="$(expand_path "$LOGS_DIR_RAW")"
# Namespaced <logsDir>/<app>/<role>.log (mirrors getLogFile) so apps/platforms don't collide.
APP_LOGS_DIR="$LOGS_DIR/$APP"
LOG_FILE="$APP_LOGS_DIR/$ROLE.log"

mkdir -p "$STATE_DIR" "$APP_LOGS_DIR"

# These exports spare the extension re-deriving config + carry the resolved HUB_PORT.
export PI_ROLE="$ROLE"
export PI_HOST="$HOST"
export HUB_PORT="$HUB_PORT"
export PI_HUB_PORT="$HUB_PORT"            # alias for symmetry with PI_SELF_PORT
export PI_SELF_PORT="$SELF_PORT"          # PREFERRED; transport may fall back
export PI_TARGET_DIR="$TARGET_DIR"
export PI_ANDROID_PACKAGE="$ANDROID_PACKAGE"
export PI_DEVICE_SERIAL="$DEVICE_SERIAL"
export PI_STATE_DIR="$STATE_DIR"
export PI_LOGS_DIR="$LOGS_DIR"
export PI_LOG_FILE="$LOG_FILE"
export PI_PROJECT_DIR="$PROJECT_DIR"

echo "launch-spoke.sh: starting '$ROLE' spoke for app '$APP'"
echo "  self    : $HOST:$SELF_PORT (preferred)   hub: $HOST:$HUB_PORT"
echo "  target  : $TARGET_DIR   pkg: $ANDROID_PACKAGE"
echo "  device  : $DEVICE_SERIAL"
echo "  log     : $LOG_FILE"
echo "  model   : ${MODEL:-<pi default>}   thinking: ${THINKING:-<pi default>}"
echo "  pi      : $(command -v pi)   ext: $EXTENSION"
echo

# Non-zero exit keeps the window open (exec bash) so a crash stays inspectable.
keep_open() {
  local code=$?
  if [[ $code -eq 0 ]]; then
    exit 0
  fi
  echo
  echo "launch-spoke.sh: pi ('$ROLE' spoke) exited with code $code."
  echo "Window kept open for inspection. Logs: $LOG_FILE"
  echo "Type 'exit' to close, or re-run: $PROJECT_DIR/launch-spoke.sh $ROLE"
  exec bash
}
trap keep_open EXIT

# -nc drops ambient AGENTS.md/CLAUDE.md so the harness inherits no parent-repo
# context; its own guidance lives in .pi/APPEND_SYSTEM.md (which -nc ignores).
# --no-builtin-tools HARD-GATES the spoke LLM to ONLY the registered device verbs
# (no built-in bash/read/write/edit) — all path access goes through guarded tools
# (read_screenshot / read_creds); built-in tools have no path sandbox.
# cwd = project dir so the extension's relative imports and .pi/ resolve.
cd "$PROJECT_DIR"
PI_ARGS=()
[[ -n "$MODEL" ]] && PI_ARGS+=(--model "$MODEL")
[[ -n "$THINKING" ]] && PI_ARGS+=(--thinking "$THINKING")
exec pi --no-extensions --no-builtin-tools -nc -e "$EXTENSION" --name "pi-e2e-tester:$ROLE" ${PI_ARGS[@]+"${PI_ARGS[@]}"}
