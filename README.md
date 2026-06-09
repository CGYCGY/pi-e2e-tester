# pi-e2e-tester

A standalone **agentic end-to-end tester** for the
[expari](https://github.com/) monorepo (web / android / ios), built on
[pi](https://pi.dev) (the minimal terminal coding agent by Earendil Inc. / Mario
Zechner). You chat test intent to a **hub**; the hub brings expari up and drives
a device **spoke** that automates the real Android phone, then returns a
**PASS/FAIL** verdict.

It will eventually replace expari's Maestro (mobile) + Playwright (web) suites.
Build order is **android → web → ios**; this repo is **phase 1 (foundation)** —
the shared transport, config, and launch scaffolding. The hub and spoke drivers
land in later phases.

The tester drives expari **only** through its public `just` recipes + `adb` +
`agent-device`. The **expari repo stays untouched**: the tester backgrounds
expari's *plain* dev recipes into its own `logs/` and owns their lifecycle.

---

## Architecture at a glance

Two independent interactive `pi` sessions, each in its own terminal window:

| Window | Role | Preferred port | Extension | Job |
|--------|------|----------------|-----------|-----|
| **HUB** | hub | 7200 | `hub/index.ts` (phase 2) | Orchestrator. Brings expari up (`usbipd` attach + `convex`/`metro` dev, backgrounded into `logs/`), waits for the real ready signal, spawns the spoke, then issues test intents. |
| **ANDROID** | android | 7201 | `spoke/index.ts` (phase 2) | Drives the real phone via `agent-device` (adb fallback). Interprets each NL intent, acts, and returns a `PASS`/`FAIL` verdict. |

Each session runs a `node:http` server on `127.0.0.1` and POSTs JSON to the
other, every request carrying a shared token. Ports are **preferred** values —
the transport auto-falls-back to the next free port and the resolved value
propagates (`HUB_PORT` spawn env hub→spoke, `register{port}` message spoke→hub).

**Auto-readiness, not spawned-out terminals:** bring-up is `-bg` + logfiles in
`logs/`, which give BOTH visibility (read the file) AND readiness (the hub tails
for the real ready signal, with `adb devices` / `curl :8081/status` probe
backstops). **You never signal ready.**

---

## Prerequisites

| Tool | Why | Check |
|------|-----|-------|
| **pi** ≥ 0.78 | the agent runtime | `pi --version` |
| **agent-device** | drives the phone | `agent-device --version` |
| **adb** | device fallback + probes | `adb version` |
| **just** | the recipe runner | `just --version` |
| **bun** (or node ≥ 22) | installs deps | `bun --version` |
| **jq** | shell scripts read `config.json` | `jq --version` |
| **usbipd-win** | USB passthrough of the phone into WSL | `usbipd.exe --version` |
| **WSL Debian** + **PowerShell interop** | spawning the visible spoke window | `powershell.exe -NoProfile -Command "echo ok"` |

The test device (`R5CNC180FKY`, Galaxy S21 Ultra) must be attached via usbipd
with the dev app (`com.expari.app.dev`) installed + logged in.

Install deps once: `bun install`.

`pi` is loaded with `--no-extensions -e <extension>` so **only** the hub/spoke
extension is active.

---

## Configuration

Everything flows from **`config.json`** — there are no hard-coded
paths/ports/tokens anywhere else. On relocation you change **one key**:
`target.dir` (the expari repo root). A **startup guard**
(`assertTargetValid()` in `shared/config.ts`) fails loud if `target.dir` is stale
— it must contain a `justfile` + `apps/mobile`.

| Key | Meaning |
|-----|---------|
| `target.dir` | expari repo root (the ONLY relocation key). |
| `target.envTest` | absolute path to `apps/mobile/.env.test`. |
| `target.androidPackage` | dev app id the guards pin to. |
| `device.{busid,serial,usbipd}` | the phone + its usbipd passthrough. |
| `ports.{hub,androidSpoke}` | preferred ports (auto-fallback at runtime). |
| `readiness.*` | ready-signal regexes + probe backstops (overridable seeds). |
| `token`, `stateDir`, `logsDir`, `hub`, `android`, `defaults` | the rest. |

---

## Usage

```bash
just hub            # launch the hub orchestrator in THIS terminal (phase 2)
just spawn android  # open the android spoke in its OWN visible WSL window
just spoke android  # run the android spoke in THIS terminal (debug, no new window)
just status         # which ports are alive + is the test device reachable
just logs <name>    # tail logs/<name>.log (role hub|android, or a dev log e.g. convex-dev)
just clean-state    # remove state.json
just clean          # remove state.json + wipe logs
```

All recipes read `config.json` via `jq`. `launch-spoke.sh <role>` is the single
source of truth for starting a spoke; the spawn mechanism (proven
`Start-Process wsl.exe`) is documented in
[docs/spawning-wsl-windows.md](./docs/spawning-wsl-windows.md).

> **Phase 1 note:** `just hub` / `just spawn` will report that `hub/index.ts` /
> `spoke/index.ts` don't exist yet — those drivers are phase 2. The transport,
> config, types, logging, and launch scaffolding are complete and typecheck
> clean (`bun run typecheck`).

---

## Scope (phase 1)

Foundation only: `shared/` transport + types + config (with the relocation guard)
+ logging + state, `config.json`, the `justfile`, `launch-spoke.sh`, and empty
`hub/` + `spoke/` homes. Messenger-only wire protocol (NL `intent` → `PASS`/`FAIL`
`intent_result`); no deterministic `run_test` door yet. Android only; web + ios
follow.
