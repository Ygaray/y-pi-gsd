// Project/App: gsd-pi
// File Purpose: READ-ONLY projection of the y-pi-gsd driver registry (`$GSD_HOME/session-instances.json`,
// written by mcp-server) for the interactive TUI. This module never writes, renames, quarantines or
// signals anything: a corrupt registry reads as "unreadable", never a `.corrupt-*` rename (RD-RESEARCH-OPEN 3).

import { closeSync, openSync, readSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SessionRegistryEntry } from "@opengsd/contracts";

export const DRIVER_REGISTRY_FILENAME = "session-instances.json";
/** Ceiling on registry bytes read. A larger file is "unreadable", never silently treated as empty. */
export const MAX_REGISTRY_BYTES = 256 * 1024;

/**
 * `$GSD_HOME` (or `~/.gsd`) + `session-instances.json` - the same rule as mcp-server's session-persist.ts,
 * but evaluated per call so a changed environment is honoured.
 */
export function driverRegistryPath(env: NodeJS.ProcessEnv = process.env): string {
	return join(env.GSD_HOME || join(homedir(), ".gsd"), DRIVER_REGISTRY_FILENAME);
}

export interface RegistryRowEntry {
	key: string;
	row: SessionRegistryEntry;
}

export type DriverRegistryRead = { kind: "ok"; entries: RegistryRowEntry[] } | { kind: "unreadable"; why: string };

function isPlainObject(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Validate one raw registry row. Accepts only an object with an integer `pid`, a non-empty string
 * `projectDir` and a string `startTime`. `ownerPid` is kept only when it is a safe integer > 1. A
 * present-but-malformed `exit` invalidates the whole row - a death record must never be silently
 * downgraded into a live claim. Unknown keys are ignored.
 */
export function validateRegistryRow(raw: unknown): SessionRegistryEntry | null {
	if (!isPlainObject(raw)) return null;
	const { pid, projectDir, startTime } = raw;
	if (typeof pid !== "number" || !Number.isInteger(pid)) return null;
	if (typeof projectDir !== "string" || projectDir.length === 0) return null;
	if (typeof startTime !== "string") return null;

	const row: SessionRegistryEntry = {
		sessionId: typeof raw.sessionId === "string" ? raw.sessionId : "",
		projectDir,
		pid,
		startTime,
		status: typeof raw.status === "string" ? raw.status : "",
	};

	const ownerPid = raw.ownerPid;
	if (typeof ownerPid === "number" && Number.isSafeInteger(ownerPid) && ownerPid > 1) {
		row.ownerPid = ownerPid;
	}

	if (raw.exit !== undefined) {
		const exit = raw.exit;
		if (!isPlainObject(exit)) return null;
		if (typeof exit.reason !== "string") return null;
		if (!(exit.code === null || (typeof exit.code === "number" && Number.isFinite(exit.code)))) return null;
		if (!(exit.signal === null || typeof exit.signal === "string")) return null;
		if (typeof exit.at !== "string") return null;
		row.exit = { reason: exit.reason, code: exit.code, signal: exit.signal, at: exit.at };
	}

	return row;
}

function readExactly(path: string, size: number): string {
	const fd = openSync(path, "r");
	try {
		const buffer = Buffer.alloc(size);
		let offset = 0;
		while (offset < size) {
			const n = readSync(fd, buffer, offset, size - offset, offset);
			if (n === 0) break;
			offset += n;
		}
		return buffer.toString("utf8", 0, offset);
	} finally {
		try {
			closeSync(fd);
		} catch {
			// already closed - nothing more to do
		}
	}
}

/**
 * Read the registry: size-gated, bounded, never throws, never writes. A missing file is
 * `{ kind: "ok", entries: [] }` (no drivers is not an error); everything else that cannot be
 * trusted is `{ kind: "unreadable" }` with a short `why`. Invalid rows are dropped individually.
 */
export function readDriverRegistry(path: string = driverRegistryPath()): DriverRegistryRead {
	let size: number;
	try {
		size = statSync(path).size;
	} catch (error) {
		if ((error as NodeJS.ErrnoException | null)?.code === "ENOENT") return { kind: "ok", entries: [] };
		return { kind: "unreadable", why: "read failed" };
	}
	if (size > MAX_REGISTRY_BYTES) return { kind: "unreadable", why: "over size cap" };

	let text: string;
	try {
		text = readExactly(path, size);
	} catch {
		return { kind: "unreadable", why: "read failed" };
	}

	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return { kind: "unreadable", why: "parse failed" };
	}
	if (!isPlainObject(parsed)) return { kind: "unreadable", why: "not an object" };

	const entries: RegistryRowEntry[] = [];
	for (const [key, raw] of Object.entries(parsed)) {
		const row = validateRegistryRow(raw);
		if (row !== null) entries.push({ key, row });
	}
	return { kind: "ok", entries };
}

/** Fixed honest phrase for a live claim whose process is gone and whose exit was never observed (UI-SPEC U5). */
export function unreconciledDeathReason(pid: number): string {
	return `driver pid ${pid} is no longer running; exit status unobserved`;
}

export type DriverLiveness =
	| { kind: "running"; sinceMs: number | null }
	| { kind: "stale"; why: "supervisor-gone" | "starting-timeout"; sinceMs: number | null }
	| {
			kind: "died";
			reason: string;
			code: number | null;
			signal: string | null;
			atMs: number | null;
			reconciled: boolean;
	  };

export interface ClassifyContext {
	nowMs: number;
	isPidAlive(pid: number): boolean;
	getStartTimeMs(pid: number): number | null;
	isOwnerAlive(ownerPid: number): boolean;
}

function isProbablePid(pid: number): boolean {
	return Number.isSafeInteger(pid) && pid > 1;
}

function diedUnreconciled(pid: number): DriverLiveness {
	return {
		kind: "died",
		reason: unreconciledDeathReason(pid),
		code: null,
		signal: null,
		atMs: null,
		reconciled: false,
	};
}

/**
 * Classify one registry row. A tombstone (`exit` present) is died with its persisted reason and its pid
 * is never probed. A live claim whose pid is dead is died-unreconciled. Task 2 adds the recycle and
 * stale branches.
 */
export function classifyDriverRow(row: SessionRegistryEntry, ctx: ClassifyContext): DriverLiveness {
	if (row.exit !== undefined) {
		const at = Date.parse(row.exit.at);
		return {
			kind: "died",
			reason: row.exit.reason,
			code: row.exit.code,
			signal: row.exit.signal,
			atMs: Number.isFinite(at) ? at : null,
			reconciled: true,
		};
	}

	if (!isProbablePid(row.pid) || !ctx.isPidAlive(row.pid)) return diedUnreconciled(row.pid);

	const recordedMs = Date.parse(row.startTime);
	const sinceMs = Number.isFinite(recordedMs) && ctx.nowMs - recordedMs >= 0 ? ctx.nowMs - recordedMs : null;
	return { kind: "running", sinceMs };
}
