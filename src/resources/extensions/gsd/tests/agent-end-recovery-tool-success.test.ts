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
