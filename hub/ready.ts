/**
 * hub/ready.ts — the reusable "wait until ready" helper for auto-bring-up.
 *
 * The spec's whole bring-up model is `-bg` + logfiles: the hub backgrounds
 * expari's PLAIN dev recipes (and usbipd attach) into <logsDir>/*.log, then waits
 * for the REAL ready signal by:
 *   1. LOG-SIGNAL (primary): tailing the backgrounded logfile for a ready regex
 *      (readiness.convexReady / metroReady / usbAttached). Deterministic, zero LLM
 *      tokens — pure Node fs + RegExp, per the design.
 *   2. PROBE BACKSTOP (fallback): if the log signal never lands, run a probe
 *      (adb get-state for the device, curl :8081/status for Metro) and accept that
 *      as ready instead. This covers the case where the exact log line drifts from
 *      the config seed (the readiness regexes carry `// VERIFY` notes).
 *
 * On timeout the helper returns the last ~40 log lines so the caller can surface
 * WHY bring-up stalled (e.g. a Convex auth error mid-log) instead of a bare
 * "timed out". Uses only node: built-ins; no pi runtime dependency.
 */

import { execFile } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";

import { getDefaults } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";

/** How many trailing log lines to surface on a ready-wait failure. */
export const READY_TAIL_LINES = 40;

/** A deterministic probe: returns true when the dependency is up. */
export type ReadyProbe = () => Promise<boolean>;

/** Options for waitForReady. */
export interface WaitForReadyOptions {
  /** Human label for logs/errors (e.g. "convex", "metro", "usb"). */
  label: string;
  /** Absolute path of the backgrounded logfile to tail for the ready signal. */
  logPath: string;
  /** RegExp SOURCE (from config.readiness) the ready line matches. */
  readyRegex: string;
  /** Optional probe backstop, run each poll if the log signal hasn't landed. */
  probe?: ReadyProbe;
  /** Overall budget (ms). Defaults to defaults.readyTimeoutMs. */
  timeoutMs?: number;
  /** Re-tail / re-probe cadence (ms). Defaults to defaults.readyPollIntervalMs. */
  pollIntervalMs?: number;
  /** Logger for milestone breadcrumbs. */
  log: Logger;
}

/** Outcome of a ready-wait. */
export interface WaitForReadyResult {
  /** True once the log signal OR the probe reported ready. */
  ready: boolean;
  /** How it became ready (for logs): "log" | "probe" | "timeout". */
  via: "log" | "probe" | "timeout";
  /** Elapsed ms. */
  elapsedMs: number;
  /** On timeout, the last ~40 log lines (else undefined). */
  tail?: string;
}

/** Read the whole logfile if present (best-effort; never throws). */
function readLog(path: string): string {
  if (!existsSync(path)) return "";
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Last N non-empty-trimmed lines of a logfile, joined for display. */
export function tailLog(path: string, lines = READY_TAIL_LINES): string {
  const text = readLog(path);
  if (!text) return `(no log yet at ${path})`;
  const all = text.split("\n");
  return all.slice(Math.max(0, all.length - lines)).join("\n").trimEnd();
}

/** Sleep helper (unref'd timer so it can't keep the process alive). */
function delay(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    t.unref?.();
  });
}

/**
 * Wait until a backgrounded dependency is ready by LOG-SIGNAL first, PROBE second.
 *
 * Polls every pollIntervalMs up to timeoutMs: each tick it (1) re-reads the
 * logfile and tests the ready regex (case-insensitive), then (2) if still not
 * ready and a probe was given, runs the probe. Resolves the moment either fires;
 * on timeout returns ready:false with the last ~40 log lines for diagnosis.
 */
export async function waitForReady(
  opts: WaitForReadyOptions,
): Promise<WaitForReadyResult> {
  const defaults = getDefaults();
  const timeoutMs = opts.timeoutMs ?? defaults.readyTimeoutMs;
  const pollIntervalMs = opts.pollIntervalMs ?? defaults.readyPollIntervalMs;
  // case-insensitive: the config regexes are best-known seeds, matched loosely.
  const re = new RegExp(opts.readyRegex, "i");
  const started = Date.now();

  opts.log.info(`ready-wait: ${opts.label} — tailing ${opts.logPath}`, {
    readyRegex: opts.readyRegex,
    hasProbe: !!opts.probe,
    timeoutMs,
  });

  while (Date.now() - started < timeoutMs) {
    // 1) LOG-SIGNAL (primary): the real ready line in the backgrounded log.
    if (re.test(readLog(opts.logPath))) {
      const elapsedMs = Date.now() - started;
      opts.log.info(`ready: ${opts.label} via log signal`, { elapsedMs });
      return { ready: true, via: "log", elapsedMs };
    }
    // 2) PROBE BACKSTOP (fallback): accept readiness even if the log line drifts.
    if (opts.probe) {
      // eslint-disable-next-line no-await-in-loop
      const up = await opts.probe().catch(() => false);
      if (up) {
        const elapsedMs = Date.now() - started;
        opts.log.info(`ready: ${opts.label} via probe`, { elapsedMs });
        return { ready: true, via: "probe", elapsedMs };
      }
    }
    // eslint-disable-next-line no-await-in-loop
    await delay(pollIntervalMs);
  }

  const elapsedMs = Date.now() - started;
  const tail = tailLog(opts.logPath);
  opts.log.warn(`ready-wait TIMEOUT: ${opts.label}`, { elapsedMs, timeoutMs });
  return { ready: false, via: "timeout", elapsedMs, tail };
}

/* ─────────────────────────── probe builders ─────────────────────────── */

/** Run a binary with args, resolving its { code, stdout, stderr } (never rejects). */
function run(
  cmd: string,
  args: string[],
  timeoutMs = 5000,
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      args,
      { timeout: timeoutMs, windowsHide: true },
      (err, stdout, stderr) => {
        const code =
          err && typeof (err as { code?: unknown }).code === "number"
            ? ((err as { code: number }).code)
            : err
              ? 1
              : 0;
        resolve({ code, stdout: String(stdout), stderr: String(stderr) });
      },
    );
  });
}

/**
 * ADB probe backstop (USB/device readiness). Runs the configured probeAdb command
 * (with {serial} substituted) and expects stdout to contain "device". Built from
 * readiness.probeAdb so the exact adb invocation stays config-driven.
 */
export function makeAdbProbe(probeAdbCmd: string, serial: string): ReadyProbe {
  // probeAdb seed is e.g. "adb -s {serial} get-state"; substitute + split.
  const resolved = probeAdbCmd.replace(/\{serial\}/g, serial);
  const [bin, ...args] = resolved.split(/\s+/).filter(Boolean);
  return async () => {
    if (!bin) return false;
    const { code, stdout } = await run(bin, args, 4000);
    // adb get-state prints "device" on a healthy attach (exit 0).
    return code === 0 && /device/i.test(stdout);
  };
}

/**
 * Metro probe backstop. Curls the configured probeMetro URL and expects the
 * packager-status line ("packager-status:running"). Uses curl (already on PATH in
 * WSL) so we don't add an http client dependency.
 */
export function makeMetroProbe(probeMetroUrl: string): ReadyProbe {
  return async () => {
    const { code, stdout } = await run(
      "curl",
      ["-fsS", "--max-time", "3", probeMetroUrl],
      4000,
    );
    return code === 0 && /packager-status:running/i.test(stdout);
  };
}
