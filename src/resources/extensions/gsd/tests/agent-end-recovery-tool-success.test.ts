// gsd-pi + src/resources/extensions/gsd/tests/agent-end-recovery-tool-success.test.ts
// SIGNAL-03: a completed operation whose trailing chat message was aborted must
// resolve as done, not surface an "Operation aborted" pause — Phase 23 Plan 02.

import test from "node:test";
import assert from "node:assert/strict";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import {
  getLastTurnToolOutcome,
  recordTurnToolOutcome,
  resetTurnToolOutcome,
} from "../auto-tool-tracking.ts";
import {
  _shouldOverrideAbortedPauseAfterToolSuccess,
  handleAgentEnd,
} from "../bootstrap/agent-end-recovery.ts";
import { _resetPendingResolve, _setCurrentResolve } from "../auto/resolve.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  emitToolResult: (event: Record<string, unknown>) => Promise<void>;
  emitToolExecutionEnd: (event: Record<string, unknown>) => Promise<void>;
  emitAgentEnd: (event: Record<string, unknown>) => Promise<void>;
} {
  const handlers = new Map<string, Handler[]>();
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    hasPendingMessages: () => false,
  };
  let callId = 0;

  registerHooks(pi as any, []);

  return {
    async emitToolCall(toolName: string, input: Record<string, unknown>): Promise<any> {
      callId += 1;
      const loopGuardHandler = handlers.get("tool_call")?.[0];
      assert.ok(loopGuardHandler, "loop-guard tool_call handler should be registered");
      return loopGuardHandler({ toolCallId: `loop-${callId}`, toolName, input }, ctx);
    },
    async emitToolResult(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_result") ?? []) {
        await handler({
          toolCallId: `result-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitToolExecutionEnd(event: Record<string, unknown>): Promise<void> {
      callId += 1;
      for (const handler of handlers.get("tool_execution_end") ?? []) {
        await handler({
          toolCallId: `exec-${callId}`,
          ...event,
        }, ctx);
      }
    },
    async emitAgentEnd(event: Record<string, unknown>): Promise<void> {
      for (const handler of handlers.get("agent_end") ?? []) {
        await handler(event, ctx);
      }
    },
  };
}

// ─── Task 1: the generic per-turn tool-outcome tracker ──────────────────────

test("getLastTurnToolOutcome starts at null on fresh module state", () => {
  resetTurnToolOutcome();
  assert.equal(getLastTurnToolOutcome(), null);
});

test("recordTurnToolOutcome(true) then read returns true", () => {
  resetTurnToolOutcome();
  recordTurnToolOutcome(true);
  assert.equal(getLastTurnToolOutcome(), true);
});

test("recordTurnToolOutcome is a LAST-call signal: true then false returns false", () => {
  resetTurnToolOutcome();
  recordTurnToolOutcome(true);
  recordTurnToolOutcome(false);
  assert.equal(getLastTurnToolOutcome(), false);
});

test("recordTurnToolOutcome is a LAST-call signal: false then true returns true", () => {
  resetTurnToolOutcome();
  recordTurnToolOutcome(false);
  recordTurnToolOutcome(true);
  assert.equal(getLastTurnToolOutcome(), true);
});

test("resetTurnToolOutcome yields null, distinguishable from false", () => {
  resetTurnToolOutcome();
  recordTurnToolOutcome(false);
  assert.equal(getLastTurnToolOutcome(), false);
  resetTurnToolOutcome();
  assert.equal(getLastTurnToolOutcome(), null, "reset must yield null, not false");
});

test("tool_execution_end records success unconditionally while autoSession is INACTIVE", async (t) => {
  autoSession.reset();
  resetTurnToolOutcome();
  t.after(() => {
    autoSession.reset();
    resetTurnToolOutcome();
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  assert.equal(autoSession.active, false);

  await emitToolExecutionEnd({ toolName: "gsd_validate_milestone", result: "ok", isError: false });

  assert.equal(getLastTurnToolOutcome(), true, "the record must not be gated on auto-mode");
});

test("tool_execution_end records failure unconditionally while autoSession is INACTIVE", async (t) => {
  autoSession.reset();
  resetTurnToolOutcome();
  t.after(() => {
    autoSession.reset();
    resetTurnToolOutcome();
  });

  const { emitToolExecutionEnd } = makeHookHarness();
  assert.equal(autoSession.active, false);

  await emitToolExecutionEnd({ toolName: "gsd_validate_milestone", result: "boom", isError: true });

  assert.equal(getLastTurnToolOutcome(), false);
});

// ─── Task 2: the override predicate + the aborted-pause recovery branch ────

function makeAbortedEvent(content: unknown[], extra: Record<string, unknown> = {}) {
  return {
    messages: [{
      stopReason: "aborted",
      content,
      ...extra,
    }],
  };
}

function minimalPauseCtx(notifications?: Array<{ message: string; level: string }>): any {
  return {
    ui: {
      notify: (message: string, level: string) => notifications?.push({ message, level }),
      setStatus: () => undefined,
      setWidget: () => undefined,
    },
  };
}

test.afterEach(() => {
  autoSession.reset();
  _resetPendingResolve();
  resetTurnToolOutcome();
});

// ── Predicate: _shouldOverrideAbortedPauseAfterToolSuccess ─────────────────

test("_shouldOverrideAbortedPauseAfterToolSuccess: last-call success + no pending -> true", () => {
  assert.equal(
    _shouldOverrideAbortedPauseAfterToolSuccess({ lastToolOutcome: true, hasPendingToolCall: false }),
    true,
  );
});

test("_shouldOverrideAbortedPauseAfterToolSuccess: last-call error + no pending -> false", () => {
  assert.equal(
    _shouldOverrideAbortedPauseAfterToolSuccess({ lastToolOutcome: false, hasPendingToolCall: false }),
    false,
  );
});

test("_shouldOverrideAbortedPauseAfterToolSuccess: zero tool calls (null) + no pending -> false", () => {
  assert.equal(
    _shouldOverrideAbortedPauseAfterToolSuccess({ lastToolOutcome: null, hasPendingToolCall: false }),
    false,
    "zero tool calls this turn is not success",
  );
});

test("_shouldOverrideAbortedPauseAfterToolSuccess: last-call success + pending tool call -> false", () => {
  assert.equal(
    _shouldOverrideAbortedPauseAfterToolSuccess({ lastToolOutcome: true, hasPendingToolCall: true }),
    false,
    "the model was still calling tools",
  );
});

// ── Recovery level: handleAgentEnd's aborted branch ─────────────────────────

test("aborted + non-empty content + tracker true + no pending tool call resolves as done (no pause)", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(true);
  const results: unknown[] = [];
  const notifications: Array<{ message: string; level: string }> = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([{ type: "text", text: "Implemented and verified the task." }]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx(notifications));

  assert.deepEqual(results, [{ status: "completed", event }]);
  assert.ok(
    notifications.some((n) => n.level === "info"),
    "an info notice must explain the treated-as-done override",
  );
});

test("aborted + populated errorMessage + tracker true + no pending tool call resolves as done (reported bug shape)", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(true);
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([], { errorMessage: "stream cut off after tool success" });

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.deepEqual(results, [{ status: "completed", event }]);
});

test("aborted + non-empty content + tracker false still pauses (unchanged)", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(false);
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([{ type: "text", text: "Implemented and verified the task." }]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.equal(results.length, 1);
  assert.equal((results[0] as any).status, "cancelled");
  assert.equal((results[0] as any).errorContext?.category, "aborted");
});

test("aborted + non-empty content + tracker null (zero tool calls) still pauses, distinct from tracker false", async () => {
  autoSession.active = true;
  // resetTurnToolOutcome() already ran in the previous afterEach; tracker is null.
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([{ type: "text", text: "Implemented and verified the task." }]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.equal(results.length, 1);
  assert.equal((results[0] as any).status, "cancelled");
});

test("aborted + tracker true BUT pending tool call in trailing message still pauses", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(true);
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([{ type: "toolCall", id: "x", name: "web_search", arguments: {} }]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.equal(results.length, 1);
  assert.equal((results[0] as any).status, "cancelled", "the model was still calling tools -- must still pause");
});

// ── WR-01: a genuine user-initiated abort must never be overridden ─────────

test("WR-01: abortOrigin \"user\" still pauses even when the last tool call succeeded and nothing is pending", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(true);
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = {
    ...makeAbortedEvent([{ type: "text", text: "Implemented and verified the task." }]),
    abortOrigin: "user",
  };

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.equal(results.length, 1);
  assert.equal(
    (results[0] as any).status,
    "cancelled",
    "a genuine user-initiated abort must still pause, even after a last-call tool success",
  );
  assert.equal((results[0] as any).errorContext?.category, "aborted");
});

test("WR-01: user-abort errorMessage phrasing (no abortOrigin) still pauses even when the last tool call succeeded", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(true);
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent(
    [{ type: "text", text: "Implemented and verified the task." }],
    { errorMessage: "request aborted by user" },
  );

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.equal(results.length, 1);
  assert.equal(
    (results[0] as any).status,
    "cancelled",
    "isUserInitiatedAbortMessage-matching errorMessage must still pause, mirroring the sibling stopReason=='error' branch",
  );
});

// ── Regression: pre-existing branches keep their exact precedence ──────────

test("regression: aborted + EMPTY content + no errorMessage still resolves via the pre-existing empty-content branch, regardless of tracker", async () => {
  autoSession.active = true;
  recordTurnToolOutcome(false); // tracker says failure -- must not matter for this branch
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.deepEqual(results, [{ status: "completed", event }]);
});

test("regression: isAutoCompletionStopInProgress() short-circuits before the new guard, regardless of tracker", async () => {
  autoSession.active = true;
  autoSession.completionStopInProgress = true;
  recordTurnToolOutcome(false); // tracker says failure -- must not matter, this branch wins first
  const results: unknown[] = [];
  _setCurrentResolve((r) => results.push(r));

  const event = makeAbortedEvent([{ type: "text", text: "some content" }]);

  await handleAgentEnd({} as any, event as any, minimalPauseCtx());

  assert.deepEqual(results, [{ status: "completed", event }]);
});
