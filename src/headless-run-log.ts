// Project/App: gsd-pi
// File Purpose: Host-side wrapper for recording milestone run-log lifecycle
// transitions from the headless host process (DRIVER-01, DRIVER-02).
//
// This is the phase's tracer: the FIRST write-path from `src/` into a
// Domain Operation in this repository -- every other host-side module
// (`headless-milestone-readiness.ts`, etc.) only reads. A direct sibling of
// `headless-milestone-readiness.ts`'s own open/read-or-write/close contract.
//
// `recordHeadlessRunPause`/`recordHeadlessRunResume` (16-05) extend the same
// never-throws host wrapper for the two later lifecycle transitions a
// headless pause/resume cycle performs: `running -> paused` (persisted
// BEFORE any resume decision is made, ROADMAP SC3) and `paused -> resumed`
// plus a fresh `running` row for the next attempt (ROADMAP SC4). Both call
// `transitionMilestoneRunLogRow`/`executeDomainOperation` directly, mirroring
// `commands-gsd-core.ts`'s `failStaleMilestoneRunLogRow` inline shape --
// there is no shared transition helper in `milestone-run-log-domain-operation.ts`
// to call instead (it exposes only the INSERT-shaped `recordMilestoneRunLifecycle`).

import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import { internalExecutionInvocation } from './resources/extensions/gsd/execution-invocation.js'
import { findDerivedActiveMilestone } from './headless-milestone-readiness.js'
import {
  recordMilestoneRunLifecycle,
  MILESTONE_RUN_LOG_EVENT_TYPE,
} from './resources/extensions/gsd/milestone-run-log-domain-operation.js'
import {
  countUnresolvedBlockingGapFindingsForSlice,
  executeDomainOperation,
  MILESTONE_RUN_LOG_OPERATION_TYPE,
  readDomainOperationFence,
  transitionMilestoneRunLogRow,
} from './resources/extensions/gsd/gsd-db.js'
import type { MilestoneRunLogStatus } from './resources/extensions/gsd/db/writers/milestone-run-log.js'
import { readMilestoneRunLog, renderMilestoneRunLog } from './resources/extensions/gsd/run-log-projection.js'
import type { PauseKind } from './resources/extensions/gsd/types.js'

export interface RecordHeadlessRunLifecycleInput {
  runId: string
  attempt: number
  status: MilestoneRunLogStatus
  resumeFrom?: number | null
  pauseKind?: string | null
  reason?: string | null
}

export interface RecordHeadlessRunLifecycleResult {
  recorded: boolean
  milestoneId: string | null
  entryId: string | null
}

const NOOP_RESULT: RecordHeadlessRunLifecycleResult = {
  recorded: false,
  milestoneId: null,
  entryId: null,
}

/**
 * Record a lifecycle transition for the active milestone's run-log, then
 * regenerate `.gsd/RUN-LOG.md`. Never throws (mirrors
 * `isMilestoneExecutableInDb`'s documented never-throws contract,
 * `src/headless-milestone-readiness.ts`) -- every failure path (no DB, no
 * `.gsd` directory, no active milestone, or a write failure) returns the
 * no-op result. Opens the workflow database fresh and always closes it
 * before returning, leaking no handle into the headless host process.
 */
export function recordHeadlessRunLifecycle(
  basePath: string,
  input: RecordHeadlessRunLifecycleInput,
): RecordHeadlessRunLifecycleResult {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return NOOP_RESULT
  try {
    const active = findDerivedActiveMilestone(basePath)
    if (active == null) return NOOP_RESULT

    const receipt = recordMilestoneRunLifecycle({
      invocation: internalExecutionInvocation(
        `headless-run-log/${input.runId}/a${input.attempt}`,
        { actorId: 'headless-auto' },
      ),
      milestoneId: active.id,
      runId: input.runId,
      attempt: input.attempt,
      status: input.status,
      resumeFrom: input.resumeFrom ?? null,
      pauseKind: input.pauseKind ?? null,
      reason: input.reason ?? null,
    })
    renderMilestoneRunLog(basePath)
    return { recorded: true, milestoneId: active.id, entryId: receipt.entryId }
  } catch {
    return NOOP_RESULT
  } finally {
    closeWorkflowDatabase()
  }
}

export interface RecordHeadlessRunPauseInput {
  kind: PauseKind
  reason: string
  milestoneId: string | null
  sliceId: string | null
}

export interface RecordHeadlessRunPauseResult {
  recorded: boolean
  entryId: string | null
  /**
   * The unresolved-blocking-gap-finding count observed AT THE MOMENT this
   * pause was recorded, captured fresh from the DB -- never inferred. Only
   * populated for a `gap-closure-cap` pause with a resolved milestone/slice;
   * `null` otherwise. The caller (headless.ts) carries this value forward
   * into `decideHeadlessResume` so the resume condition has a genuine
   * before-value to compare against (16-04's Resolved Open Question 2).
   */
  unresolvedAtPause: number | null
}

const PAUSE_NOOP_RESULT: RecordHeadlessRunPauseResult = {
  recorded: false,
  entryId: null,
  unresolvedAtPause: null,
}

const RESUME_NOOP_RESULT: RecordHeadlessRunLifecycleResult = NOOP_RESULT

