/**
 * Regression tests for tokenMatches — the ONLY credential gating the transport
 * that accepts shutdown/reset/intent. Asserts constant-time-safe behaviour: no
 * throw on length mismatch (both sides are hashed) and a missing token rejects.
 */
import { describe, expect, test } from "bun:test";
import { tokenMatches } from "./transport.ts";

describe("tokenMatches", () => {
  const token = "device-token-42";

  test("accepts the exact token", () => {
    expect(tokenMatches(token, token)).toBe(true);
  });

  test("rejects a wrong token of equal length", () => {
    expect(tokenMatches("device-token-XX", token)).toBe(false);
  });

  test("rejects a shorter/longer token WITHOUT throwing (the hash is why)", () => {
    expect(() => tokenMatches("nope", token)).not.toThrow();
    expect(tokenMatches("nope", token)).toBe(false);
    expect(tokenMatches(token + "extra", token)).toBe(false);
  });

  test("rejects undefined (no header provided)", () => {
    expect(tokenMatches(undefined, token)).toBe(false);
  });

  test("rejects empty string against a real token", () => {
    expect(tokenMatches("", token)).toBe(false);
  });
});
