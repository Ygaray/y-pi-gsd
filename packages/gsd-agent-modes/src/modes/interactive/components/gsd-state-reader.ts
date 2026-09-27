// Project/App: gsd-pi
// File Purpose: Read-only projection of `.planning/STATE.md` for the interactive TUI's milestone/phase
// footer row (SL-02). Ports the walk-up-from-cwd idiom of footer-data-provider.ts's `findGitPaths` and
// the never-throw degrade-to-null contract of `resolveGitBranchSync` — never the external reference
// implementation's scene-selection field names, which do not exist in this project's own STATE.md
// schema (see 28-04-PLAN.md's `d04_plan_time_resolution` for the locked field mapping).

import { closeSync, existsSync, openSync, readSync } from "node:fs";
import { dirname, join } from "node:path";

/** Read-only projection of `.planning/STATE.md`'s frontmatter (SL-02). */
export interface GsdPlanningState {
	milestone: string | null;
	milestoneName: string | null;
	/** Kept as a string — phase ids like "02.1" exist. */
	currentPhase: string | null;
	status: string | null;
	completedPhases: number | null;
	totalPhases: number | null;
	percent: number | null;
}

/** Ceiling on bytes read from a candidate STATE.md — never read a pathological file fully into memory (T-28-10). */
const MAX_READ_BYTES = 64 * 1024;
/** Ceiling on frontmatter lines scanned — bounds a pathologically long (but small-byte) fence-less file. */
const MAX_FRONTMATTER_LINES = 200;
/** Short TTL so `render()`, which runs on every keystroke, pays for at most one filesystem read every couple of seconds. */
const CACHE_TTL_MS = 2000;

/**
 * Walk up from `cwd` looking for `.planning/STATE.md`, mirroring `footer-data-provider.ts`'s
 * `findGitPaths` walk-up-to-`.git` idiom exactly (`existsSync` per candidate, stop when
 * `dirname(dir) === dir`). Returns `null` when the walk exhausts at the filesystem root without
 * finding one. Deliberately does not stop at a git worktree boundary — the same upward
 * reachability `findGitPaths` already has for `.git` (T-28-12, accepted).
 */
