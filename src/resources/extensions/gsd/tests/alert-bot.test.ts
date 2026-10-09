/**
 * alert-bot.test.ts — best-effort producer for the sibling GSD-alert-bot.
 *
 * y-pi-gsd talks to GSD-alert-bot ONLY through its `gsd-alert-emit` CLI contract
 * (Product-independence rule): resolve on PATH, spawn detached, never throw, and
 * stay silent under tests or when disabled.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { emitAlertBotEvent, resolveAlertEmitBin } from "../alert-bot.js";
import {
  sendDesktopNotification,
  remoteNotificationDispatcher,
  _resetNotificationRateLimits,
  alertBotDispatcher,
} from "../notifications.js";

function pathWithFakeBin(): { dir: string; bin: string } {
  const dir = mkdtempSync(join(tmpdir(), "alert-bot-bin-"));
  const bin = join(dir, "gsd-alert-emit");
  writeFileSync(bin, "#!/bin/sh\n", { mode: 0o755 });
  return { dir, bin };
}

test("resolveAlertEmitBin finds gsd-alert-emit on PATH outside tests", () => {
  const { dir, bin } = pathWithFakeBin();
  assert.equal(resolveAlertEmitBin({ PATH: dir }), bin);
});

test("resolveAlertEmitBin is null under node --test, GSD_ALERT_DISABLE=1, or when absent", () => {
  const { dir } = pathWithFakeBin();
  assert.equal(resolveAlertEmitBin({ PATH: dir, NODE_TEST_CONTEXT: "child-v8" }), null);
  assert.equal(resolveAlertEmitBin({ PATH: dir, GSD_ALERT_DISABLE: "1" }), null);
  assert.equal(resolveAlertEmitBin({ PATH: mkdtempSync(join(tmpdir(), "empty-")) }), null);
});

test("emitAlertBotEvent spawns the CLI detached with mapped severity", () => {
  const spawns: Array<{ bin: string; argv: string[]; opts: unknown }> = [];
  let unrefs = 0;
  emitAlertBotEvent(
    { event: "blocked", project: "SecondBrain", title: "Context 91% — paused" },
    {
      resolveBin: () => "/bin/gsd-alert-emit",
      spawnFn: (bin, argv, opts) => {
        spawns.push({ bin, argv, opts });
        return { unref: () => { unrefs++; }, on: () => {} };
      },
    },
  );
  assert.equal(spawns.length, 1);
  assert.deepEqual(spawns[0].opts, { detached: true, stdio: "ignore" });
  assert.deepEqual(spawns[0].argv, [
    "--source", "y-pi-gsd", "--project", "SecondBrain", "--event", "blocked",
    "--severity", "loud", "--title", "Context 91% — paused",
  ]);
  assert.equal(unrefs, 1);
});

test("milestone_complete is quiet, needs_input is loud", () => {
  const argvs: string[][] = [];
  const deps = {
    resolveBin: () => "/bin/gsd-alert-emit",
    spawnFn: (_b: string, argv: string[]) => { argvs.push(argv); return { unref() {}, on() {} }; },
  };
  emitAlertBotEvent({ event: "milestone_complete", project: "p", title: "t" }, deps);
  emitAlertBotEvent({ event: "needs_input", project: "p", title: "t" }, deps);
  assert.equal(argvs[0][argvs[0].indexOf("--severity") + 1], "quiet");
  assert.equal(argvs[1][argvs[1].indexOf("--severity") + 1], "loud");
});

test("emitAlertBotEvent never throws and no-ops when unresolved", () => {
  let spawned = false;
  assert.doesNotThrow(() => emitAlertBotEvent(
    { event: "blocked", project: "p", title: "t" },
    { resolveBin: () => null, spawnFn: () => { spawned = true; return { unref() {}, on() {} }; } },
  ));
  assert.equal(spawned, false);
  assert.doesNotThrow(() => emitAlertBotEvent(
    { event: "blocked", project: "p", title: "t" },
    { resolveBin: () => "/bin/x", spawnFn: () => { throw new Error("boom"); } },
  ));
});

test("sendDesktopNotification forwards an explicit alert tag with the project", (t) => {
  _resetNotificationRateLimits();
  t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const emit = t.mock.method(alertBotDispatcher, "emit", () => {});
  sendDesktopNotification("GSD", "Milestone M007 complete!", "success", "milestone", "SecondBrain",
    { notifications: { enabled: false }, alert: "milestone_complete" });
  assert.equal(emit.mock.callCount(), 1);
  assert.deepEqual(emit.mock.calls[0].arguments[0], {
    event: "milestone_complete", project: "SecondBrain", title: "Milestone M007 complete!",
  });
});

test("sendDesktopNotification without an alert tag emits nothing", (t) => {
  _resetNotificationRateLimits();
  t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const emit = t.mock.method(alertBotDispatcher, "emit", () => {});
  sendDesktopNotification("GSD", "Budget 80%: $4 / $5", "warning", "budget", "p",
    { notifications: { enabled: false } });
  assert.equal(emit.mock.callCount(), 0);
});

test("alert_bot: false in notification preferences suppresses the emit", (t) => {
  _resetNotificationRateLimits();
  t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const emit = t.mock.method(alertBotDispatcher, "emit", () => {});
  sendDesktopNotification("GSD", "paused", "warning", "attention", "p",
    { notifications: { enabled: false, alert_bot: false }, alert: "blocked" });
  assert.equal(emit.mock.callCount(), 0);
});

// ─── needs_input at the ask_user_questions bell ─────────────────────────────

import { emitNeedsInputAlert } from "../../ask-user-questions.js";

const QUESTIONS = [{ id: "q1", header: "Deploy", question: "Ship v8 to prod now?" }];

function needsInputDeps(over: { auto?: boolean; enabled?: boolean } = {}) {
  const emitted: unknown[] = [];
  return {
    emitted,
    deps: {
      isAutoActive: async () => over.auto ?? false,
      alertBotEnabled: async () => over.enabled ?? true,
      emit: (f: unknown) => { emitted.push(f); },
      project: "SecondBrain",
    },
  };
}

test("needs_input fires while auto-mode is active, titled by the first question", async () => {
  const { emitted, deps } = needsInputDeps({ auto: true });
  await emitNeedsInputAlert(QUESTIONS, true, deps);
  assert.deepEqual(emitted, [{ event: "needs_input", project: "SecondBrain", title: "Ship v8 to prod now?" }]);
});

test("needs_input fires headless (no UI) even when auto-mode is not active", async () => {
  const { emitted, deps } = needsInputDeps({ auto: false });
  await emitNeedsInputAlert(QUESTIONS, false, deps);
  assert.equal(emitted.length, 1);
});

test("needs_input stays silent in an interactive chat (UI, no auto-mode)", async () => {
  const { emitted, deps } = needsInputDeps({ auto: false });
  await emitNeedsInputAlert(QUESTIONS, true, deps);
  assert.equal(emitted.length, 0);
});

test("needs_input respects notifications.alert_bot: false and never throws", async () => {
  const { emitted, deps } = needsInputDeps({ auto: true, enabled: false });
  await emitNeedsInputAlert(QUESTIONS, true, deps);
  assert.equal(emitted.length, 0);
  await assert.doesNotReject(emitNeedsInputAlert(QUESTIONS, true, {
    ...deps, alertBotEnabled: async () => true, isAutoActive: async () => { throw new Error("boom"); },
  }));
});
