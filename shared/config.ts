// Loads the selected app config for BOTH the hub and every spoke; they must load
// the SAME file (chosen by PI_CONFIG_APP) to agree on target + platforms. node:-only
// (no pi runtime dep) so it's cheap to import via jiti from any extension.

import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type {
  AndroidDeviceConfig,
  AndroidPlatformConfig,
  AppLevelTarget,
  AppReadinessConfig,
  Config,
  HubConfig,
  IosDeviceConfig,
  IosPlatformConfig,
  PlatformConfig,
  PlatformsConfig,
  Role,
  SpokeRole,
  WebPlatformConfig,
} from "./types.ts";

const HERE = dirname(fileURLToPath(import.meta.url));

// Self-located from import.meta.url so it survives renaming/moving the project
// dir — a hardcoded path would drift.
export const PROJECT_DIR = resolve(HERE, "..");

export const CONFIGS_DIR = resolve(PROJECT_DIR, "configs");

export function getAppFromEnv(): string {
  const v = process.env.PI_CONFIG_APP;
  return typeof v === "string" && v.length > 0 ? v : "default";
}

export function getConfigPath(): string {
  return join(CONFIGS_DIR, `${getAppFromEnv()}.json`);
}

export function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return p;
}

function expandPath(p: string): string {
  const tilded = expandTilde(p);
  return isAbsolute(tilded) ? tilded : resolve(PROJECT_DIR, tilded);
}

