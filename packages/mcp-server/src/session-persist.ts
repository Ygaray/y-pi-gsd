/**
 * Durable headless-session registry (INC-2026-09-29-02 fix 3 Option B).
 *
 * SessionManager's in-memory `sessions` Map (keyed by projectDir) is wiped
 * whenever the MCP server process restarts. The headless GSD child spawned
 * by the *prior* server instance can still be alive — it just becomes
 * invisible to the new server's in-memory map, so `startSession()`'s
 * "already active" guard can no longer see it. A fresh `gsd_execute` then
 * launches a SECOND driver on the same worktree, producing two concurrent
 * drivers mutating the same `.gsd` state / git worktree.
 *
 * This module persists a small per-projectDir record (sessionId, child pid,
 * start time) under `GSD_HOME` so a new server instance can detect that
 * orphan before starting a duplicate, and reap it. It deliberately MIRRORS
 * pid-registry.ts's shape and technique (JSON registry under `~/.gsd`,
 * tolerant reads that quarantine corrupt files instead of dropping them,
 * pid-liveness gated by a start-time guard against PID reuse) rather than
 * inventing a new persistence mechanism. Unlike pid-registry.ts's MCP-server
 * registry (which re-verifies a candidate pid by inspecting its command
 * line, since any process on the box could coincidentally reuse that pid),
 * this registry only ever kills a pid *we* wrote the entry for — the
 * start-time guard is the sole defense against a since-recycled pid.
 */

import { mkdirSync, readFileSync, realpathSync, renameSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  defaultGetProcessStartTime,
  defaultWaitForExit,
  isPidAlive,
  isSafePid,
} from './pid-registry.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * The death record of a driver, consumed by Phase 42's died-with-reason
 * widget. `reason` is a short human-readable string built ONLY from the exit
 * code/signal or a fixed reconcile phrase - never stderr, prompt text, or
 * agent output.
 */
export interface SessionExitRecord {
  reason: string;
  code: number | null;
  signal: string | null;
  /** ISO timestamp of when the exit was observed. */
  at: string;
}

export interface SessionRegistryEntry {
  sessionId: string;
  projectDir: string;
  pid: number;
  /** ISO timestamp recorded when we learned the child's pid. */
  startTime: string;
  /**
   * Values used from Phase 41 on: 'starting' (registered right after
   * start() resolves, before init), 'running', 'exited' (death tombstone).
   */
  status: string;
  /**
   * `process.pid` of the MCP server that spawned the driver. Advisory only -
   * never authorises a signal. Optional so pre-Phase-41 rows stay valid.
   */
  ownerPid?: number;
  /** Present only on a death tombstone (written by later Phase 41 plans). */
  exit?: SessionExitRecord;
}

export type SessionRegistry = Record<string, SessionRegistryEntry>;

export interface SessionLivenessOptions {
  kill?: (pid: number, signal?: NodeJS.Signals | 0) => void;
  getProcessStartTime?: (pid: number) => number | null;
  waitForExit?: () => void;
}

export type KillOrphanSessionResult =
  | 'killed'
  | 'force-killed'
  | 'already-dead'
  | 'invalid'
  | { error: string };

// ---------------------------------------------------------------------------
// Registry location + skew tolerance
// ---------------------------------------------------------------------------

const REGISTRY_PATH = join(
  process.env.GSD_HOME || join(homedir(), '.gsd'),
  'session-instances.json',
);

// Mirrors pid-registry.ts's STALE_PID_START_SKEW_MS: a live pid is only
// treated as "our" orphan if its OS start time is no later than the moment
// we recorded the registry entry (plus skew for clock granularity / the gap
// between the child actually starting and us learning its pid). A pid that
// started materially later has been recycled by an unrelated process.
const STALE_PID_START_SKEW_MS = 60_000;

/**
 * Canonical form of a worktree path: `realpathSync.native(resolve(dir))`,
 * falling back to `resolve(dir)` when the path does not exist (or cannot be
 * resolved). Same shape as the orphan reconcile module's
 * `normalizeOrphanProjectRoot`, duplicated deliberately so this module stays
 * a leaf (that module loads workflow-tools at runtime). Canonical so a symlink alias and its target
 * share ONE registry key, one in-memory session and one start lock (SC3).
 */
export function canonicalProjectDir(projectDir: string): string {
  const resolved = resolve(projectDir);
  try {
    return realpathSync.native(resolved);
  } catch {
    return resolved;
  }
}

