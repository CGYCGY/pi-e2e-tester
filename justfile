# justfile — pi-e2e-tester operator recipes.
#
# pi-e2e-tester is a standalone agentic e2e tester for the expari monorepo,
# built on pi. Two visible windows:
#   hub (preferred port 7200, orchestrator) · android (7201, device spoke).
# The hub backgrounds expari's PLAIN dev recipes into this project's logs/ and
# tails them for auto-readiness — only hub + spoke windows are visible.
# config.json is the single source of truth; recipes read it via jq.
# Ports here are PREFERRED — transport auto-falls-back to the next free port and
# the resolved value propagates at runtime (HUB_PORT env / register message).

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

project_dir := justfile_directory()
config := project_dir / "config.json"
launch_spoke := project_dir / "launch-spoke.sh"
hub_ext := project_dir / "hub" / "index.ts"
wsl_distro := "Debian"

# Default: list recipes.
default:
    @just --list

# --- helpers (private) -------------------------------------------------------

# Expand a leading ~ against $HOME (mirrors shared/config.ts expandTilde).
_expand path:
    @p='{{path}}'; case "$p" in "~") echo "$HOME";; "~/"*) echo "$HOME/${p:2}";; *) echo "$p";; esac

_cfg query:
    @jq -r '{{query}}' "{{config}}"

# Resolve logsDir: ~ expands against $HOME, a relative path against the project dir.
_logs-dir:
    @raw=$(jq -r '.logsDir' "{{config}}"); \
    case "$raw" in \
      "~") echo "$HOME";; \
      "~/"*) echo "$HOME/${raw:2}";; \
      /*) echo "$raw";; \
      *) echo "{{project_dir}}/$raw";; \
    esac

_state-dir:
    @raw=$(jq -r '.stateDir' "{{config}}"); just _expand "$raw"

# --- hub ---------------------------------------------------------------------

# --no-extensions + -e load ONLY the hub extension; -nc drops ambient context.
# Launch the hub orchestrator pi session in THIS terminal.
hub:
    @test -f "{{hub_ext}}" || { echo "hub extension not found: {{hub_ext}} (owned by a later phase-2 agent)"; exit 1; }
    model=$(jq -r '.hub.model // empty' "{{config}}"); thinking=$(jq -r '.hub.thinking // empty' "{{config}}"); \
    args=(); [ -n "$model" ] && args+=(--model "$model"); [ -n "$thinking" ] && args+=(--thinking "$thinking"); \
    cd "{{project_dir}}" && exec pi --no-extensions -nc -e "{{hub_ext}}" --name "pi-e2e-tester:hub" ${args[@]+"${args[@]}"}

# --- spoke -------------------------------------------------------------------

# Run the android spoke in THIS terminal for debugging (no new window).
spoke role="android":
    @case '{{role}}' in android) ;; *) echo "role must be android (web/ios are phase 2)"; exit 2;; esac
    "{{launch_spoke}}" '{{role}}'

# Proven spawn: PowerShell Start-Process wsl.exe,
# wsl --cd sets cwd, bash -lic gives PATH/TTY. The "<launcher> <role>" payload is
# double-quoted so bash -c runs it as one command string.
# Open the android spoke in its own visible WSL window.
spawn role="android":
    @case '{{role}}' in android) ;; *) echo "role must be android (web/ios are phase 2)"; exit 2;; esac
    powershell.exe -NoProfile -Command "Start-Process wsl.exe -ArgumentList '-d {{wsl_distro}} --cd {{project_dir}} -- bash -lic \"{{launch_spoke}} {{role}}\"'"
    @echo "spawned '{{role}}' spoke window (PowerShell Start-Process wsl.exe)"

# --- status / logs -----------------------------------------------------------

# Show which hub/spoke ports are alive (checks the preferred port; runtime may
# have fallen back — see the role log for the resolved port).
status:
    @echo "=== pi-e2e-tester ports (TCP listeners, PREFERRED) ==="; \
    host=$(jq -r '.host // "127.0.0.1"' "{{config}}"); \
    hub_port=$(jq -r '.ports.hub' "{{config}}"); \
    and_port=$(jq -r '.ports.androidSpoke' "{{config}}"); \
    for entry in "hub:$hub_port" "android:$and_port"; do \
      role="${entry%%:*}"; port="${entry##*:}"; \
      if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; echo "  $role  $host:$port  ALIVE"; \
      else echo "  $role  $host:$port  down"; fi; \
    done; \
    echo; echo "=== android test device ($(jq -r '.device.serial' "{{config}}")) ==="; \
    serial=$(jq -r '.device.serial' "{{config}}"); \
    adb -s "$serial" get-state 2>/dev/null && echo "  device reachable" || echo "  device NOT reachable (USB detached?)"

# Tail <logsDir>/<name>.log. name is a role (hub|android) OR a dev log
# (e.g. convex-dev, mobile-android) the hub backgrounds there.
logs name:
    @dir=$(just _logs-dir); f="$dir/{{name}}.log"; \
    test -f "$f" || { echo "no log yet: $f"; exit 0; }; \
    echo "==> $f <=="; tail -n 200 -f "$f"

# --- cleanup -----------------------------------------------------------------

# Remove state.json only; keep logs.
clean-state:
    @state=$(just _state-dir); f="$state/state.json"; \
    if [ -f "$f" ]; then rm -f "$f"; echo "removed $f (runtime state)."; \
    else echo "no state file at $f"; fi

# Full reset: remove state.json AND wipe the logs dir.
clean: clean-state
    @dir=$(just _logs-dir); \
    if [ -d "$dir" ]; then rm -f "$dir"/*.log 2>/dev/null || true; echo "wiped logs in $dir"; fi; \
    echo "clean done — runtime state + logs removed."
