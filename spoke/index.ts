// The android spoke: one pi session that drives a real phone for the hub. The Node
// code (HTTP server, timers) always runs; the LLM runs only during an intent turn.
// Two code guards (wrong-target, crash) fail closed and force the verdict to FAIL.

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";

import {
  getAndroidPlatform,
  getDefaults,
  getMetroPort,
  getPort,
  getRoleFromEnv,
  getRoleIcon,
  getRulesForSpoke,
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

const ROLE: SpokeRole = "android";

function fmtTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(1)}M`;
}

function resolveRole(log: Logger): SpokeRole {
  const role = getRoleFromEnv();
  if (role === "android") return role;
  log.warn(`PI_ROLE not set to "android"; defaulting to "android"`);
  return ROLE;
}

// Scan for the LAST `VERDICT: PASS|FAIL` line the spoke prompt requires; FAIL
// CLOSED if absent — a turn that rendered no verdict is not a pass.
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
  // App-level (creds/repo) vs the android platform block (this spoke's identity + device).
  const target = getTarget();
  const platform = getAndroidPlatform();
  const deviceCfg = platform.device;
  const androidPackage = platform.androidPackage;
  const allowedForegroundPackages = platform.allowedForegroundPackages;
  const crashLogTag = platform.crashLogTag;
  const notReadyActivities = platform.notReadyActivities;
  const readyMarker = platform.readyMarker;
  const metroPort = getMetroPort();

  // Built-in tools are gated off, so this workspace is the spoke's only filesystem surface.
  const testsDirs = getTestsDirs();
  ensureTestsDirs(testsDirs);

  const device = new Device({
    serial: deviceCfg.serial,
    androidPackage,
    log: roleLog,
  });

  // DeviceProfile = vendor input quirks (e.g. how a field is submitted), by device.profile.
  const profile = getProfile(deviceCfg.profile);

  // Mutable spoke runtime — extension memory, NOT LLM context.
  let halted = false; // set on needs-device until a resume arrives
  let readyState: SpokeReadyState = "ready";
  let lastReportedState: SpokeReadyState | undefined;
  let server: TransportServer | undefined;
  let heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  let activeCtx: ExtensionContext | undefined; // last ctx for UI + usage reads
  let cumulativeCost = 0; // summed from assistant usage.cost.total
  let deviceReady = true; // last known adb reachability (drives the widget)
  let lastForeground: string | undefined; // last observed foreground package
  // Re-entrancy guard: idle heartbeat re-verifies must not stack while a prior
  // verify (esp. a blocking relaunch) is still running.
  let verifyInFlight = false;
  // When OUR app first went foreground-but-not-loaded. Drives idle stuck-recovery:
  // relaunch only after it stays stuck past RECOVERY_GRACE_MS, so a normal cold
  // start / fast-refresh reload (which finishes on its own) is never interrupted.
  let notLoadedSince: number | undefined;

  // Serialized to ONE in-flight intent (one phone per spoke).
  // `armed` flips true on the FIRST agent_start after dispatch — the intent's OWN
  // run beginning. An unrelated run already executing (operator typing in the TUI)
  // fires agent_end first; agent_end ignores it until armed so its text can't be
  // posted back as the intent answer.
  let activeIntent: { requestId: string; armed: boolean } | null = null;
  let activeIntentTimer: ReturnType<typeof setTimeout> | undefined;
  // Final text of the intent run's latest agent_end. pi may follow an agent_end
  // with an auto-retry, a compaction retry, or a queued continuation, so the run
  // that ends is not always the run that answers: each capture overwrites the
  // last, and only agent_settled promotes one to the verdict.
  let capturedIntentText: string | null = null;
  // Set by an acting verb when a guard fails; if still set when the intent
  // resolves, the verdict is FORCED to FAIL regardless of the LLM's text.
  let guardTrip: { kind: "wrong-target" | "crash"; detail: string } | null = null;

  // Dead-man's switch (covers an ABRUPT hub kill with no graceful broadcast).
  let lastHubContactTs = Date.now(); // updated on every successful hub contact
  let everConnected = false; // CRITICAL: never self-shutdown before the hub is ever reached
  let shuttingDown = false; // re-entrancy guard for gracefulShutdown

  // 3 layers: generic skeleton + profile.submitHint (device submit rule) +
  // getRulesForSpoke (app/platform rules markdown). A hardcoded-wrong hint is worse
  // than none here (it's the spoke's only knowledge), so layers 2-3 come from
  // config/profile, never literals. The code guards are the floor.
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

${getRulesForSpoke(role)}

The acting verbs (tap/type/key/app) run two deterministic guards in code: a wrong-target guard (refuses to act unless ${androidPackage}${allowedForegroundPackages.length ? ` — or one of these allowed handoff apps: ${allowedForegroundPackages.join(", ")} (e.g. the browser an OAuth/SSO sign-in opens; act in it normally to complete the flow)` : ""} is foreground) and a crash-guard (fails the step if new ${crashLogTag} errors appear). If a guard refuses or trips, that is a real failure — report it.

End EVERY turn with a SHORT final summary, then a line exactly: \`VERDICT: PASS\` or \`VERDICT: FAIL\`. Your final text is sent back to the hub verbatim.`;

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
      {
        type: "heartbeat",
        from: role,
        ts: Date.now(),
        port: server?.port ?? getPort(role),
        status: buildStatus(),
      },
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

  const reportStatus = (state: SpokeReadyState, detail?: string): void => {
    readyState = state;
    deviceReady = state !== "needs-device" && state !== "error";
    halted = state === "needs-device" || state === "error";
    // Only POST on change (avoid spamming the hub while the device is absent);
    // the heartbeat carries readyState continuously regardless.
    if (state !== lastReportedState) {
      lastReportedState = state;
      void postToHub(
        { type: "status", from: role, ts: Date.now(), state, detail },
        { port: hubPort() },
      ).catch((err) => roleLog.warn("status post failed", { err: String(err) }));
    }
    refreshUI();
  };

  // Package matches but the activity is the dev launcher ⇒ the wrong-target check
  // (package-only) passes yet the app isn't actually loaded — must NOT report ready.
  const onNotReadyActivity = (activity: string): boolean =>
    notReadyActivities.some((a) => activity.includes(a));

  // How long OUR app may sit foreground-but-not-loaded before idle self-heal
  // relaunches it. Must exceed a normal cold start / fast-refresh reload (which
  // finish on their own) so recovery never cuts a legitimate load short.
  const RECOVERY_GRACE_MS = 30_000;

  // The marker is the only signal separating a RENDERED app from one still
  // splashing / bundling / reloading — appstate stays identical across all of them.
  const computeLoaded = async (activity: string): Promise<boolean> => {
    if (lastForeground !== androidPackage || onNotReadyActivity(activity)) return false;
    return device.markerVisible(readyMarker);
  };

  // opts.launch (establish paths: session_start / resume / reset): relaunch whenever
  // not loaded. opts.recover (idle heartbeat): relaunch ONLY our own foreground-but-
  // stuck app, and only past the grace window — never fight a DIFFERENT foreground
  // app the user switched to, and never cut short a load still in progress.
  const verifyReady = async (opts?: { launch?: boolean; recover?: boolean }): Promise<void> => {
    verifyInFlight = true;
    try {
      const reachable = await device.isReachable();
      if (!reachable) {
        notLoadedSince = undefined;
        reportStatus("needs-device", `device ${deviceCfg.serial} not reachable (USB detached?).`);
        return;
      }
      let activity = "";
      try {
        const state = await device.appstate();
        lastForeground = state.package || undefined;
        activity = state.activity;
      } catch {
        lastForeground = undefined;
      }
      markConnected(role);

      let loaded = await computeLoaded(activity);

      // A different foreground isn't "stuck" (don't fight the user) — only our own
      // app, foreground yet not loaded, starts the recovery clock.
      const onOurApp = lastForeground === androidPackage;
      if (!loaded && onOurApp) notLoadedSince ??= Date.now();
      else notLoadedSince = undefined;

      const stuckLongEnough =
        notLoadedSince !== undefined && Date.now() - notLoadedSince >= RECOVERY_GRACE_MS;
      const doLaunch =
        !loaded && (Boolean(opts?.launch) || Boolean(opts?.recover && onOurApp && stuckLongEnough));

      if (doLaunch) {
        // Reverse must be re-applied BEFORE launch, not after (see reverseTcp).
        if (metroPort) await device.reverseTcp(metroPort);
        try {
          await device.launch(); // blocks until the readyMarker is visible (or deadline)
          const state = await device.appstate();
          lastForeground = state.package || undefined;
          activity = state.activity;
        } catch {
          /* launch failed — fall through to the status below */
        }
        loaded = await computeLoaded(activity);
        if (loaded) notLoadedSince = undefined;
      }

      if (loaded) {
        reportStatus("ready", `device ${deviceCfg.serial} reachable; app "${androidPackage}" loaded.`);
      } else if (lastForeground === androidPackage) {
        reportStatus(
          "wrong-target",
          `app "${androidPackage}" foreground but NOT loaded — on "${activity}" ` +
            `(splash / bundling / reloading${readyMarker ? `; ${readyMarker} not visible` : ""}).`,
        );
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
    } finally {
      verifyInFlight = false;
    }
  };

  // Guards in code around every action: wrong-target BEFORE (fail closed → throw),
  // crash-guard AFTER (trip → record guardTrip so agent_end FORCES FAIL).
  const withGuards = async (
    verb: string,
    action: () => Promise<void>,
  ): Promise<{ crash: string | null }> => {
    // PRE: wrong-target guard (do not trust the LLM; re-read foreground in code).
    const tgt = await assertOnTarget(device, androidPackage, allowedForegroundPackages, roleLog);
    lastForeground = tgt.observed ?? undefined;
    refreshUI();
    if (!tgt.ok) {
      guardTrip = { kind: "wrong-target", detail: tgt.reason };
      throw new Error(`wrong-target guard refused ${verb}: ${tgt.reason}`);
    }
    // Stamp a marker so the crash-guard can diff only the new lines from THIS verb.
    const marker = await device.markLog();
    await action();
    const crash = await scanForCrash(device, marker || undefined, roleLog);
    if (!crash.ok) {
      guardTrip = { kind: "crash", detail: `${crash.reason}\n${crash.lines}` };
      return { crash: crash.lines };
    }
    return { crash: null };
  };

  // The requestId guard ensures only the CURRENT intent resolves — a late timer or
  // a stray agent_end after we've already answered is ignored.
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
    capturedIntentText = null;
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

    activeIntent = { requestId, armed: false };
    guardTrip = null; // fresh turn: clear any stale guard trip

    const timeout = timeoutMs ?? defaults.intentTimeoutMs;
    activeIntentTimer = setTimeout(() => {
      roleLog.warn("intent timed out", { requestId, timeout });
      finishIntent(requestId, false, "", "intent timed out");
    }, timeout);

    // The turn's final text is captured in agent_end → verdict → POSTed back.
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
    // cold-reset force-stopped the app, so foreground is now the launcher — idle
    // recover won't relaunch that. Bring it back here; fire-and-forget so the ACK
    // doesn't block on a launch.
    void verifyReady({ launch: true });
    return { ok: true, detail: `${contextDetail}; ${deviceDetail}` };
  };

  // The hub passes its RESOLVED port via HUB_PORT at spawn (may differ from config
  // after auto-fallback); honour it, else fall back to the preferred config port.
  const hubPort = (): number => {
    const env = process.env.HUB_PORT ?? process.env.PI_HUB_PORT;
    const n = env ? parseInt(env, 10) : NaN;
    return Number.isFinite(n) && n > 0 ? n : getPort("hub");
  };

  const startServer = async (): Promise<void> => {
    if (server) return;
    server = await createTransportServer({
      port: getPort(role),
      handlers: {
        // ACK synchronously; the final answer is captured at agent_end and POSTed
        // back as an IntentResultMessage.
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
        // The explicit scenario boundary — messenger otherwise CONTINUES by default.
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

  // Re-verify EVERY beat (old code only did when halted), so a reload wedged inside
  // MainActivity self-heals instead of staying false-green. Heartbeat first: the hub
  // must see liveness even through a blocking relaunch. halted ⇒ launch so re-plugging
  // recovers (verifyReady no-ops at needs-device before launching).
  const heartbeatTick = (): void => {
    sendHeartbeat();
    if (activeIntent || verifyInFlight || shuttingDown) return;
    void verifyReady(halted ? { launch: true } : { recover: true });
  };

  // Announce our RESOLVED port (may differ from config after auto-fallback) so the
  // hub knows where to POST intents.
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

  pi.on("session_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (ctx.hasUI) {
      ctx.ui.setWorkingIndicator(undefined);
    }
    await startServer();
    announce();
    await verifyReady({ launch: true });

    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(heartbeatTick, defaults.heartbeatIntervalMs);
      heartbeatTick();
    }
    refreshUI(ctx);
  });

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + SPOKE_RULES,
  }));

  pi.on("turn_start", async (_event, ctx) => {
    activeCtx = ctx;
  });
  // Arm the pending intent when ITS agent run starts. A run already in flight when
  // the intent queued fired agent_start earlier, so it stays unarmed and its
  // agent_end is ignored below. agent_start fires once per run (turn_start is
  // per tool-loop turn — too granular to correlate a run).
  pi.on("agent_start", async (_event, ctx) => {
    activeCtx = ctx;
    if (activeIntent && !activeIntent.armed) activeIntent.armed = true;
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

  // CAPTURE the intent run's final answer (last assistant message's text blocks);
  // agent_settled below promotes it to the verdict. This capture-then-settle split
  // is the spec's #1 runtime risk: resolving straight from agent_end would score
  // the pre-retry text whenever pi retries or continues after this run.
  pi.on("agent_end", async (event, ctx) => {
    activeCtx = ctx;
    // Only the intent's OWN run may answer it — an unrelated run ending first
    // (still unarmed) must not post its text back as the intent verdict.
    if (!activeIntent || !activeIntent.armed) return;
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
    capturedIntentText = text;
  });

  // RESOLVE the intent. pi guarantees no automatic retry, compaction retry, or
  // queued continuation remains once agent_settled fires, so the last captured
  // text is the run's real final answer.
  pi.on("agent_settled", async (_event, ctx) => {
    activeCtx = ctx;
    if (!activeIntent || !activeIntent.armed) return;
    finishIntent(activeIntent.requestId, true, capturedIntentText ?? "");
  });

  pi.on("session_shutdown", async () => {
    if (heartbeatTimer) clearInterval(heartbeatTimer);
    heartbeatTimer = undefined;
    if (activeIntentTimer) clearTimeout(activeIntentTimer);
    activeIntentTimer = undefined;
    await server?.close();
    server = undefined;
  });

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
