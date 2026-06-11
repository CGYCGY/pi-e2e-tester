/**
 * Persisted runtime state + state/logs dir helpers. Namespaced by APP then
 * platform ROLE so testing different apps/platforms never collides. node:-only
 * (+ shared/{types,config}); no pi dependency.
 */

import {
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getAppName, getLogsDirForApp, getStateDir } from "./config.ts";
import type {
  AppState,
  PersistedState,
  RoleState,
  SpokeRole,
} from "./types.ts";

function emptyRoleState(): RoleState {
  return { lastConnected: null };
}

export function emptyState(): PersistedState {
  return {};
}

export function getStatePath(): string {
  return join(getStateDir(), "state.json");
}

export function ensureStateDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

export function ensureLogsDir(): void {
  const dir = getLogsDirForApp();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

function coerceRoleState(v: unknown): RoleState {
  if (typeof v !== "object" || v === null) return emptyRoleState();
  const o = v as Record<string, unknown>;
  const lastConnected =
    typeof o.lastConnected === "number" ? o.lastConnected : null;
  return { lastConnected };
}

function coerceAppState(v: unknown): AppState {
  const out: AppState = {};
  if (typeof v !== "object" || v === null) return out;
  for (const [role, rs] of Object.entries(v as Record<string, unknown>)) {
    if (role === "android" || role === "ios" || role === "web") {
      out[role] = coerceRoleState(rs);
    }
  }
  return out;
}

/** Empty state if the file is missing/unparseable — never throws on a fresh machine. */
export function readState(): PersistedState {
  const path = getStatePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    const out: PersistedState = {};
    for (const [app, appState] of Object.entries(raw)) {
      out[app] = coerceAppState(appState);
    }
    return out;
  } catch {
    return emptyState();
  }
}

/** Atomic (temp + rename) so a crash can't leave a half-written state.json. */
export function writeState(state: PersistedState): void {
  ensureStateDir();
  const path = getStatePath();
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

export function getRoleState(role: SpokeRole): RoleState {
  const app = readState()[getAppName()];
  return app?.[role] ?? emptyRoleState();
}

// Cross-process mutex for the read-modify-write below. Hub + spoke share one
// state.json; without this, two near-simultaneous read→merge→rename cycles let
// the later writer's stale snapshot clobber the other's write. openSync("wx") is
// an atomic create-if-absent; a lock older than STALE_LOCK_MS is presumed
// orphaned by a crashed writer and stolen. Best-effort: after LOCK_TIMEOUT_MS we
// proceed unlocked rather than wedge a caller (a rare lost write beats a hang).
const STALE_LOCK_MS = 5000;
const LOCK_TIMEOUT_MS = 2000;

function sleepSync(ms: number): void {
  // Synchronous, non-spinning sleep — updateRoleState callers are sync.
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function withStateLock<T>(fn: () => T): T {
  ensureStateDir();
  const lockPath = `${getStatePath()}.lock`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  let fd: number | undefined;
  for (;;) {
    try {
      fd = openSync(lockPath, "wx");
      break;
    } catch {
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > STALE_LOCK_MS) {
          unlinkSync(lockPath);
          continue;
        }
      } catch {
        continue; // lock vanished between open and stat — retry immediately
      }
      if (Date.now() >= deadline) break; // give up locking; proceed best-effort
      sleepSync(25);
    }
  }
  try {
    return fn();
  } finally {
    if (fd !== undefined) {
      closeSync(fd);
      try {
        unlinkSync(lockPath);
      } catch {
        /* already stolen as stale — fine */
      }
    }
  }
}

export function updateRoleState(
  role: SpokeRole,
  patch: Partial<RoleState>,
): PersistedState {
  return withStateLock(() => {
    const app = getAppName();
    const state = readState();
    const appState = state[app] ?? {};
    appState[role] = { ...(appState[role] ?? emptyRoleState()), ...patch };
    state[app] = appState;
    writeState(state);
    return state;
  });
}

export function markConnected(role: SpokeRole): PersistedState {
  return updateRoleState(role, { lastConnected: Date.now() });
}
