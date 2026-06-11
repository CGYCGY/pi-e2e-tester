/**
 * Regression tests for safeWorkspacePath — the in-code filename guard (matches
 * spoke/guards.ts "guarded in code"). pi has no path sandbox, so this is the
 * only check on every name the gated LLMs pass; assert the rejections.
 */
import { describe, expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { safeWorkspacePath } from "./workspace.ts";

const root = resolve(tmpdir(), "pie2e-guard-spec");

describe("safeWorkspacePath", () => {
  test("accepts a bare <name>.<ext> and resolves into the subfolder", () => {
    const p = safeWorkspacePath(root, "cases", "smoke.md", "md");
    expect(p).toBe(resolve(root, "cases", "smoke.md"));
  });

  test("accepts the dotted/hyphen/underscore name charset", () => {
    expect(() => safeWorkspacePath(root, "cases", "a.b_c-1.md", "md")).not.toThrow();
  });

  test.each([
    ["../escape.md", "parent traversal"],
    ["../../etc/passwd.md", "deep traversal"],
    ["sub/case.md", "forward slash"],
    ["a\\b.md", "back slash"],
    ["/abs/case.md", "absolute path"],
    ["case.json", "wrong extension"],
    ["case", "no extension"],
    ["", "empty name"],
    [".md", "extension only, no stem"],
    ["foo bar.md", "space in name"],
    ["name$().md", "shell metacharacters"],
  ])("rejects %j (%s)", (name: string) => {
    expect(() => safeWorkspacePath(root, "cases", name, "md")).toThrow();
  });

  test("ext arg tolerates a leading dot", () => {
    expect(safeWorkspacePath(root, "cases", "x.md", ".md")).toBe(resolve(root, "cases", "x.md"));
  });
});
