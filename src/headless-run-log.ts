// Project/App: gsd-pi
// File Purpose: Host-side wrapper for recording a milestone run-log
// lifecycle transition from the headless host process (DRIVER-01).
//
// This is the phase's tracer: the FIRST write-path from `src/` into a
// Domain Operation in this repository -- every other host-side module
// (`headless-milestone-readiness.ts`, etc.) only reads. A direct sibling of
// `headless-milestone-readiness.ts`'s own open/read-or-write/close contract.

import {
  closeWorkflowDatabase,
  openExistingWorkflowDatabase,
} from './resources/extensions/gsd/db-workspace.js'
import { internalExecutionInvocation } from './resources/extensions/gsd/execution-invocation.js'
import { findDerivedActiveMilestone } from './headless-milestone-readiness.js'
import {
  recordMilestoneRunLifecycle,
} from './resources/extensions/gsd/milestone-run-log-domain-operation.js'
import type { MilestoneRunLogStatus } from './resources/extensions/gsd/db/writers/milestone-run-log.js'
import { renderMilestoneRunLog } from './resources/extensions/gsd/run-log-projection.js'

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
