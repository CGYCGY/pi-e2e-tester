// shared/config.ts — load, parse, and tilde-expand config.json (the single
// source of truth). Importable from any extension via a relative .ts import
// (jiti); uses only node: built-ins, no pi runtime dependency.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AndroidConfig,
  Config,
  DeviceConfig,
  HubConfig,
  PortsConfig,
  ReadinessConfig,
  Role,
  TargetConfig,
} from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// Self-located from this module's own path (shared/ lives directly under the
// root), so it survives renaming/moving the project dir — can't drift like a
// hardcoded path would.
export const PROJECT_DIR = resolve(HERE, "..");

export const CONFIG_PATH = resolve(PROJECT_DIR, "config.json");

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

// Expand "~", then resolve a relative path against PROJECT_DIR (e.g. logsDir
// defaults to "./logs").
function expandPath(p: string): string {
  const tilded = expandTilde(p);
  return isAbsolute(tilded) ? tilded : resolve(PROJECT_DIR, tilded);
}

function parseConfig(raw: unknown): Config {
  if (typeof raw !== "object" || raw === null) {
    throw new Error(`config.json: expected an object, got ${typeof raw}`);
  }
  const r = raw as Record<string, unknown>;

  const requireString = (key: string): string => {
    const v = r[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`config.json: "${key}" must be a non-empty string`);
    }
    return v;
  };

  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" ? v : fallback;
  // A missing key keeps the fallback (expari defaults); an explicit [] is
  // honoured as "no paths" — force-stop only.
  const strArray = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : fallback;

  const t = r.target as Record<string, unknown> | undefined;
  if (!t || typeof t !== "object") {
    throw new Error(`config.json: "target" must be an object`);
  }
  if (typeof t.dir !== "string" || t.dir.length === 0) {
    throw new Error(`config.json: "target.dir" must be a non-empty string`);
  }
  const target: TargetConfig = {
    dir: expandTilde(t.dir),
    envTest: expandTilde(str(t.envTest, "")),
    androidPackage: str(t.androidPackage, "com.expari.app.dev"),
    crashLogTag: str(t.crashLogTag, "ReactNativeJS"),
    crashSignature: str(
      t.crashSignature,
      "(^|\\s)E[\\/\\s]ReactNativeJS|\\bE ReactNativeJS\\b",
    ),
    resetPaths: strArray(t.resetPaths, [
      "shared_prefs/SecureStore.xml",
      "files/mmkv/mobile-template",
      "files/mmkv/mobile-template.crc",
    ]),
    spokeHints: str(
      t.spokeHints,
      "Auth: the WorkOS AuthKit test creds are in the file at the PI env path " +
        "`envTest` (read it with your read tool when you need to sign in). Use the " +
        "app verb's cold-reset to get a true signed-out first run before testing " +
        "the sign-in flow.",
    ),
  };

  const dv = r.device as Record<string, unknown> | undefined;
  if (!dv || typeof dv !== "object") {
    throw new Error(`config.json: "device" must be an object`);
  }
  const device: DeviceConfig = {
    busid: requireDeviceString(dv, "busid"),
    serial: requireDeviceString(dv, "serial"),
    usbipd: str(dv.usbipd, "usbipd.exe"),
    profile: str(dv.profile, "samsung-galaxy"),
  };

  // Preferred ports only — transport auto-falls back at runtime (see getPort).
  const p = r.ports as Record<string, unknown> | undefined;
  if (!p || typeof p.hub !== "number" || typeof p.androidSpoke !== "number") {
    throw new Error(
      `config.json: "ports.hub" and "ports.androidSpoke" must be numbers`,
    );
  }
  const ports: PortsConfig = { hub: p.hub, androidSpoke: p.androidSpoke };

  const h = (r.hub ?? {}) as Record<string, unknown>;
  const hub: HubConfig = {
    model: str(h.model, "openai-codex/gpt-5.5"),
    thinking: str(h.thinking, "high"),
  };
  const a = (r.android ?? {}) as Record<string, unknown>;
  const android: AndroidConfig = {
    model: str(a.model, "openai-codex/gpt-5.5"),
    thinking: str(a.thinking, "medium"),
  };

  // Spread passes through extra readiness keys; the listed ones get defaults.
  const rd = (r.readiness ?? {}) as Record<string, unknown>;
  const readiness: ReadinessConfig = {
    ...(rd as Record<string, string>),
    convexReady: str(rd.convexReady, "Convex functions ready"),
    metroReady: str(rd.metroReady, "Waiting on http://localhost:8081"),
    usbAttached: str(rd.usbAttached, "attached"),
    probeAdb: str(rd.probeAdb, "adb -s {serial} get-state"),
    probeMetro: str(rd.probeMetro, "http://127.0.0.1:8081/status"),
  };

  const d = (r.defaults ?? {}) as Record<string, unknown>;

  // Per-role display glyphs; keep only non-empty string values (an empty/absent
  // key falls back to the emoji/ASCII defaults in getRoleIcon).
  const ic = (r.icons ?? {}) as Record<string, unknown>;
  const icons: Record<string, string> = {};
  for (const [k, v] of Object.entries(ic)) {
    if (typeof v === "string" && v.length > 0) icons[k] = v;
  }

  return {
    projectDir: PROJECT_DIR,
    token: requireString("token"),
    stateDir: expandTilde(str(r.stateDir, "~/.pi-e2e-tester")),
    logsDir: expandPath(str(r.logsDir, "./logs")),
    host: str(r.host, "127.0.0.1"),
    icons,
    target,
    device,
    ports,
    hub,
    android,
    readiness,
    defaults: {
      heartbeatIntervalMs: num(d.heartbeatIntervalMs, 5000),
      heartbeatTimeoutMs: num(d.heartbeatTimeoutMs, 15000),
      intentTimeoutMs: num(d.intentTimeoutMs, 180000),
      spokeConnectTimeoutMs: num(d.spokeConnectTimeoutMs, 120000),
      readyTimeoutMs: num(d.readyTimeoutMs, 180000),
      readyPollIntervalMs: num(d.readyPollIntervalMs, 2000),
    },
  };
}

