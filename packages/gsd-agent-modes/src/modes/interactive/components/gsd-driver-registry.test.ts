// Project/App: gsd-pi
// File Purpose: Regression net for the read-only driver-registry projection (OBS-01): the bounded
// never-throw reader, per-row validation, the H0 liveness classifier with injected probes, the async
// process probes, alias collapse, project relation, the widget summary, the sanitizer and the age format.
// Fixtures use the exact writer format of mcp-server's session-persist.ts (JSON.stringify(obj, null, 2))
// and always pass an explicit temp path - the real registry is never read.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRegistry } from "@opengsd/contracts";
import {
	DIED_DISPLAY_TTL_MS,
	MAX_REGISTRY_BYTES,
	classifyDriverRow,
	classifyDrivers,
	createProcessProbes,
	formatDriverAge,
	readDriverRegistry,
	relatesToProject,
	sanitizeDriverText,
	summarizeDrivers,
	type ClassifiedDriver,
	type ClassifyContext,
} from "./gsd-driver-registry.js";

const tempDirs: string[] = [];

function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "gsd-driver-registry-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of tempDirs.splice(0)) {
		rmSync(dir, { recursive: true, force: true });
	}
});

interface ProbeSpy {
	ctx: ClassifyContext;
	calls: string[];
}

function makeCtx(
	nowMs: number,
	options: {
		alive?: (pid: number) => boolean;
		startTimeMs?: (pid: number) => number | null;
		ownerAlive?: (pid: number) => boolean;
	} = {},
): ProbeSpy {
	const calls: string[] = [];
	return {
		calls,
		ctx: {
			nowMs,
			isPidAlive(pid) {
				calls.push(`alive:${pid}`);
				return options.alive ? options.alive(pid) : true;
			},
			getStartTimeMs(pid) {
				calls.push(`start:${pid}`);
				return options.startTimeMs ? options.startTimeMs(pid) : null;
			},
			isOwnerAlive(pid) {
				calls.push(`owner:${pid}`);
				return options.ownerAlive ? options.ownerAlive(pid) : true;
			},
		},
	};
}

