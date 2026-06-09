/**
 * shared/types.ts — the SHARED CONTRACT for pi-e2e-tester.
 *
 * Pure TypeScript types (no runtime code, no pi-package imports) so this module
 * is cheap to import from any extension via a relative .ts import (jiti).
 *
 * Phase 1 is MESSENGER-ONLY: the chat-/DAG-specific types from the pi-4b-tester
 * sibling (send/wait/reply/incoming/mismatch, expectations, TaskPlan, lock state)
 * are intentionally ABSENT — they're not missing by mistake. The hub expresses NL
 * `intent`; the spoke's own LLM interprets it and answers with an `intent_result`.
 */

/* ── 1. Roles ── */

/**
 * Phase 1 is hub + android only; web/ios join later (build order android -> web
 * -> ios) and only need to be added here + in config.
 */
export type Role = "hub" | "android";

export type SpokeRole = "android";

/* ── 2. Transport message union (the wire protocol) ── */

/**
 * Every message carries `from` (sender role) and `ts` (epoch ms). The shared
 * token is sent/checked at the HTTP layer (header), NOT inside this payload —
 * see shared/transport.ts.
 */
export type TransportMessage =
  | RegisterMessage
  | HeartbeatMessage
  | IntentMessage
  | IntentResultMessage
  | StatusMessage
  | ResumeMessage
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
 * configured androidSpoke port if that was occupied — see shared/transport.ts).
 * This completes the port-propagation loop: hub -> spoke via the HUB_PORT spawn
 * env, spoke -> hub here.
 */
export interface RegisterMessage extends TransportBase {
  type: "register";
  from: SpokeRole;
  /** The RESOLVED port the spoke's own HTTP server is actually listening on. */
  port: number;
  /** Best-effort liveness aid; heartbeat is canonical. */
  pid?: number;
}

export interface HeartbeatMessage extends TransportBase {
  type: "heartbeat";
  from: SpokeRole;
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
  /** Override the default intent timeout for the whole spoke turn. */
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
  | "wrong-target" // a foreground app other than target.androidPackage is up (guard)
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

/** hub -> spoke: hub is shutting down; spoke must shut down too (cascade). */
export interface ShutdownMessage extends TransportBase {
  type: "shutdown";
  reason?: string;
}

/* ── 3. Spoke status (carried on heartbeats; rendered in the hub widget) ── */

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

/* ── 4. Config shape (mirror of config.json; ~ expanded by shared/config.ts) ── */

/** The expari monorepo under test (the ONLY thing that changes on relocation). */
export interface TargetConfig {
  /** Repo root: must contain justfile + apps/mobile. */
  dir: string;
  /** Mobile test env file (decoupled from `dir`). */
  envTest: string;
  /** Dev app id under test (guards pin to this). */
  androidPackage: string;
  /** logcat tag the crash-guard watches and stamps markers under. RN default: ReactNativeJS. */
  crashLogTag: string;
  /** RegExp source (case-insensitive) for a crash-error log line. A generic error-phrasing fallback is always also applied in code. */
  crashSignature: string;
  /** App-private files (relative to the package data dir) `cold-reset` `run-as rm`s to force a signed-out first run. Empty ⇒ cold-reset is force-stop only. */
  resetPaths: string[];
  /** App/auth playbook injected into the spoke prompt (creds location, reset semantics). Device-submit rule lives on the DeviceProfile, not here. */
  spokeHints: string;
}

/** The physical Android test device + its usbipd passthrough. */
export interface DeviceConfig {
  /** For `usbipd.exe attach --busid`. */
  busid: string;
  /** Pinned on EVERY adb / agent-device call. */
  serial: string;
  /** Binary name or absolute path. */
  usbipd: string;
  /** DeviceProfile id under spoke/profiles/ (vendor input quirks, e.g. auth-field submit), e.g. samsung-galaxy. */
  profile: string;
}

/**
 * PREFERRED ports — both auto-fall back to the next free port if occupied (see
 * shared/transport.ts); resolved values propagate at runtime (HUB_PORT spawn env
 * + register message).
 */
export interface PortsConfig {
  hub: number;
  androidSpoke: number;
}

export interface HubConfig {
  /** "provider/id". */
  model: string;
  /** Reasoning tier, e.g. "high". */
  thinking: string;
}

export interface AndroidConfig {
  /** "provider/id". */
  model: string;
  /** Reasoning tier, e.g. "medium". */
  thinking: string;
}

/**
 * Ready-signal regexes the hub greps out of the backgrounded expari dev logs,
 * plus probe backstops. Values are best-known seeds carrying `_*_note` // VERIFY
 * comments in config.json; tune freely. The index signature permits those
 * forward-compatible note/signal keys.
 */
export interface ReadinessConfig {
  /** RegExp source: `just convex-dev` "functions ready" line. */
  convexReady: string;
  /** RegExp source: `just mobile-dev` (Metro/Expo) "waiting / ready" line. */
  metroReady: string;
  /** RegExp source: `usbipd.exe attach` success line (hint only). */
  usbAttached: string;
  /** adb command; {serial} is substituted. */
  probeAdb: string;
  /** URL to curl for packager-status. */
  probeMetro: string;
  [extra: string]: string;
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
  token: string;
  stateDir: string;
  /** Relative paths resolve against projectDir. */
  logsDir: string;
  /** Always 127.0.0.1 in v1. */
  host: string;
  target: TargetConfig;
  device: DeviceConfig;
  ports: PortsConfig;
  hub: HubConfig;
  android: AndroidConfig;
  readiness: ReadinessConfig;
  defaults: Defaults;
}

/* ── 5. Persisted runtime state (shared/state.ts; ~/.pi-e2e-tester/state.json) ── */

export interface RoleState {
  /** Epoch ms of the last successful connect/verify. */
  lastConnected: number | null;
}

export interface PersistedState {
  android: RoleState;
}
