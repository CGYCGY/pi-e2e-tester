/**
 * hub/index.ts — the HUB extension entry point for pi-e2e-tester.
 *
 * The user-facing orchestrator. It:
 *   - validates the expari target dir, then runs the localhost transport server
 *     (receives register/heartbeat/intent_result/status from the android spoke),
 *   - tracks spoke liveness via heartbeats + renders a below-editor widget + a
 *     custom 2-line footer (model | ctx | cost),
 *   - AUTO-BRINGS-UP the whole stack on startup with ZERO user signal:
 *       usb_attach -> dev_up -> spawn android spoke (HUB_PORT=<resolved>) -> wait
 *       for the spoke's register / ready status,
 *   - exposes the bring-up as explicit tools too (usb_attach / dev_up / dev_down),
 *   - exposes `messenger({target, intent})` — the ONE door in phase 1: POST a
 *     natural-language intent to the spoke, correlate the intent_result by
 *     requestId, return { verdict, text }.
 *
 * The hub CANNOT see or touch the phone. Every android test goes through the spoke
 * via `messenger`. Readiness detection is DETERMINISTIC NODE (zero LLM tokens):
 * the hub backgrounds expari's PLAIN recipes + usbipd attach into <logsDir>/*.log
 * and tails them for the real ready signal (log-regex OR probe backstop).
 *
 * Modeled on pi-4b-tester/hub/{index,spokes,ui}.ts — same pi extension API usage.
 */

