// hub/spokes.ts — spoke liveness/status registry, spawning, and send client.
//
// Liveness is heartbeat-based, NOT PID-based: a spoke is "connected" iff a
// heartbeat (or register) arrived within heartbeatTimeoutMs.
//
// The registry is keyed by role so an app spanning android + ios drops in
// cleanly, but only android has a BUILT spoke today (see BUILT_SPOKE_ROLES) — so
// in practice it holds one record for now.

import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  getAppName,
  getDefaults,
  getHost,
  getPort,
  getProjectDir,
  getToken,
} from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { postToSpoke } from "../shared/transport.ts";
import type { SpokeReadyState, SpokeRole, SpokeStatus } from "../shared/types.ts";

// The platforms with a built spoke. A configured platform NOT in this set
// (ios/web) is parsed + reserved but never spawned — the one place to flip ios on.
export const BUILT_SPOKE_ROLES: readonly SpokeRole[] = ["android"];

export const SPOKE_ROLE: SpokeRole = "android";

/** Mirrors the justfile — must stay in sync. */
const WSL_DISTRO = "Debian";

export interface SpokeRecord {
  role: SpokeRole;
  status: SpokeStatus;
  /** Source of truth for the colored dot + ready gate. */
  readyState: SpokeReadyState;
  /** RESOLVED port from the register message (the spoke may fall back); 0 = unknown. */
  port: number;
  /** 0 = never. */
  lastHeartbeat: number;
  /** 0 = never. */
  lastRegister: number;
  readyDetail?: string;
}

function emptyStatus(role: SpokeRole): SpokeStatus {
  return { role, connected: false, deviceReady: false };
}

function emptyRecord(role: SpokeRole): SpokeRecord {
  return {
    role,
    status: emptyStatus(role),
    readyState: "needs-device",
    port: 0,
    lastHeartbeat: 0,
    lastRegister: 0,
  };
}

export class SpokeRegistry {
  private records: Map<SpokeRole, SpokeRecord>;

  constructor(
    private log: Logger,
    roles: readonly SpokeRole[] = [SPOKE_ROLE],
  ) {
    const tracked = roles.length > 0 ? roles : [SPOKE_ROLE];
    this.records = new Map(tracked.map((r) => [r, emptyRecord(r)]));
  }

  roles(): SpokeRole[] {
    return [...this.records.keys()];
  }

  get(role: SpokeRole): SpokeRecord | undefined {
    return this.records.get(role);
  }

  /** Array-shaped for the widget renderer. */
  all(): SpokeRecord[] {
    return [...this.records.values()];
  }

  /** For a spoke role we didn't pre-register. */
  private ensure(role: SpokeRole): SpokeRecord {
    let rec = this.records.get(role);
    if (!rec) {
      rec = emptyRecord(role);
      this.records.set(role, rec);
    }
    return rec;
  }

  // Captures the spoke's RESOLVED port (it may have fallen back from its preferred
  // one) — that's where the hub POSTs every subsequent intent.
  onRegister(role: SpokeRole, port: number): void {
    const rec = this.ensure(role);
    rec.port = port;
    rec.lastRegister = Date.now();
    rec.lastHeartbeat = Date.now();
    rec.status.connected = true;
    this.log.info(`spoke registered: ${role}`, { port });
  }

  onHeartbeat(role: SpokeRole, status: SpokeStatus): void {
    const rec = this.ensure(role);
    rec.lastHeartbeat = Date.now();
    rec.status = { ...status, connected: true };
    rec.readyState = status.readyState ?? (status.deviceReady ? "ready" : "needs-device");
  }

  onStatus(role: SpokeRole, state: SpokeReadyState, detail?: string): void {
    const rec = this.ensure(role);
    rec.readyState = state;
    // device is reachable in both ready and wrong-target; absent only for needs-device/error
    rec.status.deviceReady = state === "ready" || state === "wrong-target";
    rec.readyDetail = detail;
  }

  /** Returns true if any spoke's connected state flipped (caller re-renders). */
  reapStale(): boolean {
    const timeout = getDefaults().heartbeatTimeoutMs;
    const now = Date.now();
    let flipped = false;
    for (const rec of this.records.values()) {
      const alive = rec.lastHeartbeat > 0 && now - rec.lastHeartbeat <= timeout;
      if (alive !== rec.status.connected) {
        rec.status.connected = alive;
        if (!alive) {
          rec.status.deviceReady = false;
          rec.readyState = "needs-device";
        }
        this.log.info(`spoke ${rec.role} -> ${alive ? "connected" : "disconnected"}`);
        flipped = true;
      }
    }
    return flipped;
  }

