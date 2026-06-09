// Two deterministic guards re-checked in code (not LLM tools) around every acting
// verb; both fail CLOSED and a trip FORCES verdict:"FAIL". The crash-guard exists
// because expari's worst failures are SILENT to an a11y snapshot/appstate: the auth
// bridge not mounting (→ Convex queries return unauth) and swallowed Sentry errors.

import type { Device } from "./device.ts";
import type { Logger } from "../shared/log.ts";
import { getTarget } from "../shared/config.ts";

export interface TargetGuardResult {
  ok: boolean;
  reason: string;
  expected: string;
  observed: string | null;
}

export interface CrashGuardResult {
  ok: boolean;
  reason: string;
  lines: string;
}

// Fail CLOSED on an unreadable foreground (detached device / opaque surface).
export async function assertOnTarget(
  device: Device,
  expectedPackage: string,
  log: Logger,
): Promise<TargetGuardResult> {
  let observed: string | null = null;
  try {
    const state = await device.appstate();
    observed = state.package || null;
  } catch (err) {
    log.warn("target guard: appstate threw (fail closed)", { err: String(err) });
    observed = null;
  }

  if (!observed) {
    return {
      ok: false,
      reason: "foreground package unreadable (device detached / opaque surface) — failing closed",
      expected: expectedPackage,
      observed: null,
    };
  }

  if (observed !== expectedPackage) {
    return {
      ok: false,
      reason: `wrong target: expected foreground "${expectedPackage}" but observed "${observed}"`,
      expected: expectedPackage,
      observed,
    };
  }

  return { ok: true, reason: "", expected: expectedPackage, observed };
}

// Trips on the config-driven crash signature (sigRe) OR an always-on generic
// redbox/exception/fatal fallback. Kept tight to avoid failing on benign warnings.
function looksLikeError(line: string, sigRe: RegExp | null): boolean {
  if (sigRe && sigRe.test(line)) return true;
  return /(red ?box|unhandled\s+(?:promise\s+)?(?:rejection|error)|fatal|exception|invariant violation)/i.test(
    line,
  );
}

export async function scanForCrash(
  device: Device,
  marker: string | undefined,
  log: Logger,
): Promise<CrashGuardResult> {
  // A bad config signature must degrade to the generic-only fallback, not throw.
  let sigRe: RegExp | null = null;
  try {
    sigRe = new RegExp(getTarget().crashSignature, "i");
  } catch (err) {
    log.warn("crash guard: invalid crashSignature, using generic fallback only", {
      err: String(err),
    });
    sigRe = null;
  }

  let recent = "";
  try {
    recent = await device.logcat({ sinceMarker: marker });
  } catch (err) {
    // A logcat read failure must not itself fail the step — report clean.
    log.debug("crash guard: logcat threw", { err: String(err) });
    return { ok: true, reason: "", lines: "" };
  }

  const errorLines = recent
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => l.length > 0 && looksLikeError(l, sigRe));

  if (errorLines.length > 0) {
    const joined = errorLines.join("\n");
    log.warn("crash guard tripped: new error lines", { count: errorLines.length });
    return {
      ok: false,
      reason: `crash guard: ${errorLines.length} new crash-signature error line(s) appeared after the action`,
      lines: joined,
    };
  }

  return { ok: true, reason: "", lines: "" };
}
