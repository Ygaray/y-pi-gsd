// Project/App: gsd-pi
// File Purpose: Workflow DB open helpers for state derivation.

import type { GSDState } from '../../types.js';
import { getAllMilestones, isDbAvailable, isSchemaTooNewError, setMilestoneQueueOrder } from '../../gsd-db.js';
import { getWorkflowDatabasePath as getDbPath, openExistingWorkflowDatabase, resolveProjectRootDbPath, type WorkflowDatabaseOpenResult } from '../../db-workspace.js';
import { loadQueueOrder, sortByQueueOrder } from '../../queue-order.js';
import { realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createJiti } from '@mariozechner/jiti';

export function syncQueueOrderProjectionToDb(basePath: string): void {
  const queueOrder = loadQueueOrder(basePath);
  if (!queueOrder) return;

  const currentIds = getAllMilestones().map((m) => m.id);
  const desiredIds = sortByQueueOrder(currentIds, queueOrder);
  if (currentIds.length === desiredIds.length && currentIds.every((id, i) => id === desiredIds[i])) return;

  setMilestoneQueueOrder(desiredIds);
}

/**
 * Compare DB paths by canonical form: resolveProjectRootDbPath canonicalizes
 * (realpath) while the open handle keeps the spelling it was opened with — on
 * macOS a /var vs /private/var mismatch must reuse the same DB, not reopen it.
 * A missing requested path falls back to its raw form so it can never match.
 */
function isSameOpenDatabase(currentDbPath: string | null, requestedDbPath: string): boolean {
  if (!currentDbPath) return false;
  if (currentDbPath === ":memory:" || currentDbPath === requestedDbPath) return true;
  const canonical = (p: string): string => {
    try {
      return realpathSync(p);
    } catch {
      return resolve(p);
    }
  };
  return canonical(currentDbPath) === canonical(requestedDbPath);
}

// Read-only source-tree SCHEMA_VERSION probe (TRACK-005 / RELY-04). Mirrors
// read-cli.ts's loadSchemaPreflight() jiti-import trick: this jiti instance
// always resolves db/engine.ts from the checked-out src/ tree, never
// whatever dist/ this running process itself was compiled from -- a plain
// static import here would just be this binary's own dist copy, not an
// independent second signal.
const staleDistProbeJiti = createJiti(fileURLToPath(import.meta.url), { interopDefault: true, debug: false });

/**
 * db-open.ts sits exactly 6 directories below the package root in both its
 * src/ and dist/ locations (resources/extensions/gsd/state/derive/, plus the
 * top-level src/ or dist/ segment) -- climb 6 levels up from this module's
 * own dirname to reach the package root, then re-root under the checked-out
 * src/ tree's db/engine.ts. This ALWAYS reads the source tree regardless of
 * whether this process itself is running from src/ or dist/.
 */
function resolveSourceEngineModulePath(): string {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  const packageRoot = join(moduleDir, "..", "..", "..", "..", "..", "..");
  return join(packageRoot, "src", "resources", "extensions", "gsd", "db", "engine.ts");
}

async function loadSourceTreeSchemaVersionViaJiti(): Promise<number> {
  const engineModule = await staleDistProbeJiti.import(resolveSourceEngineModulePath(), {}) as { SCHEMA_VERSION?: unknown };
  if (typeof engineModule.SCHEMA_VERSION !== "number") {
    throw new Error("source-tree db/engine.ts did not export a numeric SCHEMA_VERSION");
  }
  return engineModule.SCHEMA_VERSION;
}

interface StaleDistDescriptor {
  currentVersion: number;
  supportedVersion: number;
  message: string;
}

/**
 * Distinguish a stale dist/ build (checked-out source already supports this
 * schema -- warn and degrade) from a genuinely newer-than-supported schema
 * (return null so the caller keeps throwing loudly, unchanged -- SC-3). ANY
 * probe failure -- the jiti import throwing, or a non-finite source version
 * -- fails closed to null: an inconclusive signal must never be treated as
 * "confirmed stale" (T-32-01).
 */
