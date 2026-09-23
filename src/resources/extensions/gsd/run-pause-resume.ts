// Project/App: gsd-pi
// File Purpose: Swappable, default-deny, DB-re-derived resume condition for
// a headless pause (Phase 16, DRIVER-02). This is where D-03's three Runtime
// Decisions become code:
//   1. Resume-readiness is re-derived from CURRENT database state on every
//      call -- mirroring `headless-milestone-readiness.ts`'s "open DB fresh,
//      re-derive from current rows" contract. This module never reads any
//      serialized pause snapshot written to disk at pause time.
//   2. Only the two named safe pause kinds (`gap-closure-cap`,
//      `certify-escalation`) can ever auto-resume. Every other kind --
//      including the named `"human-decision"` member, a `null` kind, and
//      any unrecognised token -- stays paused for the operator.
//   3. The installed resume condition is SWAPPABLE (`resolveResumeCondition`/
//      `setResumeCondition`), so the auto-resume allowlist can widen later
//      without re-plumbing the headless host.
//
// Never throws: every failure path (missing database, missing `.gsd`
// directory, missing row, a query that throws) returns a no-resume decision
// with a named reason, mirroring `isMilestoneExecutableInDb`'s documented
// never-throws contract. The workflow database is always closed in a
// `finally`, so no handle leaks into the headless host process.

import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from "./db-workspace.js";
import { getDb } from "./db/engine.js";
import { countUnresolvedBlockingGapFindingsForSlice } from "./gsd-db.js";
import type { PauseKind } from "./types.js";

/**
 * The ONLY pause kinds a headless run may ever auto-resume without a human
 * (D-03 Runtime Decision #2). Exactly two members -- Test 3 asserts the set
 * size, so widening this allowlist is a deliberate, reviewable test edit,
 * never a quiet addition.
 */
export const AUTO_RESUMABLE_PAUSE_KINDS: ReadonlySet<PauseKind> = new Set<PauseKind>([
  "gap-closure-cap",
  "certify-escalation",
]);

export interface PauseSnapshot {
  /** Unresolved blocking gap-finding count recorded when the pause fired. */
  unresolvedAtPause: number;
}

export interface PauseContext {
  /** Explicit discriminant -- never inferred from prose. `null`/`undefined` means unparseable/absent. */
  kind: PauseKind | null | undefined;
  milestoneId: string;
  sliceId: string;
  /** Present only for a `certify-escalation` pause. */
  gate2EntryId?: string;
  /** Present only for a `gap-closure-cap` pause. */
  snapshot?: PauseSnapshot;
}

export interface ResumeDecision {
  resume: boolean;
  /**
   * Required on BOTH branches -- a resume with no stated ground is
   * indistinguishable from a bug, and 16-05 writes this into the run-log
   * row the operator reads.
   */
  reason: string;
}

export type ResumeCondition = (basePath: string, pause: PauseContext) => ResumeDecision;

function noResume(reason: string): ResumeDecision {
  return { resume: false, reason };
}

function readyToResume(reason: string): ResumeDecision {
  return { resume: true, reason };
}

/**
 * Gap-closure-cap readiness: zero unresolved blocking findings remain across
 * the slice's gap-closure briefs, AND that count is strictly lower than it
 * was when the pause was recorded (`## Resolved Open Question 2`,
 * 16-04-PLAN.md). The first clause is the substantive condition -- the
 * underlying gaps are genuinely closed, not the cap raised. The second
 * clause is the snapshot comparison (mirroring
 * `isMilestoneExecutableInDb`'s `changedSince` option,
 * `headless-milestone-readiness.ts`): without it, a pause recorded at zero
 * unresolved findings would resume immediately with nothing having
 * changed, and -- because the cap count itself never decreases -- would
 * immediately re-pause on the very next evaluation: a no-op auto-resume
 * loop that would burn tokens overnight unattended. DO NOT remove this
 * clause to "simplify" the predicate; that reintroduces the infinite loop.
 *
 * Never reads any serialized pause-time gate-block snapshot -- the count is
 * re-queried fresh from `rework_brief_findings` on every call.
 */
