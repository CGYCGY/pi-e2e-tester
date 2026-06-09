/**
 * Append-only file logger. logsDir is shared with the hub's backgrounded dev
 * recipes (convex/metro) so role logs + dev logs sit under one dir the hub can
 * tail. Console echo defaults OFF because pi owns the TUI. node:-only; no pi dep.
 */

import { appendFileSync } from "node:fs";
import { join } from "node:path";

import { getLogsDirForApp } from "./config.ts";
import { ensureLogsDir } from "./state.ts";
import type { Role } from "./types.ts";

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
