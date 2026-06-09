#!/usr/bin/env bash
# launch-spoke.sh <android> — start a pi-e2e-tester spoke.
#
# Reads config.json, exports the env the spoke extension reads, then execs an
# interactive `pi` loading ONLY spoke/index.ts (the role is chosen at launch via
# PI_ROLE). On exit the window is kept open (trap -> exec bash) so a crash is
# inspectable. Normally launched in a freshly spawned WSL window by `just spawn`
# or by the hub at bring-up.
#
# PORT PROPAGATION (spec): the hub passes its OWN RESOLVED port to this script via
# the inherited HUB_PORT env at spawn time. If HUB_PORT is already set in the
# environment we HONOUR it (the hub knows its real port); only when it is unset do
# we fall back to ports.hub from config. The spoke's own port is a PREFERRED value
# (ports.androidSpoke) — the spoke's transport auto-falls-back to the next free
# port and reports the RESOLVED port back to the hub via the `register` message.

set -euo pipefail

# --- resolve role ------------------------------------------------------------
ROLE="${1:-}"
if [[ "$ROLE" != "android" ]]; then
  echo "launch-spoke.sh: ERROR — role must be 'android' (web/ios are phase 2; got: '${ROLE:-<none>}')" >&2
  echo "usage: launch-spoke.sh <android>" >&2
  exit 2
fi

# --- locate project ----------------------------------------------------------
SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd -P)"
PROJECT_DIR="$SCRIPT_DIR"
CONFIG="$PROJECT_DIR/config.json"
EXTENSION="$PROJECT_DIR/spoke/index.ts"

if [[ ! -f "$CONFIG" ]]; then
  echo "launch-spoke.sh: ERROR — config.json not found at $CONFIG" >&2
  exit 1
fi
if [[ ! -f "$EXTENSION" ]]; then
  echo "launch-spoke.sh: ERROR — spoke extension not found at $EXTENSION" >&2
  echo "(the spoke/ layer is owned by a later phase-2 agent; cannot launch until it exists)" >&2
  exit 1
fi

# --- ensure tooling ----------------------------------------------------------
if ! command -v jq >/dev/null 2>&1; then
  echo "launch-spoke.sh: ERROR — jq is required to read config.json" >&2
  exit 1
fi
if ! command -v pi >/dev/null 2>&1; then
  echo "launch-spoke.sh: ERROR — 'pi' not on PATH. Install it or run via bash -lic so rc files load PATH." >&2
  exit 1
fi

# --- read config -------------------------------------------------------------
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

TOKEN="$(jq -r '.token' "$CONFIG")"
HOST="$(jq -r '.host // "127.0.0.1"' "$CONFIG")"
STATE_DIR_RAW="$(jq -r '.stateDir' "$CONFIG")"
LOGS_DIR_RAW="$(jq -r '.logsDir' "$CONFIG")"

# HUB_PORT: honour an inherited (hub-resolved) value; else fall back to config.
CFG_HUB_PORT="$(jq -r '.ports.hub' "$CONFIG")"
HUB_PORT="${HUB_PORT:-$CFG_HUB_PORT}"

# The spoke's own PREFERRED port (transport may auto-fall-back at runtime).
SELF_PORT="$(jq -r '.ports.androidSpoke' "$CONFIG")"

MODEL="$(jq -r '.android.model // empty' "$CONFIG")"
THINKING="$(jq -r '.android.thinking // empty' "$CONFIG")"

# Target + device (the spoke pins device.serial on every adb/agent-device call).
TARGET_DIR="$(expand_tilde "$(jq -r '.target.dir' "$CONFIG")")"
ANDROID_PACKAGE="$(jq -r '.target.androidPackage' "$CONFIG")"
DEVICE_SERIAL="$(jq -r '.device.serial' "$CONFIG")"

STATE_DIR="$(expand_tilde "$STATE_DIR_RAW")"
LOGS_DIR="$(expand_path "$LOGS_DIR_RAW")"
LOG_FILE="$LOGS_DIR/$ROLE.log"

mkdir -p "$STATE_DIR" "$LOGS_DIR"

# --- export env for the spoke extension --------------------------------------
# config.json stays the source of truth; these exports spare the extension from
# re-deriving and carry the RESOLVED HUB_PORT the hub passed in.
export PI_ROLE="$ROLE"
export PI_TOKEN="$TOKEN"
export PI_HOST="$HOST"
export HUB_PORT="$HUB_PORT"               # spec-named: hub's resolved port
export PI_HUB_PORT="$HUB_PORT"            # alias for symmetry with PI_SELF_PORT
export PI_SELF_PORT="$SELF_PORT"          # spoke's PREFERRED port (may fall back)
export PI_TARGET_DIR="$TARGET_DIR"
export PI_ANDROID_PACKAGE="$ANDROID_PACKAGE"
export PI_DEVICE_SERIAL="$DEVICE_SERIAL"
export PI_STATE_DIR="$STATE_DIR"
export PI_LOGS_DIR="$LOGS_DIR"
export PI_LOG_FILE="$LOG_FILE"
export PI_PROJECT_DIR="$PROJECT_DIR"

echo "launch-spoke.sh: starting '$ROLE' spoke"
echo "  self    : $HOST:$SELF_PORT (preferred)   hub: $HOST:$HUB_PORT"
echo "  target  : $TARGET_DIR   app: $ANDROID_PACKAGE"
echo "  device  : $DEVICE_SERIAL"
echo "  log     : $LOG_FILE"
echo "  model   : ${MODEL:-<pi default>}   thinking: ${THINKING:-<pi default>}"
echo "  pi      : $(command -v pi)   ext: $EXTENSION"
echo

# --- keep the window open on exit for debugging ------------------------------
keep_open() {
  local code=$?
  if [[ $code -eq 0 ]]; then
    exit 0   # clean shutdown (hub-requested / manual quit) — close the window
  fi
  echo
  echo "launch-spoke.sh: pi ('$ROLE' spoke) exited with code $code."
  echo "Window kept open for inspection. Logs: $LOG_FILE"
  echo "Type 'exit' to close, or re-run: $PROJECT_DIR/launch-spoke.sh $ROLE"
  exec bash
}
trap keep_open EXIT

# --- launch pi ---------------------------------------------------------------
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
