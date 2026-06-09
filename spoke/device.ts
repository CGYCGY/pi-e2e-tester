// spoke/device.ts — thin agent-device + raw-adb wrapper, serial-pinned.
//
// FOOTGUN: agent-device also lists a `PC linux desktop` target, so every call
// MUST pin `--platform android --serial`; an unpinned call routes to the wrong
// target. agent-device has NO keyevent verb, so KEYCODE_* goes via raw adb —
// that's why two binaries exist.

import { spawn } from "node:child_process";

import { getAndroidPlatform } from "../shared/config.ts";
import type { Logger } from "../shared/log.ts";

export class DeviceError extends Error {
  constructor(
    message: string,
    readonly args: string[],
    readonly code: number | null,
    readonly stderr: string,
  ) {
    super(message);
    this.name = "DeviceError";
  }
}

export interface DeviceOptions {
  serial: string;
  androidPackage: string;
  log: Logger;
  timeoutMs?: number;
  bin?: string;
  adbBin?: string;
}

interface RunResult {
  stdout: string;
  stderr: string;
  code: number | null;
}

export interface AppState {
  package: string;
  activity: string;
}

export type IsPredicate =
  | "visible"
  | "hidden"
  | "exists"
  | "editable"
  | "selected"
  | "text";

export class Device {
  private readonly serial: string;
  private readonly androidPackage: string;
  private readonly log: Logger;
  private readonly timeoutMs: number;
  private readonly bin: string;
  private readonly adbBin: string;

  constructor(opts: DeviceOptions) {
    this.serial = opts.serial;
    this.androidPackage = opts.androidPackage;
    this.log = opts.log;
    this.timeoutMs = opts.timeoutMs ?? 60000;
    this.bin = opts.bin ?? "agent-device";
    this.adbBin = opts.adbBin ?? "adb";
  }

  private baseFlags(): string[] {
    return ["--platform", "android", "--serial", this.serial];
  }

