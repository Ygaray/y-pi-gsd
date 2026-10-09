// Project/App: gsd-pi
// File Purpose: Tests for the read-only driver liveness monitor (OBS-01): the tracer from a registry file
// change to one widget line, death-alert bookkeeping, in-memory dismissal, and the machine-wide listing.
// Fixtures use the writer format of mcp-server's session-persist.ts and always pass an explicit temp path.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { SessionRegistry, SessionRegistryEntry } from "@opengsd/contracts";
import type { DriverProcessProbes } from "./gsd-driver-registry.js";
import { DriverLivenessMonitor, type DriverDeathAlert } from "./gsd-driver-liveness-monitor.js";
import { DriverLivenessWidget } from "./gsd-driver-liveness-widget.js";

initTheme("dark", false);

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const MIN = 60_000;
const HOUR = 60 * MIN;

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-driver-monitor-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface FakeProbes extends DriverProcessProbes {
	alive: Set<number>;
	prefetches: number[][];
	failPrefetch: boolean;
}

function makeProbes(alive: number[]): FakeProbes {
	const probes: FakeProbes = {
		alive: new Set(alive),
		prefetches: [],
		failPrefetch: false,
		isPidAlive: (pid) => probes.alive.has(pid),
		isOwnerAlive: (pid) => probes.alive.has(pid),
		getStartTimeMs: () => null,
		async prefetchStartTimes(pids) {
			probes.prefetches.push([...pids]);
			if (probes.failPrefetch) throw new Error("ps exploded");
		},
	};
	return probes;
}

function liveRow(projectDir: string, pid: number, ageMs: number, extra: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
	return {
		sessionId: "9f3c0a1e",
		projectDir,
		pid,
		ownerPid: 4100,
		startTime: new Date(NOW - ageMs).toISOString(),
		status: "running",
		...extra,
	};
}

function tombstone(projectDir: string, pid: number, exitAgeMs: number | null, reason = "Agent process exited unexpectedly (signal SIGKILL)"): SessionRegistryEntry {
	return {
		...liveRow(projectDir, pid, 12 * MIN),
		status: "exited",
		exit: {
			reason,
			code: null,
			signal: "SIGKILL",
			at: exitAgeMs === null ? "garbage" : new Date(NOW - exitAgeMs).toISOString(),
		},
	};
}

function writeRegistry(path: string, rows: SessionRegistryEntry[]): void {
	const registry: SessionRegistry = {};
	for (const row of rows) registry[row.projectDir] = row;
	writeFileSync(path, JSON.stringify(registry, null, 2));
}

interface Harness {
	root: string;
	registryPath: string;
	probes: FakeProbes;
	clock: { now: number };
	alerts: DriverDeathAlert[];
	monitor: DriverLivenessMonitor;
}

function makeHarness(alive: number[] = [4242, 4100]): Harness {
	const root = makeTempDir();
	const registryPath = join(makeTempDir(), "session-instances.json");
	const probes = makeProbes(alive);
	const clock = { now: NOW };
	const alerts: DriverDeathAlert[] = [];
	const monitor = new DriverLivenessMonitor({
		projectRoot: root,
		registryPath,
		probes,
		now: () => clock.now,
		onAlert: (alert) => alerts.push(alert),
	});
	return { root, registryPath, probes, clock, alerts, monitor };
}

