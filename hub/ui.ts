/**
 * hub/ui.ts — hub TUI rendering helpers (ported from pi-4b-tester, trimmed to one
 * android spoke + no chat-lock concept).
 *
 * - The BELOW-EDITOR widget shows the android spoke status, ONLY when connected:
 *     [AND ●  model | ctxused/max (x%) | $cost | <foreground>]
 *   The dot is green when the device is reachable (deviceReady), amber otherwise.
 * - The hub's own STATUS SEGMENTS (model | ctx used/max (x%) | cost) live in a
 *   custom 2-line footer via ctx.ui.setFooter (REPLACES pi's built-in footer).
 *
 * Only depends on ctx.ui + theme; no transport coupling.
 */

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";

import { fmtPct, fmtTokens } from "./format.ts";
import type { SpokeRecord } from "./spokes.ts";

/** Stable widget/status keys. */
export const WIDGET_KEY = "expari-spoke";
export const STATUS_KEY = "expari-hub";

/** Short label for the android spoke in the widget. */
const LABEL = "AND";

/** One spoke segment string for the widget (assumes the spoke is connected). */
function spokeSegment(rec: SpokeRecord, theme: ExtensionContext["ui"]["theme"]): string {
  const s = rec.status;
  // Green dot when the device is reachable; amber while connected-but-not-ready.
  const dotColor = s.deviceReady ? "success" : "warning";
  const dot = theme.fg(dotColor as never, "●");
  const label = theme.fg("accent" as never, LABEL);

  const bits: string[] = [];
  if (s.model) bits.push(theme.fg("muted" as never, s.model));

  if (typeof s.contextTokens === "number" && typeof s.contextWindow === "number" && s.contextWindow > 0) {
    const pct =
      typeof s.contextPercent === "number"
        ? s.contextPercent
        : (s.contextTokens / s.contextWindow) * 100;
    bits.push(theme.fg("dim" as never, `${fmtTokens(s.contextTokens)}/${fmtTokens(s.contextWindow)} (${fmtPct(pct)}%)`));
  } else if (typeof s.contextPercent === "number") {
    bits.push(theme.fg("dim" as never, `${fmtPct(s.contextPercent)}%`));
  }

  if (typeof s.cost === "number" && s.cost > 0) {
    bits.push(theme.fg("dim" as never, `$${s.cost.toFixed(4)}`));
  }

  // Show the foreground package (drives the wrong-target view) when known.
  if (s.foregroundPackage) {
    bits.push(theme.fg("muted" as never, s.foregroundPackage));
  } else if (!s.deviceReady) {
    bits.push(theme.fg("warning" as never, "no-device"));
  }

  const body = bits.length ? " " + bits.join(theme.fg("dim" as never, " | ")) : "";
  return `[${label} ${dot}${body}]`;
}

/**
 * Render the below-editor widget from the spoke records. Connected spokes only.
 * If the spoke is not connected, the widget is cleared (hidden).
 */
export function renderSpokeWidget(ctx: ExtensionContext, records: SpokeRecord[]): void {
  const theme = ctx.ui.theme;
  const connected = records.filter((r) => r.status.connected);
  if (connected.length === 0) {
    ctx.ui.setWidget(WIDGET_KEY, undefined);
    return;
  }
  const segments = connected.map((r) => spokeSegment(r, theme));
  ctx.ui.setWidget(WIDGET_KEY, [segments.join("   ")], { placement: "belowEditor" });
}

/**
 * Install the hub's custom 2-line footer (REPLACES pi's built-in footer):
 *
 *   pi-e2e-tester:hub (sub)
 *   <used>/<window> (<pct>%) $<cost>                 (provider) id • <thinking>
 *
 * Call ONCE (at session_start). render() pulls live values every frame, so it
 * needs no re-install: getCost closes over the hub's live cumulative-cost let, and
 * model/ctx/thinking/auth are read fresh from ctx + pi each render.
 */
export function installHubFooter(
  pi: ExtensionAPI,
  ctx: ExtensionContext,
  getCost: () => number,
): void {
  if (!ctx.hasUI) return;
  ctx.ui.setFooter((_tui, theme, footerData) => ({
    invalidate() {},
    render(width: number): string[] {
      const dim = (s: string) => theme.fg("dim" as never, s);
      const muted = (s: string) => theme.fg("muted" as never, s);

      // Line 1 — session name + (sub) on subscription/OAuth auth, then any
      // extension status texts (e.g. a bring-up "usb_attach…" status).
      const name = ctx.sessionManager.getSessionName() ?? "pi-e2e-tester:hub";
      const isSub = ctx.model ? ctx.modelRegistry.isUsingOAuth(ctx.model) : false;
      const statuses = [...footerData.getExtensionStatuses().values()].filter((s) => s.length > 0);
      const statusStr = statuses.length ? "   " + dim(statuses.join("  ")) : "";
      const line1 = muted(name) + (isSub ? dim(" (sub)") : "") + statusStr;

      // Line 2 left — context used/window (pct%) + cumulative cost.
      const usage = ctx.getContextUsage();
      let ctxStr = "?/? (?)";
      if (usage && usage.contextWindow > 0) {
        const used = usage.tokens ?? 0;
        const pct = Math.round(usage.percent ?? 0);
        ctxStr = `${fmtTokens(used)}/${fmtTokens(usage.contextWindow)} (${pct}%)`;
      }
      const left = dim(`${ctxStr} $${getCost().toFixed(3)}`);

      // Line 2 right — (provider) id • thinking-effort.
      const right = ctx.model
        ? muted(`(${ctx.model.provider}) ${ctx.model.id} • ${pi.getThinkingLevel()}`)
        : muted("(no model)");

      const gap = Math.max(1, width - visibleWidth(left) - visibleWidth(right));
      const line2 = truncateToWidth(left + " ".repeat(gap) + right, width);

      return [line1, line2];
    },
  }));
}

/** Set a transient working indicator (used during bring-up / a running intent). */
export function setBusyIndicator(ctx: ExtensionContext, busy: boolean): void {
  if (!ctx.hasUI) return;
  if (busy) {
    ctx.ui.setWorkingIndicator({
      frames: [
        ctx.ui.theme.fg("dim" as never, "·"),
        ctx.ui.theme.fg("muted" as never, "•"),
        ctx.ui.theme.fg("accent" as never, "●"),
        ctx.ui.theme.fg("muted" as never, "•"),
      ],
      intervalMs: 120,
    });
  } else {
    ctx.ui.setWorkingIndicator();
  }
}

/** Format a one-line summary of the spoke's connection/readiness for /status. */
export function statusSummary(records: SpokeRecord[]): string[] {
  return records.map((r) => {
    const s = r.status;
    const conn = s.connected ? "connected" : "disconnected";
    const dev = s.connected ? (s.deviceReady ? "device-ready" : "device-down") : "-";
    const port = r.port > 0 ? ` :${r.port}` : "";
    const detail = r.readyDetail ? ` (${r.readyDetail})` : "";
    return `${LABEL}${port}: ${conn}, ${dev}${detail}`;
  });
}
