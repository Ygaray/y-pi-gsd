// Project/App: gsd-pi
// File Purpose: Tests for the operator /drivers command (OBS-01): listing, stop confirmation and outcomes,
// dismissal and edge states. Uses a real DriverLivenessMonitor over a temp registry with fake process probes.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import stripAnsi from "strip-ansi";
import { visibleWidth } from "@gsd/pi-tui";
import type { Component } from "@gsd/pi-tui";
import { initTheme } from "@gsd/pi-coding-agent/theme/theme.js";
import type { SessionRegistry, SessionRegistryEntry } from "@opengsd/contracts";
import type { DriverProcessProbes } from "./components/gsd-driver-registry.js";
import { DriverLivenessMonitor } from "./components/gsd-driver-liveness-monitor.js";
import type { DriverControlPort } from "./driver-control.js";
import { handleDriversCommand, runDriverStop, type DriversCommandContext } from "./drivers-command.js";
import type { DriverStopResult } from "./driver-control.js";
import { DRIVERS_USAGE } from "./drivers-command.js";

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

/** Plain lines of a Text block: its horizontal padding and width fill are layout, not copy. */
function copy(component: Component, width = 120): string[] {
	return plain(component, width).map((line) => line.trim());
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

		const tail = lines.slice(-3);
		assert.ok(tail[0].startsWith("● running = process alive and supervised"), tail[0]);
		assert.equal(tail[1], "Stop one with /drivers stop <n>. Hide died drivers with /drivers dismiss.");
		assert.equal(
			tail[2],
			"A died driver with no recorded exit stays listed until you record it with /drivers stop <n>.",
		);
	});
});

// ---------------------------------------------------------------------------
// Stop
// ---------------------------------------------------------------------------

const DOWN = "\x1b[B";
const ENTER = "\r";
const ESC = "\x1b";

function press(entry: Harness["selectors"][number], key: string): void {
	(entry.focus as unknown as { handleInput(data: string): void }).handleInput(key);
}

function flush(): Promise<void> {
	return new Promise((resolve) => setImmediate(resolve));
}

function allText(h: Harness): string {
	return [
		...h.statuses,
		...h.warnings,
		...h.alerts.flatMap((a) => [a.headline, ...a.details]),
		...h.blocks.flatMap((b) => plain(b)),
	].join("\n");
}

/** One live claim (gamma, pid 4242) whose supervisor is gone, so it lists as stale and stoppable #1. */
function setupStale(h: Harness): { dir: string; row: SessionRegistryEntry } {
	const dir = mkdir(makeTempDir(), "gamma");
	const row = liveRow(dir, 4242, 41 * MIN, { ownerPid: 4777 });
	writeRegistry(h.registryPath, [row]);
	h.probes.alive.add(4242);
	return { dir, row };
}

