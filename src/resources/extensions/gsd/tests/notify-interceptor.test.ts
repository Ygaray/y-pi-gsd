// GSD Extension — Notify Interceptor Tests
//
// Covers NOISE-01 (conditional forward suppression) and NOISE-05 (ANSI
// stripping before persistence) end-to-end through installNotifyInterceptor,
// plus notifyDeduped's opt-in kind:scope wrapper and the bounded dedup map
// (T-24-01).

import { describe, test, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  initNotificationStore,
  readNotifications,
  _resetNotificationStore,
  _dedupKeyCount,
  DEDUP_WINDOW_MS,
} from "../notification-store.js";

// Mirrors notification-store.ts's private DEDUP_MAX_ENTRIES (2000) — not
// exported (only the read-only _dedupKeyCount accessor is), so this test
// asserts against the documented contract value directly.
const DEDUP_MAX_ENTRIES_FOR_TEST_REFERENCE = 2000;
import { installNotifyInterceptor, notifyDeduped } from "../bootstrap/notify-interceptor.js";

// Mirrors the SGR + OSC-8 sequences real callers emit (auto-status-message.ts,
// format-utils.ts's fileLink) — not re-imported to keep this test independent
// of those modules' internals.
const ANSI_RESET = "\x1b[0m";
const ANSI_GREEN = "\x1b[32m";
function sgr(text: string, code: string): string {
  return `${code}${text}${ANSI_RESET}`;
}
function osc8Link(filePath: string, label: string): string {
  const uri = `file://${filePath}`;
  return `\x1b]8;;${uri}\x07${label}\x1b]8;;\x07`;
}

