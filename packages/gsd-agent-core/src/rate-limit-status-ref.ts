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

/**
 * How long an SDK or header reading stays authoritative over the dashboard. Equals the dashboard's
 * own upstream poll interval, so an SDK reading older than one dashboard cycle is no fresher than
 * what the dashboard can supply (43-RESEARCH A1; tunable, SDK event cadence is undocumented).
 */
export const SDK_FRESH_MS = 300_000;

/** A dashboard-sourced window is dropped once its observation is older than the dashboard's own trust limit. */
export const DASHBOARD_MAX_AGE_MS = 600_000;

function windowsEqual(a: RateLimitWindow | null | undefined, b: RateLimitWindow | null | undefined): boolean {
	if (!a && !b) return true;
	if (!a || !b) return false;
	return a.usedPercent === b.usedPercent && a.resetsAtEpochSec === b.resetsAtEpochSec;
}

function isDashboardProvider(ref: RateLimitStatusRef): boolean {
	return ref.provider === undefined || ref.provider === DASHBOARD_PROVIDER;
}

/**
 * Records one SDK or header write (D-02). Keeps WR-01 -- an absent or null window keeps the previous
 * same-provider value and its meta -- and CR-03 -- a different provider's previous windows and meta
 * are dropped -- and stamps `meta[window]` for exactly the windows it wrote. Producers never consult
 * meta before writing: the SDK and headers always win (SC3).
 */
export function writePrimaryRateLimitWindows(
	ref: RateLimitStatusRef,
	provider: string,
	windows: { session?: RateLimitWindow | null; weekly?: RateLimitWindow | null },
	source: "sdk" | "headers",
	nowMs: number,
): void {
	const sameProvider = ref.provider === provider;
	const previous = sameProvider ? ref.current : undefined;
	const previousMeta = sameProvider ? ref.meta : undefined;

	const next: Record<RateLimitWindowKey, RateLimitWindow | null> = { session: null, weekly: null };
	const nextMeta: { session?: RateLimitWindowMeta; weekly?: RateLimitWindowMeta } = {};
	for (const key of RATE_LIMIT_WINDOW_KEYS) {
		const incoming = windows[key];
		if (incoming) {
			next[key] = incoming;
			nextMeta[key] = { source, observedAtMs: nowMs };
			continue;
		}
		const kept = previous?.[key] ?? null;
		next[key] = kept;
		const keptMeta = previousMeta?.[key];
		if (kept && keptMeta) nextMeta[key] = keptMeta;
	}
	ref.current = { session: next.session, weekly: next.weekly };
	ref.meta = nextMeta;
	ref.provider = provider;
}

/**
 * Whether the dashboard may write `key` right now. Evaluated per window, after the fetch resolves
 * (never at request time), so a slow poll cannot overwrite a reading that landed while it was in
 * flight. Rules in order: empty (or held under another provider) -> writable; undated -> writable;
 * already dashboard-sourced -> writable; SDK/headers reset time has passed -> writable; SDK/headers
 * reading at most SDK_FRESH_MS old -> blocked; otherwise writable only when the dashboard
 * observation is newer than that reading.
 */
export function canDashboardWriteWindow(
	ref: RateLimitStatusRef,
	key: RateLimitWindowKey,
	dashboardObservedAtMs: number,
	nowMs: number,
): boolean {
	if (!isDashboardProvider(ref)) return true;
	const existing = ref.current?.[key];
	if (!existing) return true;
	const meta = ref.meta?.[key];
	if (!meta) return true;
	if (meta.source === "dashboard") return true;
	if (existing.resetsAtEpochSec != null && existing.resetsAtEpochSec * 1000 <= nowMs) return true;
	if (nowMs - meta.observedAtMs <= SDK_FRESH_MS) return false;
	return dashboardObservedAtMs > meta.observedAtMs;
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

function dropDashboardWindows(ref: RateLimitStatusRef, shouldDrop: (meta: RateLimitWindowMeta) => boolean): boolean {
	if (!isDashboardProvider(ref) || !ref.current || !ref.meta) return false;
	const current = { ...ref.current };
	const meta = { ...ref.meta };
	let changed = false;
	for (const key of RATE_LIMIT_WINDOW_KEYS) {
		const entry = meta[key];
		if (entry?.source !== "dashboard" || !shouldDrop(entry)) continue;
		if (current[key]) changed = true;
		current[key] = null;
		delete meta[key];
	}
	if (!changed && Object.keys(meta).length === Object.keys(ref.meta).length) return false;
	ref.current = current;
	ref.meta = meta;
	return changed;
}

/** Nulls every dashboard-sourced window (SDK and header windows are untouched). True when a visible window changed. */
export function clearDashboardWindows(ref: RateLimitStatusRef): boolean {
	return dropDashboardWindows(ref, () => true);
}

/** Nulls dashboard-sourced windows observed more than `maxAgeMs` ago. True when a visible window changed. */
export function expireDashboardWindows(ref: RateLimitStatusRef, nowMs: number, maxAgeMs = DASHBOARD_MAX_AGE_MS): boolean {
	return dropDashboardWindows(ref, (meta) => nowMs - meta.observedAtMs > maxAgeMs);
}
