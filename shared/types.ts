/**
 * The SHARED CONTRACT. Pure types (no runtime code, no pi imports) so it's cheap
 * to import via jiti from any extension. Messenger-only: no send/wait/DAG/lock
 * types — the hub sends NL `intent`, the spoke answers `intent_result`.
 */

/** android is built; ios/web are reserved (one spoke per platform). */
export type Platform = "android" | "ios" | "web";

export type Role = "hub" | Platform;

export type SpokeRole = Platform;

/** Token is checked at the HTTP layer (header), NOT in this payload — see shared/transport.ts. */
export type TransportMessage =
  | RegisterMessage
  | HeartbeatMessage
  | IntentMessage
  | IntentResultMessage
  | StatusMessage
  | ResumeMessage
  | ResetMessage
  | ShutdownMessage;

export interface TransportBase {
  type: TransportMessage["type"];
  from: Role;
  /** Epoch milliseconds when sent. */
  ts: number;
}

/**
 * spoke -> hub: announce presence after start / reattach.
 *
 * Carries the spoke's OWN RESOLVED port (it may have fallen back from the
 * platform's configured spokePort if that was occupied — see shared/transport.ts).
 * This completes the port-propagation loop: hub -> spoke via the HUB_PORT spawn
 * env, spoke -> hub here.
 */
export interface RegisterMessage extends TransportBase {
  type: "register";
  from: SpokeRole;
  port: number;
  /** Best-effort liveness aid; heartbeat is canonical. */
  pid?: number;
}

export interface HeartbeatMessage extends TransportBase {
  type: "heartbeat";
  from: SpokeRole;
  // Re-asserts the spoke's RESOLVED port on every beat so a hub restart doesn't
  // revert rec.port to the preferred config port if the spoke had fallen back.
  port: number;
  status: SpokeStatus;
}

/**
 * hub -> spoke: a NATURAL-LANGUAGE instruction the spoke's own LLM interprets
 * and acts on (the `messenger` door — the spoke is a sub-agent, not a
 * deterministic executor). It answers with an IntentResultMessage of same requestId.
 */
export interface IntentMessage extends TransportBase {
  type: "intent";
  from: "hub";
  requestId: string;
  intent: string;
  timeoutMs?: number;
}

export type Verdict = "PASS" | "FAIL";

/**
 * spoke -> hub: the final outcome of an IntentMessage turn.
 *
 * `ok` and `verdict` are DIFFERENT AXES. `ok` is TRANSPORT-LEVEL (did the turn
 * complete without an internal error); `verdict` is the TEST-LEVEL PASS/FAIL the
 * spoke's guards + LLM judged. ok:true + verdict:"FAIL" is valid (the turn ran
 * fine but the device did the wrong thing).
 */
export interface IntentResultMessage extends TransportBase {
  type: "intent_result";
  from: SpokeRole;
  requestId: string;
  ok: boolean;
  verdict: Verdict;
  /** The spoke LLM's final answer text; the hub returns it (with verdict) to the user. */
  text: string;
  /** Detail when ok === false (timeout, halted, guard refusal, busy, …). */
  error?: string;
}

export type SpokeReadyState =
  | "ready" // connected AND target device reachable & on the right app
  | "needs-device" // connected but the test device is not reachable (USB detached)
  | "wrong-target" // a foreground app other than the platform's app id is up (guard)
  | "error"; // unexpected failure during verification

/** spoke -> hub: result of a readiness self-check (answer to auto-connect / resume). */
export interface StatusMessage extends TransportBase {
  type: "status";
  from: SpokeRole;
  state: SpokeReadyState;
  detail?: string;
}

/** hub -> spoke: user fixed the problem; re-verify readiness and continue. */
export interface ResumeMessage extends TransportBase {
  type: "resume";
  from: "hub";
}

/**
 * hub -> spoke: FRESH TEST START. Clear the spoke's LLM context to the post-setup
 * baseline (spoke rules re-inject every turn) AND cold-reset the dev app on the
 * device. The explicit boundary between two unrelated messenger scenarios —
 * messenger CONTINUES by default, so the user fires this only on a genuinely new test.
 */
