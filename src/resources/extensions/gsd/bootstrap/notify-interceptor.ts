// GSD Extension — Notify Interceptor
// Wraps ctx.ui.notify() in-place to persist every notification through the
// notification store. Uses a WeakSet to prevent double-wrapping and handle
// UI context replacement on /reload gracefully.
//
// Also suppresses the visible toast (not just the store write) when a call
// is deduped, and strips ANSI escape sequences before persisting so styled
// panels don't leak raw control bytes into .gsd/notifications.jsonl — while
// the terminal still receives the original styled string.

import type { ExtensionContext } from "@gsd/pi-coding-agent";
import stripAnsi from "strip-ansi";

import {
  appendNotification,
  suppressPersistence,
  unsuppressPersistence,
  isPersistenceSuppressed,
  type NotifySeverity,
  type NotificationMeta,
} from "../notification-store.js";

// Track which ui context objects have been wrapped to prevent double-install.
// WeakSet allows GC to collect replaced uiContext instances after /reload.
const _wrappedContexts = new WeakSet<object>();

/**
 * Install the notify interceptor on a context's UI object.
 * Mutates ctx.ui.notify in place — the original is called after persistence.
 * Safe to call multiple times; no-ops if already installed on the same ui object.
 */
export function installNotifyInterceptor(ctx: ExtensionContext): void {
  if (_wrappedContexts.has(ctx.ui)) return;

  const originalNotify = ctx.ui.notify.bind(ctx.ui);

  (ctx.ui as any).notify = (message: string, type?: "info" | "warning" | "error" | "success"): void => {
    // Fail-open (T-24-03): a persistence fault must never suppress a real
    // toast — it degrades storage only. Default true before the try so any
    // thrown error (including one from stripAnsi) still forwards.
    let persisted = true;
    try {
      const plain = stripAnsi(message);
      persisted = appendNotification(plain, (type ?? "info") as NotifySeverity, "notify");
    } catch {
      // Non-fatal — never let persistence break the UI; keep persisted = true.
    }
    // A falsy `persisted` means "not written" for one of three reasons: a
    // genuine dedup collapse (suppress the toast — the whole point of
    // NOISE-01), or a deliberate administrative suppressPersistence() call
    // (e.g. notifyDeduped's internal double-write guard below — that call
    // already established this is NOT a duplicate and its only reason for
    // suppressing persistence here is to avoid a second, meta-less store
    // write; the toast must still show). isPersistenceSuppressed() lets us
    // tell those two apart without widening appendNotification's contract.
    if (persisted || isPersistenceSuppressed()) originalNotify(message, type);
  };

  _wrappedContexts.add(ctx.ui);
}

/**
 * Opt-in `kind:scope` wrapper for hot call sites (per D-01). Composes the
 * existing store primitives only — no new dedup mechanism.
 *
 * Persists first; a falsy (deduped, suppressed, or uninitialized) result
 * short-circuits before touching the UI at all. Otherwise it forwards the
 * toast through the (already-wrapped) ctx.ui.notify, wrapped in
 * suppressPersistence()/unsuppressPersistence() so that call does not
 * double-persist the same logical event (ctx.ui.notify is itself the
 * interceptor-wrapped function — an unwrapped call here would run a second,
 * meta-less appendNotification for this same event).
 */
export function notifyDeduped(
  ctx: ExtensionContext,
  message: string,
  severity: NotifySeverity,
  meta: NotificationMeta,
): boolean {
  const persisted = appendNotification(message, severity, "notify", meta);
  // A falsy `persisted` alone is ambiguous — mirror the plain interceptor's
  // isPersistenceSuppressed() distinction above: a genuine dedup collapse
  // (not suppressed) short-circuits here, but a nested call inside an
  // administrative suppressPersistence() block is NOT a duplicate and must
  // still forward the toast.
  if (!persisted && !isPersistenceSuppressed()) return false;
  suppressPersistence();
  try {
    ctx.ui.notify(message, severity);
  } finally {
    unsuppressPersistence();
  }
  return persisted;
}
