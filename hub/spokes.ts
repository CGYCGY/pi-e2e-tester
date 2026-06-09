/**
 * hub/spokes.ts — android spoke liveness + status registry, spawning, send client.
 *
 * The hub never touches the phone. It only:
 *   - tracks the android spoke's last-seen heartbeat + status snapshot (SpokeStatus)
 *     AND its RESOLVED transport port (learned from the `register` message),
 *   - spawns the spoke window via the PROVEN PowerShell Start-Process wsl.exe ->
 *     launch-spoke.sh pattern, passing the hub's OWN RESOLVED port through the
 *     inherited HUB_PORT spawn env (port propagation, per the spec),
 *   - POSTs intent / resume / shutdown requests to the spoke over the shared
 *     transport, using the spoke's resolved port.
 *
 * Liveness is heartbeat-based (NOT PID-based): the spoke is "connected" iff a
 * heartbeat (or register) arrived within heartbeatTimeoutMs.
 *
 * PHASE-1 NOTE: the pi-4b-tester sibling tracked TWO spokes + a chat-lock + a
 * send/wait/reply client. The expari tester is messenger-only with ONE android
 * spoke, so that whole chat surface is dropped; what remains is the registry +
 * resolved-port bookkeeping + spawn-with-HUB_PORT + intent/resume/shutdown posts.
 */

import { spawn } from "node:child_process";
import { join } from "node:path";

import {
  getDefaults,
  getHost,
  getPort,
  getProjectDir,
  getToken,
} from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { postToSpoke } from "../shared/transport.ts";
import type { SpokeRole, SpokeStatus } from "../shared/types.ts";

/** The only spoke role in phase 1 (web/ios join later). */
export const SPOKE_ROLE: SpokeRole = "android";

/** WSL distro the spoke window is spawned into (mirrors the justfile). */
const WSL_DISTRO = "Debian";

/** Live per-spoke bookkeeping kept only in memory on the hub. */
export interface SpokeRecord {
  role: SpokeRole;
  /** Last status snapshot received on a heartbeat (or synthesized). */
  status: SpokeStatus;
  /** The spoke's RESOLVED transport port (from its register message); 0 = unknown. */
  port: number;
  /** Epoch ms of the last heartbeat (0 = never). */
  lastHeartbeat: number;
  /** Epoch ms of the last register message (0 = never). */
  lastRegister: number;
  /** Last verification/readiness detail reported via StatusMessage (for the widget). */
  readyDetail?: string;
}

/** A fresh, disconnected status snapshot for the spoke. */
function emptyStatus(role: SpokeRole): SpokeStatus {
  return { role, connected: false, deviceReady: false };
}

/**
 * In-memory registry of the android spoke. Pure data + helpers; the extension
 * wires transport handlers and a liveness timer to it.
 */
export class SpokeRegistry {
  private record: SpokeRecord;

  constructor(private log: Logger) {
    this.record = {
      role: SPOKE_ROLE,
      status: emptyStatus(SPOKE_ROLE),
      port: 0,
      lastHeartbeat: 0,
      lastRegister: 0,
    };
  }

  get(): SpokeRecord {
    return this.record;
  }

  /** All records (one in phase 1) — kept array-shaped for the widget renderer. */
  all(): SpokeRecord[] {
    return [this.record];
  }

  /**
   * Record a register message. CRITICALLY this captures the spoke's RESOLVED
   * port (it may have fallen back from the configured androidSpoke port), which
   * is where the hub POSTs every subsequent intent.
   */
  onRegister(port: number): void {
    const rec = this.record;
    rec.port = port;
    rec.lastRegister = Date.now();
    rec.lastHeartbeat = Date.now();
    rec.status.connected = true;
    this.log.info(`spoke registered: ${SPOKE_ROLE}`, { port });
  }

  /** Record a heartbeat + status snapshot. */
  onHeartbeat(status: SpokeStatus): void {
    const rec = this.record;
    rec.lastHeartbeat = Date.now();
    rec.status = { ...status, connected: true };
  }

  /** Record a readiness (StatusMessage) result for the widget. */
  onStatus(deviceReady: boolean, detail?: string): void {
    const rec = this.record;
    rec.status.deviceReady = deviceReady;
    rec.readyDetail = detail;
  }

