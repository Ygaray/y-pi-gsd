// Project/App: gsd-pi
// File Purpose: Tests for the operator /drivers command (OBS-01): listing, stop confirmation and outcomes,
// dismissal and edge states. Uses a real DriverLivenessMonitor over a temp registry with fake process probes.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import type { Component } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { SessionRegistry, SessionRegistryEntry } from "@opengsd/contracts";
import type { DriverProcessProbes } from "./components/gsd-driver-registry.js";
import { DriverLivenessMonitor } from "./components/gsd-driver-liveness-monitor.js";
import type { DriverControlPort } from "./driver-control.js";
import { handleDriversCommand, type DriversCommandContext } from "./drivers-command.js";

initTheme("dark", false);

const NOW = Date.parse("2026-10-08T12:00:00.000Z");
const MIN = 60_000;

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = realpathSync(mkdtempSync(join(tmpdir(), "gsd-drivers-cmd-")));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function makeProbes(alive: number[]): DriverProcessProbes & { alive: Set<number> } {
	const probes = {
		alive: new Set(alive),
		isPidAlive: (pid: number) => probes.alive.has(pid),
		isOwnerAlive: (pid: number) => probes.alive.has(pid),
		getStartTimeMs: () => null,
		async prefetchStartTimes() {},
	};
	return probes;
}

function writeRegistry(path: string, rows: SessionRegistryEntry[]): void {
	const registry: SessionRegistry = {};
	for (const row of rows) registry[row.projectDir] = row;
	writeFileSync(path, JSON.stringify(registry, null, 2));
}

function liveRow(projectDir: string, pid: number, ageMs: number, extra: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
	return {
		sessionId: "9f3c0a1e",
		projectDir,
		pid,
		ownerPid: 4999,
		startTime: new Date(NOW - ageMs).toISOString(),
		status: "running",
		...extra,
	};
}

function tombstone(projectDir: string, pid: number, exitAgeMs: number, reason = "Agent process exited unexpectedly (signal SIGKILL)", extra: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
	return {
		...liveRow(projectDir, pid, 12 * MIN),
		status: "exited",
		exit: { reason, code: null, signal: "SIGKILL", at: new Date(NOW - exitAgeMs).toISOString() },
		...extra,
	};
}

interface Harness {
	root: string;
	registryPath: string;
	probes: ReturnType<typeof makeProbes>;
	monitor: DriverLivenessMonitor;
	blocks: Component[];
	statuses: string[];
	warnings: string[];
	alerts: Array<{ headline: string; details: readonly string[] }>;
	selectors: Array<{ component: Component; focus: Component; done: () => void; doneCalls: number }>;
	renders: number;
	stopCalls: Array<{ projectDir: string; expect: { pid: number; startTime: string } }>;
	ctx: DriversCommandContext;
}

function makeHarness(options: { alive?: number[]; port?: DriverControlPort | "none" } = {}): Harness {
	const root = makeTempDir();
	const registryPath = join(makeTempDir(), "session-instances.json");
	const probes = makeProbes(options.alive ?? [4999]);
	const monitor = new DriverLivenessMonitor({ projectRoot: root, registryPath, probes, now: () => NOW });
	const h = {
		root,
		registryPath,
		probes,
		monitor,
		blocks: [] as Component[],
		statuses: [] as string[],
		warnings: [] as string[],
		alerts: [] as Array<{ headline: string; details: readonly string[] }>,
		selectors: [] as Harness["selectors"],
		renders: 0,
		stopCalls: [] as Harness["stopCalls"],
	} as Harness;
	const port: DriverControlPort | undefined =
		options.port === "none"
			? undefined
			: (options.port ?? {
					async stopDriver(projectDir, expect) {
						h.stopCalls.push({ projectDir, expect });
						return { outcome: "stopped", pid: expect.pid };
					},
				});
	h.ctx = {
		driverLiveness: monitor,
		driverControl: port,
		showStatus: (m) => void h.statuses.push(m),
		showWarning: (m) => void h.warnings.push(m),
		showSelector(create) {
			const entry = { done: () => void (entry.doneCalls += 1), doneCalls: 0 } as Harness["selectors"][number];
			const made = create(entry.done);
			entry.component = made.component;
			entry.focus = made.focus;
			h.selectors.push(entry);
		},
		appendChatBlock: (c) => void h.blocks.push(c),
		showDriverAlert: (headline, details = []) => void h.alerts.push({ headline, details }),
		requestRender: () => void (h.renders += 1),
	};
	return h;
}

function mkdir(root: string, name: string): string {
	const dir = join(root, name);
	mkdirSync(dir, { recursive: true });
	return dir;
}

function plain(component: Component, width = 120): string[] {
	return component.render(width).map((line) => stripAnsi(line));
}

describe("handleDriversCommand listing", () => {
	it("OBS-01 /drivers lists every registry row with project, pid, session, state, supervisor and age", async () => {
		const h = makeHarness({ alive: [4242, 4301, 4999] });
		const base = makeTempDir();
		const alpha = mkdir(base, "alpha");
		const beta = mkdir(base, "beta");
		const gamma = mkdir(base, "gamma");
		const delta = mkdir(base, "delta");
		writeRegistry(h.registryPath, [
			tombstone(alpha, 4100, 3 * MIN, "Agent process exited unexpectedly (signal SIGKILL)", { sessionId: "9f3c0a1e77" }),
			liveRow(beta, 4150, 9 * MIN, { ownerPid: 4777 }),
			liveRow(gamma, 4242, 41 * MIN, { ownerPid: 4777 }),
			liveRow(delta, 4301, 12 * MIN, { sessionId: "7be21c04aa" }),
		]);

		await handleDriversCommand("/drivers", h.ctx);

		assert.equal(h.blocks.length, 1);
		const lines = plain(h.blocks[0]);
		assert.equal(lines[0], "Drivers · this machine (4)");
		const find = (needle: string): number => lines.findIndex((l) => l.includes(needle));
		const [a, b, g, d] = [find("alpha"), find("beta"), find("gamma"), find("delta")];
		assert.ok(a > 0 && b > a && g > b && d > g, lines.join("\n"));

		assert.ok(lines[a].startsWith("  ·"), lines[a]);
		for (const part of ["✕ DIED", "4100", "9f3c0a1e", "alpha"]) assert.ok(lines[a].includes(part), lines[a]);
		assert.ok(lines[b].startsWith("  1"), lines[b]);
		assert.ok(lines[b].includes("gone"), lines[b]);
		assert.ok(lines[g].startsWith("  2"), lines[g]);
		assert.ok(lines[g].includes("◐ stale"), lines[g]);
		assert.ok(lines[d].startsWith("  3"), lines[d]);
		for (const part of ["● running", "7be21c04", "alive"]) assert.ok(lines[d].includes(part), lines[d]);

		assert.ok(lines[a + 1].includes("Agent process exited"), lines[a + 1]);
		assert.ok(lines[a + 1].includes("exited 3m ago"), lines[a + 1]);

		const tail = lines.slice(-2);
		assert.ok(tail[0].startsWith("● running = process alive and supervised"), tail[0]);
		assert.equal(tail[1], "Stop one with /drivers stop <n>. Hide died drivers with /drivers dismiss.");
	});
});
