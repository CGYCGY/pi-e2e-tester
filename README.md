# pi-e2e-tester

A standalone **agentic end-to-end tester** for mobile/web apps, built on
[pi](https://pi.dev) (the minimal terminal coding agent by Earendil Inc. / Mario
Zechner). You chat test intent to a **hub**; the hub brings the app up and drives
a device **spoke** that automates the real device, then returns a **PASS/FAIL**
verdict.

Its default example target is the **expari** monorepo (web / android / ios), and
it will eventually replace expari's Maestro (mobile) + Playwright (web) suites —
but the tester is **app-agnostic**: each app under test is one self-contained
config file. Build order is **android → web → ios**; **android is live**, web +
ios are reserved (ios is TBD until a Mac mini exists — see *Platforms* below).

The tester drives the app under test **only** through its public `just` recipes +
`adb` + `agent-device`. The **app repo stays untouched**: the tester backgrounds
the app's *plain* dev recipes into its own `logs/` and owns their lifecycle.

---

## Architecture at a glance

Independent interactive `pi` sessions, each in its own terminal window — a hub
plus one spoke per platform the app runs on:

| Window | Role | Preferred port | Extension | Job |
|--------|------|----------------|-----------|-----|
| **HUB** | hub | `.ports.hub` (7200) | `hub/index.ts` | Orchestrator. Brings the app up (`usbipd` attach + `convex`/`metro` dev, backgrounded into `logs/<app>/`), waits for the real ready signal, spawns a spoke per configured platform, then issues test intents. |
| **ANDROID** | android | `.platforms.android.spokePort` (7201) | `spoke/index.ts` | Drives the real phone via `agent-device` (adb fallback). Interprets each NL intent, acts, returns a `PASS`/`FAIL` verdict. |

Each session runs a `node:http` server on `127.0.0.1` and POSTs JSON to the
other, every request carrying a shared token. Ports are **preferred** values —
the transport auto-falls-back to the next free port and the resolved value
propagates (`HUB_PORT` spawn env hub→spoke, `register{port}` message spoke→hub).

**Auto-readiness, not spawned-out terminals:** bring-up is `-bg` + logfiles in
`logs/<app>/`, which give BOTH visibility (read the file) AND readiness (the hub
tails for the real ready signal, with `adb devices` / `curl :8081/status` probe
backstops). **You never signal ready.**

**One run per role log:** the role logs (`hub.log`, `android.log`) hold only the
CURRENT run — each process archives the previous run to `logs/<app>/history/` at
startup (newest 20 kept), so reading a role log shows just this run, not a
growing pile. The dev logs (`convex`/`metro`/`usbipd`) are truncated in place,
since the hub regex-scans them for the ready signal.

---

## Prerequisites

| Tool | Why | Check |
|------|-----|-------|
| **pi** ≥ 0.78 | the agent runtime | `pi --version` |
| **agent-device** | drives the phone | `agent-device --version` |
| **adb** | device fallback + probes | `adb version` |
| **just** | the recipe runner | `just --version` |
| **bun** (or node ≥ 22) | installs deps | `bun --version` |
| **jq** | shell scripts read `configs/<app>.json` | `jq --version` |
| **usbipd-win** | USB passthrough of the phone into WSL | `usbipd.exe --version` |
| **WSL Debian** + **PowerShell interop** | spawning the visible spoke window | `powershell.exe -NoProfile -Command "echo ok"` |

The test device must be attached via usbipd with the app's dev build installed +
logged in (defaults: `R5CNC180FKY`, Galaxy S21 Ultra, `com.expari.app.dev`).

Install deps once: `bun install`.

`pi` is loaded with `--no-extensions -e <extension>` so **only** the hub/spoke
extension is active.

---

## Configuration

Each app under test is **one self-contained file** at `configs/<app>.json`. There
are no hard-coded paths/ports/tokens anywhere else, and there are **no app
defaults** — identity (package, serial, etc.) is required, so a misconfig fails
loud rather than silently testing the wrong app.

Get started by copying the template:

