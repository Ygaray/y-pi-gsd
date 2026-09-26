import test from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

import { autoSession } from "../auto-runtime-state.ts";
import { registerHooks } from "../bootstrap/register-hooks.ts";
import { signalTurnEnd, type TurnCompletionSignalDeps } from "../bootstrap/turn-completion-signal.ts";
import { setHookEmitter, clearHookEmitter } from "../hook-emitter.ts";
import { initNotificationStore, readNotifications, _resetNotificationStore } from "../notification-store.ts";

type Handler = (event: any, ctx?: any) => Promise<any> | any;

function makeHookHarness(): {
  emitToolCall: (toolName: string, input: Record<string, unknown>) => Promise<any>;
  emitToolResult: (event: Record<string, unknown>) => Promise<void>;
  emitToolExecutionEnd: (event: Record<string, unknown>) => Promise<void>;
  emitAgentEnd: (event: Record<string, unknown>) => Promise<void>;
  piEvents: any[];
} {
  const handlers = new Map<string, Handler[]>();
  const piEvents: any[] = [];
  const pi = {
    on(event: string, handler: Handler) {
      const existing = handlers.get(event) ?? [];
      existing.push(handler);
      handlers.set(event, existing);
    },
    async emitExtensionEvent(event: any) {
      piEvents.push(event);
      return undefined;
    },
  };
  const ctx = {
    cwd: process.cwd(),
    ui: { notify: () => undefined, setStatus: () => undefined, setWidget: () => undefined },
    hasPendingMessages: () => false,
  };
  let callId = 0;

  registerHooks(pi as any, []);
  setHookEmitter(pi as any);

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
    piEvents,
  };
}