describe("DriverLivenessMonitor", () => {
	it("OBS-01 monitor refresh reads the registry and the widget renders one running line then one DIED line", async () => {
		const h = makeHarness();
		writeRegistry(h.registryPath, [liveRow(h.root, 4242, 12 * MIN)]);
		const widget = new DriverLivenessWidget(h.monitor);

		assert.deepEqual(widget.render(100), []);
		assert.equal(await h.monitor.refresh(), true);
		const running = widget.render(100);
		assert.equal(running.length, 1);
		assert.ok(
			stripAnsi(running[0]).startsWith("● DRIVER running · pid 4242 · up 12m"),
			stripAnsi(running[0]),
		);

		writeRegistry(h.registryPath, [tombstone(h.root, 4242, 3 * MIN)]);
		h.clock.now += 5_000;
		assert.equal(await h.monitor.refresh(), true);
		const died = widget.render(100);
		assert.equal(died.length, 1);
		const text = stripAnsi(died[0]);
		assert.ok(
			text.startsWith("✕ DRIVER DIED · Agent process exited unexpectedly (signal SIGKILL) · pid 4242"),
			text,
		);
		assert.ok(text.trimEnd().endsWith("3m ago · /drivers"), text);
		assert.equal(h.alerts.length, 1);
		assert.equal(h.alerts[0].headline, "✕ Driver died: Agent process exited unexpectedly (signal SIGKILL)");
	});

	it("a running-to-died transition emits exactly one alert and repeated refreshes emit none", async () => {
		const h = makeHarness();
		writeRegistry(h.registryPath, [liveRow(h.root, 4242, 12 * MIN)]);
		await h.monitor.refresh();
		assert.equal(h.alerts.length, 0);

		h.probes.alive.delete(4242);
		await h.monitor.refresh();
		assert.equal(h.alerts.length, 1);
		assert.equal(
			h.alerts[0].headline,
			"\u2715 Driver died: driver pid 4242 is no longer running; exit status unobserved",
		);
		assert.equal(h.alerts[0].details.length, 1);
		assert.ok(h.alerts[0].details[0].startsWith("  pid 4242 \u00b7 project "), h.alerts[0].details[0]);
		assert.ok(h.alerts[0].details[0].endsWith(" \u00b7 /drivers for details"));
		assert.ok(!/\d\d:\d\d:\d\d/.test(h.alerts[0].details[0]), "no time for an unknown exit time");

		for (let i = 0; i < 3; i++) {
			h.clock.now += 3_000;
			await h.monitor.refresh();
		}
		assert.equal(h.alerts.length, 1);
	});

	it("an unreconciled death that later becomes a tombstone is not re-alerted", async () => {
		const h = makeHarness();
		writeRegistry(h.registryPath, [liveRow(h.root, 4242, 12 * MIN)]);
		await h.monitor.refresh();
		h.probes.alive.delete(4242);
		await h.monitor.refresh();
		assert.equal(h.alerts.length, 1);

		writeRegistry(h.registryPath, [tombstone(h.root, 4242, 1 * MIN)]);
		h.clock.now += 5_000;
		await h.monitor.refresh();
		assert.equal(h.alerts.length, 1);
		const text = stripAnsi(new DriverLivenessWidget(h.monitor).render(120)[0]);
		assert.ok(text.includes("Agent process exited unexpectedly (signal SIGKILL)"), text);
	});

	it("startup deaths emit at most three age-prefixed alerts plus one summary", async () => {
		const h = makeHarness([]);
		const otherA = makeTempDir();
		const otherB = makeTempDir();
		const otherC = makeTempDir();
		const otherOld = makeTempDir();
		writeRegistry(h.registryPath, [
			tombstone(h.root, 5001, 5 * HOUR, "related-five"),
			tombstone(join(h.root, "wt"), 5002, 4 * HOUR, "related-four"),
			tombstone(otherA, 5003, 1 * HOUR, "other-one"),
			tombstone(otherB, 5004, 2 * HOUR, "other-two"),
			tombstone(otherC, 5005, 3 * HOUR, "other-three"),
			tombstone(otherOld, 5006, 25 * HOUR, "too-old"),
		]);
		await h.monitor.refresh();
		assert.deepEqual(
			h.alerts.map((a) => a.headline),
			[
				"\u2715 Driver died 4h ago: related-four",
				"\u2715 Driver died 5h ago: related-five",
				"\u2715 Driver died 1h ago: other-one",
				"\u2715 2 more drivers died; run /drivers",
			],
		);
		assert.deepEqual(h.alerts[3].details, []);

		await h.monitor.refresh();
		assert.equal(h.alerts.length, 4, "no repeat on the next refresh");
	});

	it("dismissDied hides died rows from the widget but listAll still returns them marked dismissed", async () => {
		const h = makeHarness([]);
		writeRegistry(h.registryPath, [tombstone(h.root, 4242, 3 * MIN)]);
		await h.monitor.refresh();
		const widget = new DriverLivenessWidget(h.monitor);
		assert.equal(widget.render(100).length, 1);

		assert.equal(h.monitor.dismissDied(), 1);
		const snapshot = h.monitor.getSnapshot();
		assert.equal(snapshot.kind, "summary");
		assert.equal(snapshot.kind === "summary" && snapshot.summary.kind, "none");
		assert.deepEqual(widget.render(100), []);
		assert.equal(h.monitor.dismissDied(), 0, "nothing left to dismiss");

		const listing = await h.monitor.listAll();
		assert.equal(listing.kind, "ok");
		if (listing.kind === "ok") {
			assert.equal(listing.drivers.length, 1);
			assert.equal(listing.drivers[0].dismissed, true);
		}

		h.clock.now += 5_000;
		await h.monitor.refresh();
		assert.deepEqual(widget.render(100), [], "dismissal survives later refreshes in this session");
		assert.equal(h.alerts.length, 1, "dismissing never re-alerts");
	});

	it("listAll bypasses the cache and sorts died, stale, running", async () => {
		const h = makeHarness([4242, 4243, 4100, 5001]);
		const dirs = [1, 2, 3, 4, 5].map(() => makeTempDir());
		writeRegistry(h.registryPath, [liveRow(h.root, 4243, 5 * MIN)]);
		await h.monitor.refresh();

		writeRegistry(h.registryPath, [
			liveRow(dirs[0], 4243, 5 * MIN),
			liveRow(dirs[1], 4242, 30 * MIN),
			liveRow(dirs[2], 5001, 41 * MIN, { ownerPid: 5999 }),
			tombstone(dirs[3], 6001, 3 * HOUR, "older death"),
			tombstone(dirs[4], 6002, 1 * HOUR, "newer death"),
		]);
		const listing = await h.monitor.listAll();
		assert.equal(listing.kind, "ok");
		if (listing.kind !== "ok") return;
		assert.equal(listing.path, h.registryPath);
		assert.deepEqual(
			listing.drivers.map((d) => [d.liveness.kind, d.row.pid]),
			[
				["died", 6002],
				["died", 6001],
				["stale", 5001],
				["running", 4242],
				["running", 4243],
			],
		);

		writeFileSync(h.registryPath, "{not json");
		const bad = await h.monitor.listAll();
		assert.deepEqual(bad, { kind: "unreadable", path: h.registryPath, why: "parse failed" });
	});

	it("refresh never rejects and never overlaps", async () => {
		const h = makeHarness();
		writeRegistry(h.registryPath, [liveRow(h.root, 4242, 12 * MIN)]);
		assert.equal(await h.monitor.refresh(), true);
		const before = h.monitor.getSnapshot();

		h.probes.failPrefetch = true;
		h.clock.now += 5_000;
		assert.equal(await h.monitor.refresh(), true, "a failed refresh is a visible change, not a silent keep");
		assert.notEqual(h.monitor.getSnapshot(), before, "the stale snapshot is not left on screen");
		assert.deepEqual(h.monitor.getSnapshot(), { kind: "unreadable", path: h.registryPath }, "failure is loud");

		h.probes.failPrefetch = false;
		h.clock.now += 5_000;
		const prefetchesBefore = h.probes.prefetches.length;
		const a = h.monitor.refresh();
		const b = h.monitor.refresh();
		assert.equal(a, b, "concurrent refreshes share one promise");
		await a;
		assert.equal(h.probes.prefetches.length, prefetchesBefore + 1, "one read per overlapping burst");
		assert.deepEqual(h.probes.prefetches[h.probes.prefetches.length - 1], [4242], "only live-claim pids are prefetched");
	});

	it("hostile control bytes in a tombstone reason never reach an alert", async () => {
		const h = makeHarness([]);
		writeRegistry(h.registryPath, [tombstone(h.root, 4242, 3 * MIN, "boom\x07\x9b\x1b[31mred")]);
		await h.monitor.refresh();
		assert.equal(h.alerts.length, 1);
		for (const text of [h.alerts[0].headline, ...h.alerts[0].details]) {
			assert.ok(!text.includes("\x07") && !text.includes("\x9b") && !text.includes("\x1b"), JSON.stringify(text));
		}
		assert.equal(h.alerts[0].headline, "\u2715 Driver died 3m ago: boom[31mred");
		assert.match(h.alerts[0].details[0], /\d\d:\d\d:\d\d/, "known exit time is shown");
	});
});
