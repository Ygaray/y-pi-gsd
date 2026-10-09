import assert from "node:assert/strict";
import { after, before, describe, test } from "node:test";
import type { RateLimitWindow } from "./rate-limit-headers.ts";
import {
	applyDashboardReading,
	canDashboardWriteWindow,
	clearDashboardWindows,
	expireDashboardWindows,
	SDK_FRESH_MS,
	writePrimaryRateLimitWindows,
	type RateLimitStatusRef,
} from "./rate-limit-status-ref.ts";

const REAL_FETCH = globalThis.fetch;

before(() => {
	globalThis.fetch = (() => {
		throw new Error("live dashboard fetch attempted in a test");
	}) as unknown as typeof fetch;
});

after(() => {
	globalThis.fetch = REAL_FETCH;
});

const w = (usedPercent: number, resetsAtEpochSec: number | null = null): RateLimitWindow => ({ usedPercent, resetsAtEpochSec });

describe("rate-limit status ref (D-02)", () => {
	test("writePrimaryRateLimitWindows keeps WR-01: an absent or null window keeps the previous same-provider value and its meta", () => {
		const ref: RateLimitStatusRef = {};
		writePrimaryRateLimitWindows(ref, "claude-code", { session: w(1), weekly: w(2) }, "headers", 1000);
		writePrimaryRateLimitWindows(ref, "claude-code", { session: w(3), weekly: null }, "headers", 2000);
		assert.deepEqual(ref.current, { session: w(3), weekly: w(2) });
		assert.deepEqual(ref.meta?.weekly, { source: "headers", observedAtMs: 1000 });
		assert.deepEqual(ref.meta?.session, { source: "headers", observedAtMs: 2000 });

		writePrimaryRateLimitWindows(ref, "claude-code", { session: w(4) }, "sdk", 3000);
		assert.deepEqual(ref.current, { session: w(4), weekly: w(2) });
		assert.deepEqual(ref.meta?.weekly, { source: "headers", observedAtMs: 1000 });
	});

	test("writePrimaryRateLimitWindows keeps CR-03: a different provider drops the previous windows and meta", () => {
		const ref: RateLimitStatusRef = {};
		writePrimaryRateLimitWindows(ref, "provider-a", { session: w(1), weekly: w(2) }, "headers", 1000);
		writePrimaryRateLimitWindows(ref, "provider-b", { session: w(9) }, "sdk", 2000);
		assert.deepEqual(ref.current, { session: w(9), weekly: null });
		assert.equal(ref.meta?.weekly, undefined);
		assert.deepEqual(ref.meta?.session, { source: "sdk", observedAtMs: 2000 });
		assert.equal(ref.provider, "provider-b");
	});

	test("every producer write stamps meta for exactly the windows it wrote", () => {
		const ref: RateLimitStatusRef = {};
		writePrimaryRateLimitWindows(ref, "claude-code", { session: w(10) }, "sdk", 5000);
		assert.deepEqual(ref.meta, { session: { source: "sdk", observedAtMs: 5000 } });

		writePrimaryRateLimitWindows(ref, "claude-code", { weekly: w(20) }, "headers", 6000);
		assert.deepEqual(ref.meta, {
			session: { source: "sdk", observedAtMs: 5000 },
			weekly: { source: "headers", observedAtMs: 6000 },
		});

		const fresh: RateLimitStatusRef = {};
		writePrimaryRateLimitWindows(fresh, "claude-code", { session: w(1), weekly: w(2) }, "headers", 7000);
		assert.deepEqual(fresh.meta, {
			session: { source: "headers", observedAtMs: 7000 },
			weekly: { source: "headers", observedAtMs: 7000 },
		});
	});

	test("canDashboardWriteWindow: empty, dashboard-sourced and undated windows are writable", () => {
		const now = 10_000_000;
		assert.equal(canDashboardWriteWindow({}, "session", now, now), true);
		assert.equal(canDashboardWriteWindow({ current: { session: null, weekly: null }, provider: "claude-code" }, "session", now, now), true);
		const dashboard: RateLimitStatusRef = {
			current: { session: w(5), weekly: null },
			provider: "claude-code",
			meta: { session: { source: "dashboard", observedAtMs: now } },
		};
		assert.equal(canDashboardWriteWindow(dashboard, "session", now, now), true);
		const undated: RateLimitStatusRef = { current: { session: w(5), weekly: null }, provider: "claude-code" };
		assert.equal(canDashboardWriteWindow(undated, "session", now, now), true);
		const otherProvider: RateLimitStatusRef = {
			current: { session: w(5), weekly: null },
			provider: "provider-a",
			meta: { session: { source: "sdk", observedAtMs: now } },
		};
		assert.equal(canDashboardWriteWindow(otherProvider, "session", now, now), true);
	});

	test("canDashboardWriteWindow: an SDK reading exactly SDK_FRESH_MS old blocks the dashboard and 1 ms older is writable only when the dashboard observation is newer", () => {
		const t = 1_000_000;
		const ref: RateLimitStatusRef = {
			current: { session: w(40), weekly: null },
			provider: "claude-code",
			meta: { session: { source: "sdk", observedAtMs: t } },
		};
		assert.equal(canDashboardWriteWindow(ref, "session", t + SDK_FRESH_MS, t + SDK_FRESH_MS), false);
		assert.equal(canDashboardWriteWindow(ref, "session", t + 1, t + SDK_FRESH_MS + 1), true);
		assert.equal(canDashboardWriteWindow(ref, "session", t - 1, t + SDK_FRESH_MS + 1), false);
	});

	test("canDashboardWriteWindow: an SDK reading whose reset time is now or past is writable", () => {
		const now = 2_000_000_000;
		const mk = (resetsAtEpochSec: number): RateLimitStatusRef => ({
			current: { session: w(40, resetsAtEpochSec), weekly: null },
			provider: "claude-code",
			meta: { session: { source: "sdk", observedAtMs: now } },
		});
		assert.equal(canDashboardWriteWindow(mk(now / 1000), "session", now - 1000, now), true);
		assert.equal(canDashboardWriteWindow(mk(now / 1000 + 1), "session", now - 1000, now), false);
	});

	test("clearDashboardWindows nulls only dashboard-sourced windows and reports the change", () => {
		const ref: RateLimitStatusRef = {
			current: { session: w(8), weekly: w(29) },
			provider: "claude-code",
			meta: { session: { source: "dashboard", observedAtMs: 1 }, weekly: { source: "sdk", observedAtMs: 2 } },
		};
		assert.equal(clearDashboardWindows(ref), true);
		assert.deepEqual(ref.current, { session: null, weekly: w(29) });
		assert.equal(ref.meta?.session, undefined);
		assert.deepEqual(ref.meta?.weekly, { source: "sdk", observedAtMs: 2 });
		assert.equal(clearDashboardWindows(ref), false);
	});

	test("expireDashboardWindows clears a window observed more than maxAgeMs ago and keeps one observed exactly maxAgeMs ago", () => {
		const now = 5_000_000;
		const ref: RateLimitStatusRef = {
			current: { session: w(8), weekly: w(29) },
			provider: "claude-code",
			meta: {
				session: { source: "dashboard", observedAtMs: now - 600_001 },
				weekly: { source: "dashboard", observedAtMs: now - 600_000 },
			},
		};
		assert.equal(expireDashboardWindows(ref, now, 600_000), true);
		assert.deepEqual(ref.current, { session: null, weekly: w(29) });
		assert.equal(ref.meta?.session, undefined);
		assert.equal(expireDashboardWindows(ref, now, 600_000), false);
	});

	test("applyDashboardReading reports no change for a metadata-only refresh", () => {
		const ref: RateLimitStatusRef = {};
		const reading = { session: w(8, 100), weekly: w(29, 200), observedAtMs: 1000 };
		assert.equal(applyDashboardReading(ref, reading, 1000), true);
		assert.equal(applyDashboardReading(ref, { ...reading, observedAtMs: 61_000 }, 61_000), false);
		assert.equal(ref.meta?.session?.observedAtMs, 61_000);
		assert.equal(applyDashboardReading(ref, { ...reading, session: w(9, 100), observedAtMs: 121_000 }, 121_000), true);
	});
});
