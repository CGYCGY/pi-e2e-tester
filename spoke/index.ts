/**
 * spoke/index.ts — the ANDROID SPOKE extension.
 *
 * The android analog of the web spoke: one independent pi session that drives a
 * REAL phone (`com.expari.app.dev` on a Galaxy S21 Ultra) for the hub. It runs
 * its OWN LLM turn per intent, with 8 device verbs registered as pi tools, and
 * answers the hub with a PASS/FAIL verdict. Implements the full SPOKE DESIGN:
 *
 *  TRANSPORT  : own HTTP server (node:http via shared/transport) on the role's
 *               resolved port; POSTs to the hub. Token checked at the HTTP layer.
 *  STARTUP    : assertTargetValid → createTransportServer (port auto-fallback) →
 *               register{port,pid} to the hub → heartbeat loop. The hub's resolved
 *               port arrives via the HUB_PORT spawn env; our resolved port is
 *               reported back in register (the port-propagation loop).
 *  INTENT     : the hub sends ONE natural-language test intent; we wake our own
 *               LLM (one turn) to interpret it with the 8 verbs, capture the clean
 *               final text at agent_end, derive a verdict, and POST intent_result.
 *  GUARDS     : two deterministic guards (code, fail closed), run INSIDE the acting
 *               verbs — wrong-target (foreground == dev package) BEFORE the verb,
 *               crash-guard (new crash-tag error lines) AFTER it. If either
 *               trips during a turn, the verdict is FORCED to FAIL.
 *  HEARTBEAT  : periodic status (device-ready | model | ctx | cost) to the hub.
 *
 * KEY MENTAL MODEL (mirrors the web spoke): the Node code (HTTP server, timers) is
 * always running; the LLM only runs during an intent turn. The verbs are the
 * device surface; the guards are non-negotiable code around the acting ones.
 */

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getDefaults,
  getDevice,
  getPort,
  getRoleFromEnv,
  getRoleIcon,
  getTarget,
  getTestsDirs,
} from "../shared/config.ts";
import { createLogger, type Logger } from "../shared/log.ts";
import { markConnected } from "../shared/state.ts";
import { ensureTestsDirs } from "../shared/workspace.ts";
import {
  createTransportServer,
  postToHub,
  type TransportServer,
} from "../shared/transport.ts";
import type {
  SpokeReadyState,
  SpokeRole,
  SpokeStatus,
  Verdict,
} from "../shared/types.ts";

import { registerSpokeCommands } from "./commands.ts";
import { Device } from "./device.ts";
import { assertOnTarget, scanForCrash } from "./guards.ts";
import { getProfile } from "./profiles/index.ts";
import { registerSpokeTools } from "./tools.ts";

/** This spoke's role (phase 1 has exactly one spoke: android). */
const ROLE: SpokeRole = "android";

/**
 * Compact a token count for the status widget (e.g. 12345 -> "12.3k"). Inlined
 * here because the messenger-only foundation has no shared/format.ts (the web
 * spoke's sibling helper was dropped); kept tiny and local to spoke/.
 */
function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

/** Resolve the spoke role from env; warn + default to android if unset/odd. */
function resolveRole(log: Logger): SpokeRole {
  const role = getRoleFromEnv();
  if (role === "android") return role;
  log.warn(`PI_ROLE not set to "android"; defaulting to "android"`);
  return ROLE;
}

/**
 * Parse the spoke LLM's final turn text into a verdict + summary. The spoke is
 * instructed (system prompt) to end EVERY turn with a line `VERDICT: PASS` or
 * `VERDICT: FAIL`. We scan from the bottom for the LAST such line (most recent
 * judgement wins) and treat the rest as the human-readable summary. If no line is
 * present we FAIL CLOSED to "FAIL" (a turn that didn't render a verdict is not a
 * pass). This is the verdict-derivation half of the agent_end capture.
 */