const SPOKE_ROLES: readonly SpokeRole[] = ["android", "ios", "web"];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function parseConfig(raw: unknown, appName: string): Config {
  const where = `configs/${appName}.json`;
  if (!isObject(raw)) {
    throw new Error(`${where}: expected an object, got ${typeof raw}`);
  }
  const r = raw;

  const requireString = (key: string): string => {
    const v = r[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${where}: "${key}" must be a non-empty string`);
    }
    return v;
  };
  const str = (v: unknown, fallback: string): string =>
    typeof v === "string" && v.length > 0 ? v : fallback;
  const num = (v: unknown, fallback: number): number =>
    typeof v === "number" ? v : fallback;
  // explicit [] = no entries; missing key = fallback.
  const strArray = (v: unknown, fallback: string[]): string[] =>
    Array.isArray(v)
      ? v.filter((x): x is string => typeof x === "string" && x.length > 0)
      : fallback;
  const reqIn = (
    obj: Record<string, unknown>,
    path: string,
    key: string,
  ): string => {
    const v = obj[key];
    if (typeof v !== "string" || v.length === 0) {
      throw new Error(`${where}: "${path}.${key}" must be a non-empty string`);
    }
    return v;
  };
  const reqNumIn = (
    obj: Record<string, unknown>,
    path: string,
    key: string,
  ): number => {
    const v = obj[key];
    if (typeof v !== "number") {
      throw new Error(`${where}: "${path}.${key}" must be a number`);
    }
    return v;
  };

  const t = r.target;
  if (!isObject(t)) throw new Error(`${where}: "target" must be an object`);
  const td = expandTilde(reqIn(t, "target", "dir"));
  const rd = isObject(t.readiness) ? t.readiness : {};
  const readiness: AppReadinessConfig = {
    ...(rd as Record<string, string>),
    convexReady: str(rd.convexReady, "Convex functions ready"),
    metroReady: str(rd.metroReady, "Waiting on http://localhost:8081"),
    probeMetro: str(rd.probeMetro, "http://127.0.0.1:8081/status"),
  };
  const target: AppLevelTarget = {
    dir: td,
    envTest: expandTilde(str(t.envTest, "")),
    rulesFile: typeof t.rulesFile === "string" && t.rulesFile.length > 0
      ? t.rulesFile
      : undefined,
    readiness,
  };

  const pf = r.platforms;
  if (!isObject(pf)) {
    throw new Error(
      `${where}: "platforms" must be an object with at least one platform ` +
        `(e.g. "android"). The app's per-platform identity + device live here.`,
    );
  }
  const platforms: PlatformsConfig = {};
  if (isObject(pf.android)) platforms.android = parseAndroid(pf.android);
  if (isObject(pf.ios)) platforms.ios = parseIos(pf.ios);
  if (isObject(pf.web)) platforms.web = parseWeb(pf.web);
  if (Object.keys(platforms).length === 0) {
    throw new Error(
      `${where}: "platforms" has no recognised platform. Add an "android" block ` +
        `(ios/web are reserved).`,
    );
  }

  function parseAndroid(a: Record<string, unknown>): AndroidPlatformConfig {
    const dev = a.device;
    if (!isObject(dev)) {
      throw new Error(`${where}: "platforms.android.device" must be an object`);
    }
    const device: AndroidDeviceConfig = {
      busid: reqIn(dev, "platforms.android.device", "busid"),
      serial: reqIn(dev, "platforms.android.device", "serial"),
      usbipd: str(dev.usbipd, "usbipd.exe"),
      profile: reqIn(dev, "platforms.android.device", "profile"),
    };
    return {
      kind: "android",
      androidPackage: reqIn(a, "platforms.android", "androidPackage"),
      allowedForegroundPackages: strArray(a.allowedForegroundPackages, []),
      crashLogTag: reqIn(a, "platforms.android", "crashLogTag"),
      crashSignature: reqIn(a, "platforms.android", "crashSignature"),
      resetPaths: strArray(a.resetPaths, []),
      // Default catches the Expo dev-client launcher; harmless on non-expo apps
      // (the substring just never matches their activities).
      notReadyActivities: strArray(a.notReadyActivities, ["DevLauncherActivity"]),
      readyMarker: str(a.readyMarker, ""),
      launchUrl: str(a.launchUrl, ""),
      device,
      spokePort: reqNumIn(a, "platforms.android", "spokePort"),
      model: typeof a.model === "string" && a.model.length > 0 ? a.model : undefined,
      thinking:
        typeof a.thinking === "string" && a.thinking.length > 0
          ? a.thinking
          : undefined,
      rulesFile:
        typeof a.rulesFile === "string" && a.rulesFile.length > 0
          ? a.rulesFile
          : undefined,
      probeAdb: str(a.probeAdb, "adb -s {serial} get-state"),
      usbAttached: str(a.usbAttached, "attached"),
    };
  }

  // ios/web are RESERVED — parsed but no spoke spawns for them yet.
  function parseIos(i: Record<string, unknown>): IosPlatformConfig {
    const dev = isObject(i.device) ? i.device : {};
    const device: IosDeviceConfig = {
      udid: str(dev.udid, ""),
      profile: str(dev.profile, ""),
    };
    return {
      kind: "ios",
      iosBundleId: str(i.iosBundleId, ""),
      device,
      spokePort: num(i.spokePort, 7202),
      model: typeof i.model === "string" ? i.model : undefined,
      thinking: typeof i.thinking === "string" ? i.thinking : undefined,
      rulesFile: typeof i.rulesFile === "string" ? i.rulesFile : undefined,
    };
  }
  function parseWeb(w: Record<string, unknown>): WebPlatformConfig {
    return {
      kind: "web",
      url: typeof w.url === "string" ? w.url : undefined,
      spokePort: num(w.spokePort, 7203),
      model: typeof w.model === "string" ? w.model : undefined,
      thinking: typeof w.thinking === "string" ? w.thinking : undefined,
      rulesFile: typeof w.rulesFile === "string" ? w.rulesFile : undefined,
    };
  }

  const p = r.ports;
  if (!isObject(p) || typeof p.hub !== "number") {
    throw new Error(`${where}: "ports.hub" must be a number`);
  }
  const ports = { hub: p.hub };

  const h = isObject(r.hub) ? r.hub : {};
  const hub: HubConfig = {
    model: str(h.model, "openai-codex/gpt-5.5"),
    thinking: str(h.thinking, "high"),
  };

  const d = isObject(r.defaults) ? r.defaults : {};

  const testsDir = expandPath(str(r.testsDir, "./tests"));

  const ic = isObject(r.icons) ? r.icons : {};
  const icons: Record<string, string> = {};
  for (const [k, v] of Object.entries(ic)) {
    if (typeof v === "string" && v.length > 0) icons[k] = v;
  }

  return {
    projectDir: PROJECT_DIR,
    appName,
    token: requireString("token"),
    stateDir: expandTilde(str(r.stateDir, "~/.pi-e2e-tester")),
    wslDistro: str(r.wslDistro, "Debian"),
    logsDir: expandPath(str(r.logsDir, "./logs")),
    testsDir,
    testsCasesDir: join(testsDir, "cases"),
    testsResultsDir: join(testsDir, "results"),
    testsScreenshotsDir: join(testsDir, "screenshots"),
    host: str(r.host, "127.0.0.1"),
    icons,
    ports,
    target,
    platforms,
    hub,
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

let cached: Config | null = null;

export function loadConfig(): Config {
  if (cached) return cached;
  const appName = getAppFromEnv();
  const path = getConfigPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err) {
    throw new Error(
      `pi-e2e-tester: app config not found: ${path}\n` +
        `  PI_CONFIG_APP="${appName}" → expected configs/${appName}.json.\n` +
        `  Run \`just hub <app>\` for an existing app, or create ` +
        `configs/${appName}.json (copy configs/example.json.example).\n` +
        `  (${(err as Error).message})`,
    );
  }
  cached = parseConfig(JSON.parse(text), appName);
  return cached;
}

export function clearConfigCache(): void {
  cached = null;
}

export function getAppName(): string {
  return loadConfig().appName;
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

/** WSL distro to launch spoke windows in (single source: the app config). */
export function getWslDistro(): string {
  return loadConfig().wslDistro;
}

// Already ~-expanded + resolved. Base dir; per-app logs go under getLogsDirForApp().
export function getLogsDir(): string {
  return loadConfig().logsDir;
}

export function getLogsDirForApp(): string {
  const c = loadConfig();
  return join(c.logsDir, c.appName);
}

export function getLogFile(role: SpokeRole): string {
  return join(getLogsDirForApp(), `${role}.log`);
}

export function getTestsDirs(): {
  root: string;
  cases: string;
  results: string;
  screenshots: string;
} {
  const c = loadConfig();
  return {
    root: c.testsDir,
    cases: c.testsCasesDir,
    results: c.testsResultsDir,
    screenshots: c.testsScreenshotsDir,
  };
}

export function getHost(): string {
  return loadConfig().host;
}

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

export function getRoleIcon(role: string): string {
  const override = loadConfig().icons[role];
  if (typeof override === "string" && override.length > 0) return override;
  return DEFAULT_ICONS[role] ?? ASCII_ICONS[role] ?? role.toUpperCase();
}

export function getTarget(): AppLevelTarget {
  return loadConfig().target;
}

export function getConfiguredPlatforms(): SpokeRole[] {
  const pf = loadConfig().platforms;
  return SPOKE_ROLES.filter((r) => pf[r] !== undefined);
}

export function getPlatform(role: SpokeRole): PlatformConfig {
  const pf = loadConfig().platforms;
  const p = pf[role];
  if (!p) {
    throw new Error(
      `pi-e2e-tester: platform "${role}" is not configured in configs/${getAppName()}.json ` +
        `(configured: ${getConfiguredPlatforms().join(", ") || "none"}).`,
    );
  }
  return p;
}

export function getAndroidPlatform(): AndroidPlatformConfig {
  const p = getPlatform("android");
  if (p.kind !== "android") {
    throw new Error(`pi-e2e-tester: platform "android" is misconfigured`);
  }
  return p;
}

export function getDevice(
  role: SpokeRole,
): AndroidDeviceConfig | IosDeviceConfig {
  const p = getPlatform(role);
  if (p.kind === "web") {
    throw new Error(`pi-e2e-tester: platform "web" has no device block`);
  }
  return p.device;
}

export function getReadiness(): AppReadinessConfig {
  return loadConfig().target.readiness;
}

/**
 * So the `adb reverse` bridge and the hub's port-kill follow config, not a
 * hardcoded 8081. null when probeMetro carries no explicit port.
 */
export function getMetroPort(): number | null {
  try {
    const p = new URL(getReadiness().probeMetro).port;
    return p ? Number(p) : null;
  } catch {
    return null;
  }
}

/** empty ⇒ caller uses the pi default. */
export function getSpokeModel(role: SpokeRole): {
  model?: string;
  thinking?: string;
} {
  const p = getPlatform(role);
  return { model: p.model, thinking: p.thinking };
}

export function getHubConfig(): HubConfig {
  return loadConfig().hub;
}

export function getDefaults(): Config["defaults"] {
  return loadConfig().defaults;
}

/**
 * App rulesFile then platform rulesFile, concatenated. A SET-but-missing file
 * throws — a configured rules file that doesn't exist is a misconfig, not "no
 * rules". "" if neither is set.
 */
export function getRulesForSpoke(role: SpokeRole): string {
  const c = loadConfig();
  const parts: string[] = [];
  const read = (rel: string, label: string): void => {
    const path = expandPath(rel);
    let text: string;
    try {
      text = readFileSync(path, "utf8").trim();
    } catch (err) {
      throw new Error(
        `pi-e2e-tester: ${label} rules file not found: ${path} (config rulesFile="${rel}").\n` +
          `  Create it or remove the rulesFile key. (${(err as Error).message})`,
      );
    }
    if (text.length > 0) parts.push(text);
  };
  if (c.target.rulesFile) read(c.target.rulesFile, "app");
  const p = c.platforms[role];
  if (p?.rulesFile) read(p.rulesFile, `platform "${role}"`);
  return parts.join("\n\n");
}

// Returned port is only PREFERRED — the actual bound port may differ after
// auto-fallback; the resolved value propagates via HUB_PORT env / register.
export function getPort(role: Role): number {
  const c = loadConfig();
  if (role === "hub") return c.ports.hub;
  return getPlatform(role).spokePort;
}

export function getRoleFromEnv(): SpokeRole | undefined {
  const v = process.env.PI_ROLE;
  if (v === "android" || v === "ios" || v === "web") {
    return loadConfig().platforms[v] ? v : undefined;
  }
  return undefined;
}

/**
 * Filesystem checks parse-time validation can't do: target.dir (the key most
 * likely stale on relocation) exists AND looks like the monorepo. Call at startup
 * BEFORE any bring-up so a misconfig dies readably, not deep in an adb/just call.
 */
export function assertTargetValid(): void {
  const { dir } = loadConfig().target;
  if (!existsSync(dir)) {
    throw new Error(
      `pi-e2e-tester: target.dir does not exist: ${dir}\n` +
        `  Fix configs/${getAppName()}.json → target.dir to point at the app repo root.`,
    );
  }
  const missing: string[] = [];
  if (!existsSync(join(dir, "justfile"))) missing.push("justfile");
  if (!existsSync(join(dir, "apps", "mobile"))) missing.push("apps/mobile");
  if (missing.length > 0) {
    throw new Error(
      `pi-e2e-tester: target.dir does not look like the app monorepo: ${dir}\n` +
        `  Missing: ${missing.join(", ")}.\n` +
        `  Fix configs/${getAppName()}.json → target.dir.`,
    );
  }
}
