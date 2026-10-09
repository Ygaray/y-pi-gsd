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
});
