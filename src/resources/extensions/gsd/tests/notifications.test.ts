import test from "node:test";
import assert from "node:assert/strict";
import childProcess from "node:child_process";
import type { ChildProcess } from "node:child_process";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { playQuestionBell } from "../../ask-user-questions.js";
import { stopAuto } from "../auto.js";
import { autoSession } from "../auto-runtime-state.js";
import {
  buildDesktopNotificationCommand,
  shouldSendDesktopNotification,
  formatNotificationTitle,
  launchDesktopNotification,
  playNotificationBell,
  shouldPlayNotificationBell,
  sendDesktopNotification,
  remoteNotificationDispatcher,
  _resetNotificationRateLimits,
} from "../notifications.js";
import type { NotificationPreferences } from "../types.js";

test("shouldSendDesktopNotification honors granular preferences", () => {
  const prefs: NotificationPreferences = {
    enabled: true,
    on_complete: false,
    on_error: true,
    on_budget: false,
    on_milestone: true,
    on_attention: false,
  };

  assert.equal(shouldSendDesktopNotification("complete", prefs), false);
  assert.equal(shouldSendDesktopNotification("error", prefs), true);
  assert.equal(shouldSendDesktopNotification("budget", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), true);
  assert.equal(shouldSendDesktopNotification("attention", prefs), false);
});

test("shouldSendDesktopNotification disables all categories when notifications are disabled", () => {
  const prefs: NotificationPreferences = { enabled: false, on_error: true, on_milestone: true };

  assert.equal(shouldSendDesktopNotification("error", prefs), false);
  assert.equal(shouldSendDesktopNotification("milestone", prefs), false);
});

test("shouldPlayNotificationBell requires explicit local_bell opt-in", () => {
  assert.equal(shouldPlayNotificationBell("question", { enabled: true }), false);
  assert.equal(shouldPlayNotificationBell("question", { enabled: true, local_bell: true }), true);
  assert.equal(shouldPlayNotificationBell("stop", { enabled: true, local_bell: true, on_attention: false }), false);
  assert.equal(shouldPlayNotificationBell("stop", { enabled: false, local_bell: true, on_attention: true }), false);
});

test("playNotificationBell writes a terminal bell when enabled", () => {
  _resetNotificationRateLimits();
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  assert.equal(playNotificationBell("question", { enabled: true, local_bell: true }, stream), true);
  assert.equal(output, "\u0007");
});

test("playNotificationBell is silent when disabled", () => {
  _resetNotificationRateLimits();
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  assert.equal(playNotificationBell("question", { enabled: true, local_bell: false }, stream), false);
  assert.equal(output, "");
});

test("playQuestionBell writes a terminal bell when local bell is enabled", async () => {
  _resetNotificationRateLimits();
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  await playQuestionBell({ enabled: true, local_bell: true }, stream);

  assert.equal(output, "\u0007");
});

test("playQuestionBell is silent when local bell is disabled", async () => {
  _resetNotificationRateLimits();
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };

  await playQuestionBell({ enabled: true, local_bell: false }, stream);

  assert.equal(output, "");
});

test("playNotificationBell throttles a same-kind repeat inside the window (NOISE-02)", () => {
  _resetNotificationRateLimits();
  let output = "";
  const stream = { write: (chunk: string) => { output += chunk; } };
  const prefs = { enabled: true, local_bell: true };

  assert.equal(playNotificationBell("stop", prefs, stream), true, "first call rings and returns true");
  output = "";
  assert.equal(playNotificationBell("stop", prefs, stream), false, "second same-kind call is throttled");
  assert.equal(output, "", "a throttled bell call writes nothing to the stream");
});