```bash
cp configs/example.json.example configs/default.json   # then fill the CHANGE-ME placeholders
cp rules/default.md.example      rules/default.md       # then point target.rulesFile at it
```

Run `just gen-token` to generate a unique `token` value and paste it into your `configs/<app>.json`
— use a distinct secret per install; do not commit it.

`just hub` loads `configs/default.json`; `just hub <app>` loads
`configs/<app>.json`. Selection rides the **`PI_CONFIG_APP`** env var, which the
hub forwards to every spoke it spawns. Real `configs/*.json` (secrets) and
`rules/*.md` (app-specific) are gitignored; only the `*.example` /
`*.md.example` templates are tracked.

A config file has three parts:

| Part | Keys | Meaning |
|------|------|---------|
| **infra** (top-level) | `token`, `host`, `stateDir`, `logsDir`, `testsDir`, `ports.hub`, `icons`, `hub.{model,thinking}`, `defaults.*` | Shared infra for this app. |
| **`target`** (app-level) | `dir`, `envTest`, `rulesFile?`, `readiness.{convexReady,metroReady,probeMetro}` | The app repo + shared test creds + app-wide spoke rules + the SHARED dev-server ready signals. Injected into every platform's spoke. |
| **`platforms`** (per-platform) | `android.{androidPackage,crashLogTag,crashSignature,resetPaths,device.{busid,serial,usbipd,profile},spokePort,model?,thinking?,rulesFile?,probeAdb,usbAttached}` | One block per platform the app runs on; the hub spawns a spoke per block it has a driver for. |

A **startup guard** (`assertTargetValid()` in `shared/config.ts`) fails loud if
`target.dir` is stale — it must contain a `justfile` + `apps/mobile`. On
relocation you change `target.dir` (and the per-platform `device` block).

### App rules (`rules/<app>.md`)

`target.rulesFile` points at a markdown playbook injected into every spoke of the
app — the operational knowledge the spoke can't derive (where creds live, reset
semantics, **app UI quirks**). Example quirk already captured for the default
app: *focusing a text field spawns a new docked field above the keyboard, so the
spoke must re-`observe` and type into the newly-appeared field.* A platform-only
`platforms.<p>.rulesFile` is injected after the app rules for that one spoke.
(Device-input rules — e.g. how a focused field is submitted — live on the
`DeviceProfile` under `spoke/profiles/`, not in the rules file.)

---

## Platforms

An app can span multiple platforms via the `platforms` map. The hub spawns one
spoke per configured platform **it has a built driver for**:

- **android** — live.
- **ios** — **reserved / TBD until a Mac mini exists.** You may add an `ios` block
  (see the `_ios` sketch in `configs/example.json.example`), but the hub logs a
  skip and spawns no spoke until the ios driver lands.
- **web** — reserved (phase 2).

---

## Usage

```bash
just hub                  # launch the hub for app "default" in THIS terminal
just hub myapp            # launch the hub for configs/myapp.json
just spawn android        # open the android spoke (app "default") in its own WSL window
just spawn android myapp  # … for app "myapp"
just spoke android        # run the android spoke in THIS terminal (debug, no new window)
just status               # which ports are alive + is the test device reachable (app "default")
just status myapp         # … for app "myapp"
just logs <name>          # tail logs/<app>/<name>.log (platform android, or a dev log e.g. convex)
just clean-state          # remove the runtime state cache
just clean                # remove state + wipe the app's logs dir
```

Every app-dependent recipe takes an optional trailing `app` arg (default
`default`). All recipes read `configs/<app>.json` via `jq`. `launch-spoke.sh
<platform>` is the single source of truth for starting a spoke; it reads
`PI_CONFIG_APP` from the environment to pick the config file, and uses the proven
`Start-Process wsl.exe` spawn.

---

## Scope

Messenger-only wire protocol (NL `intent` → `PASS`/`FAIL` `intent_result`); no
deterministic `run_test` door yet. The shared transport, per-app config (with the
relocation guard + identity validation), logging, and state are in `shared/`; the
hub + android spoke drivers in `hub/` + `spoke/`. Android is the only live
platform; web + ios follow.