  private spawnCli(
    bin: string,
    args: string[],
    timeoutMs = this.timeoutMs,
  ): Promise<RunResult> {
    return new Promise<RunResult>((resolve) => {
      const child = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"] });
      let stdout = "";
      let stderr = "";
      let settled = false;
      const timer = setTimeout(() => {
        if (settled) return;
        settled = true;
        child.kill("SIGKILL");
        resolve({ stdout, stderr: stderr + `\n[timeout after ${timeoutMs}ms]`, code: null });
      }, timeoutMs);
      child.stdout?.on("data", (c: Buffer) => (stdout += c.toString("utf8")));
      child.stderr?.on("data", (c: Buffer) => (stderr += c.toString("utf8")));
      child.on("error", (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr: stderr + "\n" + err.message, code: null });
      });
      child.on("close", (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ stdout, stderr, code });
      });
    });
  }

  private run(args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.spawnCli(this.bin, [...this.baseFlags(), ...args], timeoutMs);
  }

  private runAdb(args: string[], timeoutMs?: number): Promise<RunResult> {
    return this.spawnCli(this.adbBin, ["-s", this.serial, ...args], timeoutMs);
  }

  private async exec(args: string[], timeoutMs?: number): Promise<string> {
    const res = await this.run(args, timeoutMs);
    if (res.code !== 0) {
      this.log.warn("agent-device failed", {
        args,
        code: res.code,
        stderr: res.stderr.slice(0, 500),
      });
      throw new DeviceError(
        `agent-device ${args[0]} exited ${res.code}`,
        args,
        res.code,
        res.stderr,
      );
    }
    return res.stdout.trim();
  }

  private async execAdb(args: string[], timeoutMs?: number): Promise<string> {
    const res = await this.runAdb(args, timeoutMs);
    if (res.code !== 0) {
      this.log.warn("adb failed", {
        args,
        code: res.code,
        stderr: res.stderr.slice(0, 500),
      });
      throw new DeviceError(
        `adb ${args[0]} exited ${res.code}`,
        args,
        res.code,
        res.stderr,
      );
    }
    return res.stdout.trim();
  }

  private parseJson<T>(out: string): T {
    const trimmed = out.trim();
    try {
      return JSON.parse(trimmed) as T;
    } catch {
      // agent-device may prefix output; salvage from the first JSON token.
      const brace = trimmed.search(/[[{"]/);
      if (brace > 0) {
        try {
          return JSON.parse(trimmed.slice(brace)) as T;
        } catch {
          /* fall through */
        }
      }
      return trimmed as unknown as T;
    }
  }

  async snapshot(interactiveOnly = false): Promise<string> {
    const args = ["snapshot", "-c"];
    if (interactiveOnly) args.push("-i");
    try {
      return await this.exec(args);
    } catch (err) {
      return `snapshot failed: ${(err as Error).message}`;
    }
  }

  async appstate(): Promise<AppState> {
    const out = await this.exec(["appstate", "--json"]);
    const parsed = this.parseJson<{
      success?: boolean;
      data?: { package?: string; activity?: string };
      package?: string;
      activity?: string;
    }>(out);
    // Result nests under data.package / data.activity.
    const data = parsed.data ?? parsed;
    return {
      package: typeof data.package === "string" ? data.package : "",
      activity: typeof data.activity === "string" ? data.activity : "",
    };
  }

  // Counterintuitive: agent-device exits 0 when the predicate HOLDS, so a clean
  // exit means TRUE.
  async is(
    predicate: IsPredicate,
    selector: string,
    value?: string,
  ): Promise<{ ok: boolean; detail: string }> {
    const args = ["is", predicate, selector];
    if (value !== undefined) args.push(value);
    const res = await this.run(args);
    const detail = (res.stdout.trim() || res.stderr.trim()).slice(0, 500);
    return { ok: res.code === 0, detail };
  }

  async getText(selector: string): Promise<string> {
    try {
      return await this.exec(["get", "text", selector]);
    } catch {
      return "";
    }
  }

  // Downscales to maxSize px: raw phone caps trip a ~2000px many-image limit that
  // SILENTLY kills the run.
  async screenshot(out: string, maxSize = 1200): Promise<string> {
    await this.exec(["screenshot", "--out", out, "--max-size", String(maxSize)]);
    return out;
  }

  // ── ACT PATH (tap / type / key) ─────────────────────────────────────────────

  async click(target: string): Promise<void> {
    await this.exec(["click", target]);
  }

  async press(target: string): Promise<void> {
    await this.exec(["press", target]);
  }

  async type(text: string): Promise<void> {
    await this.exec(["type", text]);
  }

  // Hardware key via raw adb (agent-device has no key verb).
  async pressKey(key: string): Promise<void> {
    const k = key.trim().toUpperCase();
    const keycode = k.startsWith("KEYCODE_") ? k : `KEYCODE_${k}`;
    await this.execAdb(["shell", "input", "keyevent", keycode]);
  }

  async launch(): Promise<void> {
    await this.exec(
      ["open", this.androidPackage, "--relaunch"],
      Math.max(this.timeoutMs, 60000),
    );
  }

  async forceStop(): Promise<void> {
    await this.execAdb(["shell", "am", "force-stop", this.androidPackage]);
  }

  // Tokens (SecureStore) + MMKV user store survive force-stop, so they're run-as
  // rm'd first. The file list is config-driven (the android platform's
  // resetPaths), app-specific; empty ⇒ force-stop only. A missing path is a no-op.
  async coldReset(): Promise<void> {
    const pkg = this.androidPackage;
    const targets = getAndroidPlatform().resetPaths;
    for (const t of targets) {
      // eslint-disable-next-line no-await-in-loop
      const res = await this.runAdb(["shell", "run-as", pkg, "rm", "-f", t]);
      if (res.code !== 0) {
        this.log.debug("coldReset: rm non-zero (likely absent)", {
          target: t,
          stderr: res.stderr.slice(0, 200),
        });
      }
    }
    await this.forceStop();
  }

  async logcat(opts: { sinceMarker?: string; max?: number } = {}): Promise<string> {
    const max = opts.max ?? 200;
    const tag = getAndroidPlatform().crashLogTag;
    let out = "";
    try {
      // -d dumps-and-exits; `<tag>:*` `*:S` silences all tags except the crash tag.
      out = await this.execAdb(
        ["logcat", "-d", "-v", "brief", `${tag}:*`, "*:S"],
        20000,
      );
    } catch (err) {
      this.log.debug("logcat failed", { err: String(err) });
      return "";
    }
    const lines = out.split("\n");
    // Marker not found ⇒ ring buffer rotated past it; fall back to the tail.
    if (opts.sinceMarker) {
      let lastIdx = -1;
      for (let i = lines.length - 1; i >= 0; i--) {
        if (lines[i]!.includes(opts.sinceMarker)) {
          lastIdx = i;
          break;
        }
      }
      if (lastIdx >= 0) {
        return lines.slice(lastIdx + 1).join("\n").trim();
      }
    }
    return lines.slice(-max).join("\n").trim();
  }

  // Emits a marker under the crash log tag so it lands in the SAME filtered stream
  // logcat reads. Returns "" on failure (caller then tails).
  async markLog(): Promise<string> {
    const marker = `PI-E2E-MARK-${Date.now()}-${process.pid}`;
    const tag = getAndroidPlatform().crashLogTag;
    try {
      await this.execAdb(["shell", "log", "-t", tag, marker], 10000);
    } catch (err) {
      this.log.debug("markLog failed", { err: String(err) });
      return "";
    }
    return marker;
  }

  async isReachable(): Promise<boolean> {
    try {
      const res = await this.runAdb(["get-state"], 8000);
      return res.code === 0 && res.stdout.trim() === "device";
    } catch {
      return false;
    }
  }
}