import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import { openSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { Type } from "typebox";

import {
  assertTargetValid,
  getDefaults,
  getDevice,
  getHost,
  getLogsDir,
  getPort,
  getReadiness,
  getTarget,
} from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import { markConnected } from "../shared/state.ts";
import {
  createTransportServer,
  postToSpoke,
  type TransportServer,
} from "../shared/transport.ts";
import type { Verdict } from "../shared/types.ts";
import {
  makeAdbProbe,
  makeMetroProbe,
  tailLog,
  waitForReady,
} from "./ready.ts";
import {
  resumeSpoke,
  shutdownSpoke,
  SpokeRegistry,
  spawnSpoke,
  SPOKE_ROLE,
} from "./spokes.ts";
import {
  installHubFooter,
  renderSpokeWidget,
  setBusyIndicator,
  statusSummary,
  STATUS_KEY,
  WIDGET_KEY,
} from "./ui.ts";

/** Custom message types for display-only renders. */
const VERDICT_TYPE = "expari-verdict";

/** Hub-specific operating rules appended to the agent system prompt. */
const HUB_RULES = `

You are the HUB of the pi-e2e-tester harness. You orchestrate ONE android spoke that drives a real Galaxy S21 test phone (the expari dev app). You CANNOT see or touch the phone yourself.

For ANY android test request — opening the app, tapping, typing, reading a screen, asserting a state — you MUST use the \`messenger\` tool: \`messenger({ target: "android", intent: "<plain-language instruction>" })\`. The spoke's own LLM interprets the intent, drives the device, and returns a verdict (PASS|FAIL) plus text.

NEVER answer an android question from your own memory or context. NEVER phrase a read as something else — to READ a screen, say so explicitly in the intent (e.g. "read the home screen and report what you see"). Relay the spoke's verdict + text back to the user faithfully.

The stack (USB passthrough + expari convex/metro dev servers + the spoke) is brought up AUTOMATICALLY at startup — you do not need to ask the user to start anything. If a test fails because the device is unreachable or a dev server is down, you may re-run \`usb_attach\` or \`dev_up\`; use \`dev_down\` only to tear the dev servers down.`;

export default function (pi: ExtensionAPI) {
  const log = createLogger("hub");
  const registry = new SpokeRegistry(log);

  // In-flight `messenger` intents, keyed by requestId. The intentResult handler
  // looks up the awaiting promise here and resolves/rejects it (mirrors the
  // sibling's messengerPending correlation map).
  const messengerPending = new Map<
    string,
    {
      resolve: (r: { verdict: Verdict; text: string }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  // Hub cumulative cost (summed from assistant message_end usage).
  let cumulativeCost = 0;

  let transport: TransportServer | null = null;
  /** The hub's RESOLVED transport port (after any EADDRINUSE fallback). */
  let resolvedHubPort = 0;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let renderTimer: ReturnType<typeof setInterval> | null = null;
  /** Guard so the auto-bring-up runs at most once per session. */
  let broughtUp = false;

  // Capture an ExtensionContext for use by timers / async transport handlers.
  let lastCtx: ExtensionContext | null = null;

  /* ─────────────────────────── rendering ─────────────────────────── */

  function rerender(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    renderSpokeWidget(ctx, registry.all());
  }

  /** Set a footer status segment (visible in line 1 of the custom footer). */
  function setStatus(text: string | undefined): void {
    if (lastCtx?.hasUI) lastCtx.ui.setStatus(STATUS_KEY, text);
  }

  /** Notify helper that no-ops when there is no UI (timers / bring-up). */
  function notify(text: string, sev: "info" | "warning" | "error" = "info"): void {
    if (lastCtx?.hasUI) lastCtx.ui.notify(text, sev);
  }

  /* ─────────────────── backgrounding into logsDir ─────────────────── */

  /**
   * Background a shell command DETACHED, redirecting stdout+stderr into a logfile
   * under logsDir — this is the spec's `-bg + logfile` mechanism that gives BOTH
   * visibility (read the file) AND auto-readiness (tail the file for the signal).
   *
   * MECHANISM: we open the logfile for append and hand its fd to child stdio, then
   * `child.unref()` + `detached:true` so the child outlives this turn (nohup-like:
   * it keeps running and writing the log even after the hub turn returns). The
   * command runs through `bash -lic` so login rc files set PATH (just/adb/convex).
   */
  function backgroundToLog(
    command: string,
    logName: string,
    opts: { cwd?: string } = {},
  ): { logPath: string; pid?: number } {
    const logPath = join(getLogsDir(), `${logName}.log`);
    // Append (not truncate): keep prior bring-up history for diagnosis.
    const fd = openSync(logPath, "a");
    log.info(`background -> ${logName}.log`, { command, cwd: opts.cwd });
    try {
      const child = spawn("bash", ["-lic", command], {
        cwd: opts.cwd,
        detached: true,
        stdio: ["ignore", fd, fd],
      });
      child.on("error", (err) =>
        log.error(`background ${logName} failed`, { error: String(err) }),
      );
      child.unref();
      return { logPath, pid: child.pid };
    } catch (err) {
      log.error(`background ${logName} threw`, { error: String(err) });
      return { logPath };
    }
  }

  /* ──────────────────────── bring-up steps ───────────────────────── */

  /**
   * usb_attach — background `usbipd.exe attach --wsl --busid <busid> --auto-attach`
   * into logsDir/usbipd.log, then wait until the device is reachable (log signal
   * readiness.usbAttached OR the adb probe backstop). usbipd.exe is a WINDOWS
   * binary invoked from WSL; --auto-attach keeps it re-attaching across replugs.
   */
  async function usbAttach(): Promise<{ ok: boolean; detail: string }> {
    const device = getDevice();
    const readiness = getReadiness();
    setStatus("usb_attach…");
    const cmd =
      `${device.usbipd} attach --wsl --busid ${device.busid} --auto-attach`;
    const { logPath } = backgroundToLog(cmd, "usbipd");
    const res = await waitForReady({
      label: "usb",
      logPath,
      readyRegex: readiness.usbAttached,
      probe: makeAdbProbe(readiness.probeAdb, device.serial),
      log,
    });
    setStatus(undefined);
    if (res.ready) {
      return { ok: true, detail: `device attached (via ${res.via}, ${res.elapsedMs}ms)` };
    }
    return {
      ok: false,
      detail:
        `usb attach did not become ready within ${res.elapsedMs}ms.\n` +
        `--- last log lines (${logPath}) ---\n${res.tail ?? "(none)"}`,
    };
  }

  /**
   * dev_up — background expari's PLAIN dev recipes into logsDir, then wait until
   * each is ready (log signal OR probe backstop):
   *   - `just convex-dev`  -> logsDir/convex.log  (readiness.convexReady)
   *   - `just mobile-dev`  -> logsDir/metro.log   (readiness.metroReady / probeMetro)
   * Kills any prior instance of each first so a stale server can't shadow a fresh
   * one. expari's repo is never edited; we only run its public recipes.
   */
  async function devUp(): Promise<{ ok: boolean; detail: string }> {
    const target = getTarget();
    const readiness = getReadiness();
    setStatus("dev_up…");

    // Kill any prior convex/metro the hub previously backgrounded (precise
    // patterns so we don't touch unrelated processes). `just <recipe>` execs the
    // underlying convex/expo; match the recipe invocations we started. Await the
    // kills so a stale server is gone before we spawn the fresh one.
    await killByPattern("just convex-dev");
    await killByPattern("just mobile-dev");

    const convex = backgroundToLog("just convex-dev", "convex", { cwd: target.dir });
    const metro = backgroundToLog("just mobile-dev", "metro", { cwd: target.dir });

    // Wait for BOTH in parallel; each has its own log signal + probe backstop.
    const [convexRes, metroRes] = await Promise.all([
      waitForReady({
        label: "convex",
        logPath: convex.logPath,
        readyRegex: readiness.convexReady,
        log,
      }),
      waitForReady({
        label: "metro",
        logPath: metro.logPath,
        readyRegex: readiness.metroReady,
        probe: makeMetroProbe(readiness.probeMetro),
        log,
      }),
    ]);
    setStatus(undefined);

    const fails: string[] = [];
    if (!convexRes.ready) {
      fails.push(
        `convex not ready (${convexRes.elapsedMs}ms)\n` +
          `--- last log lines (${convex.logPath}) ---\n${convexRes.tail ?? "(none)"}`,
      );
    }
    if (!metroRes.ready) {
      fails.push(
        `metro not ready (${metroRes.elapsedMs}ms)\n` +
          `--- last log lines (${metro.logPath}) ---\n${metroRes.tail ?? "(none)"}`,
      );
    }
    if (fails.length === 0) {
      return {
        ok: true,
        detail: `dev servers ready (convex via ${convexRes.via}, metro via ${metroRes.via})`,
      };
    }
    return { ok: false, detail: fails.join("\n\n") };
  }

  /**
   * dev_down — kill the backgrounded convex/metro dev servers (and optionally the
   * spoke). usbipd --auto-attach is LEFT RUNNING unless explicitly asked, so a
   * replug keeps working. Precise pkill patterns avoid collateral kills.
   */
  async function devDown(opts: { spoke?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
    const killed: string[] = [];
    if (await killByPattern("just convex-dev")) killed.push("convex");
    if (await killByPattern("just mobile-dev")) killed.push("metro");
    if (opts.spoke && registry.isConnected()) {
      await shutdownSpoke(registry.port(), "hub dev_down");
      killed.push("spoke");
    }
    return {
      ok: true,
      detail: killed.length ? `stopped: ${killed.join(", ")}` : "nothing to stop",
    };
  }

  /**
   * pkill -f a precise pattern; resolves true iff a process matched (pkill exits 0
   * on a match, 1 on no-match). The pattern is matched as one substring against
   * the full command line, so "just convex-dev" only hits the recipe we started —
   * it won't touch unrelated processes. Never rejects.
   */
  function killByPattern(pattern: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const r = spawn("pkill", ["-f", pattern], { stdio: "ignore" });
        r.on("error", (err) => {
          log.warn("pkill error", { pattern, error: String(err) });
          resolve(false);
        });
        r.on("close", (code) => {
          log.info("pkill", { pattern, code });
          resolve(code === 0); // 0 = matched + signalled; 1 = no match
        });
      } catch (err) {
        log.warn("pkill threw", { pattern, error: String(err) });
        resolve(false);
      }
    });
  }

  /* ────────────────────── auto-orchestration ─────────────────────── */

  /**
   * The full automatic bring-up, run once at session_start (the spec REQUIRES it
   * fully automatic — the user never signals ready). Each step logs a milestone;
   * a step that times out STOPS the sequence with a clear report.
   */
  async function autoBringUp(): Promise<void> {
    if (broughtUp) return;
    broughtUp = true;
    if (lastCtx) setBusyIndicator(lastCtx, true);
    try {
      // 1) USB passthrough.
      notify("bring-up: attaching USB device…");
      const usb = await usbAttach();
      log.info("bring-up usb_attach", usb);
      if (!usb.ok) {
        notify(`bring-up STOPPED at usb_attach: ${usb.detail}`, "error");
        return;
      }
      notify(`usb attached: ${usb.detail}`);

      // 2) expari dev servers (convex + metro).
      notify("bring-up: starting expari dev servers (convex + metro)…");
      const dev = await devUp();
      log.info("bring-up dev_up", { ok: dev.ok });
      if (!dev.ok) {
        notify(`bring-up STOPPED at dev_up: ${dev.detail}`, "error");
        return;
      }
      notify(`dev servers ready: ${dev.detail}`);

      // 3) Spawn the android spoke, passing the hub's RESOLVED port via HUB_PORT.
      notify("bring-up: spawning android spoke…");
      spawnSpoke(resolvedHubPort, log);

      // 4) Wait for the spoke to register / become ready (heartbeat-based).
      const ok = await waitForSpokeReady();
      if (!ok) {
        notify(
          `bring-up: android spoke did not connect within ` +
            `${Math.round(getDefaults().spokeConnectTimeoutMs / 1000)}s — ` +
            `check the spoke window or its log.`,
          "warning",
        );
        return;
      }
      markConnected(SPOKE_ROLE);
      notify("bring-up complete — android spoke connected. Ready to test.");
      log.info("bring-up complete");
    } finally {
      if (lastCtx?.hasUI) setBusyIndicator(lastCtx, false);
      if (lastCtx) rerender(lastCtx);
    }
  }

  /**
   * Poll until the spoke is connected (a register/heartbeat landed) within the
   * spokeConnectTimeoutMs budget. A cold android spoke (new WSL window +
   * agent-device init) can take tens of seconds, so we poll rather than race a
   * fixed timer.
   */
  async function waitForSpokeReady(): Promise<boolean> {
    const budget = getDefaults().spokeConnectTimeoutMs;
    const poll = getDefaults().readyPollIntervalMs;
    const started = Date.now();
    setStatus("waiting for spoke…");
    while (Date.now() - started < budget) {
      if (registry.isConnected()) {
        setStatus(undefined);
        if (lastCtx) rerender(lastCtx);
        return true;
      }
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const t = setTimeout(r, poll);
        t.unref?.();
      });
    }
    setStatus(undefined);
    return false;
  }

  /* ─────────────────────── transport handlers ────────────────────── */

  async function startTransport(): Promise<void> {
    if (transport) return;
    const host = getHost();
    transport = await createTransportServer({
      // Preferred hub port from config; createTransportServer auto-falls-back to
      // the next free port. We capture the RESOLVED port to pass to the spoke.
      port: getPort("hub"),
      host,
      handlers: {
        register: (m) => {
          // The spoke reports its OWN RESOLVED port here — capture it so every
          // intent POSTs to the right place even after a spoke-side fallback.
          registry.onRegister(m.port);
          if (lastCtx) rerender(lastCtx);
          return { ok: true };
        },
        heartbeat: (m) => {
          registry.onHeartbeat(m.status);
          return { ok: true };
        },
        intentResult: (m) => {
          // Correlate the spoke's final verdict back to the awaiting `messenger`
          // tool promise. Unknown ids are tolerated.
          const pending = messengerPending.get(m.requestId);
          log.info("intent_result received", {
            from: m.from,
            requestId: m.requestId,
            ok: m.ok,
            verdict: m.verdict,
            consumed: !!pending,
          });
          if (!pending) return { ok: true };
          clearTimeout(pending.timer);
          messengerPending.delete(m.requestId);
          if (m.ok) pending.resolve({ verdict: m.verdict, text: m.text });
          else pending.reject(new Error(m.error ?? `intent failed (${m.verdict})`));
          return { ok: true };
        },
        status: (m) => {
          const deviceReady = m.state === "ready";
          registry.onStatus(deviceReady, m.detail ?? m.state);
          if (lastCtx?.hasUI) {
            const sev = m.state === "ready" ? "info" : "warning";
            notify(`android: ${m.state}${m.detail ? ` — ${m.detail}` : ""}`, sev);
            rerender(lastCtx);
          }
          return { ok: true };
        },
        onError: (err, raw) =>
          log.error("transport error", { error: String(err), raw: raw.slice(0, 200) }),
      },
    });
    resolvedHubPort = transport.port;
    log.info(`hub transport listening on ${host}:${resolvedHubPort}`);
  }

  /* ───────────────────────── lifecycle ───────────────────────────── */

  // Append the hub operating rules so the LLM always routes android work through
  // the spoke via `messenger`.
  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + HUB_RULES,
  }));

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    cumulativeCost = 0;

    // STARTUP GUARD: fail loud immediately if the expari target dir is stale,
    // before any bring-up touches just/adb (config.ts assertTargetValid).
    try {
      assertTargetValid();
    } catch (err) {
      notify(`config error: ${(err as Error).message}`, "error");
      log.error("assertTargetValid failed", { error: String(err) });
      return;
    }

    // Custom 2-line footer (model/ctx/cost). Installed once; reads live values.
    installHubFooter(pi, ctx, () => cumulativeCost);
    await startTransport();

    // Liveness reaper: flip a stale spoke to disconnected, re-render.
    if (!liveTimer) {
      liveTimer = setInterval(() => {
        if (registry.reapStale() && lastCtx) rerender(lastCtx);
      }, getDefaults().heartbeatIntervalMs);
      liveTimer.unref?.();
    }
    // Periodic re-render so spoke status (model/ctx/cost) stays fresh.
    if (!renderTimer) {
      renderTimer = setInterval(() => {
        if (lastCtx) rerender(lastCtx);
      }, getDefaults().heartbeatIntervalMs);
      renderTimer.unref?.();
    }

    rerender(ctx);

    // AUTO-BRING-UP: usb_attach -> dev_up -> spawn spoke -> wait for register.
    // Fully automatic — the user never signals ready. Run detached so the prompt
    // is usable immediately; milestones surface via notify + the footer status.
    notify("pi-e2e-tester hub starting — auto-bringing-up the stack…", "info");
    void autoBringUp().catch((err) => {
      log.error("autoBringUp threw", { error: String(err) });
      notify(`bring-up error: ${String(err)}`, "error");
    });
  });

  pi.on("session_shutdown", async () => {
    // SHUTDOWN CASCADE: tell the spoke to shut down BEFORE tearing down our own
    // transport. Bounded so a hung spoke can't block hub exit.
    try {
      if (registry.isConnected()) {
        await shutdownSpoke(registry.port(), "hub session_shutdown");
      }
    } catch {
      /* ignore */
    }
    if (liveTimer) clearInterval(liveTimer);
    if (renderTimer) clearInterval(renderTimer);
    liveTimer = null;
    renderTimer = null;
    if (transport) {
      try {
        await transport.close();
      } catch {
        /* ignore */
      }
      transport = null;
    }
    log.info("hub shutdown");
  });

  // Track hub cost + refresh status from assistant usage.
  pi.on("message_end", async (event, ctx) => {
    lastCtx = ctx;
    if (event.message.role === "assistant") {
      const cost = event.message.usage?.cost?.total;
      if (typeof cost === "number") cumulativeCost += cost;
      rerender(ctx);
    }
  });

  pi.on("turn_end", async (_event, ctx) => {
    lastCtx = ctx;
    rerender(ctx);
  });

  /* ──────────────────── display renderer (verdict) ────────────────── */

  const asText = (content: unknown): string =>
    typeof content === "string"
      ? content
      : Array.isArray(content)
        ? content
            .map((p) =>
              p && typeof p === "object" && "text" in p
                ? String((p as { text?: unknown }).text ?? "")
                : "",
            )
            .join("")
        : String(content ?? "");

  pi.registerMessageRenderer(VERDICT_TYPE, (message, _options, theme) => {
    const ok = (message.details as { pass?: boolean } | undefined)?.pass;
    const tag = ok ? theme.fg("success", "✓ ") : theme.fg("error", "✗ ");
    return new Text(tag + asText(message.content), 0, 0);
  });

  /* ───────────────────────── commands ─────────────────────────────── */

  pi.registerCommand("status", {
    description: "Show hub + android spoke connection / readiness status",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      const lines = statusSummary(registry.all());
      lines.unshift(`hub: listening :${resolvedHubPort}`);
      ctx.ui.setWidget("expari-status-dump", lines, { placement: "belowEditor" });
      ctx.ui.notify(lines.join("  |  "), "info");
      setTimeout(() => {
        ctx.ui.setWidget("expari-status-dump", undefined);
        rerender(ctx);
      }, 6000);
    },
  });

  pi.registerCommand("continue", {
    description: "Tell the android spoke to re-verify readiness and continue",
    handler: async (_args, ctx) => {
      lastCtx = ctx;
      if (!registry.isConnected()) {
        ctx.ui.notify("android spoke is not connected.", "warning");
        return;
      }
      const res = await resumeSpoke(registry.port());
      ctx.ui.notify(`continue android: ${res.detail}`, res.ok ? "info" : "warning");
    },
  });

  /* ─────────────────────────── tools ──────────────────────────────── */

  // messenger: THE single door to the android spoke. The hub sends a
  // natural-language INTENT; the spoke's own LLM interprets it (driving the
  // device via its tools) and returns a PASS/FAIL verdict + text. The hub never
  // touches the phone directly.
  pi.registerTool({
    name: "messenger",
    label: "Messenger",
    description:
      "Send a natural-language instruction to the android spoke, which drives the real test phone " +
      "(the expari dev app) and returns a PASS/FAIL verdict plus text. Use this for ANY android " +
      "test — opening the app, tapping, typing, reading a screen, or asserting state. To READ a " +
      "screen, say so explicitly in the intent; never phrase a read as something else.",
    promptSnippet: "Drive the android test phone by sending a natural-language intent to its spoke",
    promptGuidelines: [
      "Use messenger for any android action; set target:'android' and express what you want in plain language as `intent`.",
      "To read/observe a screen, say so explicitly (e.g. \"open the app and read the home screen\"); the spoke returns a verdict + text.",
      "Relay the spoke's verdict (PASS/FAIL) and text back to the user; do not answer android questions from memory.",
    ],
    parameters: Type.Object({
      target: Type.Literal("android", {
        description: 'Which spoke to drive. Phase 1 has only "android".',
      }),
      intent: Type.String({
        description:
          'Natural-language instruction for the spoke (e.g. "open the dev app and check it reaches the home screen").',
      }),
    }),
    async execute(_toolCallId, params, signal, _onUpdate, ctx) {
      lastCtx = ctx;
      if (!registry.isConnected()) {
        throw new Error(
          "android spoke is not connected (bring-up may still be in progress). " +
            "Check /status; re-run usb_attach / dev_up if a dependency is down.",
        );
      }
      const requestId = randomUUID();
      const timeoutMs = getDefaults().intentTimeoutMs;
      const spokePort = registry.port();

      const result = await new Promise<{ verdict: Verdict; text: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          messengerPending.delete(requestId);
          reject(new Error(`android did not answer the intent within ${timeoutMs}ms (timeout).`));
        }, timeoutMs);
        timer.unref?.();

        // Abort path: drop the pending entry if the tool call is cancelled.
        const onAbort = () => {
          clearTimeout(timer);
          messengerPending.delete(requestId);
          reject(new Error("messenger intent aborted"));
        };
        if (signal?.aborted) {
          onAbort();
          return;
        }
        signal?.addEventListener("abort", onAbort, { once: true });

        messengerPending.set(requestId, { resolve, reject, timer });

        // POST the intent to the spoke's RESOLVED port; fail fast if the POST itself fails.
        void postToSpoke(
          SPOKE_ROLE,
          {
            type: "intent",
            from: "hub",
            ts: Date.now(),
            requestId,
            intent: params.intent,
            timeoutMs,
          },
          { port: spokePort, timeoutMs: 10000 },
        ).then(
          (res) => {
            if (!res.ok) {
              clearTimeout(timer);
              messengerPending.delete(requestId);
              reject(new Error(`android rejected the intent (HTTP ${res.status}).`));
            }
          },
          (err: unknown) => {
            clearTimeout(timer);
            messengerPending.delete(requestId);
            reject(new Error(`failed to reach android spoke: ${String(err)}`));
          },
        );
      });

      // Surface the verdict as a display-only custom message + return it.
      if (ctx.hasUI) {
        pi.sendMessage(
          {
            customType: VERDICT_TYPE,
            content: `[android] ${result.verdict}: ${result.text}`,
            display: true,
            details: { pass: result.verdict === "PASS" },
          },
          { deliverAs: "nextTurn" },
        );
      }
      return {
        content: [{ type: "text", text: `${result.verdict}: ${result.text}` }],
        details: { target: SPOKE_ROLE, requestId, verdict: result.verdict, text: result.text },
      };
    },
  });

  // usb_attach: background usbipd attach + wait for device readiness.
  pi.registerTool({
    name: "usb_attach",
    label: "USB attach",
    description:
      "Attach the test phone to WSL via usbipd USB passthrough (background, auto-attach) and wait " +
      "until adb sees the device. Run this if the device became unreachable. Returns when ready or " +
      "reports the last usbipd log lines on timeout.",
    promptSnippet: "Attach the test phone to WSL over usbipd and wait until adb sees it",
    promptGuidelines: [
      "Use usb_attach if a test fails because the device is unreachable (USB detached).",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const res = await usbAttach();
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });

  // dev_up: background expari's convex + metro dev recipes + wait ready.
  pi.registerTool({
    name: "dev_up",
    label: "Dev up",
    description:
      "Start expari's dev servers (convex + metro) in the background and wait until each is ready " +
      "(log signal or probe backstop). Kills any prior instance first. Run this if a dev server " +
      "went down. Returns when ready or reports the last log lines on timeout.",
    promptSnippet: "Start expari's convex + metro dev servers and wait until ready",
    promptGuidelines: [
      "Use dev_up if a test fails because convex or metro is down.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const res = await devUp();
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });

  // dev_down: stop the backgrounded convex/metro (+ optionally the spoke).
  pi.registerTool({
    name: "dev_down",
    label: "Dev down",
    description:
      "Stop the backgrounded expari dev servers (convex + metro). usbipd auto-attach is left running " +
      "unless you also stop the spoke. Use this to tear the dev stack down.",
    promptSnippet: "Stop expari's convex + metro dev servers",
    promptGuidelines: [
      "Use dev_down to tear the dev stack down; pass stopSpoke:true to also shut the android spoke.",
    ],
    parameters: Type.Object({
      stopSpoke: Type.Optional(
        Type.Boolean({ description: "Also shut down the android spoke (default false)." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      lastCtx = ctx;
      const res = await devDown({ spoke: params.stopSpoke === true });
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });
}

/* Keep helper imports referenced for clarity / future use. */
void tailLog;
void WIDGET_KEY;
