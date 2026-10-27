// Correlates the ONE in-flight hub intent with the pi run that answers it. Pure
// (no pi imports) so the lifecycle is unit-testable; spoke/index.ts feeds it pi events.
//
// pi-agent-core's agent loop (dist/agent-loop.js runLoop, pi 1.4.0) drains queued
// follow-ups INSIDE the run already going — after its last assistant turn, before
// its one agent_end, with no new agent_start. An intent queued via
// deliverAs:"followUp" behind a busy session therefore shares that run, so nothing
// here may wait for "the intent's own agent_start": it never comes. Instead the
// intent is armed at dispatch, every later agent_end overwrites the capture (the
// follow-up runs last, so the run's final assistant text is the intent's answer),
// and agent_settled — fired only once no retry, compaction or queued message
// remains — resolves it.

export interface IntentSettlement {
  requestId: string;
  ok: boolean;
  text: string;
  error?: string;
}

export interface IntentLifecycle {
  readonly requestId: string | null;
  begin(requestId: string, intent: string): void;
  end(): void;
  compactionStarted(): void;
  compactionEnded(): void;
  captureAgentEnd(text: string): void;
  settle(aborted: boolean): IntentSettlement | null;
}

export function createIntentLifecycle(dispatch: (intent: string) => void): IntentLifecycle {
  let active: {
    requestId: string;
    intent: string;
    dispatched: boolean;
    captured: string | null;
  } | null = null;
  // pi rejects a prompt while a manual compaction runs ("Cannot submit a prompt
  // while compaction is in progress"), and pi.sendUserMessage reports that only as
  // an extension_error — so an intent arriving mid-compaction (the hub sends one
  // right after /reset) is held here and dispatched when compaction ends.
  let compacting = false;

  const flush = (): void => {
    if (!active || active.dispatched || compacting) return;
    active.dispatched = true;
    dispatch(active.intent);
  };

  return {
    get requestId() {
      return active?.requestId ?? null;
    },
    begin(requestId, intent) {
      active = { requestId, intent, dispatched: false, captured: null };
      flush();
    },
    end() {
      active = null;
    },
    compactionStarted() {
      compacting = true;
    },
    compactionEnded() {
      compacting = false;
      flush();
    },
    captureAgentEnd(text) {
      if (active?.dispatched) active.captured = text;
    },
    settle(aborted) {
      if (!active?.dispatched) return null;
      const { requestId, captured } = active;
      // Either the intent's run or the run carrying it as a queued follow-up was
      // aborted (Esc); partial text must not pass as a verdict.
      if (aborted) return { requestId, ok: false, text: captured ?? "", error: "intent run aborted" };
      // No agent_end since dispatch: this settle closes a run that ended before the
      // intent arrived; the intent's own run is still to come.
      if (captured === null) return null;
      return { requestId, ok: true, text: captured };
    },
  };
}
