// GSD Extension — Loop Notice Throttle Tests
//
// Covers NOISE-03 (file-change safety notice collapse + per-violation store
// suppression) and NOISE-04 (idle-watchdog + blocked-resume notice collapse).
// Drives the real production call sites (reportFileChangeWarnings,
// notifyDeduped + buildUnitNoticeScope) through the real notification store
// and notify-interceptor chokepoint so the assertions are behavioral, not
// grep-only.

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initNotificationStore,
  readNotifications,
  _resetNotificationStore,
  DEDUP_WINDOW_MS,
} from "../notification-store.js";
import { installNotifyInterceptor, notifyDeduped } from "../bootstrap/notify-interceptor.js";
import {
  reportFileChangeWarnings,
  SAFETY_FILE_CHANGE_NOTIFICATION_KIND,
} from "../auto-post-unit.js";
import type { FileChangeAudit, FileViolation } from "../safety/file-change-validator.js";
import { peekLogs, _resetLogs } from "../workflow-logger.js";
import {
  IDLE_STALLED_TOOL_NOTIFICATION_KIND,
  IDLE_NO_PROGRESS_NOTIFICATION_KIND,
  IDLE_WATCHDOG_ERROR_NOTIFICATION_KIND,
  buildUnitNoticeScope,
} from "../auto-timers.js";
import { BLOCKED_RESUME_NOTIFICATION_KIND } from "../auto/pre-dispatch.js";

function makeCtx() {
  const forwarded: Array<{ message: string; type?: string }> = [];
  const ctx = {
    ui: {
      notify(message: string, type?: "info" | "warning" | "error" | "success") {
        forwarded.push({ message, type });
      },
    },
  } as any;
  return { ctx, forwarded };
}

function makeAudit(violations: FileViolation[]): FileChangeAudit {
  return {
    expectedFiles: [],
    actualFiles: [],
    unexpectedFiles: [],
    missingFiles: [],
    violations,
  };
}

describe("loop-notice-throttle: file-change safety (NOISE-03)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-loop-notice-throttle-test-"));
    mkdirSync(join(tmp, ".gsd"), { recursive: true });
    _resetNotificationStore();
    _resetLogs();
  });

  afterEach(() => {
    _resetNotificationStore();
    _resetLogs();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("cross-call collapse (D-02): same scope, two calls, no clock advance -> one notice", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "a.ts", reason: "unexpected" }]),
      "M001",
    );
    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "b.ts", reason: "unexpected" }]),
      "M001",
    );

    assert.equal(forwarded.length, 1, "the second same-scope call must collapse");
    const entries = readNotifications(tmp, { kind: SAFETY_FILE_CHANGE_NOTIFICATION_KIND });
    assert.equal(entries.length, 1, "only one safety-file-change entry must persist");
  });

  test("different milestone is NOT collapsed: two distinct scopes -> two notices", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "a.ts", reason: "unexpected" }]),
      "M001",
    );
    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "a.ts", reason: "unexpected" }]),
      "M002",
    );

    assert.equal(forwarded.length, 2, "a different milestone scope must still be heard");
    const entries = readNotifications(tmp, { kind: SAFETY_FILE_CHANGE_NOTIFICATION_KIND });
    assert.equal(entries.length, 2);
  });

  test("window expiry: same scope, clock advanced past 30000ms -> two notices", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "a.ts", reason: "unexpected" }]),
      "M001",
    );
    now += DEDUP_WINDOW_MS;
    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "warning", file: "a.ts", reason: "unexpected" }]),
      "M001",
    );

    assert.equal(forwarded.length, 2, "a repeat after the window elapses must forward again");
  });

  test("one entry per audit, not one per file: 20+ violations collapse to one store entry", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    const violations: FileViolation[] = Array.from({ length: 25 }, (_, i) => ({
      severity: "warning" as const,
      file: `path/to/file-${i}.ts`,
      reason: "unexpected file change",
    }));

    reportFileChangeWarnings(ctx, makeAudit(violations), "M001");

    assert.equal(forwarded.length, 1, "exactly one toast for the whole audit");
    const all = readNotifications(tmp);
    assert.equal(all.length, 1, "exactly one total store entry — no per-file workflow-logger entries");
    assert.match(all[0].message, /Safety: 25 unexpected file change\(s\) outside task plan/);
  });

  test("info-severity violations do not notify", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    reportFileChangeWarnings(
      ctx,
      makeAudit([{ severity: "info", file: "a.ts", reason: "informational only" }]),
      "M001",
    );

    assert.equal(forwarded.length, 0);
    assert.equal(readNotifications(tmp).length, 0);
  });

  test("null audit and empty-violations audit produce zero notices and do not throw", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    assert.doesNotThrow(() => reportFileChangeWarnings(ctx, null, "M001"));
    assert.doesNotThrow(() => reportFileChangeWarnings(ctx, makeAudit([]), "M001"));

    assert.equal(forwarded.length, 0);
    assert.equal(readNotifications(tmp).length, 0);
  });

  test("audit trail survives: the workflow-logger buffer still holds one entry per violation", () => {
    initNotificationStore(tmp);
    const { ctx } = makeCtx();
    installNotifyInterceptor(ctx);

    const violations: FileViolation[] = Array.from({ length: 25 }, (_, i) => ({
      severity: "warning" as const,
      file: `path/to/file-${i}.ts`,
      reason: "unexpected file change",
    }));

    reportFileChangeWarnings(ctx, makeAudit(violations), "M001");

    const logged = peekLogs().filter((e) => e.component === "safety");
    assert.equal(logged.length, 25, "every individual violation must still reach the workflow log");
  });
});

