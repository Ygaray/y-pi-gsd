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

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
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

function keyFor(projectDir: string): string {
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
      return parsed as SessionRegistry;
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

/** Persist (or overwrite) the session entry for a projectDir. */
export function registerSessionEntry(
  entry: SessionRegistryEntry,
  registryPath = REGISTRY_PATH,
): void {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(entry.projectDir);
  registry[key] = { ...entry, projectDir: key };
  writeSessionRegistry(registry, registryPath);
}

/** Look up the persisted entry for a projectDir, if any. */
export function getSessionEntry(
  projectDir: string,
  registryPath = REGISTRY_PATH,
): SessionRegistryEntry | undefined {
  const registry = readSessionRegistry(registryPath);
  return registry[keyFor(projectDir)];
}

/** Remove the persisted entry for a projectDir (no-op if absent). */
export function removeSessionEntry(projectDir: string, registryPath = REGISTRY_PATH): void {
  const registry = readSessionRegistry(registryPath);
  const key = keyFor(projectDir);
  if (key in registry) {
    delete registry[key];
    writeSessionRegistry(registry, registryPath);
  }
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