function keyFor(projectDir: string): string {
  return canonicalProjectDir(projectDir);
}

/** Pre-Phase-41 rows were keyed by plain `resolve()`; still read/migrated/removed. */
function legacyKeyFor(projectDir: string): string {
  return resolve(projectDir);
}

// ---------------------------------------------------------------------------
// Read / write (tolerant reads, atomic writes)
// ---------------------------------------------------------------------------

export function readSessionRegistry(registryPath = REGISTRY_PATH): SessionRegistry {
  let raw: string;
  try {
    raw = readFileSync(registryPath, 'utf8');
  } catch (err) {
    // Missing file is the normal first-run/no-orphans case.
    if ((err as NodeJS.ErrnoException).code !== 'ENOENT') {
      process.stderr.write(
        `[gsd-mcp-server] failed to read session registry ${registryPath}: ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }
    return {};
  }

  try {
    const parsed = JSON.parse(raw) as unknown;
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return sanitizeRegistryRows(parsed as Record<string, unknown>, registryPath);
    }
    throw new Error('registry is not a JSON object');
  } catch (err) {
    // Corrupt file — preserve it for forensics rather than silently dropping
    // every other project's entry (mirrors readMcpRegistry's policy).
    const backup = `${registryPath}.corrupt-${Date.now()}`;
    try {
      renameSync(registryPath, backup);
      process.stderr.write(
        `[gsd-mcp-server] session registry ${registryPath} was corrupt (${err instanceof Error ? err.message : String(err)}); preserved as ${backup}\n`,
      );
    } catch {
      process.stderr.write(
        `[gsd-mcp-server] session registry ${registryPath} was corrupt (${err instanceof Error ? err.message : String(err)}) and could not be preserved\n`,
      );
    }
    return {};
  }
}

/**
 * A well-formed row is an object with an integer `pid` and string
 * `projectDir` / `startTime`. Everything downstream (`row.pid`, `row.sessionId`,
 * `resolve(row.projectDir)`, `Date.parse(row.startTime)`) assumes this shape.
 */
function isWellFormedRow(row: unknown): row is SessionRegistryEntry {
  if (!row || typeof row !== 'object' || Array.isArray(row)) return false;
  const r = row as Record<string, unknown>;
  return (
    Number.isInteger(r.pid) &&
    typeof r.projectDir === 'string' &&
    r.projectDir !== '' &&
    typeof r.startTime === 'string'
  );
}

/**
 * WR-04 (41-REVIEW.md): the registry file is untrusted input. A valid-JSON
 * file whose rows are `null` / strings / shape-less objects must not crash
 * registration, session-id lookup or reconcile. Malformed rows are dropped
 * from the in-memory view (and logged); the next registry write persists the
 * cleaned view, so the file self-heals instead of blocking every start.
 */
function sanitizeRegistryRows(parsed: Record<string, unknown>, registryPath: string): SessionRegistry {
  const clean: SessionRegistry = {};
  const dropped: string[] = [];
  for (const [key, row] of Object.entries(parsed)) {
    if (isWellFormedRow(row)) {
      clean[key] = row;
    } else {
      dropped.push(key);
    }
  }
  if (dropped.length > 0) {
    process.stderr.write(
      `[gsd-mcp-server] session registry ${registryPath}: ignoring ${dropped.length} malformed row(s): ${dropped.join(', ')}\n`,
    );
  }
  return clean;
}

function writeSessionRegistry(registry: SessionRegistry, registryPath = REGISTRY_PATH): void {
  mkdirSync(dirname(registryPath), { recursive: true });
  // Atomic write: write to a temp file in the same directory, then rename
  // over the target. A crash mid-write can never leave a half-written
  // registry file for readSessionRegistry to trip over.
  const tempPath = `${registryPath}.tmp-${process.pid}-${Date.now()}`;
  writeFileSync(tempPath, JSON.stringify(registry, null, 2), 'utf8');
  renameSync(tempPath, registryPath);
}

// ---------------------------------------------------------------------------
// CRUD
// ---------------------------------------------------------------------------

/**
 * True when the row records a driver death (carries an `exit` record). A
 * tombstone never claims a live driver; its pid must never be probed or
 * signalled by any code path (the pid may have been recycled).
 */
export function isTombstoneEntry(entry: Pick<SessionRegistryEntry, 'exit'> | undefined): boolean {
  return entry?.exit !== undefined;
}

/**
 * Persist (or overwrite) the session entry for a projectDir.
 *
 * SC3 pid uniqueness (Phase 41): when the entry being written is a live claim
 * (no `exit` record), every OTHER key holding a live-claim row for the same
 * pid is dropped first - two keys can never claim one live driver. Exit
 * tombstones are exempt on both sides: a tombstone is a death record, not a
 * claim, so it is neither dropped by this rule nor does it trigger it.
 *
 * Cross-process note (research Q4, accepted deliberately): this
 * read-modify-write is atomic per write (temp file + rename) but NOT locked
 * across MCP-server processes sharing ~/.gsd/session-instances.json. Two
 * processes writing at the same instant can lose one update (the lost-update
 * window). The window is a microsecond synchronous stretch and no lock
 * dependency is added; revisit only if a real incident appears.
 */
export function registerSessionEntry(
  entry: SessionRegistryEntry,
  registryPath = REGISTRY_PATH,
): void {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(entry.projectDir);
  const legacyKey = legacyKeyFor(entry.projectDir);

  if (!isTombstoneEntry(entry)) {
    const dropped: string[] = [];
    for (const [otherKey, row] of Object.entries(registry)) {
      if (otherKey === key || otherKey === legacyKey) continue;
      if (isTombstoneEntry(row)) continue;
      if (row.pid === entry.pid) {
        delete registry[otherKey];
        dropped.push(otherKey);
      }
    }
    if (dropped.length > 0) {
      process.stderr.write(
        `[gsd-mcp-server] session registry: dropped stale row(s) ${dropped.join(', ')} claiming pid=${entry.pid} now registered for ${key}\n`,
      );
    }
  }

  registry[key] = { ...entry, projectDir: key };
  // Migration on write: a pre-Phase-41 resolve()-keyed row for the same
  // worktree is superseded by the canonical row.
  if (legacyKey !== key) delete registry[legacyKey];
  writeSessionRegistry(registry, registryPath);
}

/**
 * Look up the persisted entry for a projectDir, if any. Reads the canonical
 * key first, then the pre-Phase-41 `resolve()` key.
 */
export function getSessionEntry(
  projectDir: string,
  registryPath = REGISTRY_PATH,
): SessionRegistryEntry | undefined {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(projectDir);
  if (registry[key]) return registry[key];
  const legacyKey = legacyKeyFor(projectDir);
  return legacyKey !== key ? registry[legacyKey] : undefined;
}

/** Remove the persisted entry for a projectDir (no-op if absent). */
export function removeSessionEntry(projectDir: string, registryPath = REGISTRY_PATH): void {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(projectDir);
  const legacyKey = legacyKeyFor(projectDir);
  let changed = false;
  if (key in registry) {
    delete registry[key];
    changed = true;
  }
  if (legacyKey !== key && legacyKey in registry) {
    delete registry[legacyKey];
    changed = true;
  }
  if (changed) writeSessionRegistry(registry, registryPath);
}

/**
 * Find the persisted row whose non-empty `sessionId` equals `sessionId`.
 * Empty or whitespace-only input returns undefined: in-flight rows carry
 * `sessionId: ''` until init() resolves and must never match (same guard as
 * SessionManager.getSession('')).
 */
export function findSessionEntryBySessionId(
  sessionId: string,
  registryPath = REGISTRY_PATH,
): SessionRegistryEntry | undefined {
  const wanted = typeof sessionId === 'string' ? sessionId.trim() : '';
  if (wanted === '') return undefined;
  const registry = readSessionRegistry(registryPath);
  for (const row of Object.values(registry)) {
    if (typeof row.sessionId === 'string' && row.sessionId !== '' && row.sessionId === wanted) {
      return row;
    }
  }
  return undefined;
}

/**
 * PD-41-A tombstone writer: turn the row for `projectDir` into an exit
 * tombstone (`status: 'exited'` + `exit`) - but only when the row's pid equals
 * `expectedPid`, so a newer driver's row is never clobbered. Idempotent: the
 * first death record wins (a row that already has `exit` is left untouched and
 * the call returns true). Returns false (no write) for a missing row or a pid
 * mismatch. `exit.reason` must come only from code/signal or a fixed
 * reconcile phrase - never stderr, prompt text or agent output.
 */
export function recordSessionExit(
  projectDir: string,
  exit: SessionExitRecord,
  expectedPid: number,
  registryPath = REGISTRY_PATH,
): boolean {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(projectDir);
  const legacyKey = legacyKeyFor(projectDir);
  const heldKey = registry[key] ? key : legacyKey !== key && registry[legacyKey] ? legacyKey : undefined;
  if (heldKey === undefined) return false;
  const row = registry[heldKey];
  if (row.pid !== expectedPid) return false;
  if (isTombstoneEntry(row)) return true;

  registry[key] = { ...row, projectDir: key, status: 'exited', exit };
  if (heldKey !== key) delete registry[heldKey];
  writeSessionRegistry(registry, registryPath);
  return true;
}

// ---------------------------------------------------------------------------
// Pid liveness + start-time guard against pid reuse
// ---------------------------------------------------------------------------

/**
 * Is `entry.pid` still alive AND is it plausibly the same process we
 * recorded (i.e. it didn't start materially after `entry.startTime`, which
 * would mean the OS recycled the pid for a different process)?
 */
export function isOrphanEntryAlive(
  entry: Pick<SessionRegistryEntry, 'pid' | 'startTime'>,
  options: SessionLivenessOptions = {},
): boolean {
  if (!isSafePid(entry.pid)) return false;

  const sendSignal = options.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  if (!isPidAlive(entry.pid, sendSignal)) return false;

  const getProcessStartTime = options.getProcessStartTime ?? defaultGetProcessStartTime;
  const recordedMs = Date.parse(entry.startTime);
  const actualStartMs = getProcessStartTime(entry.pid);

  if (
    Number.isFinite(recordedMs) &&
    actualStartMs !== null &&
    actualStartMs > recordedMs + STALE_PID_START_SKEW_MS
  ) {
    return false;
  }

  return true;
}

/**
 * Is the MCP server that spawned this driver (`ownerPid`) still alive?
 * Returns null when the row carries no usable ownerPid. Signal 0 only.
 *
 * ADVISORY: it distinguishes a peer-owned driver from a true orphan for
 * reporting. A recycled ownerPid can read as alive, so the result must never
 * authorise or forbid a signal.
 */
export function isRegistryOwnerAlive(
  entry: Pick<SessionRegistryEntry, 'ownerPid'>,
  options: SessionLivenessOptions = {},
): boolean | null {
  if (!isSafePid(entry.ownerPid)) return null;
  if (entry.ownerPid === process.pid) return true;
  const sendSignal = options.kill ?? ((pid: number, signal?: NodeJS.Signals | 0) => process.kill(pid, signal));
  return isPidAlive(entry.ownerPid, sendSignal);
}

/**
 * Kill an orphaned headless session's child process. Caller MUST have
 * already confirmed via `isOrphanEntryAlive` that this pid is genuinely our
 * orphan — this function re-checks the same start-time guard defensively
 * but does not re-derive "is it alive" beyond that.
 */
export function killOrphanSessionPid(
  pid: unknown,
  recordedStartTime: string | undefined,
  options: SessionLivenessOptions = {},
): KillOrphanSessionResult {
  if (!isSafePid(pid)) return 'invalid';

  const sendSignal = options.kill ?? ((targetPid: number, signal?: NodeJS.Signals | 0) => process.kill(targetPid, signal));
  const getProcessStartTime = options.getProcessStartTime ?? defaultGetProcessStartTime;
  const waitForExit = options.waitForExit ?? defaultWaitForExit;

  try {
    sendSignal(pid, 0);
  } catch (error) {
    const isAlreadyDead =
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
    if (isAlreadyDead) return 'already-dead';
    return { error: error instanceof Error ? error.message : String(error) };
  }

  const recordedMs = recordedStartTime ? Date.parse(recordedStartTime) : NaN;
  const actualStartMs = getProcessStartTime(pid);
  if (
    Number.isFinite(recordedMs) &&
    actualStartMs !== null &&
    actualStartMs > recordedMs + STALE_PID_START_SKEW_MS
  ) {
    // Recycled pid — refuse to signal a process we never spawned.
    return 'invalid';
  }

  try {
    sendSignal(pid, 'SIGTERM');
    waitForExit();
    if (!isPidAlive(pid, sendSignal)) return 'killed';
    sendSignal(pid, 'SIGKILL');
    return 'force-killed';
  } catch (error) {
    const isAlreadyDead =
      error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === 'ESRCH';
    if (isAlreadyDead) return 'already-dead';
    return { error: error instanceof Error ? error.message : String(error) };
  }
}