function parseVerdict(finalText: string): { verdict: Verdict; text: string } {
  const text = finalText.trim();
  const lines = text.split("\n");
  let verdict: Verdict | null = null;
  for (let i = lines.length - 1; i >= 0; i--) {
    const m = /^\s*VERDICT:\s*(PASS|FAIL)\b/i.exec(lines[i]!);
    if (m) {
      verdict = m[1]!.toUpperCase() === "PASS" ? "PASS" : "FAIL";
      break;
    }
  }
  // FAIL CLOSED: no explicit verdict line ⇒ treat as FAIL (don't reward silence).
  return { verdict: verdict ?? "FAIL", text: text.length ? text : "(no final text)" };
}

export default function spokeExtension(pi: ExtensionAPI) {
  const role = resolveRole(createLogger(ROLE));
  const roleLog = createLogger(role);
  const defaults = getDefaults();
  const target = getTarget();
  const deviceCfg = getDevice();
  const androidPackage = target.androidPackage;
  const crashLogTag = target.crashLogTag;

  // Test workspace: look saves screenshots here, read_screenshot reads them back.
  // Built-in tools are gated off, so this is the spoke's only filesystem surface.
  const testsDirs = getTestsDirs();
  ensureTestsDirs(testsDirs);

  // The thin agent-device wrapper, pinned to the configured phone serial + dev pkg.
  const device = new Device({
    serial: deviceCfg.serial,
    androidPackage,
    log: roleLog,
  });

  // The pluggable device profile (vendor input quirks as behavior, not config):
  // selected by config.device.profile, supplies the focused-field submit strategy.
  const profile = getProfile(deviceCfg.profile);

  // ── Mutable spoke runtime (lives in extension memory, NOT LLM context) ───────
  let halted = false; // set on needs-device until a resume arrives
  let readyState: SpokeReadyState = "ready";
  let lastReportedState: SpokeReadyState | undefined;
  let server: TransportServer | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let activeCtx: ExtensionContext | undefined; // last ctx for UI + usage reads
  let cumulativeCost = 0; // summed from assistant usage.cost.total
  let deviceReady = true; // last known adb reachability (drives the widget)
  let lastForeground: string | undefined; // last observed foreground package

  // ── LLM-driven INTENT state ──────────────────────────────────────────────────
  // The hub sends a natural-language INTENT; we wake our own LLM (one turn) to
  // interpret it with the 8 device verbs and POST back the turn's final text +
  // derived verdict. Serialized to ONE in-flight intent (one phone per spoke).
  let activeIntent: { requestId: string } | null = null;
  let activeIntentTimer: ReturnType<typeof setTimeout> | undefined;
  // GUARD TRIP CAPTURE: set by an acting verb when a guard fails during the turn.
  // If set at agent_end, the verdict is FORCED to FAIL regardless of the LLM text.
  let guardTrip: { kind: "wrong-target" | "crash"; detail: string } | null = null;

  // ── Dead-man's switch state (covers an ABRUPT hub kill: no graceful broadcast) ─
  let lastHubContactTs = Date.now(); // updated on every successful hub contact
  let everConnected = false; // CRITICAL: never self-shutdown before the hub is ever reached
  let shuttingDown = false; // re-entrancy guard for gracefulShutdown

  // ── Spoke system-prompt rules (appended via before_agent_start) ──────────────
  // GENERIC skeleton only: the device-submit rule comes from profile.submitHint
  // and the app/auth playbook from target.spokeHints, so a non-Samsung/non-expari
  // target gets a TRUE hint, never a hardcoded-wrong one. Guards (code) are the floor.
  const SPOKE_RULES = `

## pi-e2e-tester android spoke
You are the android spoke. You drive \`${androidPackage}\` on a REAL phone via these verbs (built-in tools are DISABLED — these are all you have):
- observe — a11y snapshot + foreground app/activity (CHEAP; your default eyes; read-only).
- look — screenshot the phone; returns a file NAME. View it via read_screenshot ONLY when color/layout/vision actually matters.
- read_screenshot — view a look screenshot inline (pass the name look returned); the ONLY way to see the pixels.
- tap — tap by "x y" coords, an @ref from observe, or a selector.
- type — type into the focused field. submit:true (the default) submits it for you using THIS device's submit method (see the Device note below).
- key — send a hardware key (e.g. enter, back).
- assert — check a UI predicate (visible|hidden|exists|editable|selected|text) on a selector; contributes to your verdict.
- app — launch | stop | cold-reset the dev app (guarded to ${androidPackage}).
- logcat — pull recent ${crashLogTag} error lines for your failure report.
- read_creds — read the fixed sign-in creds file (the ONLY way to get the test credentials).

You receive ONE test intent per turn. Use observe (cheap) to look BEFORE acting; only use look (screenshot) when vision actually matters. read ≠ act.

${profile.submitHint}

${target.spokeHints}

The acting verbs (tap/type/key/app) run two deterministic guards in code: a wrong-target guard (refuses to act unless ${androidPackage} is foreground) and a crash-guard (fails the step if new ${crashLogTag} errors appear). If a guard refuses or trips, that is a real failure — report it.

End EVERY turn with a SHORT final summary, then a line exactly: \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Your final text is sent back to the hub verbatim.`;

  // ── UI helpers ──────────────────────────────────────────────────────────────
  const renderStatus = (ctx: ExtensionContext): void => {
    if (!ctx.hasUI) return;
    const theme = ctx.ui.theme;
    const usage = ctx.getContextUsage();
    const win = usage?.contextWindow ?? ctx.model?.contextWindow;
    const used =
      usage && usage.tokens != null && win
        ? `${fmtTokens(usage.tokens)}/${fmtTokens(win)}`
        : "?";
    const pct =
      usage && usage.percent != null ? ` (${Math.round(usage.percent)}%)` : "";
    const model = ctx.model?.id ?? "no-model";
    const dot =
      readyState === "ready"
        ? theme.fg("success", "●")
        : readyState === "wrong-target"
          ? theme.fg("warning", "●")
          : theme.fg("error", "●");
    const fg = lastForeground ? ` | ${lastForeground}` : "";
    ctx.ui.setStatus(
      "spoke",
      `${dot} ${getRoleIcon(role)}${fg} | ${model} | ctx ${used}${pct} | $${cumulativeCost.toFixed(3)}`,
    );
  };

  const refreshUI = (ctx?: ExtensionContext): void => {
    const c = ctx ?? activeCtx;
    if (!c) return;
    renderStatus(c);
  };

  // ── Heartbeat (status snapshot → hub) ────────────────────────────────────────
  const buildStatus = (): SpokeStatus => {
    const usage = activeCtx?.getContextUsage();
    const win = usage?.contextWindow ?? activeCtx?.model?.contextWindow;
    return {
      role,
      connected: true,
      deviceReady,
      readyState,
      foregroundPackage: lastForeground,
      model: activeCtx?.model?.id,
      contextPercent: usage?.percent ?? undefined,
      contextTokens: usage?.tokens ?? undefined,
      contextWindow: win ?? undefined,
      cost: cumulativeCost,
    };
  };

  // ── Graceful shutdown (lets the WSL window close on a clean exit) ─────────────
  const gracefulShutdown = async (reason: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    roleLog.info("spoke shutting down", { reason });
    if (heartbeatTimer) {
      clearInterval(heartbeatTimer);
      heartbeatTimer = undefined;
    }
    if (activeIntentTimer) {
      clearTimeout(activeIntentTimer);
      activeIntentTimer = undefined;
    }
    try {
      await server?.close();
    } catch {
      /* best-effort */
    }
    roleLog.info("spoke shutdown complete", { reason });
    process.exit(0); // exit 0 => launch-spoke.sh lets the WSL window close
  };

  const sendHeartbeat = (): void => {
    void postToHub(
      { type: "heartbeat", from: role, ts: Date.now(), status: buildStatus() },
      { port: hubPort(), timeoutMs: 4000 },
    )
      .then(() => {
        lastHubContactTs = Date.now();
        everConnected = true;
      })
      .catch((err) => {
        roleLog.debug("heartbeat post failed", { err: String(err) });
        // Dead-man's switch: only self-shutdown if the hub WAS reachable and has
        // now been unreachable for >= the heartbeat timeout (abrupt hub kill).
        if (
          everConnected &&
          Date.now() - lastHubContactTs >= defaults.heartbeatTimeoutMs
        ) {
          void gracefulShutdown("hub unreachable (dead-man's switch)");
        }
      });
  };

  // ── Status / readiness reporting ─────────────────────────────────────────────
  const reportStatus = (state: SpokeReadyState, detail?: string): void => {
    readyState = state;
    // Derive dependent flags from state so verifyReady callers don't need to
    // set them separately.
    deviceReady = state !== "needs-device" && state !== "error";
    halted = state === "needs-device" || state === "error";
    // Transition-gated: only POST on state change to avoid spamming the hub
    // while the device is absent. refreshUI always runs; heartbeat carries
    // readyState continuously so the hub still sees current state.
    if (state !== lastReportedState) {
      lastReportedState = state;
      void postToHub(
        { type: "status", from: role, ts: Date.now(), state, detail },
        { port: hubPort() },
      ).catch((err) => roleLog.warn("status post failed", { err: String(err) }));
    }
    refreshUI();
  };

  /**
   * Self-check readiness: device reachable AND dev app foreground?
   * opts.launch=true: when reachable but app not foreground, launch it and recheck.
   * Pass { launch: true } on establish-paths; omit at idle to not fight the user.
   */
  const verifyReady = async (opts?: { launch?: boolean }): Promise<void> => {
    try {
      const reachable = await device.isReachable();
      if (!reachable) {
        reportStatus("needs-device", `device ${deviceCfg.serial} not reachable (USB detached?).`);
        return;
      }
      // Device is up; read current foreground.
      try {
        const state = await device.appstate();
        lastForeground = state.package || undefined;
      } catch {
        lastForeground = undefined;
      }
      markConnected(role);

      const onTarget = lastForeground === androidPackage;
      if (!onTarget && opts?.launch) {
        // Auto-open the dev app, then recheck foreground once.
        try {
          await device.launch();
          const state = await device.appstate();
          lastForeground = state.package || undefined;
        } catch {
          /* launch failed — fall through to wrong-target */
        }
      }

      if (lastForeground === androidPackage) {
        reportStatus("ready", `device ${deviceCfg.serial} reachable; app "${androidPackage}".`);
      } else {
        reportStatus(
          "wrong-target",
          `foreground is "${lastForeground ?? "(unknown)"}", not the dev app "${androidPackage}".`,
        );
      }
    } catch (err) {
      roleLog.error("verifyReady failed", { err: String(err) });
      deviceReady = false;
      reportStatus("error", `verification error: ${(err as Error).message}`);
    }
  };

  // ── The shared acting-verb wrapper: guards in CODE around every action ────────
  // wrong-target BEFORE the action (fail closed → throw), crash-guard AFTER it
  // (trip → record guardTrip so agent_end FORCES FAIL, and surface to the LLM).
  // Returns the post-action observe text so verbs can echo fresh state cheaply.
  const withGuards = async (
    verb: string,
    action: () => Promise<void>,
  ): Promise<{ crash: string | null }> => {
    // PRE: wrong-target guard (do not trust the LLM; re-read foreground in code).
    const tgt = await assertOnTarget(device, androidPackage, roleLog);
    lastForeground = tgt.observed ?? undefined;
    refreshUI();
    if (!tgt.ok) {
      guardTrip = { kind: "wrong-target", detail: tgt.reason };
      throw new Error(`wrong-target guard refused ${verb}: ${tgt.reason}`);
    }
    // Stamp a marker so the crash-guard can diff only the new lines from THIS verb.
    const marker = await device.markLog();
    await action();
    // POST: crash-guard (new crash-tag error lines since the marker).
    const crash = await scanForCrash(device, marker || undefined, roleLog);
    if (!crash.ok) {
      guardTrip = { kind: "crash", detail: `${crash.reason}\n${crash.lines}` };
      return { crash: crash.lines };
    }
    return { crash: null };
  };

  // ── LLM-driven INTENT (hub natural-language instruction → one spoke turn) ─────
  // Finish an in-flight intent: derive the verdict (FORCED to FAIL if a guard
  // tripped during the turn), POST the IntentResultMessage, clear state. The
  // requestId guard ensures only the CURRENT intent can resolve (a late timer or a
  // stray agent_end after we've answered is ignored).
  const finishIntent = (
    requestId: string,
    ok: boolean,
    finalText: string,
    error?: string,
  ): void => {
    if (!activeIntent || activeIntent.requestId !== requestId) return;
    if (activeIntentTimer) {
      clearTimeout(activeIntentTimer);
      activeIntentTimer = undefined;
    }
    activeIntent = null;
    const trip = guardTrip;
    guardTrip = null;

    let verdict: Verdict;
    let text: string;
    if (!ok) {
      // Internal error / timeout: not a test verdict, but the contract still
      // carries a PASS|FAIL — a turn that couldn't complete is a FAIL.
      verdict = "FAIL";
      text = finalText.trim() || error || "intent did not complete";
    } else {
      const parsed = parseVerdict(finalText);
      verdict = parsed.verdict;
      text = parsed.text;
    }

    // GUARD OVERRIDE: a tripped guard FORCES FAIL no matter what the LLM said, and
    // its captured detail is appended to the error/text so the report shows why.
    let errOut = error;
    if (trip) {
      verdict = "FAIL";
      const note = `[${trip.kind} guard] ${trip.detail}`;
      errOut = errOut ? `${errOut}; ${note}` : note;
      if (!text.includes(trip.detail)) text = `${text}\n\n${note}`.trim();
    }

    void postToHub(
      {
        type: "intent_result",
        from: role,
        ts: Date.now(),
        requestId,
        ok,
        verdict,
        text,
        error: errOut,
      },
      { port: hubPort() },
    ).catch((err) => roleLog.warn("intent_result post failed", { err: String(err) }));
    refreshUI();
  };

  const handleIntent = async (
    requestId: string,
    intent: string,
    timeoutMs: number | undefined,
  ): Promise<void> => {
    // SERIALIZE: one LLM-driven intent at a time (one phone per spoke).
    if (activeIntent) {
      roleLog.warn("intent rejected: another intent in flight", { requestId });
      void postToHub(
        {
          type: "intent_result",
          from: role,
          ts: Date.now(),
          requestId,
          ok: false,
          verdict: "FAIL",
          text: "",
          error: "spoke busy with another intent",
        },
        { port: hubPort() },
      ).catch((err) => roleLog.warn("intent_result post failed", { err: String(err) }));
      return;
    }
    // HALTED ⇒ refuse (needs-device). Once the user reattaches and the hub resumes
    // us, the intent can be re-sent.
    if (halted) {
      roleLog.warn("intent rejected: spoke halted", { requestId });
      void postToHub(
        {
          type: "intent_result",
          from: role,
          ts: Date.now(),
          requestId,
          ok: false,
          verdict: "FAIL",
          text: "",
          error: "spoke halted (device not reachable / wrong target)",
        },
        { port: hubPort() },
      ).catch((err) => roleLog.warn("intent_result post failed", { err: String(err) }));
      return;
    }

    activeIntent = { requestId };
    guardTrip = null; // fresh turn: clear any stale guard trip

    // Arm the timeout for the whole spoke turn.
    const timeout = timeoutMs ?? defaults.intentTimeoutMs;
    activeIntentTimer = setTimeout(() => {
      roleLog.warn("intent timed out", { requestId, timeout });
      finishIntent(requestId, false, "", "intent timed out");
    }, timeout);

    // Wake our own LLM with the instruction. The final assistant text of this turn
    // is captured in the agent_end handler, parsed into a verdict, and POSTed back.
    roleLog.info("intent received; waking spoke LLM", { requestId, intent });
    try {
      if (activeCtx?.isIdle()) {
        pi.sendUserMessage(intent);
      } else {
        pi.sendUserMessage(intent, { deliverAs: "followUp" });
      }
    } catch (err) {
      roleLog.error("intent dispatch failed", { requestId, err: String(err) });
      finishIntent(requestId, false, "", `intent dispatch failed: ${(err as Error).message}`);
    }
  };

  // FRESH TEST START (hub /reset): cold-reset the dev app + shed LLM context.
  const handleReset = async (): Promise<{ ok: boolean; detail: string }> => {
    // Refuse mid-intent: shedding context during a turn would orphan it.
    if (activeIntent) {
      roleLog.warn("reset rejected: intent in flight");
      return { ok: false, detail: "intent in flight — reset after it finishes" };
    }
    // Best-effort: a device failure still lets us shed context below.
    let deviceDetail = "app cold-reset";
    try {
      await device.coldReset();
      lastForeground = undefined;
    } catch (err) {
      deviceDetail = `cold-reset failed: ${(err as Error).message}`;
      roleLog.warn("reset: coldReset failed", { err: String(err) });
    }
    guardTrip = null;
    // compact(), not newSession(): newSession is command-context-only by pi's
    // design, and this runs in a transport handler. (Same primitive pi-4b-tester
    // uses for its programmatic reset.) SPOKE_RULES re-inject every turn anyway.
    let contextDetail = "context kept (little to shed)";
    try {
      const usage = activeCtx?.getContextUsage();
      if (activeCtx && usage?.tokens != null && usage.tokens > 2000) {
        activeCtx.compact({
          customInstructions:
            "A brand-new, UNRELATED test is starting. Discard everything about the " +
            "previous test — its steps, observations, taps, and verdict are over and " +
            "must NOT influence the next one. Summarize to a single line: 'fresh test start'.",
          onError: (e) => roleLog.warn("reset: compaction failed", { err: e.message }),
        });
        contextDetail = "context cleared";
      }
    } catch (err) {
      roleLog.warn("reset: compact failed", { err: String(err) });
    }
    roleLog.info("spoke reset", { device: deviceDetail, context: contextDetail });
    refreshUI();
    return { ok: true, detail: `${contextDetail}; ${deviceDetail}` };
  };

  // ── Hub port resolution (HUB_PORT spawn env = hub's RESOLVED port) ────────────
  // The hub passes its own resolved port via the HUB_PORT env at spawn; honour it,
  // else fall back to the preferred config port. All hub POSTs route through here.
  const hubPort = (): number => {
    const env = process.env.HUB_PORT ?? process.env.PI_HUB_PORT;
    const n = env ? parseInt(env, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : getPort("hub");
  };

  // ── Transport server + handlers (hub → spoke) ────────────────────────────────
  const startServer = async (): Promise<void> => {
    if (server) return;
    server = await createTransportServer({
      port: getPort(role),
      handlers: {
        // LLM-driven INTENT: wake our own LLM (one turn) to interpret the hub's
        // natural-language test intent. ACK synchronously; the final assistant text
        // is captured at agent_end and POSTed back as an IntentResultMessage.
        intent: (msg) => {
          void handleIntent(msg.requestId, msg.intent, msg.timeoutMs);
          return { ok: true, accepted: true };
        },
        // User fixed the problem (reattached the device): re-verify readiness.
        resume: () => {
          halted = false;
          void verifyReady({ launch: true });
          return { ok: true };
        },
        // FRESH TEST START (hub /reset) — the explicit scenario boundary;
        // messenger otherwise CONTINUES by default. See handleReset.
        reset: () => handleReset(),
        // Hub-requested shutdown (cascade): ack first, then shut down on a short
        // delay so the HTTP 200 flushes before process.exit.
        shutdown: (msg) => {
          roleLog.info("shutdown requested by hub", {
            reason: (msg as { reason?: string }).reason,
          });
          setTimeout(() => {
            void gracefulShutdown("hub requested shutdown");
          }, 100);
          return { ok: true };
        },
        onUnhandled: (msg) => {
          roleLog.debug("unhandled transport message", {
            type: (msg as { type?: string }).type,
          });
          return { ok: true };
        },
        onError: (err, raw) =>
          roleLog.warn("transport server error", {
            err: err.message,
            raw: raw.slice(0, 200),
          }),
      },
    });
    roleLog.info("spoke transport listening", { port: server.port, role });
  };

  // Heartbeat tick: when halted (device absent / red), re-attempt readiness on
  // each beat so plugging the device back in auto-recovers without a manual command.
  // verifyReady returns early at needs-device BEFORE launching, so launch() is
  // never called while the phone is absent — only once it becomes reachable again.
  const heartbeatTick = (): void => {
    if (halted) {
      void verifyReady({ launch: true }).then(() => sendHeartbeat());
    } else {
      sendHeartbeat();
    }
  };

  // ── Register / heartbeat lifecycle ───────────────────────────────────────────
  // Announce with our RESOLVED port (server.port may differ from the preferred
  // config port after auto-fallback) so the hub learns where to POST intents.
  const announce = (): void => {
    const resolvedPort = server?.port ?? getPort(role);
    void postToHub(
      {
        type: "register",
        from: role,
        ts: Date.now(),
        port: resolvedPort,
        pid: process.pid,
      },
      { port: hubPort() },
    )
      .then(() => {
        lastHubContactTs = Date.now();
        everConnected = true;
      })
      .catch((err) => roleLog.debug("register post failed", { err: String(err) }));
  };

  // ── pi lifecycle wiring ──────────────────────────────────────────────────────
  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) {
      ctx.ui.setWorkingIndicator(undefined); // pi default spinner
    }
    await startServer();
    announce();
    // Auto-connect: on start, self-check device reachability + foreground.
    await verifyReady({ launch: true });

    // Heartbeat loop (self-healing tick — see heartbeatTick).
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(heartbeatTick, defaults.heartbeatIntervalMs);
      heartbeatTick();
    }
    refreshUI(ctx);
  });

  // Append the spoke rules to the system prompt every turn.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + SPOKE_RULES,
  }));

  // Keep ctx fresh + accumulate cost from assistant usage.
  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  pi.on("message_end", async (event, ctx) => {
    activeCtx = ctx;
    if (event.message.role === "assistant") {
      const usage = (event.message as { usage?: { cost?: { total?: number } } }).usage;
      if (usage?.cost?.total != null) cumulativeCost += usage.cost.total;
    }
    refreshUI(ctx);
  });
  pi.on("model_select", async (_event, ctx) => {
    activeCtx = ctx;
    refreshUI(ctx);
  });

  // Capture an INTENT turn's final answer. agent_end fires once per prompt (after
  // the whole tool loop), carrying event.messages: AgentMessage[]. We take the LAST
  // assistant message and join its TextContent blocks (skipping thinking /
  // tool-call blocks) — that clean final text is parsed into the verdict + sent to
  // the hub. (This is the agent_end capture mechanism the spec flags as the #1
  // runtime risk; it mirrors the web spoke's pattern exactly.)
  pi.on("agent_end", async (event, ctx) => {
    activeCtx = ctx;
    if (!activeIntent) return;
    const requestId = activeIntent.requestId;
    const finalAssistant = [...event.messages]
      .reverse()
      .find((m) => m.role === "assistant");
    let text = "";
    if (finalAssistant && Array.isArray((finalAssistant as { content?: unknown }).content)) {
      const content = (finalAssistant as { content: Array<{ type?: string; text?: string }> })
        .content;
      text = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string)
        .join("")
        .trim();
    }
    finishIntent(requestId, true, text);
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (activeIntentTimer) clearTimeout(activeIntentTimer);
    activeIntentTimer = undefined;
    await server?.close();
    server = undefined;
  });

  // ── Commands (manual operation / debugging) ──────────────────────────────────
  registerSpokeCommands(pi, {
    role,
    getRoleIcon,
    buildStatus,
    verifyReady,
    refreshUI,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
    getHalted: () => halted,
    setHalted: (v) => {
      halted = v;
    },
    getReadyState: () => readyState,
    getDeviceReady: () => deviceReady,
    getLastForeground: () => lastForeground,
  });

  // ── Device + workspace verbs (registered as pi tools for the spoke's OWN LLM) ─
  registerSpokeTools(pi, {
    device,
    profile,
    roleLog,
    androidPackage,
    crashLogTag,
    screenshotsDir: testsDirs.screenshots,
    envTestPath: target.envTest,
    withGuards,
    refreshUI,
    setActiveCtx: (ctx) => {
      activeCtx = ctx;
    },
    setLastForeground: (v) => {
      lastForeground = v;
    },
    setDeviceReady: (v) => {
      deviceReady = v;
    },
    setGuardTrip: (v) => {
      guardTrip = v;
    },
  });

  roleLog.info("spoke extension loaded", {
    role,
    serial: deviceCfg.serial,
    androidPackage,
    profile: profile.id,
  });
}
