/**
 * shared/log.ts — simple append-only file logger.
 *
 * Each role writes timestamped lines to <logsDir>/<role>.log (logsDir defaults to
 * ./logs in config.json). Use createLogger(role) once and call
 * .info/.warn/.error/.debug. An optional console echo is provided for foreground
 * debugging (off by default since pi owns the TUI).
 *
 * NOTE: logsDir is also where the hub backgrounds expari's dev recipes (convex /
 * metro) so it can tail them for the real ready signal — keeping role logs and
 * dev logs together under one configured dir.
 *
 * Uses only node: built-ins + shared/{config,state}. No pi runtime dependency.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { getLogsDir } from "./config.ts";
import { ensureLogsDir } from "./state.ts";
import type { Role } from "./types.ts";

/** Log severity levels. */
export type LogLevel = "debug" | "info" | "warn" | "error";

/** A bound logger for one role. */
export interface Logger {
  /** Absolute path of the log file. */
  path: string;
  debug: (message: string, data?: unknown) => void;
  info: (message: string, data?: unknown) => void;
  warn: (message: string, data?: unknown) => void;
  error: (message: string, data?: unknown) => void;
  /** Generic entrypoint. */
  log: (level: LogLevel, message: string, data?: unknown) => void;
}

/** ISO-8601 timestamp for a log line. */
function stamp(): string {
  return new Date().toISOString();
}

/** Serialize optional structured data compactly; never throws. */
function fmtData(data: unknown): string {
  if (data === undefined) return "";
  try {
    return " " + JSON.stringify(data);
  } catch {
    return " " + String(data);
  }
}

/** Path to a role's log file (under the configured logsDir). */
export function getLogPath(role: Role): string {
  return join(getLogsDir(), `${role}.log`);
}

/**
 * Create a file logger for a role. Writes are synchronous appends (small,
 * infrequent lines), so they are safe to call from timers and handlers.
 *
 * @param role   which session this logger belongs to
 * @param opts.echo  if true, also echo to console.error (stderr) — use only
 *                   when not inside the pi TUI (e.g. a standalone script).
 */
export function createLogger(
  role: Role,
  opts: { echo?: boolean } = {},
): Logger {
  ensureLogsDir();
  const path = getLogPath(role);
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

/**
 * Console echo helper for one-off messages without creating a Logger.
 * Writes to stderr so it does not interfere with stdout-based protocols.
 */
export function echo(role: Role, level: LogLevel, message: string): void {
  // eslint-disable-next-line no-console
  console.error(`${stamp()} [${role}] ${level.toUpperCase()} ${message}`);
}
