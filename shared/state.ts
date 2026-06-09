/**
 * Persisted runtime state + state/logs dir helpers. Namespaced by APP then
 * platform ROLE so testing different apps/platforms never collides. node:-only
 * (+ shared/{types,config}); no pi dependency.
 */

import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
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

export function updateRoleState(
  role: SpokeRole,
  patch: Partial<RoleState>,
): PersistedState {
  const app = getAppName();
  const state = readState();
  const appState = state[app] ?? {};
  appState[role] = { ...(appState[role] ?? emptyRoleState()), ...patch };
  state[app] = appState;
  writeState(state);
  return state;
}

export function markConnected(role: SpokeRole): PersistedState {
  return updateRoleState(role, { lastConnected: Date.now() });
}
