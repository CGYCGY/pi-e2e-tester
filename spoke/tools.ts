// The device + workspace verbs registered as pi tools for the spoke's own LLM.
// Built-in tools are gated off (--no-builtin-tools), so read_screenshot and
// read_creds replace the built-in read with code-guarded, path-fixed equivalents.

import { readFileSync } from "node:fs";
import { join } from "node:path";

import type {
  ExtensionAPI,
  ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import type { Logger } from "../shared/log.ts";
import { safeWorkspacePath } from "../shared/workspace.ts";

import type { Device } from "./device.ts";
import { scanForCrash } from "./guards.ts";
import type { DeviceProfile } from "./profiles/index.ts";

export interface SpokeToolDeps {
  device: Device;
  profile: DeviceProfile;
  roleLog: Logger;
  androidPackage: string;
  crashLogTag: string;
  screenshotsDir: string;
  /** The ONE fixed file read_creds may read (no path param — a code-fixed allowlist). */
  envTestPath: string;
  withGuards: (
    verb: string,
    action: () => Promise<void>,
  ) => Promise<{ crash: string | null }>;
  refreshUI: (ctx?: ExtensionContext) => void;
  // Mutable runtime flags: pass getter/setter over index.ts's `let` so writes
  // here mutate the original, never a copy.
  setActiveCtx: (ctx: ExtensionContext) => void;
  setLastForeground: (v: string | undefined) => void;
  setDeviceReady: (v: boolean) => void;
  setGuardTrip: (v: { kind: "wrong-target" | "crash"; detail: string } | null) => void;
}

export function registerSpokeTools(pi: ExtensionAPI, deps: SpokeToolDeps): void {
  const {
    device,
    profile,
    roleLog,
    androidPackage,
    crashLogTag,
    screenshotsDir,
    envTestPath,
    withGuards,
    refreshUI,
    setActiveCtx,
    setLastForeground,
    setDeviceReady,
    setGuardTrip,
  } = deps;

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
      setActiveCtx(ctx);
      let foreground = "(unknown)";
      let activity = "";
      try {
        const state = await device.appstate();
        foreground = state.package || "(unknown)";
        activity = state.activity;
        setLastForeground(state.package || undefined);
        setDeviceReady(true);
      } catch (err) {
        setDeviceReady(false);
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

  pi.registerTool({
    name: "look",
    label: "Look (screenshot)",
    description:
      "Capture a screenshot of the phone to a PNG in the project's screenshots dir " +
      "(downscaled to <=1200px) and return its FILE NAME. Use this ONLY when color, " +
      "layout, overlap, or other visual detail actually matters — then view it with " +
      "the read_screenshot tool. For text / bounds / presence checks use observe or " +
      "assert instead (cheaper). Do NOT use a built-in read — there isn't one.",
    promptSnippet: "Screenshot the phone and return its file name (view it via read_screenshot only when vision matters).",
    promptGuidelines: [
      "Prefer observe; only use look when you genuinely need to SEE the pixels.",
      "look returns a NAME — pass it to read_screenshot to view; the image is never dumped inline.",
    ],
    parameters: Type.Object({
      label: Type.Optional(
        Type.String({ description: "Short label for the filename (e.g. 'home', 'authkit')." }),
      ),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      const safe = (params.label ?? "shot").replace(/[^a-zA-Z0-9_-]/g, "").slice(0, 32) || "shot";
      const name = `pi-e2e-${safe}-${Date.now()}.png`;
      const out = join(screenshotsDir, name);
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
            text: `Screenshot saved as ${name} (<=1200px). View it with read_screenshot ONLY if you need to see the pixels; otherwise prefer observe.`,
          },
        ],
        details: { name, path: out },
      };
    },
  });

  pi.registerTool({
    name: "read_screenshot",
    label: "Read screenshot (inline image)",
    description:
      "View a screenshot captured by `look`: pass the file NAME it returned and this " +
      "returns the PNG INLINE so you can see the pixels. Use ONLY when color / layout " +
      "actually matters — observe is cheaper for text/bounds. This is the only way to " +
      "see a screenshot (there is no built-in read).",
    promptSnippet: "View a look screenshot inline (pass the name look returned); use only when vision matters.",
    promptGuidelines: [
      "Call read_screenshot with the name look returned, only when you must SEE the pixels.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "The screenshot file name look returned (e.g. pi-e2e-home-123.png)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      let data: string;
      try {
        const path = safeWorkspacePath(screenshotsDir, ".", params.name, "png");
        data = readFileSync(path).toString("base64");
      } catch (err) {
        return {
          content: [{ type: "text", text: `read_screenshot failed: ${(err as Error).message}` }],
          details: { ok: false },
        };
      }
      return {
        content: [{ type: "image", data, mimeType: "image/png" }],
        details: { name: params.name },
      };
    },
  });

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
      setActiveCtx(ctx);
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
      setActiveCtx(ctx);
      const submit = params.submit ?? true;
      const { crash } = await withGuards("type", async () => {
        await device.type(params.text);
        // Submit strategy is the DeviceProfile's (e.g. Samsung submits via Enter,
        // never by tapping Continue — Samsung Pass overlays it).
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
      setActiveCtx(ctx);
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
      setActiveCtx(ctx);
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
      setActiveCtx(ctx);
      // stop / cold-reset don't need the dev app foreground (they target it by
      // package id, which is inherently guarded); launch is the one we crash-scan.
      if (params.action === "stop") {
        await device.forceStop();
        setLastForeground(undefined);
        refreshUI(ctx);
        return {
          content: [{ type: "text", text: `Force-stopped ${androidPackage}.` }],
          details: { action: "stop" },
        };
      }
      if (params.action === "cold-reset") {
        await device.coldReset();
        setLastForeground(undefined);
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
      const marker = await device.markLog();
      await device.launch();
      try {
        const state = await device.appstate();
        setLastForeground(state.package || undefined);
        setDeviceReady(true);
      } catch {
        /* foreground read is best-effort right after launch */
      }
      refreshUI(ctx);
      const crash = await scanForCrash(device, marker || undefined, roleLog);
      if (!crash.ok) {
        setGuardTrip({ kind: "crash", detail: `${crash.reason}\n${crash.lines}` });
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
      setActiveCtx(ctx);
      const max = params.lines && params.lines > 0 ? Math.floor(params.lines) : 80;
      const out = await device.logcat({ max });
      const body = out.length ? out.split("\n").slice(-max).join("\n") : `(no ${crashLogTag} lines)`;
      return {
        content: [{ type: "text", text: `Recent ${crashLogTag} log:\n${body}` }],
        details: { lines: body.split("\n").length },
      };
    },
  });

  // Reads ONLY the one code-fixed creds file (no path param) — built-in read is gated off.
  pi.registerTool({
    name: "read_creds",
    label: "Read sign-in creds",
    description:
      "Read the sign-in test credentials from the project's fixed creds file and " +
      "return its contents. Call this when you need the AuthKit creds to sign in. " +
      "Takes no arguments — it reads ONLY that one fixed file (no other path).",
    promptSnippet: "Read the fixed sign-in creds file (the only way to get the test credentials).",
    promptGuidelines: [
      "Call read_creds when signing in; never guess credentials.",
    ],
    parameters: Type.Object({}),
    async execute(_toolCallId, _params, _signal, _onUpdate, ctx) {
      setActiveCtx(ctx);
      if (!envTestPath) {
        return {
          content: [{ type: "text", text: "read_creds: no creds file is configured (target.envTest is empty)." }],
          details: { ok: false },
        };
      }
      let text: string;
      try {
        text = readFileSync(envTestPath, "utf8");
      } catch (err) {
        return {
          content: [{ type: "text", text: `read_creds failed: ${(err as Error).message}` }],
          details: { ok: false },
        };
      }
      return {
        content: [{ type: "text", text }],
        details: { ok: true, bytes: text.length },
      };
    },
  });
}
