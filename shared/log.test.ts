/**
 * Regression tests for rotateRoleLog — the startup archive that keeps hub.log /
 * android.log holding only the CURRENT run (prior runs go to history/). Asserts
 * the archive, the clean reset, the no-op cases, and the retention cap.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { rotateRoleLog } from "./log.ts";

const dir = resolve(tmpdir(), "pie2e-log-rotate-spec");
const logPath = join(dir, "hub.log");
const historyDir = join(dir, "history");

function archived(): string[] {
  if (!existsSync(historyDir)) return [];
  return readdirSync(historyDir).filter((f) => f.startsWith("hub-")).sort();
}

beforeEach(() => {
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe("rotateRoleLog", () => {
  test("archives a non-empty prior log and clears the live path", () => {
    writeFileSync(logPath, "prior run line\n");
    rotateRoleLog(dir, "hub");

    expect(existsSync(logPath)).toBe(false); // live path reset; next append starts clean
    expect(archived()).toHaveLength(1);
  });

  test("is a no-op when there is no prior log", () => {
    rotateRoleLog(dir, "hub");
    expect(archived()).toHaveLength(0);
    expect(existsSync(historyDir)).toBe(false);
  });

  test("is a no-op for an empty prior log (nothing worth keeping)", () => {
    writeFileSync(logPath, "");
    rotateRoleLog(dir, "hub");
    expect(existsSync(logPath)).toBe(true); // left as-is, not archived
    expect(archived()).toHaveLength(0);
  });

  test("keeps only the newest HISTORY_KEEP (20) archives, pruning oldest", () => {
    // Seed 25 archives with strictly increasing mtimes so the sort is deterministic.
    mkdirSync(historyDir, { recursive: true });
    for (let i = 0; i < 25; i++) {
      const f = join(historyDir, `hub-2026-06-23T00-00-${String(i).padStart(2, "0")}.000Z.log`);
      writeFileSync(f, `archive ${i}\n`);
    }
    // Now rotate one more live log in; total seen = 26, cap = 20.
    writeFileSync(logPath, "newest run\n");
    rotateRoleLog(dir, "hub");

    expect(archived()).toHaveLength(20);
    // Oldest seeded names must be gone; the most recent must survive.
    expect(existsSync(join(historyDir, "hub-2026-06-23T00-00-00.000Z.log"))).toBe(false);
    expect(existsSync(join(historyDir, "hub-2026-06-23T00-00-24.000Z.log"))).toBe(true);
  });

  test("names the archive by the prior log's mtime", () => {
    writeFileSync(logPath, "x\n");
    // Pin mtime to a known instant; archive name must reflect it (colons -> '-').
    const when = new Date("2026-06-23T20:30:00.000Z");
    utimesSync(logPath, when, when);
    rotateRoleLog(dir, "hub");

    const names = archived();
    expect(names).toEqual(["hub-2026-06-23T20-30-00.000Z.log"]);
    expect(statSync(join(historyDir, names[0]!)).size).toBeGreaterThan(0);
  });
});
