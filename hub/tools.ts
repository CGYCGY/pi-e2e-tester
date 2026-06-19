// hub/tools.ts — the hub's registered tools. The orchestration core they call
// (transport handlers, bring-up steps, correlation map) lives in index.ts and is
// passed in via `deps`.

import { randomUUID } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";

import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

import { getDefaults } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";
import { postToSpoke } from "../shared/transport.ts";
import type { SpokeRole, Verdict } from "../shared/types.ts";
import { ensureTestsDirs, safeWorkspacePath } from "../shared/workspace.ts";
import { type SpokeRegistry } from "./spokes.ts";

interface MessengerPending {
  resolve: (r: { verdict: Verdict; text: string }) => void;
  reject: (e: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

export interface HubToolsDeps {
  log: Logger;
  registry: SpokeRegistry;
  /** Mutated in place, not reassigned. */
  messengerPending: Map<string, MessengerPending>;
  verdictType: string;
  setLastCtx: (ctx: ExtensionContext) => void;
  getLastCtx: () => ExtensionContext | null;
  rerender: (ctx: ExtensionContext) => void;
  usbAttach: () => Promise<{ ok: boolean; detail: string }>;
  devUp: () => Promise<{ ok: boolean; detail: string }>;
  devDown: (opts?: { spoke?: boolean }) => Promise<{ ok: boolean; detail: string }>;
  /** The hub's ONLY filesystem access (the LLM is gated off built-in read/write). */
  testsDirs: { cases: string; results: string; screenshots: string };
}

export function registerHubTools(pi: ExtensionAPI, deps: HubToolsDeps): void {
  const {
    log,
    registry,
    messengerPending,
    verdictType: VERDICT_TYPE,
    setLastCtx,
    getLastCtx,
    rerender,
    usbAttach,
    devUp,
    devDown,
    testsDirs,
  } = deps;

  const testsDirFor = (kind: "case" | "result") =>
    kind === "case" ? testsDirs.cases : testsDirs.results;

  // isConnected (heartbeating) is NOT isReady (app foreground + loaded): during a
  // reload the spoke keeps heartbeating while the app reopens. Block until GREEN
  // so an intent never lands on a still-reloading app. Throws past readyTimeoutMs
  // (genuinely stuck) or on abort; the spoke's own halted-guard is the backstop.
  const waitUntilReady = async (target: SpokeRole, signal?: AbortSignal): Promise<void> => {
    if (registry.isReady(target)) return;
    const { readyTimeoutMs, readyPollIntervalMs } = getDefaults();
    const deadline = Date.now() + readyTimeoutMs;
    while (Date.now() < deadline) {
      if (signal?.aborted) throw new Error("messenger intent aborted");
      await new Promise((r) => setTimeout(r, readyPollIntervalMs));
      if (registry.isReady(target)) return;
    }
    throw new Error(
      `${target} spoke is connected but its app is not loaded (still reloading?) ` +
        `after ${readyTimeoutMs}ms — check /status; re-run dev_up if a dependency is down.`,
    );
  };

  // THE single door to the spoke — the hub never touches the phone directly.
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
      setLastCtx(ctx);
      const target = params.target;
      if (!registry.isConnected(target)) {
        throw new Error(
          `${target} spoke is not connected (bring-up may still be in progress). ` +
            "Check /status; re-run usb_attach / dev_up if a dependency is down.",
        );
      }
      await waitUntilReady(target, signal);
      const requestId = randomUUID();
      const timeoutMs = getDefaults().intentTimeoutMs;
      const spokePort = registry.port(target);

      const result = await new Promise<{ verdict: Verdict; text: string }>((resolve, reject) => {
        const timer = setTimeout(() => {
          messengerPending.delete(requestId);
          reject(new Error(`android did not answer the intent within ${timeoutMs}ms (timeout).`));
        }, timeoutMs);
        timer.unref?.();

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

        void postToSpoke(
          target,
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

      if (ctx.hasUI) {
        pi.sendMessage(
          {
            customType: VERDICT_TYPE,
            content: `[${target}] ${result.verdict}: ${result.text}`,
            display: true,
            details: { pass: result.verdict === "PASS" },
          },
          { deliverAs: "steer" },
        );
      }
      return {
        content: [{ type: "text", text: `${result.verdict}: ${result.text}` }],
        details: { target, requestId, verdict: result.verdict, text: result.text },
      };
    },
  });

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
      setLastCtx(ctx);
      const res = await usbAttach();
      const lastCtx = getLastCtx();
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });

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
      setLastCtx(ctx);
      const res = await devUp();
      const lastCtx = getLastCtx();
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });

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
      setLastCtx(ctx);
      const res = await devDown({ spoke: params.stopSpoke === true });
      const lastCtx = getLastCtx();
      if (lastCtx) rerender(lastCtx);
      return {
        content: [{ type: "text", text: res.detail }],
        details: { ok: res.ok },
      };
    },
  });

  // tests_* are the hub's ONLY filesystem access — built-in bash/read/write/edit
  // are gated off at launch.
  const KIND_PARAM = Type.Union([Type.Literal("case"), Type.Literal("result")], {
    description: "Which set: 'case' (test scenarios in tests/cases) or 'result' (outcome records in tests/results).",
  });

  pi.registerTool({
    name: "tests_list",
    label: "Tests list",
    description:
      "List the *.md filenames in the test workspace for a kind ('case' = test " +
      "scenarios under tests/cases, 'result' = recorded outcomes under tests/results). " +
      "The tests_* tools are your ONLY filesystem access.",
    promptSnippet: "List the *.md test cases or results in the project test workspace",
    promptGuidelines: [
      "Use tests_list to discover available cases before reading/driving them.",
    ],
    parameters: Type.Object({ kind: KIND_PARAM }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      ensureTestsDirs(testsDirs);
      const dir = testsDirFor(params.kind);
      const files = readdirSync(dir)
        .filter((f) => f.endsWith(".md"))
        .sort();
      const body = files.length ? files.join("\n") : `(no ${params.kind} files yet)`;
      return {
        content: [{ type: "text", text: body }],
        details: { kind: params.kind, count: files.length, files },
      };
    },
  });

  pi.registerTool({
    name: "tests_read",
    label: "Tests read",
    description:
      "Read a *.md file from the test workspace: kind 'case' (a test scenario in " +
      "tests/cases you then drive via messenger) or 'result' (a recorded outcome in " +
      "tests/results). Path-guarded to that dir — the tests_* tools are your ONLY " +
      "filesystem access.",
    promptSnippet: "Read a *.md test case or result file from the project test workspace",
    promptGuidelines: [
      "Read a case before driving it; never invent a scenario from memory.",
    ],
    parameters: Type.Object({
      kind: KIND_PARAM,
      name: Type.String({ description: "Bare file name, e.g. sign-in.md (no slashes / no '..')." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      const path = safeWorkspacePath(testsDirFor(params.kind), ".", params.name, "md");
      const text = readFileSync(path, "utf8");
      return {
        content: [{ type: "text", text }],
        details: { kind: params.kind, name: params.name, bytes: text.length },
      };
    },
  });

  pi.registerTool({
    name: "tests_write",
    label: "Tests write",
    description:
      "Write (create or overwrite) a *.md file in the test workspace: kind 'case' " +
      "(a test scenario in tests/cases) or 'result' (a PASS/FAIL outcome record in " +
      "tests/results). Path-guarded to that dir; the dir is created if missing. The " +
      "tests_* tools are your ONLY filesystem access.",
    promptSnippet: "Write a *.md test case or result file in the project test workspace",
    promptGuidelines: [
      "Record each run's PASS/FAIL verdict + key detail as a result file.",
    ],
    parameters: Type.Object({
      kind: KIND_PARAM,
      name: Type.String({ description: "Bare file name, e.g. sign-in.md (no slashes / no '..')." }),
      content: Type.String({ description: "Full Markdown content to write (overwrites any existing file)." }),
    }),
    async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
      ensureTestsDirs(testsDirs);
      const path = safeWorkspacePath(testsDirFor(params.kind), ".", params.name, "md");
      writeFileSync(path, params.content, "utf8");
      return {
        content: [{ type: "text", text: `Wrote ${params.kind} ${params.name} (${params.content.length} bytes).` }],
        details: { kind: params.kind, name: params.name, bytes: params.content.length },
      };
    },
  });
}
