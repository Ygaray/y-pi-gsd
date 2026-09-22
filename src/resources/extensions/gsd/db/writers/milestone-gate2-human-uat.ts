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

export type Gate2HumanUatDisposition = "signed-off" | "signed-off-with-gap";

export interface ResolveGate2HumanUatPendingRowInput {
  entryId: string;
  disposition: Gate2HumanUatDisposition;
  signedOffBy: string | null;
  note: string | null;
  resolvedAt: string;
}

export interface ResolveGate2HumanUatPendingRowResult {
  milestoneId: string;
  sliceId: string;
}

export interface DrainGate2HumanUatOutboxInput {
  entryId: string;
  deliveredAt: string;
}

interface ExistingPendingRow {
  entry_id: string;
}

interface PendingRowForResolve {
  milestone_id: string;
  slice_id: string;
  status: string;
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

/**
 * Context-bound status flip of a Gate-2 human-UAT pending row. Must run
 * inside `resolveGate2HumanUatPending`'s own `executeDomainOperation`
 * `mutate()` callback, mirroring `registerGate2HumanUatPendingRow`'s guard.
 *
 * Identity columns are deliberately absent from the SET list —
 * `trg_human_uat_pending_identity_immutable` aborts on them — and the
 * pre-read throws distinct named errors for "no such entry" and "not
 * pending" before any UPDATE runs, so an unknown or already-resolved
 * entryId never reaches the trigger-guarded UPDATE at all.
 */
export function resolveGate2HumanUatPendingRow(
  context: Readonly<DomainOperationContext>,
  input: ResolveGate2HumanUatPendingRowInput,
): ResolveGate2HumanUatPendingRowResult {
  if (requireActiveDomainOperationContext(context) !== "milestone.gate2-human-uat.resolve") {
    throw new Error("Gate-2 human-UAT resolution requires its Domain Operation");
  }
  const entryId = requireNonBlank(input.entryId, "entryId");
  if (input.disposition !== "signed-off" && input.disposition !== "signed-off-with-gap") {
    throw new Error("disposition must be 'signed-off' or 'signed-off-with-gap'");
  }
  const signedOffBy = requireNonBlankIfPresent(input.signedOffBy, "signedOffBy");
  const note = requireNonBlankIfPresent(input.note, "note");
  const resolvedAt = requireNonBlank(input.resolvedAt, "resolvedAt");

  const existing = getDb().prepare(`
    SELECT milestone_id, slice_id, status FROM human_uat_pending WHERE entry_id = :entry_id
  `).get({ ":entry_id": entryId }) as unknown as PendingRowForResolve | undefined;
  if (!existing) {
    throw new Error(`Gate-2 human-UAT entry not found: ${entryId}`);
  }
  if (existing.status !== "pending") {
    throw new Error(`Gate-2 human-UAT entry is not pending (status: ${existing.status}): ${entryId}`);
  }

  const updated = getDb().prepare(`
    UPDATE human_uat_pending
    SET status = :status,
        signed_off_at = :resolved_at,
        signed_off_by = :signed_off_by,
        signoff_note = :note,
        updated_at = :resolved_at,
        last_operation_id = :operation_id,
        last_project_revision = :project_revision,
        last_authority_epoch = :authority_epoch
    WHERE entry_id = :entry_id AND status = 'pending'
  `).run({
    ":status": input.disposition,
    ":resolved_at": resolvedAt,
    ":signed_off_by": signedOffBy,
    ":note": note,
    ":entry_id": entryId,
    ":operation_id": context.operationId,
    ":project_revision": context.resultingRevision,
    ":authority_epoch": context.resultingAuthorityEpoch,
  });
  if (Number((updated as { changes?: number }).changes ?? 0) !== 1) {
    throw new Error(`Gate-2 human-UAT resolution must update exactly one pending entry: ${entryId}`);
  }

  return { milestoneId: existing.milestone_id, sliceId: existing.slice_id };
}

/**
 * The first `workflow_outbox` settlement written in this repository
 * (RESEARCH Pitfall 1). An additive UPDATE, never a DELETE —
 * `trg_workflow_outbox_delete` aborts deletes. The `IN` subquery (rather
 * than a single `event_id` parameter) settles every un-delivered outbox row
 * belonging to this entry's `milestone.gate2-human-uat-required` event(s)
 * together, so a repeat registration can never leave one un-drained row
 * blocking the close forever.
 */
export function drainGate2HumanUatOutbox(
  context: Readonly<DomainOperationContext>,
  input: DrainGate2HumanUatOutboxInput,
): number {
  const entryId = requireNonBlank(input.entryId, "entryId");
  const deliveredAt = requireNonBlank(input.deliveredAt, "deliveredAt");
  const result = getDb().prepare(`
    UPDATE workflow_outbox
    SET delivered_at = :delivered_at
    WHERE delivered_at IS NULL
      AND event_id IN (
        SELECT event_id FROM workflow_domain_events
        WHERE event_type = 'milestone.gate2-human-uat-required'
          AND project_id = :project_id
          AND json_extract(payload_json, '$.entryId') = :entry_id
      )
  `).run({
    ":delivered_at": deliveredAt,
    ":project_id": context.projectId,
    ":entry_id": entryId,
  });
  return Number((result as { changes?: number }).changes ?? 0);
}
