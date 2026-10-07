/**
 * Orphan-attempt DB reconcile (EXEC-01, Phase 39).
 *
 * `reapPersistedOrphanSession` (session-manager.ts) used to unconditionally
 * SIGTERM/SIGKILL a confirmed-alive orphaned `gsd_execute` child left behind
 * by a hard-killed prior MCP server instance. That amplified the
 * orphaned-active-unit cascade: the child's DB-side Task Attempt was still
 * `running`, and killing the child without reconciling that Attempt left a
 * dangling `running` row with no live owner.
 *
 * This module inserts a DB-based "settle" step between the existing
 * liveness check and the existing kill call (D-03). It is a sibling module
 * to `session-persist.ts`, which stays pure and DB-free — this module owns
 * every DB-touching concern instead.
 *
 * Mechanism (D-01/D-02): join the orphan's persisted registry pid to the
 * project's `workers` row (scoped by host + project_root_realpath — pids are
 * only unique per host and the OS recycles them, so a bare pid match risks a
 * false positive for an unrelated project), then delegate the actual settle
 * write to the already-existing `settleRunningAttemptsForWorker` background
 * writer (PD-2), which routes through `executeDomainOperation` and therefore
 * satisfies `workflow_execution_attempts`'s composite settle FOREIGN KEY
 * (PD-1) — a hand-rolled direct UPDATE cannot.
 *
 * This module must never re-derive the orphan's OS-level liveness by any
 * means (no signal probe, no start-time read, no worker-heartbeat
 * consultation, PD-4). It trusts the already-confirmed registry `entry` the
 * caller hands it — `isOrphanEntryAlive` in session-persist.ts already
 * established liveness under the existing start-time-skew guard, and this
 * module must not become a second, independent liveness authority.
 */

import { hostname } from 'node:os';
import { resolve } from 'node:path';
import { realpathSync } from 'node:fs';

import type { SessionRegistryEntry } from './session-persist.js';
import { _buildImportCandidates } from './workflow-tools.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type OrphanReconcileResult = 'settled' | 'no-attempt' | 'db-unavailable';

/**
 * Narrow local mirror of only the facade members this module uses —
 * modelled on `workflow-tools.ts`'s hand-maintained `GsdMcpBridge` interface,
 * deliberately NOT its full ~25-method surface.
 */
export interface OrphanReconcileBridge {
  ensureDbOpen(projectDir: string): Promise<boolean>;
  getDb(): { prepare(sql: string): { all(params?: Record<string, unknown>): unknown[] } };
  settleRunningAttemptsForWorker(workerId: string): string[];
  /**
   * WR-02 (39-REVIEW.md): resolve `resolvedDir` (the raw cwd the MCP server
   * passed to the orphan's RpcClient at spawn time) to its CANONICAL
   * project root — the same worktree-aware resolution the orphan process
   * itself used (via `registerAutoWorkerForSession` -> `resolveGsdPathContract`)
   * to populate `workers.project_root_realpath`. Without this, a worktree
   * cwd would never match the canonical root stored at registration, the
   * join would silently match zero rows, and the settle protection this
   * module exists to provide would never engage for worktree-based
   * sessions. Optional so pre-existing hand-built test fakes that don't
   * implement it keep working unchanged — its absence falls back to
   * normalizing `resolvedDir` directly (correct whenever resolvedDir is
   * already the project's canonical root, i.e. the non-worktree case).
   */
  resolveWorkflowDatabaseLocation?(basePath: string): { projectRoot: string };
}

/** Injectable seam for tests — defaults are the real implementations. */
export interface OrphanReconcileDeps {
  loadBridge?: () => Promise<OrphanReconcileBridge>;
  hostname?: () => string;
  normalizeProjectRoot?: (dir: string) => string;
}

// ---------------------------------------------------------------------------
// Bridge import (mirrors workflow-tools.ts's importLocalModule, reusing its
// exported candidate-path builder rather than re-deriving path resolution)
// ---------------------------------------------------------------------------

