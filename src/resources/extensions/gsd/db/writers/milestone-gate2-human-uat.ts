// Project/App: gsd-pi
// File Purpose: Context-bound Gate-2 human-UAT pending ledger row persistence.

import { randomUUID } from "node:crypto";

import type { DomainOperationContext } from "../domain-operation.js";
import { getDb } from "../engine.js";
import { requireActiveDomainOperationContext } from "./lifecycle-commands.js";

export interface Gate2HumanUatPartialCriterion {
  criterion: string;
  evidence: string;
  rootCause?: string;
}

export type HumanUatPendingStatus = "pending" | "signed-off" | "signed-off-with-gap";

export interface HumanUatPendingRow {
  entryId: string;
  projectId: string;
  milestoneId: string;
  sliceId: string;
  taskId: string | null;
  artifactPath: string | null;
  partialCriteria: Gate2HumanUatPartialCriterion[];
  reason: string;
  status: HumanUatPendingStatus;
  signedOffAt: string | null;
  signedOffBy: string | null;
  signoffNote: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface RegisterGate2HumanUatPendingRowInput {
  milestoneId: string;
  sliceId: string;
  taskId: string | null;
  artifactPath: string | null;
  reason: string;
  partialCriteria: Gate2HumanUatPartialCriterion[];
}

export interface RegisterGate2HumanUatPendingRowResult {
  entryId: string;
  created: boolean;
}

interface ExistingPendingRow {
  entry_id: string;
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

/**
 * Context-bound INSERT of the Gate-2 human-UAT pending ledger row. Must run
 * inside `registerGate2HumanUatPending`'s own `executeDomainOperation`
 * `mutate()` callback (D-03 #1) — never from a deferred subscriber.
 *
 * A re-registration for an already-`pending` (project, milestone, slice) is a
 * clean no-op: the partial unique index (`idx_human_uat_pending_one_open`)
 * would reject a second INSERT anyway, so this checks first and returns the
 * existing entry rather than surfacing a constraint error to the caller.
 */
export function registerGate2HumanUatPendingRow(
  context: Readonly<DomainOperationContext>,
  input: RegisterGate2HumanUatPendingRowInput,
): RegisterGate2HumanUatPendingRowResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.gate2-human-uat.require") {
    throw new Error("Gate-2 human-UAT registration requires its Domain Operation");
  }
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const sliceId = requireNonBlank(input.sliceId, "sliceId");
  const reason = requireNonBlank(input.reason, "reason");
  const taskId = requireNonBlankIfPresent(input.taskId, "taskId");
  const artifactPath = requireNonBlankIfPresent(input.artifactPath, "artifactPath");
  if (!Array.isArray(input.partialCriteria)) {
    throw new Error("partialCriteria must be an array");
  }

  const existing = getDb().prepare(`
    SELECT entry_id FROM human_uat_pending
    WHERE project_id = :project_id
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND status = 'pending'
  `).get({
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
  }) as unknown as ExistingPendingRow | undefined;
  if (existing) {
    return { entryId: existing.entry_id, created: false };
  }

  const entryId = randomUUID();
  const now = new Date().toISOString();
  getDb().prepare(`
    INSERT INTO human_uat_pending (
      entry_id, project_id, milestone_id, slice_id, task_id, artifact_path,
      partial_criteria_json, reason, status,
      signed_off_at, signed_off_by, signoff_note,
      created_at, updated_at,
      created_operation_id, created_project_revision, created_authority_epoch,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      :entry_id, :project_id, :milestone_id, :slice_id, :task_id, :artifact_path,
      :partial_criteria_json, :reason, 'pending',
      NULL, NULL, NULL,
      :created_at, :updated_at,
      :operation_id, :project_revision, :authority_epoch,
      :operation_id, :project_revision, :authority_epoch
    )
  `).run({
    ":entry_id": entryId,
    ":project_id": context.projectId,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":task_id": taskId,
    ":artifact_path": artifactPath,
    ":partial_criteria_json": JSON.stringify(input.partialCriteria),
    ":reason": reason,
    ":created_at": now,
    ":updated_at": now,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  return { entryId, created: true };
}
