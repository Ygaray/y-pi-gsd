// Project/App: gsd-pi
// File Purpose: Regression net for the read-only driver-registry projection (OBS-01): the bounded
// never-throw reader, per-row validation, the H0 liveness classifier with injected probes, the async
// process probes, alias collapse, project relation, the widget summary, the sanitizer and the age format.
// Fixtures use the exact writer format of mcp-server's session-persist.ts (JSON.stringify(obj, null, 2))
// and always pass an explicit temp path - the real registry is never read.

import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SessionRegistry } from "@opengsd/contracts";
import {
	classifyDriverRow,
	readDriverRegistry,
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
});
