// Project/App: gsd-pi
// File Purpose: READ-ONLY projection of the y-pi-gsd driver registry (`$GSD_HOME/session-instances.json`,
// written by mcp-server) for the interactive TUI. This module never writes, renames, quarantines or
// signals anything: a corrupt registry reads as "unreadable" and is never quarantined under a `.corrupt-*` name
// (RD-RESEARCH-OPEN 3).

import { execFile as nodeExecFile } from "node:child_process";
import { closeSync, openSync, readSync, realpathSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { promisify } from "node:util";
import type { SessionRegistryEntry } from "@opengsd/contracts";
import { findPlanningStatePath } from "./gsd-state-reader.js";
import { sanitizeFooterText } from "./gsd-statusline-format.js";

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

/** A pid whose OS start time is later than the recorded start by more than this has been recycled (mirrors mcp-server). */
export const PID_START_SKEW_MS = 60_000;
/** Mirrors mcp-server's INIT_TIMEOUT_MS (not imported - agent-modes must not depend on the MCP server package). */
export const DRIVER_INIT_TIMEOUT_MS = 30_000;
/** Extra tolerance on top of the init timeout before a `starting` row is called stale. */
export const DRIVER_STARTING_GRACE_MS = 15_000;

/**
 * Classify one registry row (pure; all process facts come from `ctx`).
 *
 * H0 only (RD-RESEARCH-OPEN 1): "stale" means the supervising MCP server (`ownerPid`) is gone, or the row is
 * stuck in `starting` past the init timeout plus grace. A row without `ownerPid` is never stale. Wedged-but-alive
 * driver detection is out of scope - "running" means the process is alive and supervised, not making progress.
 * The row's `status` field is never trusted for liveness. A tombstone (`exit` present) is died with its persisted
 * reason and its pid is never probed.
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
	const startMs = ctx.getStartTimeMs(row.pid);
	if (Number.isFinite(recordedMs) && startMs !== null && startMs > recordedMs + PID_START_SKEW_MS) {
		return diedUnreconciled(row.pid);
	}

	const sinceMs = Number.isFinite(recordedMs) && ctx.nowMs - recordedMs >= 0 ? ctx.nowMs - recordedMs : null;

	if (row.ownerPid !== undefined && isProbablePid(row.ownerPid) && !ctx.isOwnerAlive(row.ownerPid)) {
		return { kind: "stale", why: "supervisor-gone", sinceMs };
	}

	if (
		row.status === "starting" &&
		Number.isFinite(recordedMs) &&
		ctx.nowMs - recordedMs > DRIVER_INIT_TIMEOUT_MS + DRIVER_STARTING_GRACE_MS
	) {
		return { kind: "stale", why: "starting-timeout", sinceMs: ctx.nowMs - recordedMs };
	}

	return { kind: "running", sinceMs };
}

/** A cached OS start time is re-validated after this long. */
export const START_TIME_REVALIDATE_MS = 30_000;
/** Hard ceiling on one `ps` probe. */
export const START_TIME_PROBE_TIMEOUT_MS = 2_000;

export interface DriverProcessProbes {
	isPidAlive(pid: number): boolean;
	isOwnerAlive(ownerPid: number): boolean;
	getStartTimeMs(pid: number): number | null;
	prefetchStartTimes(pids: readonly number[]): Promise<void>;
}

export interface ProcessProbeOptions {
	kill?: (pid: number, signal: 0) => void;
	execFile?: (
		file: string,
		args: readonly string[],
		opts: { env: NodeJS.ProcessEnv; timeout: number },
	) => Promise<{ stdout: string }>;
	now?: () => number;
}

const execFileAsync = promisify(nodeExecFile);

function defaultExecFile(
	file: string,
	args: readonly string[],
	opts: { env: NodeJS.ProcessEnv; timeout: number },
): Promise<{ stdout: string }> {
	return execFileAsync(file, [...args], { env: opts.env, timeout: opts.timeout, encoding: "utf8" });
}

/**
 * Real process probes for the TUI timer. Liveness is signal 0 only (EPERM counts as alive). The OS start time
 * comes from an async, timeout-bounded `ps` probe whose result is cached per pid and re-validated after
 * START_TIME_REVALIDATE_MS; `getStartTimeMs` only ever reads that cache, so classification never blocks the
 * event loop. An unavailable start time (null) fails open to signal-0 liveness.
 */
export function createProcessProbes(options: ProcessProbeOptions = {}): DriverProcessProbes {
	const kill = options.kill ?? ((pid: number) => process.kill(pid, 0));
	const exec = options.execFile ?? defaultExecFile;
	const now = options.now ?? Date.now;
	const cache = new Map<number, { ms: number | null; fetchedAt: number }>();
	const inFlight = new Map<number, Promise<void>>();

	function signalZero(pid: number): boolean {
		if (!isProbablePid(pid)) return false;
		try {
			kill(pid, 0);
			return true;
		} catch (error) {
			return (error as NodeJS.ErrnoException | null)?.code !== "ESRCH";
		}
	}

	function fresh(pid: number): { ms: number | null; fetchedAt: number } | undefined {
		const entry = cache.get(pid);
		if (entry && now() - entry.fetchedAt < START_TIME_REVALIDATE_MS) return entry;
		return undefined;
	}

	async function fetchStartTime(pid: number): Promise<void> {
		let ms: number | null = null;
		try {
			const { stdout } = await exec("ps", ["-p", String(pid), "-o", "lstart="], {
				env: { ...process.env, LC_ALL: "C" },
				timeout: START_TIME_PROBE_TIMEOUT_MS,
			});
			const parsed = Date.parse(stdout.trim());
			ms = Number.isFinite(parsed) ? parsed : null;
		} catch {
			ms = null;
		}
		cache.set(pid, { ms, fetchedAt: now() });
	}

	return {
		isPidAlive: signalZero,
		isOwnerAlive: signalZero,
		getStartTimeMs(pid) {
			return fresh(pid)?.ms ?? null;
		},
		async prefetchStartTimes(pids) {
			const pending: Promise<void>[] = [];
			for (const pid of pids) {
				if (!isProbablePid(pid) || fresh(pid)) continue;
				let promise = inFlight.get(pid);
				if (!promise) {
					promise = fetchStartTime(pid).finally(() => inFlight.delete(pid));
					inFlight.set(pid, promise);
				}
				pending.push(promise);
			}
			await Promise.all(pending);
		},
	};
}

/** Canonical form of a worktree path, matching mcp-server: `realpathSync.native(resolve(dir))`, `resolve` on any error. */
export function canonicalDriverDir(dir: string): string {
	const resolved = resolve(dir);
	try {
		return realpathSync.native(resolved);
	} catch {
		return resolved;
	}
}

/** Project root for the TUI's cwd: the directory holding the nearest `.planning/STATE.md`, else the cwd itself. */
export function findDriverProjectRoot(cwd: string): string {
	const statePath = findPlanningStatePath(cwd);
	return canonicalDriverDir(statePath === null ? cwd : dirname(dirname(statePath)));
}

function isStrictDescendant(child: string, parent: string): boolean {
	const rel = relative(parent, child);
	return rel.length > 0 && !isAbsolute(rel) && rel.split(sep)[0] !== "..";
}

/**
 * A row relates to the TUI project when its canonical dir equals the project root, is a strict descendant of it
 * (a worktree under the project), or is a strict ancestor of it - except that the filesystem root never counts as
 * an ancestor (a row for `/` would otherwise relate to every project).
 */
export function relatesToProject(dir: string, projectRoot: string): boolean {
	if (dir === projectRoot) return true;
	if (isStrictDescendant(dir, projectRoot)) return true;
	return dirname(dir) !== dir && isStrictDescendant(projectRoot, dir);
}

/** Identity of one death for in-memory dismissal: the same worktree, pid and recorded start. */
export function driverRowKey(canonicalDir: string, row: SessionRegistryEntry): string {
	return `${canonicalDir}|${row.pid}|${row.startTime}`;
}

export type DriverSupervisor = "alive" | "gone" | "none";

export interface ClassifiedDriver {
	/** The registry key of the row that was classified. */
	key: string;
	rowKey: string;
	canonicalDir: string;
	row: SessionRegistryEntry;
	liveness: DriverLiveness;
	supervisor: DriverSupervisor;
	related: boolean;
	dismissed: boolean;
}

/**
 * Collapse rows stored under several keys for one worktree (legacy `resolve()` key, symlink alias key) into one
 * classified driver, preferring the row whose key equals the canonical dir, else the first in file order - the same
 * row mcp-server's getSessionEntry would act on.
 */
export function classifyDrivers(
	entries: readonly RegistryRowEntry[],
	opts: { ctx: ClassifyContext; projectRoot: string; dismissed: ReadonlySet<string> },
): ClassifiedDriver[] {
	const groups = new Map<string, RegistryRowEntry>();
	for (const entry of entries) {
		const canonical = canonicalDriverDir(entry.row.projectDir);
		const existing = groups.get(canonical);
		if (existing === undefined || (existing.key !== canonical && entry.key === canonical)) {
			groups.set(canonical, entry);
		}
	}

	const drivers: ClassifiedDriver[] = [];
	for (const [canonicalDir, entry] of groups) {
		const { row } = entry;
		const liveness = classifyDriverRow(row, opts.ctx);
		let supervisor: DriverSupervisor = "none";
		if (row.exit === undefined && row.ownerPid !== undefined) {
			supervisor = opts.ctx.isOwnerAlive(row.ownerPid) ? "alive" : "gone";
		}
		const rowKey = driverRowKey(canonicalDir, row);
		drivers.push({
			key: entry.key,
			rowKey,
			canonicalDir,
			row,
			liveness,
			supervisor,
			related: relatesToProject(canonicalDir, opts.projectRoot),
			dismissed: opts.dismissed.has(rowKey),
		});
	}
	return drivers;
}

/** A reconciled death stays on screen for this long after `exit.at`. */
export const DIED_DISPLAY_TTL_MS = 24 * 60 * 60 * 1000;

/**
 * Visibility of one classified driver. Running and stale rows are always visible. A died row is hidden once
 * dismissed, or once a reconciled tombstone is older than the display TTL; a tombstone with an unparsable
 * `exit.at` and an unreconciled dead row stay visible until dismissed.
 */
export function isDriverVisible(d: ClassifiedDriver, nowMs: number): boolean {
	if (d.liveness.kind !== "died") return true;
	if (d.dismissed) return false;
	if (d.liveness.reconciled && d.liveness.atMs !== null && nowMs - d.liveness.atMs >= DIED_DISPLAY_TTL_MS) return false;
	return true;
}

export type DriverSummary =
	| { kind: "none" }
	| {
			kind: "drivers";
			worst: ClassifiedDriver | null;
			relatedCount: number;
			others: { count: number; worst: "died" | "stale" | null };
	  };

const SEVERITY: Record<DriverLiveness["kind"], number> = { running: 0, stale: 1, died: 2 };

function diedAtMs(d: ClassifiedDriver): number {
	return d.liveness.kind === "died" && d.liveness.atMs !== null ? d.liveness.atMs : Number.NEGATIVE_INFINITY;
}

/**
 * Summarise visible drivers for the one-row widget: the worst related row (died > stale > running) with the
 * related count, plus unrelated died/stale rows counted in `others`. Unrelated running rows never count.
 */
export function summarizeDrivers(drivers: readonly ClassifiedDriver[], nowMs: number): DriverSummary {
	const visible = drivers.filter((d) => isDriverVisible(d, nowMs));
	const related = visible.filter((d) => d.related);
	const attention = visible.filter((d) => !d.related && d.liveness.kind !== "running");

	let worst: ClassifiedDriver | null = null;
	for (const d of related) {
		if (worst === null) {
			worst = d;
			continue;
		}
		const delta = SEVERITY[d.liveness.kind] - SEVERITY[worst.liveness.kind];
		if (delta > 0 || (delta === 0 && d.liveness.kind === "died" && diedAtMs(d) > diedAtMs(worst))) worst = d;
	}

	if (related.length === 0 && attention.length === 0) return { kind: "none" };

	const othersWorst: "died" | "stale" | null = attention.some((d) => d.liveness.kind === "died")
		? "died"
		: attention.length > 0
			? "stale"
			: null;
	return {
		kind: "drivers",
		worst,
		relatedCount: related.length,
		others: { count: attention.length, worst: othersWorst },
	};
}

export const MAX_DRIVER_TEXT_CHARS = 200;

/**
 * Sanitise untrusted registry text before it reaches the terminal (T-42-01): CR/LF/TAB become spaces, every C0,
 * DEL and C1 control character is removed (stricter than sanitizeFooterText, which keeps BEL and C1), spaces are
 * collapsed, and the result is bounded to `max` characters with a trailing ellipsis when cut.
 */
export function sanitizeDriverText(text: string, max: number = MAX_DRIVER_TEXT_CHARS): string {
	const cleaned = sanitizeFooterText(String(text).replace(/[\r\n\t]/g, " ").replace(/[\x00-\x1f\x7f-\x9f]/g, ""));
	return cleaned.length > max ? `${cleaned.slice(0, Math.max(0, max - 1))}\u2026` : cleaned;
}

/** Compact age: `45s`, `12m`, `3h`, `2d`; null for an unknown or negative age (never `NaNm`). */
export function formatDriverAge(ms: number | null): string | null {
	if (ms === null || !Number.isFinite(ms) || ms < 0) return null;
	const seconds = Math.floor(ms / 1000);
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m`;
	const hours = Math.floor(minutes / 60);
	if (hours < 24) return `${hours}h`;
	return `${Math.floor(hours / 24)}d`;
}