  /**
   * Re-evaluate the connected flag against the heartbeat timeout. Returns true if
   * the connected state flipped (so the caller can re-render/notify).
   */
  reapStale(): boolean {
    const timeout = getDefaults().heartbeatTimeoutMs;
    const now = Date.now();
    const rec = this.record;
    const alive = rec.lastHeartbeat > 0 && now - rec.lastHeartbeat <= timeout;
    if (alive !== rec.status.connected) {
      rec.status.connected = alive;
      if (!alive) rec.status.deviceReady = false;
      this.log.info(`spoke ${SPOKE_ROLE} -> ${alive ? "connected" : "disconnected"}`);
      return true;
    }
    return false;
  }

  /** True iff the spoke has a fresh heartbeat right now. */
  isConnected(): boolean {
    const rec = this.record;
    const timeout = getDefaults().heartbeatTimeoutMs;
    return rec.lastHeartbeat > 0 && Date.now() - rec.lastHeartbeat <= timeout;
  }

  /** The spoke's resolved port, or the preferred config port if not yet known. */
  port(): number {
    return this.record.port > 0 ? this.record.port : getPort(SPOKE_ROLE);
  }
}

/**
 * Spawn the android spoke window via the proven PowerShell -> wsl.exe ->
 * launch-spoke.sh command (docs/spawning-wsl-windows.md). Fire-and-forget —
 * liveness comes from the heartbeat, not this PID.
 *
 * PORT PROPAGATION: launch-spoke.sh HONOURS an inherited HUB_PORT env, so we pass
 * the hub's RESOLVED port (and the shared token) into the wsl.exe environment via
 * `wsl --cd <dir> -e env HUB_PORT=<port> PI_TOKEN=<token> bash -lic "<launcher>"`.
 * That way the spoke reports back to the port the hub actually bound, even after
 * an EADDRINUSE fallback.
 */
export function spawnSpoke(hubPort: number, log: Logger): void {
  const projectDir = getProjectDir();
  const launcher = join(projectDir, "launch-spoke.sh");
  const token = getToken();

  // Inner argument list passed to wsl.exe. We use `-e env KEY=VAL … bash -lic` so
  // the resolved HUB_PORT + token reach launch-spoke.sh's environment (it falls
  // back to config only when HUB_PORT is unset). launcher + role MUST be one
  // double-quoted token so `bash -c` runs it as the command string.
  const innerArgs =
    `-d ${WSL_DISTRO} --cd ${projectDir} -e env ` +
    `HUB_PORT=${hubPort} PI_TOKEN=${token} ` +
    `bash -lic "${launcher} ${SPOKE_ROLE}"`;
  const psCommand = `Start-Process wsl.exe -ArgumentList '${innerArgs}'`;

  log.info(`spawning spoke ${SPOKE_ROLE}`, { hubPort, psCommand });
  try {
    const child = spawn(
      "powershell.exe",
      ["-NoProfile", "-Command", psCommand],
      { detached: true, stdio: "ignore" },
    );
    child.on("error", (err) => log.error(`spawn ${SPOKE_ROLE} failed`, { error: String(err) }));
    child.unref();
  } catch (err) {
    log.error(`spawn ${SPOKE_ROLE} threw`, { error: String(err) });
  }
}

/** Result of a hub->spoke request attempt. */
export interface SpokeRequestResult {
  ok: boolean;
  detail: string;
}

/** POST a resume request to the spoke (re-verify readiness + continue). */
export async function resumeSpoke(port: number): Promise<SpokeRequestResult> {
  try {
    const res = await postToSpoke(
      SPOKE_ROLE,
      { type: "resume", from: "hub", ts: Date.now() },
      { port },
    );
    return { ok: res.ok, detail: res.ok ? "resumed" : `spoke returned ${res.status}` };
  } catch (err) {
    return { ok: false, detail: `unreachable: ${(err as Error).message}` };
  }
}

/**
 * SHUTDOWN CASCADE: ask the spoke to shut down (close agent-device + WSL window)
 * before the hub tears down its own transport. Fire-and-forget — a spoke already
 * exiting may not ack cleanly, which is expected, not an error.
 */
export async function shutdownSpoke(port: number, reason: string): Promise<void> {
  try {
    await postToSpoke(
      SPOKE_ROLE,
      { type: "shutdown", from: "hub", ts: Date.now(), reason },
      { port, timeoutMs: 1500 },
    );
  } catch {
    /* spoke exiting may not ack cleanly — expected, not an error */
  }
}

/** Just to silence unused-import linters across re-exports. */
export type { SpokeRole, SpokeStatus };
export { getHost };
