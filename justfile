# justfile — pi-e2e-tester operator recipes.
#
# Each app under test is one self-contained configs/<app>.json. `just hub <app>`
# (default "default") selects it via PI_CONFIG_APP, which the hub forwards to every
# spoke it spawns. Ports are PREFERRED: transport auto-falls-back to the next free
# port and the resolved value propagates at runtime (HUB_PORT env / register
# message). Today only `android` has a spoke; ios/web are reserved.

set shell := ["bash", "-eu", "-o", "pipefail", "-c"]

project_dir := justfile_directory()
configs_dir := project_dir / "configs"
launch_spoke := project_dir / "launch-spoke.sh"
hub_ext := project_dir / "hub" / "index.ts"
# WSL distro for spoke windows is read from configs/<app>.json (.wslDistro) at spawn time.

# Default: list recipes.
default:
    @just --list

# Expand a leading ~ against $HOME (mirrors shared/config.ts expandTilde).
_expand path:
    @p='{{path}}'; case "$p" in "~") echo "$HOME";; "~/"*) echo "$HOME/${p:2}";; *) echo "$p";; esac

# Resolve an app name to its config file; fail loud (to stderr) if missing.
_cfgfile app="default":
    @f="{{configs_dir}}/{{app}}.json"; \
    test -f "$f" || { echo "pi-e2e-tester: no config for app '{{app}}': $f not found (copy configs/example.json.example -> configs/{{app}}.json)" >&2; exit 1; }; \
    echo "$f"

# Run a jq query against an app's config file.
_cfg app query:
    @jq -r '{{query}}' "$(just _cfgfile {{app}})"

# Resolve an app's logs dir, namespaced <logsDir>/<app>/ (mirrors getLogFile).
_logs-dir app="default":
    @cfg="$(just _cfgfile {{app}})"; raw=$(jq -r '.logsDir' "$cfg"); \
    case "$raw" in \
      "~") base="$HOME";; \
      "~/"*) base="$HOME/${raw:2}";; \
      /*) base="$raw";; \
      *) base="{{project_dir}}/$raw";; \
    esac; \
    echo "$base/{{app}}"

_state-dir app="default":
    @cfg="$(just _cfgfile {{app}})"; raw=$(jq -r '.stateDir' "$cfg"); just _expand "$raw"

# --no-builtin-tools HARD-GATES the hub LLM to ONLY the registered tools (no
# built-in bash/read/write/edit, which have no path sandbox); its only filesystem
# access is the scoped tests_* tools.
# Launch the hub orchestrator pi session in THIS terminal for app <app>.
hub app="default":
    @test -f "{{hub_ext}}" || { echo "hub extension not found: {{hub_ext}} (owned by a later phase-2 agent)"; exit 1; }
    cfg="$(just _cfgfile {{app}})"; \
    model=$(jq -r '.hub.model // empty' "$cfg"); thinking=$(jq -r '.hub.thinking // empty' "$cfg"); \
    args=(); [ -n "$model" ] && args+=(--model "$model"); [ -n "$thinking" ] && args+=(--thinking "$thinking"); \
    cd "{{project_dir}}" && PI_CONFIG_APP={{app}} exec pi --no-extensions --no-builtin-tools -nc -e "{{hub_ext}}" --name "pi-e2e-tester:hub:{{app}}" ${args[@]+"${args[@]}"}

# Run a platform spoke in THIS terminal (debug, no new window).
spoke platform="android" app="default":
    @case '{{platform}}' in android) ;; *) echo "platform must be android (ios/web have no spoke yet)"; exit 2;; esac
    @just _cfgfile {{app}} >/dev/null
    PI_CONFIG_APP={{app}} "{{launch_spoke}}" '{{platform}}'

# bash -lic gives the spawned window PATH/TTY; PI_CONFIG_APP rides the wsl `-e env`
# list (same rail as HUB_PORT) so it reads configs/<app>.json; the "<launcher>
# <platform>" payload is double-quoted so bash -c runs it as one command.
# Open a platform spoke in its own visible WSL window.
spawn platform="android" app="default":
    @case '{{platform}}' in android) ;; *) echo "platform must be android (ios/web have no spoke yet)"; exit 2;; esac
    distro=$(jq -r '.wslDistro // "Debian"' "$(just _cfgfile {{app}})"); \
    powershell.exe -NoProfile -Command "Start-Process wsl.exe -ArgumentList '-d $distro --cd {{project_dir}} -e env PI_CONFIG_APP={{app}} bash -lic \"{{launch_spoke}} {{platform}}\"'"
    @echo "spawned '{{platform}}' spoke window for app '{{app}}' (PowerShell Start-Process wsl.exe)"

# Show which hub/spoke ports are alive + device reachability, for an app.
status app="default":
    @cfg="$(just _cfgfile {{app}})"; \
    echo "=== pi-e2e-tester ports for app '{{app}}' (TCP listeners, PREFERRED) ==="; \
    host=$(jq -r '.host // "127.0.0.1"' "$cfg"); \
    hub_port=$(jq -r '.ports.hub' "$cfg"); \
    and_port=$(jq -r '.platforms.android.spokePort' "$cfg"); \
    for entry in "hub:$hub_port" "android:$and_port"; do \
      role="${entry%%:*}"; port="${entry##*:}"; \
      if (exec 3<>"/dev/tcp/$host/$port") 2>/dev/null; then exec 3>&- 3<&-; echo "  $role  $host:$port  ALIVE"; \
      else echo "  $role  $host:$port  down"; fi; \
    done; \
    serial=$(jq -r '.platforms.android.device.serial' "$cfg"); \
    echo; echo "=== android test device ($serial) ==="; \
    adb -s "$serial" get-state 2>/dev/null && echo "  device reachable" || echo "  device NOT reachable (USB detached?)"

# name is a platform (android) OR a dev log (e.g. convex-dev) backgrounded there.
# Tail <logsDir>/<app>/<name>.log.
logs name app="default":
    @dir=$(just _logs-dir {{app}}); f="$dir/{{name}}.log"; \
    test -f "$f" || { echo "no log yet: $f"; exit 0; }; \
    echo "==> $f <=="; tail -n 200 -f "$f"

# state.json is keyed by app+platform inside, so this wipes ALL apps' cache.
# Remove the runtime state file (clears ALL apps' last-connected cache).
clean-state app="default":
    @state=$(just _state-dir {{app}}); f="$state/state.json"; \
    if [ -f "$f" ]; then rm -f "$f"; echo "removed $f (runtime state)."; \
    else echo "no state file at $f"; fi

# Full reset for an app: remove state.json AND wipe its namespaced logs dir.
clean app="default": (clean-state app)
    @dir=$(just _logs-dir {{app}}); \
    if [ -d "$dir" ]; then rm -f "$dir"/*.log 2>/dev/null || true; echo "wiped logs in $dir"; fi; \
    echo "clean done — runtime state + logs removed for app '{{app}}'."