describe("handleDriversCommand stop", () => {
	it("stop refuses without calling the port when the row changed since the listing", async () => {
		const h = makeHarness();
		const { dir, row } = setupStale(h);
		await handleDriversCommand("/drivers", h.ctx);

		writeRegistry(h.registryPath, [{ ...row, pid: 4243 }]);
		h.probes.alive.add(4243);
		await handleDriversCommand("/drivers stop 1", h.ctx);
		assert.deepEqual(h.warnings, [
			"Driver #1 changed since it was listed (pid or state differs). Nothing was stopped. Run /drivers to refresh.",
		]);

		// A tombstone for the same pid is also a change.
		h.warnings.length = 0;
		writeRegistry(h.registryPath, [tombstone(dir, 4242, MIN, "boom", { startTime: row.startTime })]);
		await handleDriversCommand("/drivers stop 1", h.ctx);
		assert.equal(h.warnings.length, 1);
		assert.ok(h.warnings[0].startsWith("Driver #1 changed since it was listed"), h.warnings[0]);

		// A vanished row is no-entry.
		h.warnings.length = 0;
		writeRegistry(h.registryPath, []);
		await handleDriversCommand("/drivers stop 1", h.ctx);
		assert.deepEqual(h.warnings, ["Driver #1 is no longer registered. Nothing was stopped. Run /drivers to refresh."]);

		assert.equal(h.stopCalls.length, 0);
		assert.equal(h.selectors.length, 0);
	});

	it("stop asks for confirmation with Cancel preselected and cancels by default", async () => {
		const h = makeHarness();
		setupStale(h);
		await handleDriversCommand("/drivers", h.ctx);
		await handleDriversCommand("/drivers stop 1", h.ctx);

		assert.equal(h.selectors.length, 1);
		const text = plain(h.selectors[0].component, 300).join("\n");
		for (const part of ["Stop driver #1?", "gamma", "4242", "No supervising MCP server is running.", "Cancel, keep driver running", "Stop driver pid 4242"]) {
			assert.ok(text.includes(part), `${part} missing from:\n${text}`);
		}

		press(h.selectors[0], ENTER);
		assert.equal(h.selectors[0].doneCalls, 1);
		assert.deepEqual(h.statuses, ["Stop cancelled. Nothing was stopped."]);
		await flush();
		assert.equal(h.stopCalls.length, 0);

		// Esc is Cancel too.
		h.statuses.length = 0;
		await handleDriversCommand("/drivers stop 1", h.ctx);
		press(h.selectors[1], ESC);
		assert.equal(h.selectors[1].doneCalls, 1);
		assert.deepEqual(h.statuses, ["Stop cancelled. Nothing was stopped."]);
		await flush();
		assert.equal(h.stopCalls.length, 0);
	});

	it("an unreconciled dead row offers to record the exit and signals nothing", async () => {
		const h = makeHarness();
		const dir = mkdir(makeTempDir(), "beta");
		writeRegistry(h.registryPath, [liveRow(dir, 4150, 9 * MIN)]);
		await handleDriversCommand("/drivers", h.ctx);
		const listed = plain(h.blocks[0]).join("\n");
		assert.ok(
			listed.includes("A died driver with no recorded exit stays listed until you record it with /drivers stop <n>."),
			`the listing must say how to clear an unreconciled row:\n${listed}`,
		);
		await handleDriversCommand("/drivers stop 1", h.ctx);

		const text = plain(h.selectors[0].component, 300).join("\n");
		assert.ok(text.includes("Record pid 4150 as exited"), text);
		assert.ok(text.includes("No process is signalled"), text);
		assert.ok(text.includes("is not running. This only records it as exited; no process is signalled."), text);
	});

	it("stop calls the port with the listed pid and start time and reports stopped only after a clean re-read", async () => {
		const h = makeHarness({
			port: {
				async stopDriver(projectDir, expect) {
					h.stopCalls.push({ projectDir, expect });
					writeRegistry(h.registryPath, []);
					return { outcome: "stopped", pid: expect.pid };
				},
			},
		});
		const { dir, row } = setupStale(h);
		await handleDriversCommand("/drivers", h.ctx);
		await handleDriversCommand("/drivers stop 1", h.ctx);

		press(h.selectors[0], DOWN);
		press(h.selectors[0], ENTER);
		assert.deepEqual(h.statuses, ["Stopping driver #1 (pid 4242)\u2026"]);
		await flush();

		assert.equal(h.stopCalls.length, 1);
		assert.equal(h.stopCalls[0].projectDir, row.projectDir);
		assert.equal(h.stopCalls[0].projectDir, dir);
		assert.deepEqual(h.stopCalls[0].expect, { pid: 4242, startTime: row.startTime });
		assert.equal(h.blocks.length, 2, "listing plus one outcome block");
		const outcome = copy(h.blocks[1]);
		assert.equal(outcome[0], "Stopped driver pid 4242 \u00b7 gamma");
		assert.equal(outcome[1], "Its in-flight sub-processes are not tracked and may finish on their own.");
		assert.deepEqual(h.alerts, []);
	});

	it("every typed outcome maps to its exact copy", async () => {
		interface Case {
			name: string;
			result: DriverStopResult | Error;
			mutate?: (h: Harness, dir: string, row: SessionRegistryEntry) => void;
			warnings?: string[];
			alert?: { headline: string; details: string[] };
			block?: string[];
		}
		const cases: Case[] = [
			{
				name: "dead-reconciled",
				result: { outcome: "dead-reconciled", pid: 4242 },
				mutate: (h) => writeRegistry(h.registryPath, []),
				block: ["Driver pid 4242 was not running; recorded as exited."],
			},
			{
				name: "kill-failed",
				result: { outcome: "kill-failed", pid: 4242, error: "EPERM: operation not permitted" },
				alert: {
					headline: "\u2715 Could not stop driver pid 4242: EPERM: operation not permitted",
					details: ["  The registry row was kept so you can retry. Run /drivers, then /drivers stop <n>."],
				},
			},
			{
				name: "no-entry",
				result: { outcome: "no-entry" },
				warnings: ["Driver #1 is no longer registered. Nothing was stopped. Run /drivers to refresh."],
			},
			{
				name: "row-changed",
				result: { outcome: "row-changed" },
				warnings: ["Driver #1 changed since it was listed (pid or state differs). Nothing was stopped. Run /drivers to refresh."],
			},
			{
				name: "busy",
				result: { outcome: "busy" },
				warnings: ["A start or stop for gamma is in progress. Nothing was stopped; retry in a moment."],
			},
			{
				name: "rejected",
				result: new Error("registry lock exploded\u0007"),
				alert: {
					headline: "\u2715 Stop failed: registry lock exploded",
					details: ["  Nothing is confirmed stopped. Run /drivers to check."],
				},
			},
			{
				name: "stopped but still claimed",
				result: { outcome: "stopped", pid: 4242 },
				alert: {
					headline: "\u2715 Stop reported success but driver pid 4242 still looks alive.",
					details: ["  Run /drivers to re-check."],
				},
			},
			{
				name: "stopped but registry unreadable",
				result: { outcome: "stopped", pid: 4242 },
				mutate: (h) => writeFileSync(h.registryPath, "{not json"),
				alert: {
					headline: "\u2715 Stop reported success for driver pid 4242, but the registry could not be re-read to confirm.",
					details: ["  Run /drivers to re-check."],
				},
			},
		];

		for (const c of cases) {
			const h = makeHarness({
				port: {
					async stopDriver() {
						if (c.result instanceof Error) throw c.result;
						return c.result;
					},
				},
			});
			const { dir, row } = setupStale(h);
			const listing = await h.monitor.listAll();
			assert.equal(listing.kind, "ok");
			if (listing.kind !== "ok") continue;
			const driver = listing.drivers[0];

			// The port mutates the registry as the server would, before the TUI re-reads.
			const port = h.ctx.driverControl as DriverControlPort;
			const original = port.stopDriver.bind(port);
			h.ctx.driverControl = {
				async stopDriver(projectDir, expect) {
					const r = await original(projectDir, expect);
					c.mutate?.(h, dir, row);
					return r;
				},
			};
			if (c.result instanceof Error) {
				h.ctx.driverControl = {
					async stopDriver() {
						throw c.result;
					},
				};
			}

			await runDriverStop({ index: 1, driver }, h.ctx);

			assert.deepEqual(h.warnings, c.warnings ?? [], c.name);
			if (c.alert) {
				assert.equal(h.alerts.length, 1, c.name);
				assert.equal(h.alerts[0].headline, c.alert.headline, c.name);
				assert.deepEqual(h.alerts[0].details, c.alert.details, c.name);
			} else {
				assert.deepEqual(h.alerts, [], c.name);
			}
			if (c.block) {
				assert.equal(h.blocks.length, 1, c.name);
				assert.deepEqual(copy(h.blocks[0]), c.block, c.name);
			} else {
				assert.equal(h.blocks.length, 0, `${c.name}: no success copy`);
			}
			const text = allText(h);
			assert.ok(!text.includes("Error:"), `${c.name}: ${text}`);
			assert.ok(!/kill/i.test(text.replace(/kill-failed/g, "")), `${c.name}: ${text}`);
			assert.ok(!text.includes("\u0007"), c.name);
			assert.deepEqual(h.statuses, ["Stopping driver #1 (pid 4242)\u2026"], c.name);
		}
	});

	it("stop with no port shows the unavailable alert", async () => {
		const h = makeHarness({ port: "none" });
		setupStale(h);
		await handleDriversCommand("/drivers", h.ctx);
		await handleDriversCommand("/drivers stop 1", h.ctx);

		assert.deepEqual(h.alerts, [
			{
				headline: "\u2715 Stopping drivers is unavailable in this entry point. Nothing was stopped.",
				details: ["  Start y-pi-gsd with the standard y-pi-gsd command to stop drivers."],
			},
		]);
		assert.equal(h.selectors.length, 0);
		assert.deepEqual(h.warnings, []);
	});
});