describe("notify-interceptor", () => {
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), "gsd-notify-interceptor-test-"));
    mkdirSync(join(tmp, ".gsd"), { recursive: true });
    _resetNotificationStore();
  });

  afterEach(() => {
    _resetNotificationStore();
    rmSync(tmp, { recursive: true, force: true });
  });

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

  test("duplicate suppression (NOISE-01): a repeat inside the window reaches neither terminal nor store", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("same message", "info");
    ctx.ui.notify("same message", "info");

    assert.equal(forwarded.length, 1, "only the first call should reach the terminal");
    assert.equal(readNotifications(tmp).length, 1, "only the first call should persist");
  });

  test("ordering / first-writer-wins: the earlier call survives, the later duplicate is dropped", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("A", "info");
    ctx.ui.notify("A", "info");
    ctx.ui.notify("B", "info");

    assert.deepEqual(forwarded.map((f) => f.message), ["A", "B"]);
    const stored = readNotifications(tmp).map((e) => e.message).sort();
    assert.deepEqual(stored, ["A", "B"]);
  });

  test("adjacency at the boundary: exactly 30000ms elapsed forwards and persists", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("boundary-exact", "info");
    now += DEDUP_WINDOW_MS;
    ctx.ui.notify("boundary-exact", "info");

    assert.equal(forwarded.length, 2, "a repeat at exactly the window boundary must forward");
    assert.equal(readNotifications(tmp).length, 2, "a repeat at exactly the window boundary must persist");
  });

  test("adjacency at the boundary: 29999ms elapsed does not forward or persist", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("boundary-under", "info");
    now += DEDUP_WINDOW_MS - 1;
    ctx.ui.notify("boundary-under", "info");

    assert.equal(forwarded.length, 1, "a repeat at 29999ms elapsed must still be suppressed");
    assert.equal(readNotifications(tmp).length, 1);
  });

  test("empty input: the empty string persists once and forwards once", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("", "info");
    ctx.ui.notify("", "info");

    assert.equal(forwarded.length, 1);
    const entries = readNotifications(tmp);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.message, "");
  });

  test("notifyDeduped idempotency: returns true then false, exactly one store entry, exactly one forwarded toast", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    const first = notifyDeduped(ctx, "deduped event", "warning", { kind: "test-kind", scope: "test-scope" });
    const second = notifyDeduped(ctx, "deduped event", "warning", { kind: "test-kind", scope: "test-scope" });

    assert.equal(first, true);
    assert.equal(second, false);
    assert.equal(readNotifications(tmp).length, 1, "must not double-persist (Pitfall 1's regression signature)");
    assert.equal(forwarded.length, 1);
  });

  test("notifyDeduped with {} meta: does not throw, persists once, prose repeat is suppressed", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    assert.doesNotThrow(() => {
      notifyDeduped(ctx, "prose-identity message", "info", {});
    });
    const second = notifyDeduped(ctx, "prose-identity message", "info", {});

    assert.equal(second, false, "empty meta falls back to prose identity, not the literal 'undefined' key");
    assert.equal(readNotifications(tmp).length, 1);
    assert.equal(forwarded.length, 1);
  });

  test("fail-open: a thrown persistence error still forwards the toast", (t) => {
    initNotificationStore(tmp);
    // Date.now() is called inside appendNotification OUTSIDE its own internal
    // try/catch (only the file write is guarded there) — mocking it to throw
    // drives a genuine exception out of appendNotification and into the
    // interceptor's own try/catch, which is the real fail-open path (T-24-03).
    t.mock.method(Date, "now", () => {
      throw new Error("simulated persistence fault");
    });
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify("still visible", "warning");

    assert.equal(forwarded.length, 1, "a persistence fault must never suppress a real toast");
    assert.equal(forwarded[0]?.message, "still visible");
  });

  test("ANSI strip (NOISE-05): persisted entry has zero escape bytes; forwarded message is byte-identical to styled input", () => {
    initNotificationStore(tmp);
    const { ctx, forwarded } = makeCtx();
    installNotifyInterceptor(ctx);

    const styled = `${sgr("Task complete", ANSI_GREEN)} see ${osc8Link("/tmp/foo.txt", "foo.txt")}`;
    ctx.ui.notify(styled, "success");

    const entries = readNotifications(tmp);
    assert.equal(entries.length, 1);
    assert.ok(!entries[0]?.message.includes("\u001b"), "persisted message must carry zero escape bytes");
    assert.equal(forwarded.length, 1);
    assert.equal(forwarded[0]?.message, styled, "forwarded message must be byte-identical to the styled input");
  });

  test("ANSI strip idempotency: styled then already-plain equivalent both persist with equal stripped text", (t) => {
    initNotificationStore(tmp);
    let now = 1_000;
    t.mock.method(Date, "now", () => now);
    const { ctx } = makeCtx();
    installNotifyInterceptor(ctx);

    const styled = sgr("plain text here", ANSI_GREEN);
    const plain = "plain text here";

    ctx.ui.notify(styled, "info");
    now += DEDUP_WINDOW_MS;
    ctx.ui.notify(plain, "info");

    const entries = readNotifications(tmp);
    assert.equal(entries.length, 2, "both must persist — the window has elapsed");
    assert.equal(entries[0]?.message, entries[1]?.message, "styled and pre-stripped forms must persist identically");
  });

  test("ANSI-only message: a string of nothing but escape sequences persists as an empty-string message", () => {
    initNotificationStore(tmp);
    const { ctx } = makeCtx();
    installNotifyInterceptor(ctx);

    ctx.ui.notify(sgr("", ANSI_GREEN), "info");

    const entries = readNotifications(tmp);
    assert.equal(entries.length, 1, "an ANSI-only message must still persist one entry, not be dropped");
    assert.equal(entries[0]?.message, "");
  });

  test("encoding/truncation ordering: truncation runs on stripped text, not styled text", () => {
    initNotificationStore(tmp);
    const { ctx } = makeCtx();
    installNotifyInterceptor(ctx);

    // Plain text is 495 chars — under the 500 limit. Styling wraps it in
    // escape bytes (ANSI_GREEN "\x1b[32m" + ANSI_RESET "\x1b[0m" = 9 extra
    // chars) pushing the STYLED length over 500.
    const plainCore = "x".repeat(495);
    const styled = sgr(plainCore, ANSI_GREEN);
    assert.ok(styled.length > 500, "fixture invariant: styled form must exceed the 500-char budget");
    assert.ok(plainCore.length < 500, "fixture invariant: plain form must be under the 500-char budget");

    ctx.ui.notify(styled, "info");

    const entries = readNotifications(tmp);
    assert.equal(entries.length, 1);
    assert.equal(entries[0]?.message, plainCore, "persisted message must be the full plain text, no ellipsis");
    assert.ok(!entries[0]?.message.endsWith("…"), "truncation must not have fired on the stripped text");
  });

  test("bounded dedup map (T-24-01): dedup map stays capped and still dedups a fresh key under pressure", (t) => {
    initNotificationStore(tmp);
    const frozenNow = 1_000;
    t.mock.method(Date, "now", () => frozenNow);
    const { ctx } = makeCtx();
    installNotifyInterceptor(ctx);

    const overCeiling = DEDUP_MAX_ENTRIES_FOR_TEST_REFERENCE + 50;
    for (let i = 0; i < overCeiling; i++) {
      notifyDeduped(ctx, `msg-${i}`, "info", { kind: "burst", scope: `s-${i}` });
    }

    assert.ok(_dedupKeyCount() <= DEDUP_MAX_ENTRIES_FOR_TEST_REFERENCE, `dedup map must stay at or below the ceiling, got ${_dedupKeyCount()}`);

    // A freshly-appended key (the most recent one) must still dedup.
    const lastKind = "burst";
    const lastScope = `s-${overCeiling - 1}`;
    const repeat = notifyDeduped(ctx, `msg-${overCeiling - 1}`, "info", { kind: lastKind, scope: lastScope });
    assert.equal(repeat, false, "the most recently appended key must still be suppressed on repeat");
  });
});
