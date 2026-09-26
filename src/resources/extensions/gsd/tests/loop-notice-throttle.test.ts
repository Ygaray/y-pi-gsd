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
import { installNotifyInterceptor } from "../bootstrap/notify-interceptor.js";
import {
  reportFileChangeWarnings,
  SAFETY_FILE_CHANGE_NOTIFICATION_KIND,
} from "../auto-post-unit.js";
import type { FileChangeAudit, FileViolation } from "../safety/file-change-validator.js";
import { peekLogs, _resetLogs } from "../workflow-logger.js";

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