function makeRuntimeBase(): string {
  const base = join(tmpdir(), `gsd-turn-completion-${randomUUID()}`);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function makeDepsDouble(): TurnCompletionSignalDeps & {
  bellCalls: Array<"attention">;
  notifyCalls: Array<{ message: string; severity: string; source: string; meta: { kind: string; scope?: string } }>;
  stopCalls: Array<Record<string, unknown>>;
  idleCalls: Array<{ message: string }>;
} {
  const bellCalls: Array<"attention"> = [];
  const notifyCalls: Array<{ message: string; severity: string; source: string; meta: { kind: string; scope?: string } }> = [];
  const stopCalls: Array<Record<string, unknown>> = [];
  const idleCalls: Array<{ message: string }> = [];
  let autoActiveValue = false;
  return {
    autoActive: () => autoActiveValue,
    playBell: (kind: "attention") => {
      bellCalls.push(kind);
      return true;
    },
    appendNotification: (
      message: string,
      severity: "info",
      source: "notify",
      meta: { kind: string; scope?: string },
    ) => {
      notifyCalls.push({ message, severity, source, meta });
    },
    emitStop: async (args: Record<string, unknown>) => {
      stopCalls.push(args);
    },
    emitNotification: async (_kind: "idle", message: string) => {
      idleCalls.push({ message });
    },
    bellCalls,
    notifyCalls,
    stopCalls,
    idleCalls,
    set autoActiveFlag(v: boolean) {
      autoActiveValue = v;
    },
  } as any;
}

// ─── Deps-double payload-shape assertions ───────────────────────────────────

test("signalTurnEnd (interactive, clean end): bell + turn-complete store entry + one StopEvent(completed)", async () => {
  const deps = makeDepsDouble();
  const ctx: any = { hasPendingMessages: () => false };
  await signalTurnEnd({ messages: [], willRetry: false }, ctx, {}, deps);

  assert.equal(deps.bellCalls.length, 1);
  assert.deepEqual(deps.bellCalls, ["attention"]);
  assert.equal(deps.notifyCalls.length, 1);
  assert.equal(deps.notifyCalls[0].meta.kind, "turn-complete");
  assert.equal(deps.stopCalls.length, 1);
  assert.equal(deps.stopCalls[0].reason, "completed");

  // T-23-01: the emitted stop payload must carry no message-bearing key —
  // only reason/abortOrigin/sessionId/turnId.
  const keys = Object.keys(deps.stopCalls[0]).sort();
  for (const key of keys) {
    assert.ok(
      ["reason", "abortOrigin", "sessionId", "turnId"].includes(key),
      `unexpected key on StopEvent payload: ${key}`,
    );
  }
});

test("signalTurnEnd (auto-active): zero bells, zero turn-complete entries, still one StopEvent", async () => {
  const deps = makeDepsDouble();
  (deps as any).autoActiveFlag = true;
  const ctx: any = { hasPendingMessages: () => false };
  await signalTurnEnd({ messages: [], willRetry: false }, ctx, {}, deps);

  assert.equal(deps.bellCalls.length, 0);
  assert.equal(deps.notifyCalls.length, 0);
  assert.equal(deps.idleCalls.length, 0);
  assert.equal(deps.stopCalls.length, 1);
  assert.equal(deps.stopCalls[0].reason, "completed");
});

test("signalTurnEnd (willRetry: true): emits nothing", async () => {
  const deps = makeDepsDouble();
  const ctx: any = { hasPendingMessages: () => false };
  await signalTurnEnd({ messages: [], willRetry: true }, ctx, {}, deps);

  assert.equal(deps.bellCalls.length, 0);
  assert.equal(deps.notifyCalls.length, 0);
  assert.equal(deps.idleCalls.length, 0);
  assert.equal(deps.stopCalls.length, 0, "willRetry: true must dispatch zero StopEvents");
});

test("signalTurnEnd (pending tool call in last message): no interactive signal, still one StopEvent", async () => {
  const deps = makeDepsDouble();
  const ctx: any = { hasPendingMessages: () => false };
  await signalTurnEnd(
    {
      messages: [{ role: "assistant", content: [{ type: "toolCall", id: "x", name: "web_search", arguments: {} }] }],
      willRetry: false,
    } as any,
    ctx,
    {},
    deps,
  );

  assert.equal(deps.bellCalls.length, 0);
  assert.equal(deps.notifyCalls.length, 0);
  assert.equal(deps.stopCalls.length, 1);
});

// ─── Real registerHooks harness — end-to-end wiring proof ───────────────────

test("register-hooks agent_end handler is wired to signalTurnEnd end-to-end", async (t) => {
  autoSession.reset();
  _resetNotificationStore();
  clearHookEmitter();
  const base = makeRuntimeBase();
  initNotificationStore(base);
  t.after(() => {
    autoSession.reset();
    _resetNotificationStore();
    clearHookEmitter();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd, piEvents } = makeHookHarness();

  await emitAgentEnd({ messages: [], willRetry: false });

  const stopEvents = piEvents.filter((e) => e.type === "stop");
  assert.equal(stopEvents.length, 1, "exactly one StopEvent must reach _pi.emitExtensionEvent");
  assert.equal(stopEvents[0].reason, "completed");

  const entries = readNotifications(base, { kind: "turn-complete" });
  assert.equal(entries.length, 1, "exactly one turn-complete notification-store entry");
});

test("register-hooks agent_end handler: auto-active turn emits StopEvent but no turn-complete entry", async (t) => {
  autoSession.reset();
  autoSession.active = true;
  _resetNotificationStore();
  clearHookEmitter();
  const base = makeRuntimeBase();
  initNotificationStore(base);
  t.after(() => {
    autoSession.reset();
    _resetNotificationStore();
    clearHookEmitter();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd, piEvents } = makeHookHarness();

  await emitAgentEnd({ messages: [], willRetry: false });

  const stopEvents = piEvents.filter((e) => e.type === "stop");
  assert.equal(stopEvents.length, 1, "auto-mode turn end still dispatches exactly one StopEvent");

  const entries = readNotifications(base, { kind: "turn-complete" });
  assert.equal(entries.length, 0, "auto-mode must not double-fire the interactive turn-complete entry");
});

test("register-hooks agent_end handler: willRetry true emits zero StopEvents", async (t) => {
  autoSession.reset();
  _resetNotificationStore();
  clearHookEmitter();
  const base = makeRuntimeBase();
  initNotificationStore(base);
  t.after(() => {
    autoSession.reset();
    _resetNotificationStore();
    clearHookEmitter();
    rmSync(base, { recursive: true, force: true });
  });

  const { emitAgentEnd, piEvents } = makeHookHarness();

  await emitAgentEnd({ messages: [], willRetry: true });

  const stopEvents = piEvents.filter((e) => e.type === "stop");
  assert.equal(stopEvents.length, 0, "willRetry: true must reach zero emitStop calls end-to-end");

  const entries = readNotifications(base, { kind: "turn-complete" });
  assert.equal(entries.length, 0);
});