describe("loop-notice-throttle: idle watchdog + blocked-resume (NOISE-04)", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-loop-notice-throttle-test-"));
    mkdirSync(join(tmp, ".gsd"), { recursive: true });
    _resetNotificationStore();
  });

  afterEach(() => {
    _resetNotificationStore();
    rmSync(tmp, { recursive: true, force: true });
  });

  test("same unit, repeated tick: two calls, same scope -> one notice", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);
    const scope = buildUnitNoticeScope("execute-task", "M1/S1/T1");

    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope });
    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope });

    assert.equal(forwarded.length, 1);
  });

  test("different unit, same window (Pitfall 4): two distinct scopes -> two notices", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);
    const scopeA = buildUnitNoticeScope("execute-task", "M1/S1/T1");
    const scopeB = buildUnitNoticeScope("execute-task", "M1/S1/T2");

    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope: scopeA });
    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope: scopeB });

    assert.equal(forwarded.length, 2, "a second genuinely-idle unit must still reach the operator");
  });

  test("different notice kinds on the same unit do not cross-suppress", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);
    const scope = buildUnitNoticeScope("execute-task", "M1/S1/T1");

    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope });
    notifyDeduped(ctx, "No progress detected", "warning", { kind: IDLE_NO_PROGRESS_NOTIFICATION_KIND, scope });
    notifyDeduped(ctx, "Watchdog error", "warning", { kind: IDLE_WATCHDOG_ERROR_NOTIFICATION_KIND, scope });

    assert.equal(forwarded.length, 3);
  });

  test("buildUnitNoticeScope shape matches auto-unit-closeout.ts's ${unitType}/${unitId} convention", () => {
    assert.equal(buildUnitNoticeScope("execute-task", "M1/S1/T1"), "execute-task/M1/S1/T1");
  });

  test("blocked-resume, same milestone: two calls -> one notice; different milestone -> two notices", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    notifyDeduped(ctx, "Auto-mode is blocked", "warning", { kind: BLOCKED_RESUME_NOTIFICATION_KIND, scope: "M001" });
    notifyDeduped(ctx, "Auto-mode is blocked", "warning", { kind: BLOCKED_RESUME_NOTIFICATION_KIND, scope: "M001" });
    assert.equal(forwarded.length, 1);

    notifyDeduped(ctx, "Auto-mode is blocked", "warning", { kind: BLOCKED_RESUME_NOTIFICATION_KIND, scope: "M002" });
    assert.equal(forwarded.length, 2, "a different milestone must still be heard");
  });

  test("blocked-resume with an empty scope does not throw, persists once, and repeat collapses", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    assert.doesNotThrow(() => {
      notifyDeduped(ctx, "Auto-mode is blocked", "warning", { kind: BLOCKED_RESUME_NOTIFICATION_KIND, scope: "" });
      notifyDeduped(ctx, "Auto-mode is blocked", "warning", { kind: BLOCKED_RESUME_NOTIFICATION_KIND, scope: "" });
    });
    assert.equal(forwarded.length, 1);
  });

  test("window expiry for a unit notice: same kind and scope, clock advanced past 30000ms -> two notices", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);
    const scope = buildUnitNoticeScope("execute-task", "M1/S1/T1");

    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope });
    now += DEDUP_WINDOW_MS;
    notifyDeduped(ctx, "Stalled tool detected", "warning", { kind: IDLE_STALLED_TOOL_NOTIFICATION_KIND, scope });

    assert.equal(forwarded.length, 2);
  });

  test("all new kind values are pairwise distinct from each other and from Phase 23's kinds", () => {
    const kinds = [
      SAFETY_FILE_CHANGE_NOTIFICATION_KIND,
      IDLE_STALLED_TOOL_NOTIFICATION_KIND,
      IDLE_NO_PROGRESS_NOTIFICATION_KIND,
      IDLE_WATCHDOG_ERROR_NOTIFICATION_KIND,
      BLOCKED_RESUME_NOTIFICATION_KIND,
      "unit-complete",
      "turn-complete",
    ];
    assert.equal(new Set(kinds).size, kinds.length, "no two kind strings may collide");
  });
});
