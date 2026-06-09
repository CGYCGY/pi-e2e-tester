/**
 * spoke/commands.ts — the 2 manual slash commands (/verify, /spoke-status).
 * Extracted verbatim from spoke/index.ts; closure variables they touched are
 * threaded in via `deps` (getter/setter for the mutable runtime flags, plain
 * handles for the read-only helpers).
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

import type { SpokeReadyState, SpokeRole, SpokeStatus } from "../shared/types.ts";

/** Handles the 2 slash commands need from the spoke runtime. */
export interface SpokeCommandDeps {
  role: SpokeRole;
  getRoleIcon: (role: SpokeRole) => string;
  buildStatus: () => SpokeStatus;
  verifyReady: (opts?: { launch?: boolean }) => Promise<void>;
  refreshUI: (ctx?: ExtensionContext) => void;
  // Mutable runtime flags: getter/setter over index.ts's `let` so reads/writes
  // here hit the original, never a copy.
  setActiveCtx: (ctx: ExtensionContext) => void;
  getHalted: () => boolean;
  setHalted: (v: boolean) => void;
  getReadyState: () => SpokeReadyState;
  getDeviceReady: () => boolean;
  getLastForeground: () => string | undefined;
}

export function registerSpokeCommands(pi: ExtensionAPI, deps: SpokeCommandDeps): void {
  const {
    role,
    getRoleIcon,
    buildStatus,
    verifyReady,
    refreshUI,
    setActiveCtx,
    getHalted,
    setHalted,
    getReadyState,
    getDeviceReady,
    getLastForeground,
  } = deps;

  pi.registerCommand("verify", {
    description: "Re-check device reachability + foreground app, and report readiness.",
    handler: async (_args, ctx) => {
      setActiveCtx(ctx);
      setHalted(false);
      await verifyReady({ launch: true });
      refreshUI(ctx);
    },
  });

  pi.registerCommand("spoke-status", {
    description: "Show this spoke's device + ready state.",
    handler: async (_args, ctx) => {
      setActiveCtx(ctx);
      const s = buildStatus();
      ctx.ui.notify(
        `${getRoleIcon(role)}: ${getReadyState()}${getHalted() ? " (HALTED)" : ""} | device=${
          getDeviceReady() ? "ready" : "down"
        } | fg=${getLastForeground() ?? "?"} | $${s.cost?.toFixed(3) ?? "0"}`,
        getHalted() ? "warning" : "info",
      );
      refreshUI(ctx);
    },
  });
}
