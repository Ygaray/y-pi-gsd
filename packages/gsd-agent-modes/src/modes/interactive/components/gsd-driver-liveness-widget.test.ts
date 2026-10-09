// Project/App: gsd-pi
// File Purpose: Render-contract tests for the one-row driver liveness widget (OBS-01): every state, the
// documented layouts, width degradation, ANSI-stripped distinctness, hostile input and the timer lifecycle.
// Snapshots are built directly so the contract is tested without registry file I/O.

import assert from "node:assert/strict";
import { describe, it, mock } from "node:test";
import stripAnsi from "strip-ansi";
import { visibleWidth } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { ClassifiedDriver, DriverLiveness } from "./gsd-driver-registry.js";
import type { DriverLivenessMonitor, DriverWidgetSnapshot } from "./gsd-driver-liveness-monitor.js";
import { DRIVER_STATE_STYLE, DriverLivenessWidget, renderDriverLivenessLine } from "./gsd-driver-liveness-widget.js";

initTheme("dark", false);

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const MIN = 60_000;
const REASON = "Agent process exited unexpectedly (signal SIGKILL)";

function driver(liveness: DriverLiveness, opts: { pid?: number; related?: boolean; dir?: string } = {}): ClassifiedDriver {
	const pid = opts.pid ?? 4242;
	const dir = opts.dir ?? "/work/my-project";
	return {
		key: dir,
		rowKey: `${dir}|${pid}|t`,
		canonicalDir: dir,
		row: { sessionId: "9f3c0a1e", projectDir: dir, pid, startTime: "t", status: "running" },
		liveness,
		supervisor: "alive",
		related: opts.related ?? true,
		dismissed: false,
	};
}

function summary(
	worst: ClassifiedDriver | null,
	extra: { relatedCount?: number; othersCount?: number; othersWorst?: "died" | "stale" | null } = {},
): DriverWidgetSnapshot {
	return {
		kind: "summary",
		nowMs: NOW,
		summary: {
			kind: "drivers",
			worst,
			relatedCount: extra.relatedCount ?? (worst === null ? 0 : 1),
			others: { count: extra.othersCount ?? 0, worst: extra.othersWorst ?? null },
		},
	};
}

const running = (sinceMs: number | null = 12 * MIN) => driver({ kind: "running", sinceMs });
const staleGone = () => driver({ kind: "stale", why: "supervisor-gone", sinceMs: 41 * MIN });
const staleStarting = () => driver({ kind: "stale", why: "starting-timeout", sinceMs: 52_000 });
const diedTomb = (reason = REASON, atMs: number | null = NOW - 3 * MIN) =>
	driver({ kind: "died", reason, code: null, signal: "SIGKILL", atMs, reconciled: true });
const diedUnreconciled = () =>
	driver({
		kind: "died",
		reason: "driver pid 4242 is no longer running; exit status unobserved",
		code: null,
		signal: null,
		atMs: null,
		reconciled: false,
	});

function plain(snapshot: DriverWidgetSnapshot, width = 100): string {
	const lines = renderDriverLivenessLine(snapshot, width);
	assert.equal(lines.length, 1, "expected exactly one line");
	return stripAnsi(lines[0]);
}