// ---------------------------------------------------------------------------
// Dismiss, usage and edge states
// ---------------------------------------------------------------------------

describe("handleDriversCommand dismiss, usage and edge states", () => {
	it("/drivers dismiss hides died drivers for this session", async () => {
		const h = makeHarness();
		const base = makeTempDir();
		writeRegistry(h.registryPath, [
			tombstone(mkdir(base, "alpha"), 4100, 3 * MIN, "first reason"),
			tombstone(mkdir(base, "beta"), 4101, 5 * MIN, "second reason"),
		]);
		await h.monitor.refresh();

		await handleDriversCommand("/drivers dismiss", h.ctx);
		assert.deepEqual(h.statuses, ["Dismissed 2 died drivers. They stay listed in /drivers until they are cleaned up."]);
		assert.equal(h.renders, 1);

		await handleDriversCommand("/drivers dismiss", h.ctx);
		assert.equal(h.statuses[1], "No died drivers to dismiss.");
		assert.equal(h.renders, 2);

		await handleDriversCommand("/drivers", h.ctx);
		const text = plain(h.blocks[0]).join("\n");
		assert.ok(text.includes("(dismissed) first reason"), text);
		assert.ok(text.includes("(dismissed) second reason"), text);
		assert.ok(!text.includes("Hide died drivers with /drivers dismiss."), `already-dismissed rows must not re-offer dismiss:\n${text}`);
	});

	it("bad usage, stop before listing and a non-stoppable index warn", async () => {
		const h = makeHarness();
		assert.equal(DRIVERS_USAGE, "Usage: /drivers [list] | /drivers stop <n> | /drivers dismiss");
		await handleDriversCommand("/drivers frob", h.ctx);
		await handleDriversCommand("/drivers stop x", h.ctx);
		await handleDriversCommand("/drivers stop", h.ctx);
		await handleDriversCommand("/drivers list extra", h.ctx);
		assert.deepEqual(h.warnings, [DRIVERS_USAGE, DRIVERS_USAGE, DRIVERS_USAGE, DRIVERS_USAGE]);

		h.warnings.length = 0;
		await handleDriversCommand("/drivers stop 1", h.ctx);
		assert.deepEqual(h.warnings, ["Run /drivers first, then /drivers stop <n>."]);

		h.warnings.length = 0;
		writeRegistry(h.registryPath, [tombstone(mkdir(makeTempDir(), "alpha"), 4100, MIN)]);
		await handleDriversCommand("/drivers", h.ctx);
		await handleDriversCommand("/drivers stop 1", h.ctx);
		assert.deepEqual(h.warnings, ["No stoppable driver #1 in the last listing. Run /drivers to refresh."]);

		// The target is only ever an index into the listing: a typed pid is not a driver.
		h.warnings.length = 0;
		await handleDriversCommand("/drivers stop 4100", h.ctx);
		assert.deepEqual(h.warnings, ["No stoppable driver #4100 in the last listing. Run /drivers to refresh."]);
		assert.equal(h.stopCalls.length, 0);
		assert.equal(h.selectors.length, 0);
	});

	it("empty and unreadable registries use the documented copy", async () => {
		const h = makeHarness();
		writeRegistry(h.registryPath, []);
		await handleDriversCommand("/drivers", h.ctx);
		assert.deepEqual(plain(h.blocks[0]), ["Drivers \u00b7 this machine (0)", "  No drivers registered. Nothing to stop."]);

		const corrupt = "{ this is not json";
		writeFileSync(h.registryPath, corrupt);
		const dir = join(h.registryPath, "..");
		const before = readdirSync(dir).sort();
		await handleDriversCommand("/drivers", h.ctx);
		const lines = plain(h.blocks[1]);
		assert.equal(lines[0], "Drivers \u00b7 this machine");
		assert.equal(
			lines[1],
			"  Registry unreadable (missing permissions, corrupt, or over the 256 KiB cap). Nothing was changed.",
		);
		assert.ok(lines[2].includes("session-instances.json"), lines[2]);
		assert.equal(readFileSync(h.registryPath, "utf8"), corrupt, "file is byte-identical");
		assert.deepEqual(readdirSync(dir).sort(), before, "no sibling file appears");
	});

	it("listing caps at 20 rows and never hides died or stale rows", async () => {
		const h = makeHarness();
		const base = makeTempDir();
		const rows: SessionRegistryEntry[] = [];
		const alive = [4999];
		for (let i = 0; i < 3; i++) rows.push(tombstone(mkdir(base, `died${i}`), 4000 + i, (i + 1) * MIN));
		for (let i = 0; i < 2; i++) {
			rows.push(liveRow(mkdir(base, `stale${i}`), 4100 + i, 30 * MIN, { ownerPid: 4777 }));
			alive.push(4100 + i);
		}
		for (let i = 0; i < 25; i++) {
			rows.push(liveRow(mkdir(base, `run${String(i).padStart(2, "0")}`), 4200 + i, (60 + i) * MIN));
			alive.push(4200 + i);
		}
		for (const pid of alive) h.probes.alive.add(pid);
		writeRegistry(h.registryPath, rows);

		await handleDriversCommand("/drivers", h.ctx);
		const lines = plain(h.blocks[0]);
		const joined = lines.join("\n");
		for (let i = 0; i < 3; i++) assert.ok(joined.includes(`died${i}`), `died${i}`);
		for (let i = 0; i < 2; i++) assert.ok(joined.includes(`stale${i}`), `stale${i}`);
		assert.equal(lines.filter((l) => l.includes("\u25cf running") && /\brun\d\d$/.test(l)).length, 15);
		assert.ok(lines.includes("  \u2026 and 10 more running"), joined);

		// Hidden running rows are not numbered, so they cannot be stopped by index.
		await handleDriversCommand("/drivers stop 18", h.ctx);
		assert.deepEqual(h.warnings, ["No stoppable driver #18 in the last listing. Run /drivers to refresh."]);
	});

	it("hostile reasons and paths are sanitized in the listing", async () => {
		const h = makeHarness();
		const base = makeTempDir();
		const hostile = "bad\u0007reason\u009bX\u001b[31mred";
		const hostileDir = mkdir(base, "proj\u0007\u001b[31m-\u009bname");
		writeRegistry(h.registryPath, [
			tombstone(hostileDir, 4100, 2 * MIN, hostile),
			liveRow(mkdir(base, "ok-driver-with-a-rather-long-project-name"), 4242, 20 * MIN, { sessionId: "s\u0007\u009b\u001b[31mid-padding" }),
		]);
		h.probes.alive.add(4242);

		await handleDriversCommand("/drivers", h.ctx);

		for (const width of [120, 60]) {
			const rendered = h.blocks[0].render(width);
			const raw = rendered.join("\n");
			assert.ok(!raw.includes("\u0007"), "no BEL");
			assert.ok(!raw.includes("\u009b"), "no C1 CSI");
			assert.ok(!stripAnsi(raw).includes("\u001b"), "no ESC after stripping the theme's own codes");
			for (const line of rendered) {
				assert.ok(visibleWidth(line) <= width, `width ${width}: ${stripAnsi(line)}`);
			}
		}
	});
});