test("stopAuto plays local bell for auto-mode stop notifications", async () => {
  _resetNotificationRateLimits();
  const base = mkdtempSync(join(tmpdir(), "gsd-stop-bell-"));
  const previousCwd = process.cwd();
  const previousStderrWrite = process.stderr.write;
  const previousStderrIsTTY = process.stderr.isTTY;
  let bellOutput = "";

  autoSession.reset();
  autoSession.active = true;
  autoSession.basePath = base;

  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "PREFERENCES.md"),
    "---\nnotifications:\n  enabled: true\n  local_bell: true\n---\n",
    "utf-8",
  );

  process.stderr.isTTY = true;
  process.stderr.write = ((chunk: string | Uint8Array) => {
    if (typeof chunk === "string") {
      bellOutput += chunk;
    }
    return true;
  }) as typeof process.stderr.write;

  try {
    await stopAuto(
      { hasUI: false, ui: { notify: () => {}, setStatus: () => {}, setWidget: () => {}, setHeader: () => {} } } as any,
      undefined,
      "test stop",
    );

    assert.ok(
      bellOutput.includes("\u0007"),
      "stopAuto must write a terminal bell to stderr when the local bell preference is enabled",
    );
  } finally {
    process.stderr.write = previousStderrWrite;
    process.stderr.isTTY = previousStderrIsTTY;
    autoSession.reset();
    process.chdir(previousCwd);
    rmSync(base, { recursive: true, force: true });
  }
});

test("launchDesktopNotification starts notifier as detached fire-and-forget process", (t) => {
  const child = {
    on(_event: string, _listener: (error: Error) => void) {
      return child;
    },
    unref() {
      return child;
    },
  };
  const onMock = t.mock.method(child, "on");
  const unrefMock = t.mock.method(child, "unref");
  const spawnMock = t.mock.method(
    childProcess,
    "spawn",
    () => child as unknown as ChildProcess,
  );

  launchDesktopNotification({ file: "notify-send", args: ["Title", "Message"] });

  assert.equal(spawnMock.mock.callCount(), 1);
  assert.deepEqual(spawnMock.mock.calls[0].arguments, [
    "notify-send",
    ["Title", "Message"],
    { detached: true, stdio: "ignore" },
  ]);
  assert.equal(onMock.mock.callCount(), 1);
  assert.equal(onMock.mock.calls[0].arguments[0], "error");
  assert.equal(unrefMock.mock.callCount(), 1);
});

test("buildDesktopNotificationCommand falls back to osascript on macOS when terminal-notifier is absent", () => {
  // When terminal-notifier is not on PATH, falls back to osascript.
  // This test runs in CI where terminal-notifier is typically not installed.
  // If terminal-notifier IS installed, we verify it returns that instead.
  const command = buildDesktopNotificationCommand(
    "darwin",
    `Bob's "Milestone"`,
    `Budget!\nPath: C:\\temp`,
    "error",
  );

  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    // terminal-notifier path — verify args structure
    assert.ok(command.args.includes("-title"));
    assert.ok(command.args.includes("-message"));
    assert.ok(command.args.includes("-sound"));
    assert.ok(command.args.includes("Basso")); // error level
  } else {
    // osascript fallback path
    assert.equal(command.file, "osascript");
    assert.deepEqual(command.args.slice(0, 1), ["-e"]);
    assert.match(command.args[1], /Bob's \\"Milestone\\"/);
    assert.match(command.args[1], /Budget! Path: C:\\\\temp/);
    assert.doesNotMatch(command.args[1], /\n/);
  }
});

test("buildDesktopNotificationCommand uses Glass sound for non-error on macOS", () => {
  const command = buildDesktopNotificationCommand("darwin", "Title", "Message", "info");
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    assert.ok(command.args.includes("Glass"));
  } else {
    assert.match(command.args[1], /sound name "Glass"/);
  }
});

test("buildDesktopNotificationCommand preserves literal shell characters on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    `Bob's $PATH !`,
    "line 1\nline 2",
    "warning",
  );

  assert.ok(command);
  assert.deepEqual(command, {
    file: "notify-send",
    args: ["-u", "normal", `Bob's $PATH !`, "line 1 line 2"],
  });
});

