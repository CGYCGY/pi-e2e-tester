/**
 * Per-run append logger. logsDir is shared with the hub's backgrounded dev
 * recipes (convex/metro) so role logs + dev logs sit under one dir the hub can
 * tail. Console echo defaults OFF because pi owns the TUI. node:-only; no pi dep.
 *
 * Each process archives the PREVIOUS run's role log to <logsDir>/<app>/history/
 * at startup (rotateOnce), then appends fresh — so hub.log/android.log only ever
 * hold the CURRENT run. This keeps them small for anyone (esp. an LLM) reading
 * the log to inspect a single run, without losing history. Unlike the recipe
 * logs (truncated in-place because waitForReady scans them), role logs are an
 * audit journal, so old runs are kept in history/ rather than discarded.
 */

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  renameSync,
  statSync,
  unlinkSync,
} from "node:fs";
import { join } from "node:path";

import { getLogsDirForApp } from "./config.ts";
import { ensureLogsDir } from "./state.ts";
import type { Role } from "./types.ts";

// How many archived runs to keep per role under history/ before pruning oldest.
const HISTORY_KEEP = 20;

// Paths already rotated this process. The spoke calls createLogger twice for the
// same role (resolveRole), so we MUST rotate only on the first open — a second
// rotation would archive away the fresh lines the first call just wrote.
const ROTATED = new Set<string>();

/**
 * Archive a non-empty existing role log under <dir>/history/ and reset it to
 * clean. Best-effort: rotation must never crash boot, so any failure is swallowed
 * and this run just appends to the old file. Pure in `dir` (takes the app logs
 * dir, doesn't read config) so it's unit-testable against a temp dir.
 */
export function rotateRoleLog(dir: string, role: Role): void {
  try {
    const path = join(dir, `${role}.log`);
    if (!existsSync(path) || statSync(path).size === 0) return;
    const historyDir = join(dir, "history");
    mkdirSync(historyDir, { recursive: true });
    // Name by the file's mtime = when the previous run last wrote (more useful
    // than "now"). Colons are illegal in filenames on some FSes; swap for "-".
    const stamp = statSync(path).mtime.toISOString().replace(/:/g, "-");
    renameSync(path, join(historyDir, `${role}-${stamp}.log`));
    pruneHistory(historyDir, role);
  } catch {
    // Swallow: a failed rotation just means this run appends to the old file.
  }
}

/**
 * rotateRoleLog, but only the FIRST time this process opens a given path. Done at
 * STARTUP (not shutdown) so a crashed or killed previous run still gets archived
 * on the next boot.
 */
function rotateOnce(role: Role, path: string): void {
  if (ROTATED.has(path)) return;
  ROTATED.add(path);
  rotateRoleLog(getLogsDirForApp(), role);
}

function pruneHistory(historyDir: string, role: Role): void {
  try {
    const prefix = `${role}-`;
    // ISO timestamps sort lexicographically == chronologically (oldest first).
    const archived = readdirSync(historyDir)
      .filter((f) => f.startsWith(prefix) && f.endsWith(".log"))
      .sort();
    for (const f of archived.slice(0, -HISTORY_KEEP)) {
      unlinkSync(join(historyDir, f));
    }
  } catch {
    // Best-effort prune; leaving extra archives is harmless.
  }
}

export type LogLevel = "debug" | "info" | "warn" | "error";

export interface Logger {
  path: string;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  log: (level: LogLevel, message: string, data?: unknown) => void;
}

function stamp(): string {
  return new Date().toISOString();
}

function fmtData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " " + String(data);
  }
}

export function getLogPath(role: Role): string {
  return join(getLogsDirForApp(), `${role}.log`);
}

/**
 * Writes are synchronous appends (small, infrequent lines), so they're safe from
 * timers and handlers. opts.echo also writes to stderr — use only OUTSIDE the pi
 * TUI (e.g. a standalone script).
 */
export function createLogger(
  role: Role,
  opts: { echo?: boolean } = {},
): Logger {
  ensureLogsDir();
  const path = getLogPath(role);
  rotateOnce(role, path); // archive the prior run's log so this run starts clean
  const echo = opts.echo ?? false;

  const write = (level: LogLevel, message: string, data?: unknown): void => {
    const line = `${stamp()} [${role}] ${level.toUpperCase()} ${message}${fmtData(data)}\n`;
    try {
      appendFileSync(path, line, "utf8");
    } catch {
      // Logging must never crash the caller; swallow write failures.
    }
    if (echo) {
      // eslint-disable-next-line no-console
      console.error(line.trimEnd());
    }
  };

  return {
    path,
    log: write,
    debug: (m, d) => write("debug", m, d),
    info: (m, d) => write("info", m, d),
    warn: (m, d) => write("warn", m, d),
    error: (m, d) => write("error", m, d),
  };
}

/** One-off stderr echo (no Logger) — stderr so it can't corrupt stdout protocols. */
export function echo(role: Role, level: LogLevel, message: string): void {
  // eslint-disable-next-line no-console
  console.error(`${stamp()} [${role}] ${level.toUpperCase()} ${message}`);
}