export interface ResetMessage extends TransportBase {
  type: "reset";
  from: "hub";
}

/** hub -> spoke: hub is shutting down; spoke must shut down too (cascade). */
export interface ShutdownMessage extends TransportBase {
  type: "shutdown";
  reason?: string;
}

/**
 * Rendered in the hub's below-editor widget:
 *   [AND ●  model | ctxleft/max (x%)]
 */
export interface SpokeStatus {
  role: SpokeRole;
  /** Transport reachable (heartbeating). */
  connected: boolean;
  /** The test device is reachable (adb sees the pinned serial). */
  deviceReady: boolean;
  /**
   * Coarse readiness carried on every heartbeat so the hub renders the right dot
   * WITHOUT re-deriving it: ready=green (dev app foreground), wrong-target=amber
   * (device reachable, app not foreground), needs-device/error=red. Absent ⇒ the
   * hub falls back to deviceReady.
   */
  readyState?: SpokeReadyState;
  /** Drives the wrong-target guard view. */
  foregroundPackage?: string;
  model?: string;
  /** 0–100. */
  contextPercent?: number;
  contextTokens?: number;
  contextWindow?: number;
  /** USD. */
  cost?: number;
}

/**
 * APP-LEVEL block, shared by every platform's spoke. Holds the monorepo root, the
 * shared test-creds path, optional app-wide spoke rules, and the readiness signals
 * for the dev servers that serve ALL platforms (Convex backend + Metro bundler).
 */
export interface AppLevelTarget {
  /** Repo root: must contain justfile + apps/mobile. */
  dir: string;
  /** Shared test env file (decoupled from `dir`). */
  envTest: string;
  /**
   * OPTIONAL markdown file (relative to projectDir) injected into EVERY platform's
   * spoke prompt — the app-wide operational playbook (creds location, reset
   * semantics, app UI quirks). See getRulesForSpoke().
   */
  rulesFile?: string;
  /** Ready-signal regexes for the SHARED dev servers (start once, serve all platforms). */
  readiness: AppReadinessConfig;
}

/**
 * Ready-signal regexes the hub greps from the backgrounded SHARED dev logs, plus
 * the Metro probe backstop. Per-platform device probes live on the platform block.
 * The index signature permits forward-compatible note/signal keys.
 */
export interface AppReadinessConfig {
  /** RegExp source: backend (Convex) "functions ready" line. */
  convexReady: string;
  /** RegExp source: bundler (Metro/Expo) "waiting / ready" line. */
  metroReady: string;
  /** URL to curl for packager-status (Metro probe backstop). */
  probeMetro: string;
  [extra: string]: string;
}

/** The physical Android test device + its usbipd passthrough. */
export interface AndroidDeviceConfig {
  /** For `usbipd.exe attach --busid`. */
  busid: string;
  /** Pinned on EVERY adb / agent-device call. */
  serial: string;
  /** Binary name or absolute path. */
  usbipd: string;
  /** DeviceProfile id under spoke/profiles/ (vendor input quirks, e.g. samsung-galaxy). */
  profile: string;
}

/** An iOS test device / simulator (reserved — no spoke yet). */
export interface IosDeviceConfig {
  /** Simulator/device UDID. */
  udid: string;
  /** DeviceProfile id (reserved — no ios profiles built yet). */
  profile: string;
}

/**
 * The android platform block. `kind` is set by the loader from the `platforms`
 * map key (the JSON does not carry it) so consumers can discriminate the union.
 */
