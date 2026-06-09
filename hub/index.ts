// hub/index.ts — the HUB extension entry point.
//
// The hub CANNOT see or touch the phone — every android test goes through the
// spoke via `messenger`. It auto-brings-up the whole stack at startup with ZERO
// user signal (usb_attach -> dev_up -> spawn spoke -> wait for register/ready).
// Readiness detection is DETERMINISTIC NODE (zero LLM tokens): the hub backgrounds
// the app's PLAIN recipes + usbipd attach into <logsDir> and tails them for the
// real ready signal (log-regex OR probe backstop).

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";

import {
  assertTargetValid,
  getAndroidPlatform,
  getConfiguredPlatforms,
  getDefaults,
  getHost,
  getLogsDirForApp,
  getPort,
  getReadiness,
  getTarget,
  getTestsDirs,
} from "../shared/config.ts";
import { createLogger } from "../shared/log.ts";
import { ensureLogsDir, markConnected } from "../shared/state.ts";
import {
  createTransportServer,
  type TransportServer,
} from "../shared/transport.ts";
import type { SpokeRole, Verdict } from "../shared/types.ts";
import { registerHubCommands } from "./commands.ts";
import {
  makeAdbProbe,
  makeMetroProbe,
  tailLog,
  waitForReady,
} from "./ready.ts";
import {
  BUILT_SPOKE_ROLES,
  shutdownSpoke,
  SpokeRegistry,
  spawnSpoke,
} from "./spokes.ts";
import { registerHubTools } from "./tools.ts";
import {
  installHubFooter,
  renderSpokeWidget,
  setBusyIndicator,
  STATUS_KEY,
  WIDGET_KEY,
} from "./ui.ts";

const VERDICT_TYPE = "expari-verdict";

const HUB_RULES = `

You are the HUB of the pi-e2e-tester harness. You orchestrate an android spoke that drives a real test phone (the app under test's dev build). You CANNOT see or touch the phone yourself.

For ANY android test request — opening the app, tapping, typing, reading a screen, asserting a state — you MUST use the \`messenger\` tool: \`messenger({ target: "android", intent: "<plain-language instruction>" })\`. The spoke's own LLM interprets the intent, drives the device, and returns a verdict (PASS|FAIL) plus text.

NEVER answer an android question from your own memory or context. NEVER phrase a read as something else — to READ a screen, say so explicitly in the intent (e.g. "read the home screen and report what you see"). Relay the spoke's verdict + text back to the user faithfully.

The stack (USB passthrough + the app's convex/metro dev servers + the spoke) is brought up AUTOMATICALLY at startup — you do not need to ask the user to start anything. If a test fails because the device is unreachable or a dev server is down, you may re-run \`usb_attach\` or \`dev_up\`; use \`dev_down\` only to tear the dev servers down.`;