function requireDeviceString(
  dv: Record<string, unknown>,
  key: string,
): string {
  const v = dv[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`config.json: "device.${key}" must be a non-empty string`);
  }
  return v;
}

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  let text: string;
  try {
    text = readFileSync(CONFIG_PATH, "utf8");
  } catch (err) {
    throw new Error(
      `config.json not found at ${CONFIG_PATH}: ${(err as Error).message}`,
    );
  }
  cached = parseConfig(JSON.parse(text));
  return cached;
}

// Force a re-read on next access (tests / after edits).
export function clearConfigCache(): void {
  cached = null;
}

// Startup guard. target.dir is the one key meant to change on relocation, so a
// stale value is the #1 footgun — assert it looks like the expari monorepo
// (justfile + apps/mobile). Call at hub/spoke startup BEFORE any bring-up, so a
// misconfig dies with a readable message instead of failing deep in an adb/just
// call.
export function assertTargetValid(): void {
  const { dir } = loadConfig().target;
  if (!existsSync(dir)) {
    throw new Error(
      `pi-e2e-tester: target.dir does not exist: ${dir}\n` +
        `  Fix config.json -> target.dir to point at the expari repo root ` +
        `(the ONLY key you change on relocation).`,
    );
  }
  const missing: string[] = [];
  if (!existsSync(join(dir, "justfile"))) missing.push("justfile");
  if (!existsSync(join(dir, "apps", "mobile"))) missing.push("apps/mobile");
  if (missing.length > 0) {
    throw new Error(
      `pi-e2e-tester: target.dir is set but does not look like the expari ` +
        `monorepo: ${dir}\n` +
        `  Missing: ${missing.join(", ")}.\n` +
        `  Fix config.json -> target.dir to point at the expari repo root.`,
    );
  }
}

export function getToken(): string {
  return loadConfig().token;
}

export function getProjectDir(): string {
  return PROJECT_DIR;
}

// ~ expanded.
export function getStateDir(): string {
  return loadConfig().stateDir;
}

// ~ expanded; relative resolved against projectDir.
export function getLogsDir(): string {
  return loadConfig().logsDir;
}

export function getHost(): string {
  return loadConfig().host;
}

// Default per-role display glyphs. Emoji is the out-of-the-box look; a terminal
// without emoji/Nerd-Font support can override any role to ASCII in config.json
// (icons.<role> = "AND"/"WEB"/"IOS").
const DEFAULT_ICONS: Record<string, string> = {
  android: "🤖",
  web: "🌐",
  ios: "🍎",
};
const ASCII_ICONS: Record<string, string> = {
  android: "AND",
  web: "WEB",
  ios: "IOS",
};

// The display glyph for a spoke role: config override → emoji default → ASCII
// default → upper-cased role. Used by both the hub widget and the spoke status line.
export function getRoleIcon(role: string): string {
  const override = loadConfig().icons[role];
  if (typeof override === "string" && override.length > 0) return override;
  return DEFAULT_ICONS[role] ?? ASCII_ICONS[role] ?? role.toUpperCase();
}

export function getTarget(): TargetConfig {
  return loadConfig().target;
}

export function getDevice(): DeviceConfig {
  return loadConfig().device;
}

export function getReadiness(): ReadinessConfig {
  return loadConfig().readiness;
}

export function getDefaults(): Config["defaults"] {
  return loadConfig().defaults;
}

export function getHubConfig(): HubConfig {
  return loadConfig().hub;
}

export function getAndroidConfig(): AndroidConfig {
  return loadConfig().android;
}

// Returned port is only PREFERRED — the actual bound port may differ after
// auto-fallback; the resolved value propagates via HUB_PORT env / register.
export function getPort(role: Role): number {
  const cfg = loadConfig();
  return role === "hub" ? cfg.ports.hub : cfg.ports.androidSpoke;
}

// undefined if unset/invalid; callers decide the default.
export function getRoleFromEnv(): Role | undefined {
  const v = process.env.PI_ROLE;
  if (v === "hub" || v === "android") return v;
  return undefined;
}