async function importLocalModule<T>(relativePath: string): Promise<T> {
  const rawCandidates = _buildImportCandidates(relativePath);
  const candidates = (
    import.meta.url.includes('/dist-test/') || import.meta.url.includes('\\dist-test\\')
      ? [...rawCandidates].sort((a, b) => Number(a.endsWith('.ts')) - Number(b.endsWith('.ts')))
      : rawCandidates
  ).map((p) => new URL(p, import.meta.url).href);

  let lastErr: unknown;
  for (const candidate of candidates) {
    try {
      return (await import(candidate)) as T;
    } catch (err) {
      lastErr = err;
    }
  }
  throw lastErr;
}

async function defaultLoadBridge(): Promise<OrphanReconcileBridge> {
  return importLocalModule<OrphanReconcileBridge>(
    '../../../src/resources/extensions/gsd/mcp-bridge.js',
  );
}

// ---------------------------------------------------------------------------
// Project-root normalization (mirrors paths.ts's normalizeRealPath exactly —
// duplicated deliberately, since paths.ts sits outside this package's rootDir
// and cannot be imported)
// ---------------------------------------------------------------------------

export function normalizeOrphanProjectRoot(dir: string): string {
  try {
    return realpathSync.native(dir);
  } catch {
    return resolve(dir);
  }
}

// ---------------------------------------------------------------------------
// Started-at bound (WR-01, 39-REVIEW.md): host+project_root scoping alone
// does not close pid recycling WITHIN the same host+project (e.g. a
// long-running dev workspace where an earlier, already-dead `gsd auto`
// process's `workers` row was never cleaned up, and the OS later reassigns
// that exact pid to a brand-new, unrelated orphan process for the SAME
// project). Mirrors the bounded-skew guard `killOrphanSessionPid` already
// applies (STALE_PID_START_SKEW_MS in session-persist.ts/pid-registry.ts)
// — this is not a re-derived OS liveness check (forbidden, PD-4); it is a
// DB-side identity guard applied to the row this query is about to act on.
// `workers.started_at` (recorded by the child's own registerAutoWorker call)
// is not expected to equal `entry.startTime` (recorded by the MCP server
// moments earlier, after the init handshake) to the millisecond, so an exact
// match would be too fragile — a bounded window is used instead.
const WORKER_START_TIME_SKEW_MS = 60_000;

/**
 * Compute an inclusive ISO8601 [min, max] bound around `recordedStartTime`
 * for the `workers.started_at` cross-check. Falls back to an unbounded
 * window (effectively a no-op filter) when `recordedStartTime` cannot be
 * parsed, since ORPHAN_RECONCILE_WORKER_ATTEMPT_SQL's other predicates
 * (host + pid + project_root_realpath) already carry the primary identity
 * burden — this cross-check must only ever narrow, never itself become a
 * silent false-negative source when the input is malformed.
 */
export function computeWorkerStartTimeBound(recordedStartTime: string): { min: string; max: string } {
  const recordedMs = Date.parse(recordedStartTime);
  if (!Number.isFinite(recordedMs)) {
    return { min: '0000-01-01T00:00:00.000Z', max: '9999-12-31T23:59:59.999Z' };
  }
  return {
    min: new Date(recordedMs - WORKER_START_TIME_SKEW_MS).toISOString(),
    max: new Date(recordedMs + WORKER_START_TIME_SKEW_MS).toISOString(),
  };
}

// ---------------------------------------------------------------------------
// The pid-keyed join (host + project-root scoped — see module header)
// ---------------------------------------------------------------------------

export const ORPHAN_RECONCILE_WORKER_ATTEMPT_SQL = `
  SELECT DISTINCT worker.worker_id AS worker_id
  FROM workers worker
  JOIN workflow_execution_attempts attempt
    ON attempt.worker_id = worker.worker_id
  JOIN workflow_item_lifecycles lifecycle
    ON lifecycle.lifecycle_id = attempt.lifecycle_id
   AND lifecycle.project_id = attempt.project_id
  WHERE worker.pid = :pid
    AND worker.host = :host
    AND worker.project_root_realpath = :project_root
    AND worker.started_at >= :start_time_min
    AND worker.started_at <= :start_time_max
    AND attempt.attempt_state = 'running'
    AND lifecycle.item_kind = 'task'
`;

