// Event sequences mirror pi 1.4.0: a follow-up queued behind a busy run is drained
// inside that run, so it yields one agent_end + one agent_settled and NO new
// agent_start (the old agent_start arming left such intents to time out).
import { describe, expect, test } from "bun:test";
import { createIntentLifecycle } from "./intent.ts";

const setup = () => {
  const sent: string[] = [];
  const life = createIntentLifecycle((intent) => sent.push(intent));
  return { sent, life };
};

describe("intent lifecycle", () => {
  test("dispatches at begin and resolves on settle with the captured text", () => {
    const { sent, life } = setup();
    life.begin("r1", "sign in");
    expect(sent).toEqual(["sign in"]);
    life.captureAgentEnd("done\nVERDICT: PASS");
    expect(life.settle()).toEqual({ requestId: "r1", ok: true, text: "done\nVERDICT: PASS" });
  });

  test("a follow-up sharing a busy run resolves from that run's single agent_end", () => {
    const { life } = setup();
    life.begin("r1", "sign in"); // operator run in flight; intent queued as follow-up
    life.captureAgentEnd("intent answer\nVERDICT: FAIL"); // last assistant of the shared run
    expect(life.settle()?.text).toBe("intent answer\nVERDICT: FAIL");
  });

  test("a settle with no agent_end since dispatch is not credited", () => {
    const { life } = setup();
    life.begin("r1", "sign in");
    expect(life.settle()).toBeNull();
    life.captureAgentEnd("VERDICT: PASS");
    expect(life.settle()?.ok).toBe(true);
  });

  test("a later agent_end (retry / continuation) overwrites the capture", () => {
    const { life } = setup();
    life.begin("r1", "x");
    life.captureAgentEnd("");
    life.captureAgentEnd("retried\nVERDICT: PASS");
    expect(life.settle()?.text).toBe("retried\nVERDICT: PASS");
  });

  test("holds dispatch during compaction and ignores runs until it ends", () => {
    const { sent, life } = setup();
    life.compactionStarted();
    life.begin("r1", "x");
    expect(sent).toEqual([]);
    life.captureAgentEnd("unrelated");
    expect(life.settle()).toBeNull();
    life.compactionEnded();
    life.compactionEnded();
    expect(sent).toEqual(["x"]);
    life.captureAgentEnd("VERDICT: PASS");
    expect(life.settle()?.text).toBe("VERDICT: PASS");
  });

  test("after end, late events resolve nothing and a held intent is never sent", () => {
    const { sent, life } = setup();
    life.compactionStarted();
    life.begin("r1", "x");
    life.end();
    life.compactionEnded();
    expect(sent).toEqual([]);
    expect(life.requestId).toBeNull();
    expect(life.settle()).toBeNull();
  });
});