  isConnected(role: SpokeRole = SPOKE_ROLE): boolean {
    const rec = this.records.get(role);
    if (!rec) return false;
    const timeout = getDefaults().heartbeatTimeoutMs;
    return rec.lastHeartbeat > 0 && Date.now() - rec.lastHeartbeat <= timeout;
  }

  /** GREEN: heartbeating AND the dev app is foreground. */
  isReady(role: SpokeRole = SPOKE_ROLE): boolean {
    const rec = this.records.get(role);
    return !!rec && rec.status.connected && rec.readyState === "ready";
  }

  /** Resolved port, or the preferred config port if not yet known. */
  port(role: SpokeRole = SPOKE_ROLE): number {
    const rec = this.records.get(role);
    return rec && rec.port > 0 ? rec.port : getPort(role);
  }
}

// Fire-and-forget: liveness comes from the heartbeat, not this PID.
//
// launch-spoke.sh HONOURS the inherited HUB_PORT + PI_CONFIG_APP, so they MUST
// ride the wsl.exe `-e env` list: the spoke then registers back to the port the
// hub actually bound (even after an EADDRINUSE fallback) AND loads the SAME app
// config the hub is running. `<launcher> <role>` MUST be one double-quoted token
// so `bash -c` runs it as the command string.
export function spawnSpoke(role: SpokeRole, hubPort: number, log: Logger): void {
  const projectDir = getProjectDir();
  const launcher = join(projectDir, "launch-spoke.sh");
  const token = getToken();
  const app = getAppName();

  const innerArgs =
    `-d ${WSL_DISTRO} --cd ${projectDir} -e env ` +
    `HUB_PORT=${hubPort} PI_TOKEN=${token} PI_CONFIG_APP=${app} ` +
    `bash -lic "${launcher} ${role}"`;
  const psCommand = `Start-Process wsl.exe -ArgumentList '${innerArgs}'`;

  log.info(`spawning spoke ${role}`, { hubPort, app, psCommand });
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", psCommand],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", (err) => log.error(`spawn ${role} failed`, { error: String(err) }));
    child.unref();
  } catch (err) {
    log.error(`spawn ${role} threw`, { error: String(err) });
  }
}

export interface SpokeRequestResult {
  ok: boolean;
  detail: string;
}

export async function resumeSpoke(
  role: SpokeRole,
  port: number,
): Promise<SpokeRequestResult> {
  try {
    const res = await postToSpoke(
      role,
      { type: "resume", from: "hub", ts: Date.now() },
      { port },
    );
    return { ok: res.ok, detail: res.ok ? "resumed" : `spoke returned ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

/**
 * FRESH TEST START (hub /reset). 20s timeout: the spoke awaits an adb run-as rm
 * sweep + force-stop before it acks. The spoke echoes a detail string in the body.
 */
export async function resetSpoke(
  role: SpokeRole,
  port: number,
): Promise<SpokeRequestResult> {
  try {
    const res = await postToSpoke(
      role,
      { type: "reset", from: "hub", ts: Date.now() },
      { port, timeoutMs: 20000 },
    );
    const detail = (res.body as { detail?: string } | undefined)?.detail;
    return {
      ok: res.ok,
      detail: res.ok ? detail ?? "reset" : `spoke returned ${res.status}`,
    };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

/**
 * SHUTDOWN CASCADE: ask a spoke to shut down (close agent-device + WSL window)
 * before the hub tears down its own transport. Fire-and-forget — a spoke already
 * exiting may not ack cleanly, which is expected, not an error.
 */
export async function shutdownSpoke(
  role: SpokeRole,
  port: number,
  reason: string,
): Promise<void> {
  try {
    await postToSpoke(
      role,
      { type: "shutdown", from: "hub", ts: Date.now(), reason },
      { port, timeoutMs: 1500 },
    );
  } catch {
    /* spoke exiting may not ack cleanly — expected, not an error */
  }
}

/** Just to silence unused-import linters across re-exports. */
export type { SpokeReadyState, SpokeRole, SpokeStatus };
export { getHost };
