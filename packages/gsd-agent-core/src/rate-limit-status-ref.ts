/**
 * The provenance-carrying ref every rate-limit producer writes (D-02, 43-CONTEXT.md).
 *
 * `RateLimitStatus` (rate-limit-headers.ts) stays the footer-facing value shape (SC2): provenance
 * never leaks into it. It lives beside it on the ref, per window, because the SDK and header
 * producers merge one window at a time -- a single ref-level stamp would mislabel the sibling
 * window, and precedence between producers can only be decided per window.
 */

import type { RateLimitStatus, RateLimitWindow } from "./rate-limit-headers.js";

/** The two windows the footer renders. */
export type RateLimitWindowKey = "session" | "weekly";

export const RATE_LIMIT_WINDOW_KEYS: readonly RateLimitWindowKey[] = ["session", "weekly"];

/** Which producer wrote a window. */
export type RateLimitSource = "sdk" | "headers" | "dashboard";

/** Provenance of one window: who wrote it and when the underlying observation was made. */
export interface RateLimitWindowMeta {
	source: RateLimitSource;
	observedAtMs: number;
}

/**
 * Mutable ref shared by every rate-limit producer and `AgentSession.getRateLimitStatus()`.
 * `provider` records which model's provider produced `current` (CR-03).
 */
export interface RateLimitStatusRef {
	current?: RateLimitStatus;
	provider?: string;
	meta?: { session?: RateLimitWindowMeta; weekly?: RateLimitWindowMeta };
}

/**
 * A producer that fills the ref without a provider round trip (the claude-code dashboard poller).
 * `start` and `stop` are idempotent. `refresh` never rejects, resolves immediately when stopped,
 * and returns the in-flight tick's promise when one is running.
 */
export interface RateLimitFallbackProducer {
	start(onChange: () => void): void;
	stop(): void;
	refresh(): Promise<void>;
}

/** One validated dashboard observation, already mapped onto the footer-facing window shape. */
export interface DashboardReading {
	session: RateLimitWindow | null;
	weekly: RateLimitWindow | null;
	observedAtMs: number;
}

/** The only provider the dashboard producer writes for. */
export const DASHBOARD_PROVIDER = "claude-code";

function windowsEqual(a: RateLimitWindow | null | undefined, b: RateLimitWindow | null | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.usedPercent === b.usedPercent && a.resetsAtEpochSec === b.resetsAtEpochSec;
}

function isDashboardProvider(ref: RateLimitStatusRef): boolean {
	return ref.provider === undefined || ref.provider === DASHBOARD_PROVIDER;
}

/**
 * Whether the dashboard may write `key` right now. Evaluated per window, after the fetch resolves
 * (never at request time), so a slow poll cannot overwrite a reading that landed while it was in
 * flight.
 *
 * Conservative rule of the tracer: writable only when the window is empty (a window held under a
 * different provider counts as empty) or already dashboard-sourced. The producers do not stamp
 * provenance yet, so any other filled window is treated as a fresh SDK reading.
 */
export function canDashboardWriteWindow(
	ref: RateLimitStatusRef,
	key: RateLimitWindowKey,
	_dashboardObservedAtMs: number,
	_nowMs: number,
): boolean {
	if (!isDashboardProvider(ref)) return true;
	const existing = ref.current?.[key];
	if (!existing) return true;
	return ref.meta?.[key]?.source === "dashboard";
}

/**
 * Applies a dashboard reading to the ref window by window. Returns true only when a window's
 * null-ness, usedPercent or resetsAtEpochSec changed, so a metadata-only refresh does not notify.
 */
export function applyDashboardReading(ref: RateLimitStatusRef, reading: DashboardReading, nowMs: number): boolean {
	const sameProvider = isDashboardProvider(ref);
	const baseCurrent = sameProvider ? ref.current : undefined;
	const baseMeta = sameProvider ? ref.meta : undefined;

	const next: Record<RateLimitWindowKey, RateLimitWindow | null> = {
		session: baseCurrent?.session ?? null,
		weekly: baseCurrent?.weekly ?? null,
	};
	const nextMeta: { session?: RateLimitWindowMeta; weekly?: RateLimitWindowMeta } = { ...baseMeta };
	let wrote = false;

	for (const key of RATE_LIMIT_WINDOW_KEYS) {
		if (!canDashboardWriteWindow(ref, key, reading.observedAtMs, nowMs)) continue;
		const incoming = reading[key];
		if (incoming) {
			next[key] = incoming;
			nextMeta[key] = { source: "dashboard", observedAtMs: reading.observedAtMs };
			wrote = true;
		} else if (baseMeta?.[key]?.source === "dashboard") {
			next[key] = null;
			delete nextMeta[key];
			wrote = true;
		}
	}

	if (!wrote) return false;

	const changed = RATE_LIMIT_WINDOW_KEYS.some((key) => !windowsEqual(baseCurrent?.[key], next[key]));
	ref.current = { session: next.session, weekly: next.weekly };
	ref.meta = nextMeta;
	ref.provider = DASHBOARD_PROVIDER;
	return changed;
}