/**
 * Persist a `running -> paused` transition for the active milestone's
 * currently-running run-log attempt, BEFORE any resume decision is made
 * (ROADMAP SC3 -- a pause is durably accounted for whether or not it turns
 * out to be resumable). Never throws; every failure path (no DB, no `.gsd`
 * directory, no active milestone, no matching running row) returns the
 * no-op result. Opens the workflow database fresh and always closes it.
 */
export function recordHeadlessRunPause(
  basePath: string,
  runId: string,
  pause: RecordHeadlessRunPauseInput,
): RecordHeadlessRunPauseResult {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return PAUSE_NOOP_RESULT
  try {
    const active = findDerivedActiveMilestone(basePath)
    if (active == null) return PAUSE_NOOP_RESULT

    const row = readMilestoneRunLog().find(
      (r) => r.milestoneId === active.id && r.runId === runId && r.status === 'running',
    )
    if (!row) return PAUSE_NOOP_RESULT

    const unresolvedAtPause =
      pause.kind === 'gap-closure-cap' && pause.milestoneId && pause.sliceId
        ? countUnresolvedBlockingGapFindingsForSlice(pause.milestoneId, pause.sliceId)
        : null

    const idempotencyKey = `headless-run-log/${runId}/a${row.attempt}/pause`
    const fence = readDomainOperationFence(idempotencyKey)
    executeDomainOperation({
      operationType: MILESTONE_RUN_LOG_OPERATION_TYPE,
      idempotencyKey,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: 'agent',
      actorId: 'headless-auto',
      sourceTransport: 'internal',
      payload: { entryId: row.entryId, status: 'paused' },
    }, (context) => {
      transitionMilestoneRunLogRow(context, {
        entryId: row.entryId,
        status: 'paused',
        resumeFrom: row.resumeFrom,
        pauseKind: pause.kind,
        reason: pause.reason,
      })
      return {
        events: [{
          eventType: MILESTONE_RUN_LOG_EVENT_TYPE,
          entityType: 'milestone',
          entityId: active.id,
          payload: { entryId: row.entryId, status: 'paused' },
          destinations: ['projection'],
        }],
        projections: [{
          projectionKey: `run-log/${active.id}`.toLowerCase(),
          projectionKind: 'milestone-run-log',
          rendererVersion: '1',
        }],
      }
    })
    renderMilestoneRunLog(basePath)
    return { recorded: true, entryId: row.entryId, unresolvedAtPause }
  } catch {
    return PAUSE_NOOP_RESULT
  } finally {
    closeWorkflowDatabase()
  }
}

/**
 * Persist a `paused -> resumed` transition on the paused attempt row, then
 * register a NEW attempt row at `running` for the next attempt (ROADMAP SC4
 * -- the same run re-enters the loop, never upserting onto the paused row).
 * Never throws; every failure path (no DB, no `.gsd` directory, no active
 * milestone, no matching paused row) returns the no-op result. Opens the
 * workflow database fresh and always closes it.
 */
export function recordHeadlessRunResume(
  basePath: string,
  runId: string,
): RecordHeadlessRunLifecycleResult {
  const opened = openExistingWorkflowDatabase(basePath)
  if (!opened.ok) return RESUME_NOOP_RESULT
  try {
    const active = findDerivedActiveMilestone(basePath)
    if (active == null) return RESUME_NOOP_RESULT

    const pausedRow = readMilestoneRunLog().find(
      (r) => r.milestoneId === active.id && r.runId === runId && r.status === 'paused',
    )
    if (!pausedRow) return RESUME_NOOP_RESULT

    const idempotencyKey = `headless-run-log/${runId}/a${pausedRow.attempt}/resume`
    const fence = readDomainOperationFence(idempotencyKey)
    executeDomainOperation({
      operationType: MILESTONE_RUN_LOG_OPERATION_TYPE,
      idempotencyKey,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: 'agent',
      actorId: 'headless-auto',
      sourceTransport: 'internal',
      payload: { entryId: pausedRow.entryId, status: 'resumed' },
    }, (context) => {
      transitionMilestoneRunLogRow(context, {
        entryId: pausedRow.entryId,
        status: 'resumed',
        resumeFrom: pausedRow.resumeFrom,
        pauseKind: pausedRow.pauseKind,
        reason: pausedRow.reason,
      })
      return {
        events: [{
          eventType: MILESTONE_RUN_LOG_EVENT_TYPE,
          entityType: 'milestone',
          entityId: active.id,
          payload: { entryId: pausedRow.entryId, status: 'resumed' },
          destinations: ['projection'],
        }],
        projections: [{
          projectionKey: `run-log/${active.id}`.toLowerCase(),
          projectionKind: 'milestone-run-log',
          rendererVersion: '1',
        }],
      }
    })

    const receipt = recordMilestoneRunLifecycle({
      invocation: internalExecutionInvocation(
        `headless-run-log/${runId}/a${pausedRow.attempt + 1}`,
        { actorId: 'headless-auto' },
      ),
      milestoneId: active.id,
      runId,
      attempt: pausedRow.attempt + 1,
      status: 'running',
      resumeFrom: pausedRow.resumeFrom,
    })
    renderMilestoneRunLog(basePath)
    return { recorded: true, milestoneId: active.id, entryId: receipt.entryId }
  } catch {
    return RESUME_NOOP_RESULT
  } finally {
    closeWorkflowDatabase()
  }
}