// ---------------------------------------------------------------------------
// The reconcile decision
// ---------------------------------------------------------------------------

/**
 * Reconcile a confirmed-alive orphan's DB-side Task Attempt(s) before the
 * caller decides whether to signal its pid. Returns:
 *  - 'settled'       — at least one running Attempt owned by this pid's
 *                       worker was settled; the pid must NOT be killed.
 *  - 'no-attempt'    — no matching `workers` row, no running Attempt, or the
 *                       settle call settled nothing (someone else settled it
 *                       first); the pid falls through to the existing kill.
 *  - 'db-unavailable'— the database could not be reached at all (closed
 *                       bridge import, `ensureDbOpen` returning false, or any
 *                       thrown error); the pid falls through to the existing
 *                       kill, exactly as 'no-attempt'.
 *
 * Any thrown error anywhere in this function's body is caught and reported
 * as 'db-unavailable' — this function must never reject, since its caller
 * (`reapPersistedOrphanSession`) is itself awaited from `startSession()`.
 */
export async function reconcileOrphanAttempt(
  entry: SessionRegistryEntry,
  resolvedDir: string,
  deps: OrphanReconcileDeps = {},
): Promise<OrphanReconcileResult> {
  try {
    const loadBridge = deps.loadBridge ?? defaultLoadBridge;
    const getHostname = deps.hostname ?? hostname;
    const normalizeProjectRoot = deps.normalizeProjectRoot ?? normalizeOrphanProjectRoot;

    const bridge = await loadBridge();

    if (!(await bridge.ensureDbOpen(resolvedDir))) {
      return 'db-unavailable';
    }

    const startTimeBound = computeWorkerStartTimeBound(entry.startTime);

    // WR-02 (39-REVIEW.md): resolve resolvedDir to its canonical project
    // root the same worktree-aware way the orphan process itself did when
    // it registered `workers.project_root_realpath` -- a raw worktree cwd
    // must never be bound directly, or the join would silently match zero
    // rows for worktree-based sessions. Falls back to resolvedDir itself
    // when the bridge doesn't provide the resolver (test fakes, or an
    // older bridge module) -- correct whenever resolvedDir already IS the
    // canonical root.
    const projectRootForQuery = bridge.resolveWorkflowDatabaseLocation
      ? bridge.resolveWorkflowDatabaseLocation(resolvedDir).projectRoot
      : resolvedDir;

    const rows = bridge
      .getDb()
      .prepare(ORPHAN_RECONCILE_WORKER_ATTEMPT_SQL)
      .all({
        ':pid': entry.pid,
        ':host': getHostname(),
        ':project_root': normalizeProjectRoot(projectRootForQuery),
        ':start_time_min': startTimeBound.min,
        ':start_time_max': startTimeBound.max,
      }) as Array<{ worker_id: string }>;

    if (rows.length === 0) {
      return 'no-attempt';
    }

    let settledCount = 0;
    for (const row of rows) {
      // CR-02 (39-REVIEW.md): best-effort per matched worker row, mirroring
      // settleRunningAttemptsForWorker's own internal per-attempt pattern.
      // `rows` can contain more than one worker_id; if one row's settle call
      // throws, it must not erase an EARLIER row's already-durable settle by
      // falling into the outer catch and reporting 'db-unavailable' (which
      // the caller treats identically to 'no-attempt' and falls through to
      // killing the pid). Without this per-row guard, a later row's failure
      // would discard the whole loop's progress and leave any OTHER matched
      // worker's still-running Attempt dangling once the pid is killed.
      try {
        settledCount += bridge.settleRunningAttemptsForWorker(row.worker_id).length;
      } catch {
        // best-effort — continue to the next matched worker row.
      }
    }

    return settledCount > 0 ? 'settled' : 'no-attempt';
  } catch {
    return 'db-unavailable';
  }
}