export function findPlanningStatePath(cwd: string): string | null {
	let dir = cwd;
	while (true) {
		const candidate = join(dir, ".planning", "STATE.md");
		if (existsSync(candidate)) return candidate;
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

function stripQuotes(value: string): string {
	if (value.length >= 2) {
		const first = value[0];
		const last = value[value.length - 1];
		if ((first === '"' && last === '"') || (first === "'" && last === "'")) {
			return value.slice(1, -1);
		}
	}
	return value;
}

function toNumberOrNull(value: string): number | null {
	if (value.length === 0) return null;
	const parsed = Number(value);
	return Number.isFinite(parsed) ? parsed : null;
}

/**
 * Minimal hand-rolled frontmatter reader for `.planning/STATE.md` — no YAML dependency exists in
 * this package, and a general parser is out of scope (D-04). Reads only scalar `key: value` pairs
 * at column 0, plus two-space-indented `key: value` pairs nested under a `progress:` line, bounded
 * by both a byte-length ceiling and a line-count ceiling (T-28-10) rather than scanning unboundedly.
 * `milestone`, `currentPhase`, and `status` are treated as the minimum viable signal — if any of the
 * three is unrecoverable (no delimiters, truncated frontmatter, wrong-indent/garbage content that
 * defeats the column-0 key match), the whole read is considered unusable and this returns `null`
 * rather than a partially-populated struct. Never throws (V5 never-throw contract) — this runs
 * inside a render loop.
 */
export function parseStateMd(raw: string): GsdPlanningState | null {
	try {
		if (typeof raw !== "string" || raw.length === 0) return null;
		if (raw.length > MAX_READ_BYTES) return null;

		const lines = raw.split("\n");
		if ((lines[0] ?? "").trim() !== "---") return null;

		let closingIndex = -1;
		const scanLimit = Math.min(lines.length, MAX_FRONTMATTER_LINES);
		for (let i = 1; i < scanLimit; i++) {
			if ((lines[i] ?? "").trim() === "---") {
				closingIndex = i;
				break;
			}
		}
		if (closingIndex === -1) return null;

		let milestone: string | null = null;
		let milestoneName: string | null = null;
		let currentPhase: string | null = null;
		let status: string | null = null;
		let completedPhases: number | null = null;
		let totalPhases: number | null = null;
		let percent: number | null = null;
		let inProgressBlock = false;

		for (let i = 1; i < closingIndex; i++) {
			const line = lines[i] ?? "";
			if (line.trim().length === 0) continue;

			const topLevel = /^([A-Za-z0-9_]+):[ \t]*(.*)$/.exec(line);
			if (topLevel) {
				const key = topLevel[1] ?? "";
				const value = stripQuotes((topLevel[2] ?? "").trim());
				inProgressBlock = key === "progress";
				switch (key) {
					case "milestone":
						milestone = value || null;
						break;
					case "milestone_name":
						milestoneName = value || null;
						break;
					case "current_phase":
						currentPhase = value || null;
						break;
					case "status":
						status = value || null;
						break;
					default:
						break;
				}
				continue;
			}

			if (inProgressBlock) {
				const nested = /^ {2}([A-Za-z0-9_]+):[ \t]*(.*)$/.exec(line);
				if (!nested) continue;
				const key = nested[1] ?? "";
				const value = stripQuotes((nested[2] ?? "").trim());
				switch (key) {
					case "completed_phases":
						completedPhases = toNumberOrNull(value);
						break;
					case "total_phases":
						totalPhases = toNumberOrNull(value);
						break;
					case "percent":
						percent = toNumberOrNull(value);
						break;
					default:
						break;
				}
			}
		}

		if (milestone === null || currentPhase === null || status === null) return null;

		return { milestone, milestoneName, currentPhase, status, completedPhases, totalPhases, percent };
	} catch {
		return null;
	}
}

/**
 * Map a parsed state to the locked lifecycle scene phrase (28-04-PLAN.md `d04_plan_time_resolution`
 * table). Complete takes precedence over in-flight. Returns `null` when neither branch applies —
 * row 3 is then omitted entirely by the caller, never a blank row.
 */
export function formatGsdStateScene(state: GsdPlanningState): string | null {
	const isComplete =
		state.percent === 100 ||
		(state.totalPhases !== null && state.totalPhases > 0 && state.completedPhases === state.totalPhases);
	if (isComplete) return "milestone complete";
	if (state.currentPhase !== null && state.status !== null) {
		return `Phase ${state.currentPhase} ${state.status}`;
	}
	return null;
}

type CacheEntry = { state: GsdPlanningState | null; cachedAtMs: number };
/**
 * Keyed by `cwd` (not the resolved STATE.md path) — `render()` calls this repeatedly with the same
 * session cwd, so keying on the input avoids re-walking the tree on every cache hit, including the
 * negative (no `.planning` anywhere up to the filesystem root) case.
 */
const stateCache = new Map<string, CacheEntry>();
/**
 * Caps `stateCache`'s growth (IN-02) — in the normal interactive session this map holds one or a
 * handful of keys, but a caller that passes many distinct `cwd` values over a long-running process
 * (tests, or a host reusing this module across many workspaces) would otherwise grow it forever,
 * including one permanent entry per negative/`null` result. Eviction below is FIFO by insertion
 * order (a `Map` preserves it, and each write re-inserts its key at the end) rather than a full LRU
 * — sufficient to bound memory without adding an access-order tracking structure.
 */
const MAX_CACHE_ENTRIES = 50;

/**
 * Bounded read of at most `MAX_READ_BYTES` from `path` — never reads a pathological file fully into
 * memory (T-28-10). Returns `null` on any I/O error.
 */
function readBounded(path: string): string | null {
	let fd: number | undefined;
	try {
		fd = openSync(path, "r");
		const buffer = Buffer.alloc(MAX_READ_BYTES);
		const bytesRead = readSync(fd, buffer, 0, MAX_READ_BYTES, 0);
		return buffer.toString("utf8", 0, bytesRead);
	} catch {
		return null;
	} finally {
		if (fd !== undefined) {
			try {
				closeSync(fd);
			} catch {
				// already closed / unreadable — nothing more to do
			}
		}
	}
}

/**
 * Compose find + bounded-read + parse for `cwd`, wrapped in a try/catch degrading to `null` (the
 * `resolveGitBranchSync` never-throw contract), and memoised — including the negative result — for
 * `CACHE_TTL_MS` keyed by `cwd`. Accepts an injectable `nowMs` so the TTL is testable without
 * wall-clock games.
 */
export function readPlanningState(cwd: string, nowMs: number = Date.now()): GsdPlanningState | null {
	try {
		const cached = stateCache.get(cwd);
		if (cached && nowMs - cached.cachedAtMs < CACHE_TTL_MS) {
			return cached.state;
		}

		const path = findPlanningStatePath(cwd);
		const state = path === null ? null : parseStateMd(readBounded(path) ?? "");
		// Delete before re-set so an existing key moves to the end of the Map's insertion order —
		// the eviction below then always drops the least-recently-written entry (IN-02).
		stateCache.delete(cwd);
		stateCache.set(cwd, { state, cachedAtMs: nowMs });
		if (stateCache.size > MAX_CACHE_ENTRIES) {
			const oldestKey = stateCache.keys().next().value;
			if (oldestKey !== undefined) stateCache.delete(oldestKey);
		}
		return state;
	} catch {
		return null;
	}
}
