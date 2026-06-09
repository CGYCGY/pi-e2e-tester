/**
 * hub/commands.ts — the hub's user-facing slash commands.
 *
 * Extracted verbatim from hub/index.ts: /status, /continue, /reset, /reconnect.
 * The orchestration core (timers, transport handlers, bring-up, lifecycle) stays
 * in index.ts and is passed in via the `deps` handle so behavior is identical.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getDefaults } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import {
  resetSpoke,
  resumeSpoke,
  type SpokeRegistry,
  spawnSpoke,
} from "./spokes.ts";
import { statusSummary } from "./ui.ts";

/** Handles the commands need from the index.ts orchestration core. */
export interface HubCommandsDeps {
  log: Logger;
  registry: SpokeRegistry;
  /** Read-only: the hub's RESOLVED transport port (read inside command handlers). */
  getResolvedHubPort: () => number;
  /** Setter over index.ts's mutable `lastCtx` (handlers assign `lastCtx = ctx`). */
  setLastCtx: (ctx: ExtensionContext) => void;
  /** Re-render the spoke widget for the given ctx. */
  rerender: (ctx: ExtensionContext) => void;
  /** Footer status segment setter (reads index.ts's live lastCtx). */
  setStatus: (text: string | undefined) => void;
  /** UI notify helper (reads index.ts's live lastCtx; no-ops without UI). */
  notify: (text: string, sev?: "info" | "warning" | "error") => void;
  /** Re-attach USB + wait for device readiness (bring-up step in index.ts). */
  usbAttach: () => Promise<{ ok: boolean; detail: string }>;
  /** Poll until pred() within budgetMs (bring-up helper in index.ts). */
  waitForSpoke: (pred: () => boolean, budgetMs: number) => Promise<boolean>;
}

export function registerHubCommands(pi: ExtensionAPI, deps: HubCommandsDeps): void {
  const {
    log,
    registry,
    getResolvedHubPort,
    setLastCtx,
    rerender,
    setStatus,
    notify,
    usbAttach,
    waitForSpoke,
  } = deps;

  pi.registerCommand("status", {
    description: "Show hub + android spoke connection / readiness status",
    handler: async (_args, ctx) => {
      setLastCtx(ctx);
      const lines = statusSummary(registry.all());
      lines.unshift(`hub: listening :${getResolvedHubPort()}`);
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
      setLastCtx(ctx);
      if (!registry.isConnected()) {
        ctx.ui.notify("android spoke is not connected.", "warning");
        return;
      }
      const res = await resumeSpoke(registry.port());
      ctx.ui.notify(`continue android: ${res.detail}`, res.ok ? "info" : "warning");
    },
  });

  pi.registerCommand("reset", {
    description: "Fresh test start: clear the android spoke's context + cold-reset the dev app",
    handler: async (_args, ctx) => {
      setLastCtx(ctx);
      if (!registry.isConnected()) {
        ctx.ui.notify("android spoke is not connected.", "warning");
        return;
      }
      const res = await resetSpoke(registry.port());
      ctx.ui.notify(
        res.ok ? `↺ reset android: ${res.detail}` : `reset failed: ${res.detail}`,
        res.ok ? "info" : "warning",
      );
    },
  });

  pi.registerCommand("reconnect", {
    description: "Re-attach USB + bring the android spoke back to ready (run after plugging the device in).",
    handler: async (_args, ctx) => {
      setLastCtx(ctx);
      notify("reconnecting — re-attaching USB…");
      const usb = await usbAttach();
      notify(usb.detail, usb.ok ? "info" : "warning");

      if (!registry.isConnected()) {
        // Spoke process is gone — spawn fresh and wait for it to connect.
        notify("android spoke not connected — spawning…");
        spawnSpoke(getResolvedHubPort(), log);
        setStatus("waiting for spoke…");
        await waitForSpoke(() => registry.isConnected(), getDefaults().spokeConnectTimeoutMs);
        setStatus(undefined);
      } else {
        // Spoke is alive — ask it to re-verify readiness (it will auto-launch the app).
        const res = await resumeSpoke(registry.port());
        notify(`resume android: ${res.detail}`, res.ok ? "info" : "warning");
      }

      // maybeAnnounceReady() will fire "Ready to test" via incoming heartbeat/status.
      notify(
        registry.isReady()
          ? "android ready."
          : "android still not ready — check the device / spoke window.",
        registry.isReady() ? "info" : "warning",
      );
      rerender(ctx);
    },
  });
}
