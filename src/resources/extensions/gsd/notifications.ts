// GSD Extension — Desktop Notification Helper
// Cross-platform desktop notifications for auto-mode events.

import childProcess from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, resolve } from "node:path";
import type { NotificationPreferences } from "./types.js";
import { loadEffectiveGSDPreferences } from "./preferences.js";
import { sendRemoteNotification as _sendRemoteNotification } from "../remote-questions/notify.js";
import { DEDUP_WINDOW_MS } from "./notification-store.js";

/** Swappable dispatcher for remote notifications — exported so tests can mock it. */
export const remoteNotificationDispatcher = {
  send: _sendRemoteNotification,
};

export type NotifyLevel = "info" | "success" | "warning" | "error";
export type NotificationKind = "complete" | "error" | "budget" | "milestone" | "attention";
export type NotificationBellKind = "question" | "stop" | "attention";

interface NotificationCommand {
  file: string;
  args: string[];
}

interface BellStream {
  isTTY?: boolean;
  write(chunk: string): unknown;
}

const executablePathCache = new Map<string, string | null>();

/**
 * Channel-namespaced throttle state, keyed `${channel}:${normalizedKind}`.
 * Shares `DEDUP_WINDOW_MS` with the notification store's own dedup map
 * (D-01: one window constant for the whole phase) but keeps its own state —
 * mixing this channel's timestamps into the store's map would couple
 * Phase 23's desktop/bell call sites into the store's mutation path.
 */
const _channelRateLimits = new Map<string, number>();

/** Closed literal kind sets per channel (T-24-06) — see `_allowChannelNotification`. */
const DESKTOP_RATE_LIMIT_KINDS = new Set<string>(["complete", "error", "budget", "milestone", "attention"]);
const BELL_RATE_LIMIT_KINDS = new Set<string>(["question", "stop", "attention"]);

/**
 * Normalize a runtime `kind` string against its channel's closed literal set.
 * Any value outside the set collapses to the single literal `"other"` so an
 * unrecognized runtime kind (JS caller, dep-injected shim) cannot mint an
 * unbounded number of throttle buckets (T-24-06).
 */
function _normalizeChannelKind(channel: "desktop" | "bell", kind: string): string {
  const knownKinds = channel === "desktop" ? DESKTOP_RATE_LIMIT_KINDS : BELL_RATE_LIMIT_KINDS;
  return knownKinds.has(kind) ? kind : "other";
}

/**
 * Channel-namespaced rate-limit gate shared by `sendDesktopNotification` and
 * `playNotificationBell`. Returns `false` (throttled) only when a same-key
 * call was already seen within `DEDUP_WINDOW_MS`; returns `true` (allowed)
 * and re-baselines the key otherwise — including on a backwards clock jump
 * (negative elapsed), so a clock correction can never wedge a channel shut
 * (T-24-08). Channel namespacing keeps the shared literal `"attention"` from
 * cross-suppressing between the desktop and bell channels.
 */
function _allowChannelNotification(channel: "desktop" | "bell", kind: string): boolean {
  const normalizedKind = _normalizeChannelKind(channel, kind);
  const key = `${channel}:${normalizedKind}`;
  const now = Date.now();
  const lastSeen = _channelRateLimits.get(key);
  if (lastSeen !== undefined) {
    const elapsed = now - lastSeen;
    if (elapsed >= 0 && elapsed < DEDUP_WINDOW_MS) return false;
  }
  _channelRateLimits.set(key, now);
  return true;
}

/**
 * Reset module-private channel rate-limit state. Test-only — mirrors the
 * `_resetNotificationStore` convention already established in
 * `notification-store.ts`.
 */
export function _resetNotificationRateLimits(): void {
  _channelRateLimits.clear();
}

/**
 * Send a native desktop notification. Non-blocking, non-fatal.
 * macOS: osascript, Linux: notify-send, Windows: skipped.
 */
export function sendDesktopNotification(
  title: string,
  message: string,
  level: NotifyLevel = "info",
  kind: NotificationKind = "complete",
  projectName?: string,
  deps: { notifications?: NotificationPreferences } = {},
): void {
  // Throttle gate FIRST — upstream of the remote dispatch below (T-24-07):
  // that dispatch is deliberately upstream of the preference gate ("remote
  // notifications fire independently of desktop preferences"), so a
  // downstream throttle would leave the outbound Telegram/Slack/Discord
  // fan-out completely unthrottled.
  if (!_allowChannelNotification("desktop", kind)) return;

  // When a projectName is provided and the title is the default "GSD",
  // replace it with a project-qualified title for multi-project clarity.
  if (projectName && title === "GSD") {
    title = formatNotificationTitle(projectName);
  }
  const loadedPreferences = loadEffectiveGSDPreferences()?.preferences;
  const notifications = deps.notifications ?? loadedPreferences?.notifications;

  // Remote notifications fire independently of desktop preferences.
  // sendRemoteNotification handles "not configured" gracefully (early return).
  void remoteNotificationDispatcher.send(title, message).catch(() => {});

  if (!shouldSendDesktopNotification(kind, notifications)) return;

  // cmux delivery and desktop delivery are independent — if cmux import or
  // delivery fails, we must still attempt the native desktop notification.
  const runCmux = async () => {
    try {
      const { CmuxClient, emitOsc777Notification, resolveCmuxConfig } = await import("../cmux/index.js");
      const cmux = resolveCmuxConfig(loadedPreferences);
      if (cmux.notifications) {
        const delivered = CmuxClient.fromPreferences(loadedPreferences).notify(title, message);
        if (delivered) return true;
        emitOsc777Notification(title, message);
      }
    } catch {
      // cmux unavailable — fall through to desktop notification
    }
    return false;
  };

  void runCmux().then((deliveredByCmux) => {
    if (deliveredByCmux) return;
    try {
      const command = buildDesktopNotificationCommand(process.platform, title, message, level);
      if (!command) return;
      launchDesktopNotification(command);
    } catch {
      // Non-fatal — desktop notifications are best-effort
    }
  }).catch(() => {});
}