async function resolveStaleDistWarning(
  error: unknown,
  loadSourceSchemaVersion: () => Promise<number>,
): Promise<StaleDistDescriptor | null> {
  if (!isSchemaTooNewError(error)) return null;
  let sourceVersion: number;
  try {
    sourceVersion = await loadSourceSchemaVersion();
  } catch {
    return null;
  }
  if (!Number.isFinite(sourceVersion) || error.currentVersion > sourceVersion) {
    return null;
  }
  process.stderr.write(
    `[gsd] ${error.message} (dist/ is stale -- the checked-out source already supports this schema)\n`,
  );
  return {
    currentVersion: error.currentVersion,
    supportedVersion: error.supportedVersion,
    message: error.message,
  };
}

export type EnsureExistingWorkflowDbOpenResult =
  | { ok: true }
  | { ok: false; staleDist?: StaleDistDescriptor };

export async function ensureExistingWorkflowDbOpen(
  basePath: string,
  options: {
    throwOnOpenFailure?: boolean;
    syncQueueOrder?: boolean;
    loadSourceSchemaVersion?: () => Promise<number>;
  } = {},
): Promise<EnsureExistingWorkflowDbOpenResult> {
  const syncQueueOrder = options.syncQueueOrder !== false;
  if (isDbAvailable() && isSameOpenDatabase(getDbPath(), resolveProjectRootDbPath(basePath))) {
    if (syncQueueOrder) syncQueueOrderProjectionToDb(basePath);
    return { ok: true };
  }
  let result: WorkflowDatabaseOpenResult;
  try {
    result = openExistingWorkflowDatabase(basePath);
  } catch (err) {
    // Defensive: if an open path ever throws the typed refuse-newer error
    // directly instead of returning a "schema-too-new" result, it must still
    // refuse loudly rather than degrade to empty state.
    if (isSchemaTooNewError(err)) throw err;
    throw err;
  }
  if (!result.ok && result.reason === "schema-too-new") {
    // Version skew is not generic DB unavailability: a stale dist/ build
    // (checked-out source already supports this schema) warns and degrades;
    // a genuinely newer-than-supported schema still throws the typed error
    // (exact engine message attached) so state-read surfaces refuse loudly
    // instead of emitting a degraded all-zero snapshot (T003 spike / SC-3).
    const loadSourceSchemaVersion = options.loadSourceSchemaVersion ?? loadSourceTreeSchemaVersionViaJiti;
    const staleDist = await resolveStaleDistWarning(result.error, loadSourceSchemaVersion);
    if (staleDist) {
      return { ok: false, staleDist };
    }
    throw result.error;
  }
  if (!result.ok && options.throwOnOpenFailure && result.reason !== "missing-database" && result.reason !== "missing-gsd-dir") {
    throw result.error ?? new Error(`Unable to open the GSD database: ${result.reason}`);
  }
  if (result.ok && syncQueueOrder) syncQueueOrderProjectionToDb(basePath);
  return { ok: result.ok };
}

export function buildStaleDistState(staleDist: StaleDistDescriptor): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: ["Stale dist/ build: " + staleDist.message],
    nextAction: "Rebuild your fork: run pnpm build before opening this project.",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 0 } },
  };
}

export function buildDbUnavailableState(): GSDState {
  return {
    activeMilestone: null,
    activeSlice: null,
    activeTask: null,
    phase: "pre-planning",
    recentDecisions: [],
    blockers: ["DB unavailable — runtime markdown state derivation is disabled"],
    nextAction:
      "Open or create the canonical GSD database before deriving workflow state. If this project only has markdown state, run /gsd migrate explicitly.",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 0 } },
  };
}

export function getRequestedMilestoneLock(): string | undefined {
  const lock = process.env.GSD_MILESTONE_LOCK?.trim();
  return lock || undefined;
}
