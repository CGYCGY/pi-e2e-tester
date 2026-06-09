// hub/commands.ts — the hub's slash commands (/status, /continue, /reset,
// /reconnect). The orchestration core stays in index.ts and is passed via `deps`.

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import { getDefaults } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import {
  resetSpoke,
  resumeSpoke,
  SPOKE_ROLE,
  type SpokeRegistry,
  spawnSpoke,
} from "./spokes.ts";
import { statusSummary } from "./ui.ts";

export interface HubCommandsDeps {
  log: Logger;
  registry: SpokeRegistry;
  getResolvedHubPort: () => number;
  setLastCtx: (ctx: ExtensionContext) => void;
  rerender: (ctx: ExtensionContext) => void;
  setStatus: (text: string | undefined) => void;
  notify: (text: string, sev?: "info" | "warning" | "error") => void;
  usbAttach: () => Promise<{ ok: boolean; detail: string }>;
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
      const res = await resumeSpoke(SPOKE_ROLE, registry.port(SPOKE_ROLE));
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
      const res = await resetSpoke(SPOKE_ROLE, registry.port(SPOKE_ROLE));
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
        notify("android spoke not connected — spawning…");
        spawnSpoke(SPOKE_ROLE, getResolvedHubPort(), log);
        setStatus("waiting for spoke…");
        await waitForSpoke(() => registry.isConnected(SPOKE_ROLE), getDefaults().spokeConnectTimeoutMs);
        setStatus(undefined);
      } else {
        // resume makes the live spoke re-verify readiness and auto-launch the app.
        const res = await resumeSpoke(SPOKE_ROLE, registry.port(SPOKE_ROLE));
        notify(`resume android: ${res.detail}`, res.ok ? "info" : "warning");
      }

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
