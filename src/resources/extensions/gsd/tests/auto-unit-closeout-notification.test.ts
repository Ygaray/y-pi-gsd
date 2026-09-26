// Project/App: gsd-pi
// File Purpose: SIGNAL-04 (notification half) regression tests — every
// closeoutAutoUnit call must append one per-unit unit-complete notification,
// scoped so back-to-back units cannot dedup away, independent of the metrics
// ledger, and non-fatal on failure.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";

import {
  UNIT_COMPLETE_NOTIFICATION_KIND,
  buildUnitCompletionNotice,
  notifyUnitCompletion,
  type UnitCompletionNotificationDeps,
} from "../auto-unit-closeout.ts";
import {
  initNotificationStore,
  readNotifications,
  _resetNotificationStore,
} from "../notification-store.ts";

function makeMockDeps(overrides: Partial<UnitCompletionNotificationDeps> = {}): UnitCompletionNotificationDeps & {
  appendCalls: Array<{ message: string; severity: string; source: string; meta: { kind: string; scope: string } }>;
  emitCalls: Array<{ kind: string; message: string; details?: Record<string, unknown> }>;
  warnCalls: string[];
} {
  const appendCalls: Array<{ message: string; severity: string; source: string; meta: { kind: string; scope: string } }> = [];
  const emitCalls: Array<{ kind: string; message: string; details?: Record<string, unknown> }> = [];
  const warnCalls: string[] = [];
  return {
    append: (message, severity, source, meta) => appendCalls.push({ message, severity, source, meta }),
    emit: async (kind, message, details) => {
      emitCalls.push({ kind, message, details });
    },
    warn: (message) => warnCalls.push(message),
    appendCalls,
    emitCalls,
    warnCalls,
    ...overrides,
  };
}

// ─── Task 1: buildUnitCompletionNotice (pure) ──────────────────────────────

test("buildUnitCompletionNotice: non-empty unitId produces a notice containing both unitType and unitId", () => {
  const notice = buildUnitCompletionNotice("research-slice", "M001/S01");
  assert.ok(notice.length > 0);
  assert.match(notice, /research-slice/);
  assert.match(notice, /M001\/S01/);
});

test("buildUnitCompletionNotice: empty unitId falls back to a unitType-only notice, no dangling separator", () => {
  const notice = buildUnitCompletionNotice("execute-task", "");
  assert.ok(notice.length > 0);
  assert.match(notice, /execute-task/);
  assert.doesNotMatch(notice, /:\s*$/);
  assert.doesNotMatch(notice, /\/\s*$/);
  assert.doesNotMatch(notice, /\s$/);
});

test("buildUnitCompletionNotice: output stays well under the 500-char truncation threshold for a realistic unit id", () => {
  const notice = buildUnitCompletionNotice("execute-task", "M001/S01/T01");
  assert.ok(notice.length < 500);
});

// ─── Task 1: notifyUnitCompletion with injected deps ───────────────────────

test("notifyUnitCompletion: calls append exactly once with success/notify/unit-complete and the per-unit scope", async () => {
  const deps = makeMockDeps();
  await notifyUnitCompletion("execute-task", "M001/S01/T01", deps);

  assert.equal(deps.appendCalls.length, 1);
  const call = deps.appendCalls[0];
  assert.equal(call.severity, "success");
  assert.equal(call.source, "notify");
  assert.equal(call.meta.kind, UNIT_COMPLETE_NOTIFICATION_KIND);
  assert.equal(call.meta.scope, "execute-task/M001/S01/T01");
  assert.match(call.message, /execute-task/);
  assert.match(call.message, /M001\/S01\/T01/);
});

test("notifyUnitCompletion: also calls the extension-event emitter exactly once", async () => {
  const deps = makeMockDeps();
  await notifyUnitCompletion("execute-task", "M001/S01/T01", deps);

  assert.equal(deps.emitCalls.length, 1);
});

test("notifyUnitCompletion: an injected append throw resolves without rejecting, and warns exactly once", async () => {
  const deps = makeMockDeps({
    append: () => {
      throw new Error("simulated append failure");
    },
  });

  await assert.doesNotReject(() => notifyUnitCompletion("execute-task", "M001/S01/T01", deps));
  assert.equal(deps.warnCalls.length, 1);
  assert.match(deps.warnCalls[0], /simulated append failure/);
});

// ─── Task 1: notifyUnitCompletion against the REAL store (dedup proof) ────

test("notifyUnitCompletion: two DIFFERENT unit ids back to back with no clock advance yield TWO store entries, in call order", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "notify-store-test-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetNotificationStore();
  });
  initNotificationStore(dir);

  await notifyUnitCompletion("execute-task", "M001/S01/T01");
  await notifyUnitCompletion("execute-task", "M001/S01/T02");

  const entries = readNotifications(dir, { kind: UNIT_COMPLETE_NOTIFICATION_KIND });
  assert.equal(entries.length, 2);
  // readNotifications returns newest-first; call order is oldest-first.
  const inCallOrder = [...entries].reverse();
  assert.equal(inCallOrder[0].scope, "execute-task/M001/S01/T01");
  assert.equal(inCallOrder[1].scope, "execute-task/M001/S01/T02");
});

test("notifyUnitCompletion: two IDENTICAL unit closeouts back to back with no clock advance yield ONE store entry (pre-existing dedup preserved)", async (t: TestContext) => {
  const dir = mkdtempSync(join(tmpdir(), "notify-store-test-"));
  t.after(() => {
    rmSync(dir, { recursive: true, force: true });
    _resetNotificationStore();
  });
  initNotificationStore(dir);

  await notifyUnitCompletion("execute-task", "M001/S01/T01");
  await notifyUnitCompletion("execute-task", "M001/S01/T01");

  const entries = readNotifications(dir, { kind: UNIT_COMPLETE_NOTIFICATION_KIND });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].scope, "execute-task/M001/S01/T01");
});