export default function (pi: ExtensionAPI) {
  const log = createLogger("hub");
  const registry = new SpokeRegistry(log);

  // Keyed by requestId; the intentResult handler resolves/rejects the matching entry.
  const messengerPending = new Map<
    string,
    {
      resolve: (r: { verdict: Verdict; text: string }) => void;
      reject: (e: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  let cumulativeCost = 0;

  let transport: TransportServer | null = null;
  /** RESOLVED port after any EADDRINUSE fallback — what the spoke registers to. */
  let resolvedHubPort = 0;
  let liveTimer: ReturnType<typeof setInterval> | null = null;
  let renderTimer: ReturnType<typeof setInterval> | null = null;
  let broughtUp = false;
  /** Latched on first GREEN; re-armed on disconnect so a replug re-announces. */
  let readyAnnounced = false;

  // Timers + async transport handlers have no ctx of their own; they read this.
  let lastCtx: ExtensionContext | null = null;

  function rerender(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return;
    renderSpokeWidget(ctx, registry.all());
  }

  function setStatus(text: string | undefined): void {
    if (lastCtx?.hasUI) lastCtx.ui.setStatus(STATUS_KEY, text);
  }

  function notify(text: string, sev: "info" | "warning" | "error" = "info"): void {
    if (lastCtx?.hasUI) lastCtx.ui.notify(text, sev);
  }

  // The spec's `-bg + logfile` mechanism: gives BOTH visibility (read the file)
  // AND auto-readiness (tail it for the signal). detached + unref means the child
  // outlives this turn (nohup-like); `bash -lic` lets login rc files set PATH so
  // just/adb/convex resolve.
  function backgroundToLog(
    command: string,
    logName: string,
    opts: { cwd?: string } = {},
  ): { logPath: string; pid?: number } {
    const logPath = join(getLogsDirForApp(), `${logName}.log`);
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

  // True iff any process matches (pgrep exits 0 on match, 1 on none). Never rejects.
  function isRunning(pattern: string): Promise<boolean> {
    return new Promise<boolean>((resolve) => {
      try {
        const r = spawn("pgrep", ["-f", pattern], { stdio: "ignore" });
        r.on("error", () => resolve(false));
        r.on("close", (code) => resolve(code === 0));
      } catch {
        resolve(false);
      }
    });
  }

  // usbipd.exe is a WINDOWS binary invoked from WSL; --auto-attach keeps it
  // re-attaching across device replugs. We NEVER tear it down: it spawns a ROOT
  // helper the user-owned hub can't kill (and usbipd detach won't reap it), so we
  // make this idempotent instead — if a monitor for this busid already exists
  // (matches BOTH the usbipd.exe wrapper and the usbip-auto-attach helper), reuse
  // it rather than stacking a second. The adb probe in waitForReady is what
  // actually confirms the device, so a reused monitor verifies the same way.
  async function usbAttach(): Promise<{ ok: boolean; detail: string }> {
    const android = getAndroidPlatform();
    const device = android.device;
    setStatus("usb_attach…");
    const logPath = join(getLogsDirForApp(), "usbipd.log");
    if (await isRunning(`busid ${device.busid}`)) {
      log.info("usb auto-attach already running — reusing", { busid: device.busid });
    } else {
      const cmd =
        `${device.usbipd} attach --wsl --busid ${device.busid} --auto-attach`;
      backgroundToLog(cmd, "usbipd");
    }
    const res = await waitForReady({
      label: "usb",
      logPath,
      readyRegex: android.usbAttached,
      probe: makeAdbProbe(android.probeAdb, device.serial),
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

  // Runs the target's PUBLIC dev recipes only — its repo is never edited. Kills any
  // prior instance first so a stale server can't shadow the fresh one.
  async function devUp(): Promise<{ ok: boolean; detail: string }> {
    const target = getTarget();
    const readiness = getReadiness();
    setStatus("dev_up…");

    // Await the kills so a stale server is gone before we spawn the fresh one.
    await killByPattern("just convex-dev");
    await killByPattern("just mobile-dev");

    const convex = backgroundToLog("just convex-dev", "convex", { cwd: target.dir });
    const metro = backgroundToLog("just mobile-dev", "metro", { cwd: target.dir });

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

  // usbipd --auto-attach is LEFT RUNNING unless opts.spoke, so a replug keeps working.
  async function devDown(opts: { spoke?: boolean } = {}): Promise<{ ok: boolean; detail: string }> {
    const killed: string[] = [];
    if (await killByPattern("just convex-dev")) killed.push("convex");
    if (await killByPattern("just mobile-dev")) killed.push("metro");
    if (opts.spoke) {
      for (const r of registry.roles()) {
        if (registry.isConnected(r)) {
          await shutdownSpoke(r, registry.port(r), "hub dev_down");
          killed.push(`spoke:${r}`);
        }
      }
    }
    return {
      ok: true,
      detail: killed.length ? `stopped: ${killed.join(", ")}` : "nothing to stop",
    };
  }

  // Resolves true iff a process matched (pkill exits 0 on match, 1 on no-match).
  // The pattern is one substring vs the full command line, so "just convex-dev"
  // only hits the recipe we started. Never rejects.
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
          resolve(code === 0);
        });
      } catch (err) {
        log.warn("pkill threw", { pattern, error: String(err) });
        resolve(false);
      }
    });
  }

  // The single owner of the "Ready to test" announcement, called after every
  // heartbeat/status. The readyAnnounced latch (re-armed below) keeps it to once
  // per green transition so a replug re-announces but steady state doesn't spam.
  function maybeAnnounceReady(): void {
    const roles = registry.roles();
    const allReady = roles.length > 0 && roles.every((r) => registry.isReady(r));
    if (allReady && !readyAnnounced) {
      readyAnnounced = true;
      for (const r of roles) markConnected(r);
      notify(
        `bring-up complete — spoke ready (${roles.join(", ")}; dev app foreground). Ready to test.`,
      );
      if (lastCtx) rerender(lastCtx);
    } else if (!allReady && readyAnnounced) {
      readyAnnounced = false;
    }
  }

  // Poll rather than race a fixed timer: a cold spoke (new WSL window + agent-device
  // init) can take tens of seconds.
  async function waitForSpoke(pred: () => boolean, budgetMs: number): Promise<boolean> {
    const poll = getDefaults().readyPollIntervalMs;
    const started = Date.now();
    while (Date.now() - started < budgetMs) {
      if (pred()) return true;
      // eslint-disable-next-line no-await-in-loop
      await new Promise((r) => {
        const t = setTimeout(r, poll);
        t.unref?.();
      });
    }
    return false;
  }

  // Runs once at session_start. A host-side failure (dev servers) STOPS the
  // sequence; a USB failure only WARNS and continues — the spoke comes up
  // needs-device and self-heals once the device is plugged in.
  async function autoBringUp(): Promise<void> {
    if (broughtUp) return;
    broughtUp = true;
    if (lastCtx) setBusyIndicator(lastCtx, true);
    try {
      notify("bring-up: attaching USB device…");
      const usb = await usbAttach();
      log.info("bring-up usb_attach", usb);
      if (!usb.ok) {
        notify(
          `usb attach not ready: ${usb.detail} — continuing; plug in the device and run /reconnect`,
          "warning",
        );
      } else {
        notify(`usb attached: ${usb.detail}`);
      }

      notify("bring-up: starting expari dev servers (convex + metro)…");
      const dev = await devUp();
      log.info("bring-up dev_up", { ok: dev.ok });
      if (!dev.ok) {
        notify(`bring-up STOPPED at dev_up: ${dev.detail}`, "error");
        return;
      }
      notify(`dev servers ready: ${dev.detail}`);

      // A configured-but-unbuilt platform (ios/web) is logged + skipped, never an
      // error — it's reserved in config until its spoke exists.
      const configured = getConfiguredPlatforms();
      const toSpawn = configured.filter((r) => BUILT_SPOKE_ROLES.includes(r));
      for (const r of configured.filter((r) => !BUILT_SPOKE_ROLES.includes(r))) {
        log.info(`platform ${r} configured but no spoke built — skipping`);
        notify(
          `${r} platform configured but no spoke is built yet (TBD until a Mac mini) — skipping`,
          "warning",
        );
      }
      if (toSpawn.length === 0) {
        notify("no buildable platform spoke configured — nothing to spawn.", "warning");
        return;
      }
      notify(`bring-up: spawning spoke(s): ${toSpawn.join(", ")}…`);
      for (const r of toSpawn) spawnSpoke(r, resolvedHubPort, log);

      setStatus("waiting for spoke…");
      const budget = getDefaults().spokeConnectTimeoutMs;
      const green = await waitForSpoke(
        () => toSpawn.every((r) => registry.isReady(r)),
        budget,
      );
      setStatus(undefined);
      const connected = toSpawn.filter((r) => registry.isConnected(r));
      log.info("bring-up spoke wait done", { green, connected });

      if (!green) {
        if (connected.length > 0) {
          notify(
            `spoke(s) up (${connected.join(", ")}) but device not ready — ` +
              "plug in the device and run /reconnect.",
            "warning",
          );
        } else {
          notify(
            `spoke(s) did not connect within ${Math.round(budget / 1000)}s — ` +
              "check the spoke window(s) / log(s).",
            "warning",
          );
        }
      }
    } finally {
      if (lastCtx?.hasUI) setBusyIndicator(lastCtx, false);
      if (lastCtx) rerender(lastCtx);
    }
  }

  async function startTransport(): Promise<void> {
    if (transport) return;
    const host = getHost();
    transport = await createTransportServer({
      // Preferred port; createTransportServer auto-falls-back to the next free one,
      // and we capture the RESOLVED port (resolvedHubPort) to hand to the spoke.
      port: getPort("hub"),
      host,
      handlers: {
        register: (m) => {
          registry.onRegister(m.from, m.port);
          if (lastCtx) rerender(lastCtx);
          return { ok: true };
        },
        heartbeat: (m) => {
          registry.onHeartbeat(m.from, m.status);
          maybeAnnounceReady();
          return { ok: true };
        },
        intentResult: (m) => {
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
          registry.onStatus(m.from, m.state, m.detail ?? m.state);
          if (lastCtx?.hasUI) {
            const sev = m.state === "ready" ? "info" : "warning";
            notify(`${m.from}: ${m.state}${m.detail ? ` — ${m.detail}` : ""}`, sev);
            rerender(lastCtx);
          }
          maybeAnnounceReady();
          return { ok: true };
        },
        onError: (err, raw) =>
          log.error("transport error", { error: String(err), raw: raw.slice(0, 200) }),
      },
    });
    resolvedHubPort = transport.port;
    log.info(`hub transport listening on ${host}:${resolvedHubPort}`);
  }

  pi.on("before_agent_start", (event) => ({
    systemPrompt: event.systemPrompt + HUB_RULES,
  }));

  pi.on("session_start", async (_event, ctx) => {
    lastCtx = ctx;
    cumulativeCost = 0;

    // Fail loud BEFORE any bring-up touches just/adb if the target dir is stale.
    try {
      assertTargetValid();
    } catch (err) {
      notify(`config error: ${(err as Error).message}`, "error");
      log.error("assertTargetValid failed", { error: String(err) });
      return;
    }

    // Create the per-app logs dir before anything backgrounds into it.
    ensureLogsDir();

    installHubFooter(pi, ctx, () => cumulativeCost);
    await startTransport();

    if (!liveTimer) {
      liveTimer = setInterval(() => {
        if (registry.reapStale() && lastCtx) rerender(lastCtx);
      }, getDefaults().heartbeatIntervalMs);
      liveTimer.unref?.();
    }
    // Periodic re-render so the spoke's model/ctx/cost stay fresh in the widget.
    if (!renderTimer) {
      renderTimer = setInterval(() => {
        if (lastCtx) rerender(lastCtx);
      }, getDefaults().heartbeatIntervalMs);
      renderTimer.unref?.();
    }

    rerender(ctx);

    // Detached (not awaited) so the prompt is usable immediately; milestones
    // surface via notify + the footer status.
    notify("pi-e2e-tester hub starting — auto-bringing-up the stack…", "info");
    void autoBringUp().catch((err) => {
      log.error("autoBringUp threw", { error: String(err) });
      notify(`bring-up error: ${String(err)}`, "error");
    });
  });

  pi.on("session_shutdown", async () => {
    // Tell the spoke to shut down BEFORE tearing down our transport; bounded so a
    // hung spoke can't block hub exit.
    try {
      for (const r of registry.roles()) {
        if (registry.isConnected(r)) {
          await shutdownSpoke(r, registry.port(r), "hub session_shutdown");
        }
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

  registerHubCommands(pi, {
    log,
    registry,
    getResolvedHubPort: () => resolvedHubPort,
    setLastCtx: (ctx) => {
      lastCtx = ctx;
    },
    rerender,
    setStatus,
    notify,
    usbAttach,
    waitForSpoke,
  });

  registerHubTools(pi, {
    log,
    registry,
    messengerPending,
    verdictType: VERDICT_TYPE,
    setLastCtx: (ctx) => {
      lastCtx = ctx;
    },
    getLastCtx: () => lastCtx,
    rerender,
    usbAttach,
    devUp,
    devDown,
    testsDirs: getTestsDirs(),
  });
}

// Referenced so the imports aren't flagged unused (kept for near-term use).
void tailLog;
void WIDGET_KEY;