export interface AndroidPlatformConfig {
  kind: "android";
  /** Dev app id under test (guards pin to this). REQUIRED. */
  androidPackage: string;
  /** logcat tag the crash-guard watches + stamps markers under. REQUIRED. */
  crashLogTag: string;
  /** RegExp source for a crash-error log line. A generic fallback is always also applied in code. REQUIRED. */
  crashSignature: string;
  /** App-private files (relative to the package data dir) `cold-reset` removes. Empty ⇒ force-stop only. */
  resetPaths: string[];
  device: AndroidDeviceConfig;
  /** PREFERRED transport port for this platform's spoke (auto-falls back at runtime). */
  spokePort: number;
  /** OPTIONAL spoke model override; empty ⇒ pi default. */
  model?: string;
  /** OPTIONAL reasoning tier. */
  thinking?: string;
  /** OPTIONAL platform-only rules markdown (relative to projectDir), injected after the app rules. */
  rulesFile?: string;
  /** adb device-readiness probe; {serial} is substituted. */
  probeAdb: string;
  /** RegExp hint for the usbipd attach success line. */
  usbAttached: string;
}

/** The ios platform block — RESERVED. Parsed but no spoke is spawned for it yet. */
export interface IosPlatformConfig {
  kind: "ios";
  iosBundleId: string;
  device: IosDeviceConfig;
  spokePort: number;
  model?: string;
  thinking?: string;
  rulesFile?: string;
}

/** The web platform block — RESERVED. Parsed but no spoke is spawned for it yet. */
export interface WebPlatformConfig {
  kind: "web";
  url?: string;
  spokePort: number;
  model?: string;
  thinking?: string;
  rulesFile?: string;
}

export type PlatformConfig =
  | AndroidPlatformConfig
  | IosPlatformConfig
  | WebPlatformConfig;

/** The configured platforms for an app; the map key is the platform discriminator. */
export interface PlatformsConfig {
  android?: AndroidPlatformConfig;
  ios?: IosPlatformConfig;
  web?: WebPlatformConfig;
}

/** Hub orchestrator model knobs. */
export interface HubConfig {
  /** "provider/id". */
  model: string;
  /** Reasoning tier, e.g. "high". */
  thinking: string;
}

export interface Defaults {
  heartbeatIntervalMs: number;
  heartbeatTimeoutMs: number;
  /** Budget for a whole intent turn. */
  intentTimeoutMs: number;
  /** How long a freshly spawned spoke may cold-start before auto-connect gives up. */
  spokeConnectTimeoutMs: number;
  /** How long the hub waits for a dev-up ready signal (log OR probe). */
  readyTimeoutMs: number;
  /** Cadence the hub re-tails logs / re-runs probes while waiting for ready. */
  readyPollIntervalMs: number;
}

export interface Config {
  /** Self-located, see PROJECT_DIR. */
  projectDir: string;
  /** The selected app's basename (e.g. "default") — namespaces logs + state. */
  appName: string;
  token: string;
  stateDir: string;
  /** WSL distro the hub launches spoke windows in (must match the justfile). */
  wslDistro: string;
  /** Relative paths resolve against projectDir. Base dir; per-app logs go under <logsDir>/<appName>. */
  logsDir: string;
  /**
   * Project-local test workspace (the ONLY filesystem the gated LLMs touch).
   * Absolute; relative paths in config resolve against projectDir. Subpaths are
   * pre-resolved so both extensions read them without re-deriving.
   */
  testsDir: string;
  testsCasesDir: string;
  testsResultsDir: string;
  testsScreenshotsDir: string;
  /** Always 127.0.0.1 in v1. */
  host: string;
  /**
   * Per-role display glyph for the status widget, keyed by role ("android" |
   * "web" | "ios"). Default is an emoji map (🤖/🌐/🍎); override to ASCII on
   * terminals without emoji support. Resolved via getRoleIcon().
   */
  icons: Record<string, string>;
  /** Hub transport port (PREFERRED; auto-falls back). Spoke ports are per-platform. */
  ports: { hub: number };
  target: AppLevelTarget;
  platforms: PlatformsConfig;
  hub: HubConfig;
  defaults: Defaults;
}

/* ── 5. Persisted runtime state (shared/state.ts; ~/.pi-e2e-tester/state.json) ── */

export interface RoleState {
  /** Epoch ms of the last successful connect/verify. */
  lastConnected: number | null;
}

/** One app's per-platform state. */
export type AppState = Partial<Record<SpokeRole, RoleState>>;

/** Persisted state, namespaced by app name then platform role. */
export type PersistedState = Record<string, AppState>;