describe("gsd-driver-registry", () => {
	it("OBS-01 reads a registry row in the mcp-server shape and classifies a live claim as running and a tombstone as died with its reason", () => {
		const dir = makeTempDir();
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const registry: SessionRegistry = {
			"/work/alpha": {
				sessionId: "sess-a",
				projectDir: "/work/alpha",
				pid: 4242,
				startTime: new Date(nowMs - 12 * 60_000).toISOString(),
				status: "running",
				ownerPid: 4100,
			},
			"/work/beta": {
				sessionId: "sess-b",
				projectDir: "/work/beta",
				pid: 4300,
				startTime: new Date(nowMs - 20 * 60_000).toISOString(),
				status: "exited",
				exit: {
					reason: "Agent process exited unexpectedly (signal SIGKILL)",
					code: null,
					signal: "SIGKILL",
					at: new Date(nowMs - 3 * 60_000).toISOString(),
				},
			},
		};
		const path = join(dir, "session-instances.json");
		writeFileSync(path, JSON.stringify(registry, null, 2));

		const read = readDriverRegistry(path);
		assert.equal(read.kind, "ok");
		if (read.kind !== "ok") return;
		assert.equal(read.entries.length, 2);
		assert.deepEqual(
			read.entries.map((entry) => entry.key),
			["/work/alpha", "/work/beta"],
		);

		const live = read.entries[0]!.row;
		const liveSpy = makeCtx(nowMs, { alive: (pid) => pid === 4242 });
		assert.deepEqual(classifyDriverRow(live, liveSpy.ctx), { kind: "running", sinceMs: 12 * 60_000 });

		const tombstone = read.entries[1]!.row;
		const tombSpy = makeCtx(nowMs);
		assert.deepEqual(classifyDriverRow(tombstone, tombSpy.ctx), {
			kind: "died",
			reason: "Agent process exited unexpectedly (signal SIGKILL)",
			code: null,
			signal: "SIGKILL",
			atMs: nowMs - 3 * 60_000,
			reconciled: true,
		});
		assert.deepEqual(tombSpy.calls, []);
	});

	it("a missing registry file reads as ok with no rows", () => {
		const dir = makeTempDir();
		assert.deepEqual(readDriverRegistry(join(dir, "absent", "session-instances.json")), {
			kind: "ok",
			entries: [],
		});
	});

	it("a live claim whose pid is dead is died unreconciled with the fixed phrase", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const spy = makeCtx(nowMs, { alive: () => false });
		const verdict = classifyDriverRow(
			{
				sessionId: "sess-a",
				projectDir: "/work/alpha",
				pid: 4242,
				startTime: new Date(nowMs - 60_000).toISOString(),
				status: "running",
			},
			spy.ctx,
		);
		assert.deepEqual(verdict, {
			kind: "died",
			reconciled: false,
			reason: "driver pid 4242 is no longer running; exit status unobserved",
			code: null,
			signal: null,
			atMs: null,
		});
	});

	it("a tombstone is died with its verbatim reason and its pid is never probed", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const spy = makeCtx(nowMs);
		const verdict = classifyDriverRow(
			{
				sessionId: "s",
				projectDir: "/work/a",
				pid: 4300,
				startTime: new Date(nowMs - 60_000).toISOString(),
				status: "exited",
				ownerPid: 4100,
				exit: { reason: "Agent process exited with code 1", code: 1, signal: null, at: "not-a-date" },
			},
			spy.ctx,
		);
		assert.deepEqual(verdict, {
			kind: "died",
			reason: "Agent process exited with code 1",
			code: 1,
			signal: null,
			atMs: null,
			reconciled: true,
		});
		assert.deepEqual(spy.calls, []);
	});

	it("a live claim whose pid was recycled (start time more than 60 s after the row) is died unreconciled", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const startTime = new Date(nowMs - 10 * 60_000).toISOString();
		const row = { sessionId: "s", projectDir: "/work/a", pid: 4242, startTime, status: "running" };
		const recycled = classifyDriverRow(row, makeCtx(nowMs, { startTimeMs: () => Date.parse(startTime) + 61_000 }).ctx);
		assert.equal(recycled.kind, "died");
		if (recycled.kind === "died") {
			assert.equal(recycled.reconciled, false);
			assert.equal(recycled.reason, "driver pid 4242 is no longer running; exit status unobserved");
		}
		const inSkew = classifyDriverRow(row, makeCtx(nowMs, { startTimeMs: () => Date.parse(startTime) + 59_000 }).ctx);
		assert.equal(inSkew.kind, "running");
	});

	it("a live claim whose ownerPid is dead is stale supervisor-gone", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const row = {
			sessionId: "s",
			projectDir: "/work/a",
			pid: 4242,
			startTime: new Date(nowMs - 5 * 60_000).toISOString(),
			status: "running",
			ownerPid: 4100,
		};
		const gone = classifyDriverRow(row, makeCtx(nowMs, { ownerAlive: () => false }).ctx);
		assert.deepEqual(gone, { kind: "stale", why: "supervisor-gone", sinceMs: 5 * 60_000 });
		assert.equal(classifyDriverRow(row, makeCtx(nowMs, { ownerAlive: () => true }).ctx).kind, "running");
	});

	it("a row without ownerPid is running, never stale", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const spy = makeCtx(nowMs, { ownerAlive: () => false });
		const verdict = classifyDriverRow(
			{
				sessionId: "s",
				projectDir: "/work/a",
				pid: 4242,
				startTime: new Date(nowMs - 5 * 60_000).toISOString(),
				status: "running",
			},
			spy.ctx,
		);
		assert.equal(verdict.kind, "running");
		assert.equal(spy.calls.some((call) => call.startsWith("owner:")), false);
	});

	it("a starting row older than 45 s is stale starting-timeout", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const base = { sessionId: "", projectDir: "/work/a", pid: 4242, status: "starting" };
		const old = classifyDriverRow({ ...base, startTime: new Date(nowMs - 46_000).toISOString() }, makeCtx(nowMs).ctx);
		assert.deepEqual(old, { kind: "stale", why: "starting-timeout", sinceMs: 46_000 });
		const young = classifyDriverRow({ ...base, startTime: new Date(nowMs - 44_000).toISOString() }, makeCtx(nowMs).ctx);
		assert.equal(young.kind, "running");
	});

	it("an unverifiable start time fails open to signal-0 liveness", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const verdict = classifyDriverRow(
			{
				sessionId: "s",
				projectDir: "/work/a",
				pid: 4242,
				startTime: new Date(nowMs - 60_000).toISOString(),
				status: "running",
			},
			makeCtx(nowMs, { startTimeMs: () => null, alive: () => true }).ctx,
		);
		assert.equal(verdict.kind, "running");
	});

	it("process probes fetch start times asynchronously and cache them", async () => {
		let clock = 1_000_000;
		const calls: Array<{ file: string; args: readonly string[]; env: NodeJS.ProcessEnv; timeout: number }> = [];
		let fail = false;
		const probes = createProcessProbes({
			now: () => clock,
			execFile: async (file, args, opts) => {
				calls.push({ file, args, env: opts.env, timeout: opts.timeout });
				if (fail) throw new Error("ps failed");
				return { stdout: "Wed Oct  8 10:00:00 2026\n" };
			},
		});

		assert.equal(probes.getStartTimeMs(4242), null);
		await probes.prefetchStartTimes([4242]);
		assert.equal(probes.getStartTimeMs(4242), Date.parse("Wed Oct  8 10:00:00 2026"));
		assert.equal(calls.length, 1);
		assert.equal(calls[0]!.file, "ps");
		assert.deepEqual(calls[0]!.args, ["-p", "4242", "-o", "lstart="]);
		assert.equal(calls[0]!.env.LC_ALL, "C");
		assert.equal(calls[0]!.timeout, 2000);

		clock += 29_000;
		await probes.prefetchStartTimes([4242]);
		assert.equal(calls.length, 1);

		clock += 2_000;
		await probes.prefetchStartTimes([4242]);
		assert.equal(calls.length, 2);

		// concurrent prefetches for one pid share one call
		clock += 31_000;
		await Promise.all([probes.prefetchStartTimes([4242]), probes.prefetchStartTimes([4242])]);
		assert.equal(calls.length, 3);

		// an execFile error caches null
		clock += 31_000;
		fail = true;
		await probes.prefetchStartTimes([4242]);
		assert.equal(calls.length, 4);
		assert.equal(probes.getStartTimeMs(4242), null);
		await probes.prefetchStartTimes([4242]);
		assert.equal(calls.length, 4);
	});

	it("EPERM on signal 0 counts as alive", () => {
		const killed: number[] = [];
		const withCode = (code: string) =>
			createProcessProbes({
				kill: (pid) => {
					killed.push(pid);
					throw Object.assign(new Error(code), { code });
				},
			});
		assert.equal(withCode("EPERM").isPidAlive(4242), true);
		assert.equal(withCode("ESRCH").isPidAlive(4242), false);
		assert.equal(withCode("EPERM").isOwnerAlive(4100), true);
		killed.length = 0;
		const probes = withCode("EPERM");
		assert.equal(probes.isPidAlive(1), false);
		assert.equal(probes.isPidAlive(2.5), false);
		assert.deepEqual(killed, []);
	});

	it("corrupt JSON, a non-object, and an oversize file read as unreadable and the file is left untouched", () => {
		const dir = makeTempDir();
		const path = join(dir, "session-instances.json");
		const cases: Array<[Buffer | string, string]> = [
			["{not json", "parse failed"],
			["[1,2]", "not an object"],
			[Buffer.alloc(MAX_REGISTRY_BYTES + 1, 0x20), "over size cap"],
		];
		for (const [content, why] of cases) {
			writeFileSync(path, content);
			const before = { bytes: readFileSync(path), mtimeMs: statSync(path).mtimeMs };
			assert.deepEqual(readDriverRegistry(path), { kind: "unreadable", why });
			assert.deepEqual(readdirSync(dir), ["session-instances.json"]);
			assert.ok(readFileSync(path).equals(before.bytes));
			assert.equal(statSync(path).mtimeMs, before.mtimeMs);
		}
	});

	it("malformed rows and hostile exit or ownerPid fields are dropped individually", () => {
		const dir = makeTempDir();
		const path = join(dir, "session-instances.json");
		const good = { sessionId: "s", projectDir: "/work/good", pid: 4242, startTime: "2026-10-08T11:00:00.000Z", status: "running" };
		writeFileSync(
			path,
			JSON.stringify(
				{
					a: null,
					b: "x",
					c: { pid: "1" },
					d: { pid: 5, projectDir: "" },
					e: { ...good, exit: { reason: "r", code: "1", signal: null, at: "2026-10-08T11:00:00.000Z" } },
					f: { ...good, exit: { reason: "r", code: 1, signal: null } },
					g: { ...good, ownerPid: -3 },
					h: { ...good, ownerPid: 1.5 },
					i: good,
				},
				null,
				2,
			),
		);
		const read = readDriverRegistry(path);
		assert.equal(read.kind, "ok");
		if (read.kind !== "ok") return;
		assert.deepEqual(
			read.entries.map((entry) => entry.key),
			["g", "h", "i"],
		);
		assert.equal("ownerPid" in read.entries[0]!.row, false);
		assert.equal("ownerPid" in read.entries[1]!.row, false);
	});

	it("rows for one worktree under alias keys collapse to the row stop-by-dir would target", () => {
		const base = makeTempDir();
		const real = join(base, "real");
		mkdirSync(real);
		const link = join(base, "link");
		symlinkSync(real, link);
		const canonical = realpathSync.native(real);
		const mk = (pid: number, projectDir: string) => ({
			sessionId: `s${pid}`,
			projectDir,
			pid,
			startTime: "2026-10-08T11:00:00.000Z",
			status: "running",
		});
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const opts = { ctx: makeCtx(nowMs).ctx, projectRoot: canonical, dismissed: new Set<string>() };

		const both = classifyDrivers([{ key: link, row: mk(1111, link) }, { key: canonical, row: mk(2222, real) }], opts);
		assert.equal(both.length, 1);
		assert.equal(both[0]!.row.pid, 2222);
		assert.equal(both[0]!.canonicalDir, canonical);

		const aliasOnly = classifyDrivers([{ key: link, row: mk(1111, link) }], opts);
		assert.equal(aliasOnly.length, 1);
		assert.equal(aliasOnly[0]!.row.pid, 1111);
		assert.equal(aliasOnly[0]!.canonicalDir, canonical);
	});

	it("relatesToProject matches equal, descendant and ancestor dirs but not siblings or the filesystem root", () => {
		assert.equal(relatesToProject("/a/b", "/a/b"), true);
		assert.equal(relatesToProject("/a/b/wt/x", "/a/b"), true);
		assert.equal(relatesToProject("/a", "/a/b"), true);
		assert.equal(relatesToProject("/a/c", "/a/b"), false);
		assert.equal(relatesToProject("/a/bc", "/a/b"), false);
		assert.equal(relatesToProject("/", "/a/b"), false);
	});

	it("summarizeDrivers picks the worst related row, counts others needing attention, and hides dismissed or expired deaths", () => {
		const nowMs = Date.parse("2026-10-08T12:00:00.000Z");
		const driver = (
			name: string,
			related: boolean,
			liveness: ClassifiedDriver["liveness"],
			dismissed = false,
		): ClassifiedDriver => ({
			key: name,
			rowKey: `${name}|1|t`,
			canonicalDir: `/${name}`,
			row: { sessionId: "s", projectDir: `/${name}`, pid: 10, startTime: "t", status: "running" },
			liveness,
			supervisor: "none",
			related,
			dismissed,
		});
		const running = { kind: "running", sinceMs: 1 } as const;
		const stale = { kind: "stale", why: "supervisor-gone", sinceMs: 1 } as const;
		const died = (atMs: number | null, reconciled = true) =>
			({ kind: "died", reason: "r", code: null, signal: null, atMs, reconciled }) as const;

		const relatedMix = summarizeDrivers([driver("a", true, running), driver("b", true, stale)], nowMs);
		assert.equal(relatedMix.kind, "drivers");
		if (relatedMix.kind === "drivers") {
			assert.equal(relatedMix.worst?.key, "b");
			assert.equal(relatedMix.relatedCount, 2);
			assert.deepEqual(relatedMix.others, { count: 0, worst: null });
		}

		const others = summarizeDrivers(
			[driver("x", false, died(nowMs - 1000)), driver("y", false, stale), driver("z", false, running)],
			nowMs,
		);
		assert.equal(others.kind, "drivers");
		if (others.kind === "drivers") {
			assert.equal(others.worst, null);
			assert.equal(others.relatedCount, 0);
			assert.deepEqual(others.others, { count: 2, worst: "died" });
		}

		assert.deepEqual(summarizeDrivers([driver("old", true, died(nowMs - DIED_DISPLAY_TTL_MS - 3_600_000))], nowMs), {
			kind: "none",
		});
		const garbage = summarizeDrivers([driver("g", true, died(null))], nowMs);
		assert.equal(garbage.kind, "drivers");
		assert.deepEqual(summarizeDrivers([driver("d", true, died(nowMs - 1000), true)], nowMs), { kind: "none" });
		assert.deepEqual(summarizeDrivers([driver("u", false, running)], nowMs), { kind: "none" });
		assert.deepEqual(summarizeDrivers([], nowMs), { kind: "none" });
	});

	it("sanitizeDriverText strips C0, DEL and C1 controls and bounds length", () => {
		assert.equal(sanitizeDriverText("a\x07b\x9bc\x1b[31md\r\ne\tf\x7f"), "abc[31md e f");
		const long = sanitizeDriverText("x".repeat(300));
		assert.equal(long.length, 200);
		assert.ok(long.endsWith("\u2026"));
	});

	it("formatDriverAge renders s/m/h/d and omits unknown ages", () => {
		assert.equal(formatDriverAge(45_000), "45s");
		assert.equal(formatDriverAge(12 * 60_000), "12m");
		assert.equal(formatDriverAge(3 * 3_600_000), "3h");
		assert.equal(formatDriverAge(2 * 86_400_000), "2d");
		assert.equal(formatDriverAge(null), null);
		assert.equal(formatDriverAge(Number.NaN), null);
		assert.equal(formatDriverAge(-1), null);
	});
});