describe("DriverLivenessWidget render contract", () => {
	it("renders exactly one line in every visible state and [] when there is nothing to show", () => {
		assert.deepEqual(renderDriverLivenessLine({ kind: "pending" }, 100), []);
		assert.deepEqual(renderDriverLivenessLine({ kind: "summary", nowMs: NOW, summary: { kind: "none" } }, 100), []);
		assert.deepEqual(renderDriverLivenessLine(summary(running()), 0), []);

		const visible: DriverWidgetSnapshot[] = [
			summary(running()),
			summary(staleGone()),
			summary(staleStarting()),
			summary(diedTomb()),
			summary(diedUnreconciled()),
			summary(null, { othersCount: 2, othersWorst: "died" }),
			{ kind: "unreadable", path: "/x/session-instances.json" },
		];
		for (const snapshot of visible) assert.equal(renderDriverLivenessLine(snapshot, 100).length, 1);

		let refreshes = 0;
		const monitor = {
			getSnapshot: () => summary(running()),
			refresh: async () => {
				refreshes++;
				return false;
			},
		} as unknown as DriverLivenessMonitor;
		const widget = new DriverLivenessWidget(monitor);
		for (let i = 0; i < 50; i++) widget.render(100);
		assert.equal(refreshes, 0, "render must not refresh");
	});

	it("stale, unreadable, others-needing-attention and +N layouts match the UI contract", () => {
		assert.ok(
			plain(summary(staleGone())).startsWith("◐ DRIVER stale · supervisor gone, driver unwatched · pid 4242 · up 41m"),
		);
		assert.ok(plain(summary(staleStarting())).startsWith("◐ DRIVER stale · still starting after 52s · pid 4242"));
		assert.ok(
			plain({ kind: "unreadable", path: "/p" }).startsWith("○ DRIVER registry unreadable · cannot show driver status"),
		);
		assert.ok(
			plain(summary(null, { othersCount: 2, othersWorst: "died" })).startsWith("✕ DRIVER DIED · 2 other drivers need attention"),
		);
		assert.ok(
			plain(summary(null, { othersCount: 1, othersWorst: "stale" })).startsWith("◐ DRIVER stale · 1 other driver needs attention"),
		);
		assert.ok(plain(summary(running(), { relatedCount: 3 })).includes("· +2 more"));

		const withOther = plain(summary(running(), { othersCount: 1, othersWorst: "died" })).trimEnd();
		assert.ok(withOther.includes("· 1 other driver needs attention"), withOther);
		assert.ok(withOther.endsWith("/drivers"), withOther);

		assert.ok(
			plain(summary(diedUnreconciled())).startsWith(
				"✕ DRIVER DIED · driver pid 4242 is no longer running; exit status unobserved",
			),
		);

		const everything = [
			summary(running()),
			summary(running(), { relatedCount: 3, othersCount: 2, othersWorst: "stale" }),
			summary(staleGone()),
			summary(staleStarting()),
			summary(diedTomb()),
			summary(diedUnreconciled()),
			summary(null, { othersCount: 3, othersWorst: "died" }),
			{ kind: "unreadable", path: "/p" } as DriverWidgetSnapshot,
		];
		for (const snapshot of everything) {
			for (const width of [100, 40, 20]) {
				assert.doesNotMatch(plain(snapshot, width), /stall|activity|progress/i);
			}
		}
		assert.equal(DRIVER_STATE_STYLE.running.tone, "success");
		assert.equal(DRIVER_STATE_STYLE.stale.tone, "warning");
		assert.equal(DRIVER_STATE_STYLE.died.tone, "error");
		assert.equal(DRIVER_STATE_STYLE.unreadable.tone, null);
	});

	it("narrow widths drop segments in the documented order and never exceed the width", () => {
		const snapshot = summary(diedTomb());
		for (const width of [120, 80, 40, 24, 16, 14]) {
			const lines = renderDriverLivenessLine(snapshot, width);
			assert.equal(lines.length, 1, `width ${width}`);
			assert.ok(visibleWidth(lines[0]) <= width, `width ${width}: ${visibleWidth(lines[0])}`);
		}

		const at120 = plain(snapshot, 120);
		assert.ok(at120.includes("pid 4242"));
		assert.ok(at120.trimEnd().endsWith("3m ago · /drivers"), at120);

		const at80 = plain(snapshot, 80);
		assert.ok(at80.includes("pid 4242") && at80.includes(REASON), at80);
		assert.ok(!at80.includes("/drivers") && !at80.includes("ago"), at80);

		for (const width of [40, 24]) {
			const text = plain(snapshot, width);
			assert.ok(text.startsWith("✕ DIED · Agent proces"), text);
			assert.ok(text.trimEnd().endsWith("…"), text);
			assert.ok(!/pid|ago|\/drivers/.test(text), text);
		}
		assert.equal(plain(snapshot, 14).trim(), "✕ DIED");

		// Running rows shed metadata before the pid, and the extras before the primary detail.
		const busy = summary(running(), { relatedCount: 3, othersCount: 2, othersWorst: "died" });
		const wide = plain(busy, 120);
		assert.ok(wide.includes("up 12m") && wide.includes("+2 more") && wide.includes("2 other drivers need attention"), wide);
		const mid = plain(busy, 62);
		assert.ok(mid.includes("pid 4242"), mid);
		assert.ok(!mid.includes("up 12m"), mid);
		assert.ok(visibleWidth(renderDriverLivenessLine(busy, 62)[0]) <= 62);
	});

	it("the three states stay distinct with ANSI stripped", () => {
		const r = plain(summary(running()));
		const s = plain(summary(staleGone()));
		const d = plain(summary(diedTomb()));
		assert.equal(new Set([r, s, d]).size, 3);
		assert.ok(r.includes("running") && s.includes("stale") && d.includes("DIED"));
		// Colour is never the only carrier: the glyphs differ too.
		assert.equal(new Set([r[0], s[0], d[0]]).size, 3);
	});

	it("hostile control bytes never reach a rendered line", () => {
		const hostile = diedTomb("boom\x07\x9b\x1b[31mred");
		for (const width of [120, 80, 40, 16]) {
			const lines = renderDriverLivenessLine(summary(hostile), width);
			assert.equal(lines.length, 1);
			assert.ok(!lines[0].includes("\x07"), "BEL survived");
			assert.ok(!lines[0].includes("\x9b"), "C1 CSI survived");
			assert.ok(!stripAnsi(lines[0]).includes("\x1b"), "ESC survived");
		}
		assert.ok(plain(summary(hostile)).includes("boom"));
	});

	it("unknown ages are omitted, never NaN", () => {
		const noExitAt = plain(summary(diedTomb(REASON, null)));
		assert.ok(!noExitAt.includes("ago") && !noExitAt.includes("NaN"), noExitAt);
		assert.ok(noExitAt.trimEnd().endsWith("/drivers"), noExitAt);

		const noStart = plain(summary(running(null)));
		assert.ok(!noStart.includes("up ") && !noStart.includes("NaN"), noStart);
		assert.ok(noStart.startsWith("● DRIVER running · pid 4242"), noStart);
	});

	it("dispose stops the refresh timer", async () => {
		mock.timers.enable({ apis: ["setInterval"] });
		try {
			let refreshes = 0;
			let renders = 0;
			const monitor = {
				getSnapshot: (): DriverWidgetSnapshot => ({ kind: "pending" }),
				refresh: async () => {
					refreshes++;
					return true;
				},
			} as unknown as DriverLivenessMonitor;
			const widget = new DriverLivenessWidget(monitor);
			widget.start(() => {
				renders++;
			});
			assert.equal(refreshes, 1, "start refreshes immediately");
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(renders, 1);

			mock.timers.tick(3000);
			assert.equal(refreshes, 2);
			await new Promise<void>((resolve) => setImmediate(resolve));

			widget.dispose();
			mock.timers.tick(30_000);
			await new Promise<void>((resolve) => setImmediate(resolve));
			assert.equal(refreshes, 2, "no refresh after dispose");
		} finally {
			mock.timers.reset();
		}
	});
});