function evaluateGapClosureCap(basePath: string, pause: PauseContext): ResumeDecision {
  const opened = openExistingWorkflowDatabase(basePath);
  if (!opened.ok) {
    return noResume(
      `cannot re-derive gap-closure readiness for ${pause.milestoneId}/${pause.sliceId}: workflow database unavailable (${opened.reason})`,
    );
  }
  try {
    const unresolved = countUnresolvedBlockingGapFindingsForSlice(pause.milestoneId, pause.sliceId);
    if (unresolved !== 0) {
      return noResume(
        `${unresolved} unresolved blocking gap finding(s) remain for ${pause.milestoneId}/${pause.sliceId}`,
      );
    }
    const atPause = pause.snapshot?.unresolvedAtPause;
    if (atPause === undefined) {
      return noResume(
        `no pause-time snapshot recorded for ${pause.milestoneId}/${pause.sliceId} — cannot confirm the unresolved count actually changed`,
      );
    }
    if (atPause <= 0) {
      return noResume(
        `no change since pause: the unresolved count for ${pause.milestoneId}/${pause.sliceId} was already zero when the pause was recorded`,
      );
    }
    return readyToResume(
      `all ${atPause} unresolved blocking gap finding(s) recorded at pause time are now resolved for ${pause.milestoneId}/${pause.sliceId}`,
    );
  } catch (e) {
    return noResume(`gap-closure readiness check failed for ${pause.milestoneId}/${pause.sliceId}: ${(e as Error).message}`);
  } finally {
    closeWorkflowDatabase();
  }
}

/**
 * Certify-escalation readiness: the Gate-2 entry's status has transitioned
 * off `pending`. A missing row is NOT resume-ready -- an entry that cannot
 * be found is a no-resume with a named reason, never an optimistic pass.
 * The row already IS the DB-authoritative signal (it lives in the same
 * `human_uat_pending` table Phase 13's ledger built) -- no re-derivation
 * beyond a `SELECT` is needed.
 */
function evaluateCertifyEscalation(basePath: string, pause: PauseContext): ResumeDecision {
  const entryId = pause.gate2EntryId;
  if (!entryId) {
    return noResume(`certify-escalation pause for ${pause.milestoneId}/${pause.sliceId} carries no Gate-2 entry id to check`);
  }
  const opened = openExistingWorkflowDatabase(basePath);
  if (!opened.ok) {
    return noResume(`cannot re-derive certify-escalation readiness for entry ${entryId}: workflow database unavailable (${opened.reason})`);
  }
  try {
    const row = getDb().prepare(
      `SELECT status FROM human_uat_pending WHERE entry_id = :entry_id`,
    ).get({ ":entry_id": entryId }) as { status: string } | undefined;
    if (!row) {
      return noResume(`Gate-2 entry not found: ${entryId}`);
    }
    if (row.status === "pending") {
      return noResume(`Gate-2 entry ${entryId} is still pending sign-off`);
    }
    return readyToResume(`Gate-2 entry ${entryId} was resolved (status: ${row.status})`);
  } catch (e) {
    return noResume(`certify-escalation readiness check failed for entry ${entryId}: ${(e as Error).message}`);
  } finally {
    closeWorkflowDatabase();
  }
}

/**
 * The default, installed resume condition. An explicit switch over the
 * pause kind with the deny branch placed FIRST, so a reader sees the
 * default-deny case before either allow branch: an unlisted kind (absent,
 * unrecognised, or the named `"human-decision"` member) returns no-resume
 * WITHOUT ever touching the database -- default-deny, not
 * default-allow-then-check.
 */
export const defaultResumeCondition: ResumeCondition = (basePath, pause) => {
  const kind = pause.kind;
  if (kind == null || !AUTO_RESUMABLE_PAUSE_KINDS.has(kind)) {
    return noResume(
      `pause kind "${kind ?? "null"}" is not on the auto-resume allowlist `
        + `(${[...AUTO_RESUMABLE_PAUSE_KINDS].join(", ")}) — stays paused for the operator`,
    );
  }
  if (kind === "gap-closure-cap") return evaluateGapClosureCap(basePath, pause);
  if (kind === "certify-escalation") return evaluateCertifyEscalation(basePath, pause);
  // Unreachable while AUTO_RESUMABLE_PAUSE_KINDS only names the two kinds
  // handled above. Kept as a defensive default-deny (never an assertion)
  // in case the allowlist is ever widened without adding the matching
  // branch here.
  return noResume(`pause kind "${kind}" is on the allowlist but has no resume-readiness branch implemented`);
};

let _activeResumeCondition: ResumeCondition = defaultResumeCondition;

/** The currently installed resume condition (D-03 Runtime Decision #3). */
export function resolveResumeCondition(): ResumeCondition {
  return _activeResumeCondition;
}

/**
 * Install a replacement resume condition, returning a restore function --
 * mirrors `_setProperLockfileForTests`'s (`session-lock.ts`) swap-and-restore
 * shape. This is how the auto-resume allowlist widens later: by installing a
 * different function, never by re-plumbing the headless host.
 */
export function setResumeCondition(fn: ResumeCondition): () => void {
  const previous = _activeResumeCondition;
  _activeResumeCondition = fn;
  return () => {
    _activeResumeCondition = previous;
  };
}
