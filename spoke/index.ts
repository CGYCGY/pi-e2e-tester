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

import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import {
  getDefaults,
  getDevice,
  getPort,
  getRoleFromEnv,
  getTarget,
} from "../shared/config.ts";
import { createLogger, type Logger } from "../shared/log.ts";
import { markConnected } from "../shared/state.ts";
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

import { Device } from "./device.ts";
import { assertOnTarget, scanForCrash } from "./guards.ts";
import { getProfile } from "./profiles/index.ts";

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
You are the android spoke. You drive \`${androidPackage}\` on a REAL phone via these 8 verbs:
- observe — a11y snapshot + foreground app/activity (CHEAP; your default eyes; read-only).
- look — screenshot to /tmp; returns a FILE PATH. Read that file ONLY when color/layout/vision actually matters.
- tap — tap by "x y" coords, an @ref from observe, or a selector.
- type — type into the focused field. submit:true (the default) submits it for you using THIS device's submit method (see the Device note below).
- key — send a hardware key (e.g. enter, back).
- assert — check a UI predicate (visible|hidden|exists|editable|selected|text) on a selector; contributes to your verdict.
- app — launch | stop | cold-reset the dev app (guarded to ${androidPackage}).
- logcat — pull recent ${crashLogTag} error lines for your failure report.

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
    const dot = halted
      ? theme.fg("error", "●")
      : deviceReady
        ? theme.fg("success", "●")
        : theme.fg("warning", "●");
    const fg = lastForeground ? ` | ${lastForeground}` : "";
    ctx.ui.setStatus(
      "spoke",
      `${dot} AND${fg} | ${model} | ctx ${used}${pct} | $${cumulativeCost.toFixed(3)}`,
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
    void postToHub(
      { type: "status", from: role, ts: Date.now(), state, detail },
      { port: hubPort() },
    ).catch((err) => roleLog.warn("status post failed", { err: String(err) }));
    refreshUI();
  };

  /**
   * Self-check readiness: is the device reachable (adb sees the pinned serial)
   * and is the dev app foreground? Updates deviceReady/lastForeground and reports
   * a coarse SpokeReadyState. This answers auto-connect, resume, and the hub's
   * status ping.
   */
  const verifyReady = async (): Promise<void> => {
    try {
      const reachable = await device.isReachable();
      deviceReady = reachable;
      if (!reachable) {
        halted = true;
        reportStatus("needs-device", `device ${deviceCfg.serial} not reachable (USB detached?).`);
        return;
      }
      // Device is up; note the current foreground (for the widget + wrong-target view).
      try {
        const state = await device.appstate();
        lastForeground = state.package || undefined;
      } catch {
        lastForeground = undefined;
      }
      halted = false;
      markConnected(role);
      if (lastForeground && lastForeground !== androidPackage) {
        reportStatus(
          "wrong-target",
          `foreground is "${lastForeground}", not the dev app "${androidPackage}".`,
        );
        return;
      }
      reportStatus("ready", `device ${deviceCfg.serial} reachable; app "${androidPackage}".`);
    } catch (err) {
      roleLog.error("verifyReady failed", { err: String(err) });
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
          void verifyReady();
          return { ok: true };
        },
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
    await verifyReady();

    // Heartbeat loop.
    if (!heartbeatTimer) {
      heartbeatTimer = setInterval(sendHeartbeat, defaults.heartbeatIntervalMs);
      sendHeartbeat();
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
  pi.registerCommand("verify", {
    description: "Re-check device reachability + foreground app, and report readiness.",
    handler: async (_args, ctx) => {
      activeCtx = ctx;
      halted = false;
      await verifyReady();
      refreshUI(ctx);
    },
  });

  pi.registerCommand("spoke-status", {
    description: "Show this spoke's device + ready state.",
    handler: async (_args, ctx) => {
      activeCtx = ctx;
      const s = buildStatus();
      ctx.ui.notify(
        `AND: ${readyState}${halted ? " (HALTED)" : ""} | device=${
          deviceReady ? "ready" : "down"
        } | fg=${lastForeground ?? "?"} | $${s.cost?.toFixed(3) ?? "0"}`,
        halted ? "warning" : "info",
      );
      refreshUI(ctx);
    },
  });

  // ── The 8 verbs (registered as pi tools for the spoke's OWN LLM) ─────────────

  // 1) observe — a11y snapshot + foreground app/activity (CHEAP; the default eyes).
  pi.registerTool({
    name: "observe",
    label: "Observe (a11y + appstate)",
    description:
      "Read the screen cheaply: the accessibility-tree snapshot (text + @eN refs " +
      "you can tap) plus the foreground app/activity. Read-only — your DEFAULT eyes. " +
      "Prefer this over `look`; only screenshot when color/layout/vision matters. " +
      "Pass interactive:true to trim to interactive elements + refresh refs.",
    promptSnippet: "Read the screen cheaply (a11y snapshot + foreground app).",
    promptGuidelines: [
      "Use observe to look before acting; it is read-only and cheap.",
      "Only use look (screenshot) when color/layout/vision actually matters.",
    ],
    parameters: Type.Object({
      interactive: Type.Optional(
        Type.Boolean({
          description: "Trim to interactive elements only and refresh @eN refs (default false).",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      let foreground = "(unknown)";
      let activity = "";
      try {
        const state = await device.appstate();
        foreground = state.package || "(unknown)";
        activity = state.activity;
        lastForeground = state.package || undefined;
        deviceReady = true;
      } catch (err) {
        deviceReady = false;
        refreshUI(ctx);
        return {
          content: [
            {
              type: "text",
              text: `observe: device unreachable (${(err as Error).message}). The phone may be detached.`,
            },
          ],
          details: { deviceReady: false },
        };
      }
      const snap = await device.snapshot(params.interactive ?? false);
      refreshUI(ctx);
      const onTarget = foreground === androidPackage;
      const header =
        `Foreground: ${foreground}${activity ? ` (${activity})` : ""}` +
        (onTarget ? "" : `  ⚠ NOT the dev app ${androidPackage}`);
      return {
        content: [{ type: "text", text: `${header}\n\n${snap}` }],
        details: { foreground, activity, onTarget, interactive: params.interactive ?? false },
      };
    },
  });

  // 2) look — screenshot to /tmp; return the FILE PATH (LLM reads it only if vision matters).
  pi.registerTool({
    name: "look",
    label: "Look (screenshot → /tmp)",
    description:
      "Capture a screenshot of the phone to a /tmp PNG (downscaled to <=1200px) and " +
      "return its FILE PATH. Use this ONLY when color, layout, overlap, or other " +
      "visual detail actually matters — then read the returned file. For text / " +
      "bounds / presence checks use observe or assert instead (cheaper).",
    promptSnippet: "Screenshot the phone to /tmp and return the file path (read it only when vision matters).",
    promptGuidelines: [
      "Prefer observe; only use look when you genuinely need to SEE the pixels.",
      "look returns a file PATH — read that file; the image is never dumped inline.",
    ],
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({ description: "Short label for the filename (e.g. 'home', 'authkit')." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const safe = (params.label ?? "shot").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "shot";
      const out = join(tmpdir(), `pi-e2e-${safe}-${Date.now()}.png`);
      try {
        await device.screenshot(out, 1200);
      } catch (err) {
        return {
          content: [{ type: "text", text: `look failed: ${(err as Error).message}` }],
          details: { ok: false },
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `Screenshot saved to ${out} (<=1200px). Read this file ONLY if you need to see the pixels; otherwise prefer observe.`,
          },
        ],
        details: { path: out },
      };
    },
  });

  // 3) tap — guarded acting verb (wrong-target before, crash-guard after).
  pi.registerTool({
    name: "tap",
    label: "Tap (guarded)",
    description:
      "Tap the screen. Target is coordinates \"x y\", an @ref from observe, or a " +
      "selector (e.g. id=\"submit\" or label=\"Allow\"). GUARDED in code: refuses " +
      "unless the dev app is foreground (wrong-target guard), and fails the step if " +
      "new " + crashLogTag + " errors appear right after (crash-guard).",
    promptSnippet: "Tap by coords / @ref / selector (guarded to the dev app).",
    parameters: Type.Object({
      target: Type.String({
        description: 'What to tap: "x y" coords, an @ref from observe, or a selector like id="submit".',
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const { crash } = await withGuards("tap", () => device.click(params.target));
      if (crash) {
        return {
          content: [
            {
              type: "text",
              text: `Tapped ${params.target}, but the CRASH-GUARD tripped (new ${crashLogTag} errors):\n${crash}`,
            },
          ],
          details: { tapped: params.target, crashGuard: "tripped" },
        };
      }
      return {
        content: [{ type: "text", text: `Tapped ${params.target}.` }],
        details: { tapped: params.target },
      };
    },
  });

  // 4) type — guarded acting verb with the KEYCODE_ENTER auth-submit baked in.
  pi.registerTool({
    name: "type",
    label: "Type (guarded, auth-submit)",
    description:
      "Type text into the currently focused field. GUARDED in code (wrong-target + " +
      "crash-guard). Pass submit:true (the DEFAULT) to submit the field after typing " +
      "using THIS device's submit method (follow the Device note in your instructions); " +
      "pass submit:false to type without submitting.",
    promptSnippet: "Type into the focused field (submit:true submits it the device's way).",
    promptGuidelines: [
      "For auth fields, type with submit:true (default) and follow the Device note for how this phone submits.",
    ],
    parameters: Type.Object({
      text: Type.String({ description: "Exact text to type into the focused field." }),
      submit: Type.Optional(
        Type.Boolean({
          description:
            "Submit the field after typing using the device's submit method (default true). " +
            "Set false to type without submitting.",
        }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const submit = params.submit ?? true;
      const { crash } = await withGuards("type", async () => {
        await device.type(params.text);
        // Submit strategy comes from the selected DeviceProfile (e.g. samsung-galaxy
        // submits via KEYCODE_ENTER, NEVER by tapping Continue/Sign-in).
        if (submit) await profile.submit(device);
      });
      const note = submit ? " and submitted" : "";
      if (crash) {
        return {
          content: [
            {
              type: "text",
              text: `Typed${note}, but the CRASH-GUARD tripped (new ${crashLogTag} errors):\n${crash}`,
            },
          ],
          details: { typed: params.text.length, submit, crashGuard: "tripped" },
        };
      }
      return {
        content: [{ type: "text", text: `Typed ${params.text.length} char(s)${note}.` }],
        details: { typed: params.text.length, submit },
      };
    },
  });

  // 5) key — guarded acting verb: send a hardware key (enter / back / etc.).
  pi.registerTool({
    name: "key",
    label: "Key (guarded)",
    description:
      "Send a hardware key event (e.g. 'enter', 'back', 'tab'). GUARDED in code " +
      "(wrong-target + crash-guard). Use key('enter') to submit a focused field per " +
      "the Device note in your instructions.",
    promptSnippet: "Send a hardware key (enter to submit fields per the device note).",
    parameters: Type.Object({
      key: Type.String({
        description: "Key name (e.g. 'enter', 'back', 'tab') or a full KEYCODE_* name.",
      }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const { crash } = await withGuards("key", () => device.pressKey(params.key));
      if (crash) {
        return {
          content: [
            {
              type: "text",
              text: `Sent key '${params.key}', but the CRASH-GUARD tripped (new ${crashLogTag} errors):\n${crash}`,
            },
          ],
          details: { key: params.key, crashGuard: "tripped" },
        };
      }
      return {
        content: [{ type: "text", text: `Sent key '${params.key}'.` }],
        details: { key: params.key },
      };
    },
  });

  // 6) assert — is-predicate / visible-text check; contributes to the verdict.
  pi.registerTool({
    name: "assert",
    label: "Assert (UI predicate)",
    description:
      "Check a UI predicate on a selector and report whether it holds. Predicate is " +
      "one of visible | hidden | exists | editable | selected | text. For 'text', " +
      "pass the expected value to compare. Read-only (no guards); use this to verify " +
      "expected UI for your verdict (e.g. assert visible on a 'TODAY' label after login).",
    promptSnippet: "Assert a UI predicate (visible/hidden/exists/editable/selected/text) for your verdict.",
    promptGuidelines: [
      "Use assert to turn 'the screen should show X' into a concrete pass/fail signal.",
    ],
    parameters: Type.Object({
      predicate: Type.Union(
        [
          Type.Literal("visible"),
          Type.Literal("hidden"),
          Type.Literal("exists"),
          Type.Literal("editable"),
          Type.Literal("selected"),
          Type.Literal("text"),
        ],
        { description: "The UI predicate to check." },
      ),
      selector: Type.String({
        description: 'Selector or @ref to check, e.g. label="TODAY" or id="email" or @e12.',
      }),
      value: Type.Optional(
        Type.String({ description: "Expected value for the 'text' predicate." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const res = await device.is(params.predicate, params.selector, params.value);
      const verb = `is ${params.predicate} ${params.selector}${params.value ? ` = ${params.value}` : ""}`;
      return {
        content: [
          {
            type: "text",
            text: res.ok
              ? `ASSERT PASS: ${verb}`
              : `ASSERT FAIL: ${verb}${res.detail ? `\n${res.detail}` : ""}`,
          },
        ],
        details: { ok: res.ok, predicate: params.predicate, selector: params.selector },
      };
    },
  });

  // 7) app — launch / stop / cold-reset the dev app (guarded to the dev package).
  pi.registerTool({
    name: "app",
    label: "App (launch/stop/cold-reset)",
    description:
      `Control the dev app ${androidPackage}: action 'launch' (relaunch it), 'stop' ` +
      "(force-stop), or 'cold-reset' (force a true signed-out first run by removing " +
      "the app's configured reset files (target.resetPaths), then force-stop). All " +
      "actions are GUARDED to the dev package in code — they can never touch another " +
      "app. After launch, the crash-guard scans for startup " + crashLogTag + " errors.",
    promptSnippet: `Launch / stop / cold-reset the dev app ${androidPackage} (guarded).`,
    promptGuidelines: [
      "cold-reset gives you a signed-out first run (use before testing the sign-in flow).",
    ],
    parameters: Type.Object({
      action: Type.Union(
        [Type.Literal("launch"), Type.Literal("stop"), Type.Literal("cold-reset")],
        { description: "What to do with the dev app." },
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      // stop / cold-reset don't need the dev app foreground (they target it by
      // package id, which is inherently guarded); launch is the one we crash-scan.
      if (params.action === "stop") {
        await device.forceStop();
        lastForeground = undefined;
        refreshUI(ctx);
        return {
          content: [{ type: "text", text: `Force-stopped ${androidPackage}.` }],
          details: { action: "stop" },
        };
      }
      if (params.action === "cold-reset") {
        await device.coldReset();
        lastForeground = undefined;
        refreshUI(ctx);
        return {
          content: [
            {
              type: "text",
              text: `Cold-reset ${androidPackage}: removed SecureStore + MMKV user store and force-stopped. Next launch is a signed-out first run.`,
            },
          ],
          details: { action: "cold-reset" },
        };
      }
      // launch: open --relaunch, then crash-scan the startup window.
      const marker = await device.markLog();
      await device.launch();
      try {
        const state = await device.appstate();
        lastForeground = state.package || undefined;
        deviceReady = true;
      } catch {
        /* foreground read is best-effort right after launch */
      }
      refreshUI(ctx);
      const crash = await scanForCrash(device, marker || undefined, roleLog);
      if (!crash.ok) {
        guardTrip = { kind: "crash", detail: `${crash.reason}\n${crash.lines}` };
        return {
          content: [
            {
              type: "text",
              text: `Launched ${androidPackage}, but the CRASH-GUARD tripped at startup (new ${crashLogTag} errors):\n${crash.lines}`,
            },
          ],
          details: { action: "launch", crashGuard: "tripped" },
        };
      }
      return {
        content: [{ type: "text", text: `Launched ${androidPackage}.` }],
        details: { action: "launch" },
      };
    },
  });

  // 8) logcat — pull recent crash-tag error lines for the failure report.
  pi.registerTool({
    name: "logcat",
    label: `Logcat (${crashLogTag})`,
    description:
      "Pull recent " + crashLogTag + " log lines from the device — the silent app " +
      "errors observe/look can't see (e.g. red-box / unhandled exceptions). Use this " +
      "when building a failure report or diagnosing why a screen looks wrong.",
    promptSnippet: "Pull recent " + crashLogTag + " log lines for diagnosis / the failure report.",
    parameters: Type.Object({
      lines: Type.Optional(
        Type.Number({ description: "How many recent lines to return (default 80)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      activeCtx = ctx;
      const max = params.lines && params.lines > 0 ? Math.floor(params.lines) : 80;
      const out = await device.logcat({ max });
      const body = out.length ? out.split("\n").slice(-max).join("\n") : `(no ${crashLogTag} lines)`;
      return {
        content: [{ type: "text", text: `Recent ${crashLogTag} log:\n${body}` }],
        details: { lines: body.split("\n").length },
      };
    },
  });

  roleLog.info("spoke extension loaded", {
    role,
    serial: deviceCfg.serial,
    androidPackage,
    profile: profile.id,
  });
}