test("buildDesktopNotificationCommand skips unsupported platforms", () => {
  assert.equal(buildDesktopNotificationCommand("win32", "Title", "Message"), null);
});

// ─── formatNotificationTitle — project context in notifications (#2708) ──────

test("formatNotificationTitle returns 'GSD' when no project name is given", () => {
  assert.equal(formatNotificationTitle(), "GSD");
  assert.equal(formatNotificationTitle(undefined), "GSD");
  assert.equal(formatNotificationTitle(""), "GSD");
});

test("formatNotificationTitle includes project name when provided", () => {
  assert.equal(formatNotificationTitle("my-app"), "GSD — my-app");
});

test("formatNotificationTitle trims whitespace from project name", () => {
  assert.equal(formatNotificationTitle("  spaced  "), "GSD — spaced");
});

test("buildDesktopNotificationCommand includes project name in title on linux", () => {
  const command = buildDesktopNotificationCommand(
    "linux",
    formatNotificationTitle("my-project"),
    "All milestones complete!",
    "success",
  );
  assert.ok(command);
  assert.equal(command.args[2], "GSD — my-project");
  assert.equal(command.args[3], "All milestones complete!");
});

test("buildDesktopNotificationCommand includes project name in title on macOS", () => {
  const command = buildDesktopNotificationCommand(
    "darwin",
    formatNotificationTitle("my-project"),
    "Budget 90%",
    "warning",
  );
  assert.ok(command);
  if (command.file.includes("terminal-notifier")) {
    const titleIdx = command.args.indexOf("-title");
    assert.equal(command.args[titleIdx + 1], "GSD — my-project");
  } else {
    assert.match(command.args[1], /GSD — my-project/);
  }
});

// ─── Channel throttle edge matrix (NOISE-02) ──────────────────────────────

test("sendDesktopNotification: boundary — exactly 30000ms elapsed is delivered (NOISE-02/boundary)", async (t) => {
  _resetNotificationRateLimits();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Error 1", "Message 1", "info", "error");
  now += 30000;
  sendDesktopNotification("Error 2", "Message 2", "info", "error");

  assert.equal(sendMock.mock.callCount(), 2, "a repeat at exactly the 30000ms window boundary must be delivered");
});

test("sendDesktopNotification: boundary — 29999ms elapsed is throttled (NOISE-02/boundary)", async (t) => {
  _resetNotificationRateLimits();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Error 1", "Message 1", "info", "error");
  now += 29999;
  sendDesktopNotification("Error 2", "Message 2", "info", "error");

  assert.equal(sendMock.mock.callCount(), 1, "a repeat at 29999ms elapsed must still be throttled");
});

test("playNotificationBell: boundary — exactly 30000ms elapsed is delivered (NOISE-02/boundary)", (t) => {
  _resetNotificationRateLimits();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const stream = { write: (_chunk: string) => {} };
  const prefs = { enabled: true, local_bell: true };

  assert.equal(playNotificationBell("stop", prefs, stream), true);
  now += 30000;
  assert.equal(playNotificationBell("stop", prefs, stream), true, "a bell repeat at exactly 30000ms elapsed must ring");
});

test("playNotificationBell: boundary — 29999ms elapsed is throttled (NOISE-02/boundary)", (t) => {
  _resetNotificationRateLimits();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const stream = { write: (_chunk: string) => {} };
  const prefs = { enabled: true, local_bell: true };

  assert.equal(playNotificationBell("stop", prefs, stream), true);
  now += 29999;
  assert.equal(playNotificationBell("stop", prefs, stream), false, "a bell repeat at 29999ms elapsed must still be throttled");
});

test("cross-channel adjacency: desktop attention then bell attention — neither suppresses the other (NOISE-02/adjacency)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const stream = { write: (_chunk: string) => {} };
  const prefs = { enabled: true, local_bell: true };

  sendDesktopNotification("Attn", "Attn message", "info", "attention");
  assert.equal(
    playNotificationBell("attention", prefs, stream),
    true,
    "the bell channel's attention kind must still ring after the desktop channel's attention kind fired",
  );
  assert.equal(sendMock.mock.callCount(), 1);
});

