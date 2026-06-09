/**
 * shared/state.ts — persisted runtime state + state/logs dir helpers.
 *
 * PHASE 1 NOTE: pi-4b-tester's state.ts was almost entirely chat LOCK state
 * (per-role LockState for restoring the locked chat across restarts). The
 * messenger-only android tester has NO lock concept yet — it pins a device serial
 * from config, not a chat — so that whole surface is DROPPED. What remains and is
 * genuinely needed:
 *   - ensureStateDir() / ensureLogsDir(): dir creation that log.ts + writers rely on
 *   - a lean per-role `lastConnected` PersistedState for auto-connect bookkeeping
 *
 * Stored at ~/.pi-e2e-tester/state.json. Writes are atomic-ish: write to a temp
 * file then rename. Dirs are created on demand. Uses only node: built-ins +
 * shared/{types,config}. No pi runtime dependency.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";

import { getLogsDir, getStateDir } from "./config.ts";
import type { PersistedState, RoleState, SpokeRole } from "./types.ts";

/** A fresh, empty per-role state. */
function emptyRoleState(): RoleState {
  return { lastConnected: null };
}

/** A fresh, empty persisted state. */
export function emptyState(): PersistedState {
  return { android: emptyRoleState() };
}

/** Absolute path to state.json (under the configured state dir). */
export function getStatePath(): string {
  return join(getStateDir(), "state.json");
}

/** Ensure the state directory exists. */
export function ensureStateDir(): void {
  const dir = getStateDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Ensure the logs directory exists (logsDir is decoupled from stateDir). */
export function ensureLogsDir(): void {
  const dir = getLogsDir();
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
}

/** Coerce an unknown parsed object into a valid RoleState. */
function coerceRoleState(v: unknown): RoleState {
  if (typeof v !== "object" || v === null) return emptyRoleState();
  const o = v as Record<string, unknown>;
  const lastConnected =
    typeof o.lastConnected === "number" ? o.lastConnected : null;
  return { lastConnected };
}

/**
 * Read the persisted state. Returns empty state if the file is missing or
 * unparseable (never throws on a fresh machine).
 */
export function readState(): PersistedState {
  const path = getStatePath();
  if (!existsSync(path)) return emptyState();
  try {
    const raw = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>;
    return {
      android: coerceRoleState(raw.android),
    };
  } catch {
    return emptyState();
  }
}

/** Atomically write the full persisted state. */
export function writeState(state: PersistedState): void {
  ensureStateDir();
  const path = getStatePath();
  const tmp = `${path}.tmp.${process.pid}.${Date.now()}`;
  writeFileSync(tmp, JSON.stringify(state, null, 2), "utf8");
  renameSync(tmp, path);
}

/** Read just one role's state. */
export function getRoleState(role: SpokeRole): RoleState {
  return readState()[role];
}

/**
 * Update one role's state via a partial patch, persisting the result.
 * Returns the updated full state.
 */
export function updateRoleState(
  role: SpokeRole,
  patch: Partial<RoleState>,
): PersistedState {
  const state = readState();
  state[role] = { ...state[role], ...patch };
  writeState(state);
  return state;
}

/** Convenience: stamp a role's lastConnected = now. */
export function markConnected(role: SpokeRole): PersistedState {
  return updateRoleState(role, { lastConnected: Date.now() });
}