export function launchDesktopNotification(command: NotificationCommand): void {
  try {
    const child = childProcess.spawn(command.file, command.args, {
      detached: true,
      stdio: "ignore",
    });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Non-fatal — desktop notifications are best-effort
  }
}

export function shouldSendDesktopNotification(
  kind: NotificationKind,
  preferences: NotificationPreferences | undefined = loadEffectiveGSDPreferences()?.preferences.notifications,
): boolean {
  if (preferences?.enabled === false) return false;

  switch (kind) {
    case "error":
      return preferences?.on_error ?? true;
    case "budget":
      return preferences?.on_budget ?? true;
    case "milestone":
      return preferences?.on_milestone ?? true;
    case "attention":
      return preferences?.on_attention ?? true;
    case "complete":
    default:
      return preferences?.on_complete ?? true;
  }
}

export function shouldPlayNotificationBell(
  kind: NotificationBellKind,
  preferences: NotificationPreferences | undefined = loadEffectiveGSDPreferences()?.preferences.notifications,
): boolean {
  if (preferences?.enabled === false) return false;
  if (preferences?.local_bell !== true) return false;

  switch (kind) {
    case "question":
    case "stop":
    case "attention":
    default:
      return preferences?.on_attention ?? true;
  }
}

/**
 * Play a local terminal bell for attention-critical events. This intentionally
 * does not depend on desktop notification permissions or remote configuration.
 */
export function playNotificationBell(
  kind: NotificationBellKind = "attention",
  preferences: NotificationPreferences | undefined = loadEffectiveGSDPreferences()?.preferences.notifications,
  stream: BellStream | null = resolveBellStream(),
): boolean {
  if (!shouldPlayNotificationBell(kind, preferences)) return false;
  // Throttle AFTER the preference gate: a call the operator's preferences
  // already disabled did not actually ring anything, so it must not
  // consume the window budget.
  if (!_allowChannelNotification("bell", kind)) return false;
  if (!stream) return false;

  try {
    stream.write("\u0007");
    return true;
  } catch {
    return false;
  }
}

/**
 * Format a notification title that includes the project name for context.
 * Returns "GSD — projectName" when a project name is available, otherwise "GSD".
 */
export function formatNotificationTitle(projectName?: string): string {
  const trimmed = projectName?.trim();
  if (trimmed) return `GSD — ${trimmed}`;
  return "GSD";
}

export function buildDesktopNotificationCommand(
  platform: NodeJS.Platform,
  title: string,
  message: string,
  level: NotifyLevel = "info",
): NotificationCommand | null {
  const normalizedTitle = normalizeNotificationText(title);
  const normalizedMessage = normalizeNotificationText(message);

  if (platform === "darwin") {
    // Prefer terminal-notifier: registers as its own Notification Center app,
    // so it gets a proper permission entry in System Settings → Notifications.
    // osascript notifications are silently swallowed when the calling terminal
    // (Ghostty, iTerm2, etc.) lacks notification permissions — exits 0, no error.
    // See: https://github.com/open-gsd/gsd-pi/issues/2632
    const tnPath = findExecutable("terminal-notifier");
    if (tnPath) {
      const sound = level === "error" ? "Basso" : "Glass";
      return { file: tnPath, args: ["-title", normalizedTitle, "-message", normalizedMessage, "-sound", sound] };
    }
    // Fallback: osascript (works if terminal app has notification permissions)
    const sound = level === "error" ? 'sound name "Basso"' : 'sound name "Glass"';
    const script = `display notification "${escapeAppleScript(normalizedMessage)}" with title "${escapeAppleScript(normalizedTitle)}" ${sound}`;
    return { file: "osascript", args: ["-e", script] };
  }

  if (platform === "linux") {
    const urgency = level === "error" ? "critical" : level === "warning" ? "normal" : "low";
    return { file: "notify-send", args: ["-u", urgency, normalizedTitle, normalizedMessage] };
  }

  return null;
}

function normalizeNotificationText(s: string): string {
  return s.replace(/\r?\n/g, " ").trim();
}

function escapeAppleScript(s: string): string {
  return s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

/**
 * Locate an executable on PATH. Returns absolute path or null.
 * Non-fatal — returns null on any error.
 */
function findExecutable(name: string): string | null {
  if (executablePathCache.has(name)) return executablePathCache.get(name) ?? null;

  let resolved: string | null = null;
  const path = process.env.PATH;
  if (path) {
    for (const dir of path.split(delimiter)) {
      const candidate = resolve(dir || ".", name);
      try {
        accessSync(candidate, constants.X_OK);
        resolved = candidate;
        break;
      } catch {
        // keep searching PATH
      }
    }
  }

  executablePathCache.set(name, resolved);
  return resolved;
}

function resolveBellStream(): BellStream | null {
  if (process.stderr?.isTTY) return process.stderr;
  if (process.stdout?.isTTY) return process.stdout;
  return null;
}