test("cross-channel adjacency (reverse order): bell attention then desktop attention — neither suppresses the other (NOISE-02/adjacency)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const stream = { write: (_chunk: string) => {} };
  const prefs = { enabled: true, local_bell: true };

  assert.equal(playNotificationBell("attention", prefs, stream), true);
  sendDesktopNotification("Attn", "Attn message", "info", "attention");
  assert.equal(
    sendMock.mock.callCount(),
    1,
    "the desktop channel's attention kind must still dispatch after the bell channel's attention kind rang",
  );
});

test("within-channel adjacency: desktop budget then desktop error are independent kinds (NOISE-02/adjacency)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Budget", "Budget message", "warning", "budget");
  sendDesktopNotification("Error", "Error message", "error", "error");

  assert.equal(sendMock.mock.callCount(), 2, "two different kinds within one channel must never suppress each other");
});

test("empty title/message still throttles its repeat on kind alone (NOISE-02/empty)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("", "", "info", "complete");
  sendDesktopNotification("", "", "info", "complete");

  assert.equal(sendMock.mock.callCount(), 1, "an empty title/message pair must still throttle its repeat on kind alone");
});

test("omitting the kind argument throttles against an explicit 'complete' call, not a separate bucket (NOISE-02/empty)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Explicit", "Explicit message", "info", "complete");
  sendDesktopNotification("Omitted", "Omitted message");

  assert.equal(
    sendMock.mock.callCount(),
    1,
    "an omitted kind must use the 'complete' parameter default, not mint a distinct bucket",
  );
});

test("unrecognized runtime kinds collapse into a single 'other' bucket per channel (T-24-06)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("Unknown 1", "Message 1", "info", "totally-unrecognized-kind-a" as never);
  sendDesktopNotification("Unknown 2", "Message 2", "info", "totally-unrecognized-kind-b" as never);

  assert.equal(
    sendMock.mock.callCount(),
    1,
    "two DIFFERENT unrecognized kind strings must collapse into the same 'other' bucket, not mint two",
  );
});

test("first-caller-wins within a window: the earliest same-kind call is delivered (NOISE-02/ordering)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("First Title", "First Message", "info", "milestone");
  sendDesktopNotification("Second Title", "Second Message", "error", "milestone");
  sendDesktopNotification("Third Title", "Third Message", "warning", "milestone");

  assert.equal(sendMock.mock.callCount(), 1);
  assert.deepEqual(
    sendMock.mock.calls[0].arguments,
    ["First Title", "First Message"],
    "the single dispatched call must be the FIRST call's title and message, regardless of later calls' level/title/message",
  );
});

test("a backwards clock jump re-baselines instead of suppressing (NOISE-02/precision, T-24-08)", async (t) => {
  _resetNotificationRateLimits();
  let now = 1_000_000;
  t.mock.method(Date, "now", () => now);
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});

  sendDesktopNotification("First", "First Message", "info", "milestone");
  now -= 5000;
  sendDesktopNotification("Second", "Second Message", "info", "milestone");

  assert.equal(sendMock.mock.callCount(), 2, "a backwards clock jump must dispatch, never suppress permanently");
});

test("preference independence: remote dispatch fires and throttles even when desktop notifications are disabled (NOISE-02)", async (t) => {
  _resetNotificationRateLimits();
  const sendMock = t.mock.method(remoteNotificationDispatcher, "send", async () => {});
  const deps = { notifications: { enabled: false } };

  sendDesktopNotification("Disabled 1", "Disabled Message 1", "info", "error", undefined, deps);
  sendDesktopNotification("Disabled 2", "Disabled Message 2", "info", "error", undefined, deps);

  assert.equal(
    sendMock.mock.callCount(),
    1,
    "remote dispatch fires on the fresh kind despite desktop being disabled, then throttles the repeat",
  );
});
