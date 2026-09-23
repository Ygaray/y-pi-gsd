// Project/App: gsd-pi
// File Purpose: Context-bound milestone run-log row persistence (DRIVER-01).

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export const MILESTONE_RUN_LOG_OPERATION_TYPE = "milestone.run-log.record";

export type MilestoneRunLogStatus = "running" | "paused" | "resumed" | "completed" | "failed";

export interface MilestoneRunLogRow {
  entryId: string;
  projectId: string;
  milestoneId: string;
  runId: string;
  attempt: number;
  status: MilestoneRunLogStatus;
  resumeFrom: number | null;
  pauseKind: string | null;
  reason: string | null;
  hostPid: number;
  startedAt: string;
  updatedAt: string;
}

export interface RegisterMilestoneRunLogRowInput {
  milestoneId: string;
  runId: string;
  attempt: number;
  status: MilestoneRunLogStatus;
  resumeFrom: number | null;
  pauseKind: string | null;
  reason: string | null;
}

export interface RegisterMilestoneRunLogRowResult {
  entryId: string;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function requireNonBlankIfPresent(value: string | null, field: string): string | null {
  if (value === null) return null;
  return requireNonBlank(value, field);
}

function requirePositiveInteger(value: number, field: string): number {
  if (!Number.isInteger(value) || value < 1) {
    throw new Error(`${field} must be an integer >= 1`);
  }
  return value;
}

function requirePositiveIntegerIfPresent(value: number | null, field: string): number | null {
  if (value === null) return null;
  return requirePositiveInteger(value, field);
}

/**
 * The run-log row's identity: attempt-numbered so a pause/resume of the
 * same run creates a NEW row rather than upserting onto the existing one
 * (RESEARCH Pitfall 2). Derived here, inside the writer, rather than
 * accepted from the caller, so the attempt number can never be omitted from
 * the identity by a future call site.
 */
export function buildMilestoneRunLogEntryId(milestoneId: string, runId: string, attempt: number): string {
  return `RUN-${milestoneId}-${runId}-a${attempt}`;
}

/**
 * Context-bound INSERT of the milestone run-log row. Must run inside
 * `recordMilestoneRunLifecycle`'s own `executeDomainOperation` `mutate()`
 * callback (D-01, RESEARCH Pattern 2) -- never from a deferred subscriber.
 */
export function registerMilestoneRunLogRow(
  context: Readonly<DomainOperationContext>,
  input: RegisterMilestoneRunLogRowInput,
): RegisterMilestoneRunLogRowResult {
  if (requireActiveDomainOperationContext(context) !== MILESTONE_RUN_LOG_OPERATION_TYPE) {
    throw new Error("Milestone run-log registration requires its Domain Operation");
  }
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const runId = requireNonBlank(input.runId, "runId");
  const attempt = requirePositiveInteger(input.attempt, "attempt");
  const resumeFrom = requirePositiveIntegerIfPresent(input.resumeFrom, "resumeFrom");
  const pauseKind = requireNonBlankIfPresent(input.pauseKind, "pauseKind");
  const reason = requireNonBlankIfPresent(input.reason, "reason");

  const entryId = buildMilestoneRunLogEntryId(milestoneId, runId, attempt);
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO milestone_run_log (
      entry_id, project_id, milestone_id, run_id, attempt, status,
      resume_from, pause_kind, reason, host_pid, started_at, updated_at,
      created_operation_id, created_project_revision, created_authority_epoch,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      :entry_id, :project_id, :milestone_id, :run_id, :attempt, :status,
      :resume_from, :pause_kind, :reason, :host_pid, :started_at, :updated_at,
      :operation_id, :project_revision, :authority_epoch,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":entry_id": entryId,
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
    ":run_id": runId,
    ":attempt": attempt,
    ":status": input.status,
    ":resume_from": resumeFrom,
    ":pause_kind": pauseKind,
    ":reason": reason,
    ":host_pid": process.pid,
    ":started_at": now,
    ":updated_at": now,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { entryId };
}
