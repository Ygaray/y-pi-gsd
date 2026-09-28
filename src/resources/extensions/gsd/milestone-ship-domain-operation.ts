// Project/App: gsd-pi
// File Purpose: Replay-safe Milestone ship Domain Operation — the three-way
// gate (certify pass + audit pass + Gate-2 clean) to a terminal shipped
// status plus its immutable archive-projection snapshot.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationRequest,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { getMilestone, getMilestoneSlices, getRequirementsForMilestone } from "./db/queries.js";
import {
  describeMilestoneShipBlockers,
  readMilestoneShipAuthorization,
} from "./db/milestone-ship-readiness.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  MilestoneLifecycleValidationError,
  shipMilestoneHierarchy,
} from "./db/writers/milestone-lifecycle.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { MILESTONE_ARCHIVE_PROJECTION_KIND } from "./projection-identity.js";

export { MilestoneLifecycleValidationError };

// Locked at the plan's opening checkpoint:decision (15-01-PLAN.md OQ1) —
// module constants, never caller-supplied. "Ship" and "archive" are one
// terminal transition: milestones.status = 'shipped' IS the status, and the
// archive/{milestoneId} projection artifact IS the archival.
export const MILESTONE_SHIP_OPERATION_TYPE = "milestone.ship";
export const MILESTONE_SHIPPED_EVENT_TYPE = "milestone.shipped";
export const MILESTONE_SHIP_RENDERER_VERSION = "1";

export interface MilestoneArchiveSnapshotMilestone {
  id: string;
  title: string;
  status: string;
  completedAt: string | null;
}

export interface MilestoneArchiveSnapshotSlice {
  id: string;
  title: string;
  status: string;
  sequence: number;
  completedAt: string | null;
}

export interface MilestoneArchiveSnapshotRequirement {
  id: string;
  status: string;
  primaryOwner: string;
  supportingSlices: string;
}

/** Immutable, point-in-time capture embedded in the milestone.shipped event
 * payload (A3): no live "roadmap snapshot" projection exists to clone, so
 * ship captures its own copy inside the Domain Operation callback. Reading
 * the archive later must never re-derive this from live mutable DB state. */
export interface MilestoneArchiveSnapshot {
  milestone: MilestoneArchiveSnapshotMilestone;
  slices: MilestoneArchiveSnapshotSlice[];
  requirements: MilestoneArchiveSnapshotRequirement[];
  capturedAt: string;
}

// Deliberately carries no verdict, authorization, status, or override field —
// a caller cannot assert its own readiness (T-15-03).
export interface ShipMilestoneInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
}

export interface ShipMilestoneReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  milestoneLifecycleId: string;
  legacyStatus: string;
  shippedAt: string;
}

interface StoredShipPayload {
  milestoneLifecycleId: string;
  legacyStatus: string;
  shippedAt: string;
}

function requiredText(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new MilestoneLifecycleValidationError(`${field} must not be blank`);
  return normalized;
}

function operationRequest(
  invocation: ExecutionInvocation,
  payload: Record<string, DomainJsonValue>,
): DomainOperationRequest {
  const fence = readDomainOperationFence(invocation.idempotencyKey);
  return {
    operationType: MILESTONE_SHIP_OPERATION_TYPE,
    idempotencyKey: invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: invocation.actorType,
    ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
    sourceTransport: invocation.sourceTransport,
    ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
    ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
    payload,
  };
}

function captureMilestoneArchiveSnapshot(
  milestoneId: string,
  capturedAt: string,
): MilestoneArchiveSnapshot {
  const milestone = getMilestone(milestoneId);
  if (!milestone) {
    throw new MilestoneLifecycleValidationError(`milestone not found: ${milestoneId}`);
  }
  const slices = getMilestoneSlices(milestoneId);
  // Phase 33 / RELY-05 / D-04 read cutover: `requirements` now carries a
  // schema-level `milestone_id` column (V58), so the snapshot scopes by that
  // column directly instead of matching `primary_owner`/`supporting_slices`
  // against this milestone's slice ids. That string-matching approach bled
  // across milestones that happened to reuse a slice id (SC-3) — closed now
  // that attribution lives in the schema, not re-derived by string matching.
  const requirements = getRequirementsForMilestone(milestoneId);
  return {
    milestone: {
      id: milestone.id,
      title: milestone.title,
      status: milestone.status,
      completedAt: milestone.completed_at,
    },
    slices: slices.map((slice) => ({
      id: slice.id,
      title: slice.title,
      status: slice.status,
      sequence: slice.sequence,
      completedAt: slice.completed_at,
    })),
    requirements: requirements.map((requirement) => ({
      id: requirement.id,
      status: requirement.status,
      primaryOwner: requirement.primary_owner,
      supportingSlices: requirement.supporting_slices,
    })),
    capturedAt,
  };
}

function stringField(payload: Record<string, unknown>, field: string): string {
  const value = payload[field];
  if (typeof value !== "string") throw new Error(`Milestone ship receipt ${field} is corrupt`);
  return value;
}

function storedShipPayload(operationId: string, milestoneId: string): StoredShipPayload {
  const events = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id
      AND event_type = :event_type
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
  `).all({
    ":operation_id": operationId,
    ":event_type": MILESTONE_SHIPPED_EVENT_TYPE,
    ":milestone_id": milestoneId,
  }) as Array<Record<string, unknown>>;
  if (events.length !== 1) throw new Error("Milestone ship receipt requires one durable event");
  const parsed = JSON.parse(String(events[0]!["payload_json"])) as unknown;
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("Milestone ship receipt payload is corrupt");
  }
  const payload = parsed as Record<string, unknown>;
  return {
    milestoneLifecycleId: stringField(payload, "milestoneLifecycleId"),
    legacyStatus: stringField(payload, "legacyStatus"),
    shippedAt: stringField(payload, "shippedAt"),
  };
}

/**
 * Wire the whole ship path in one Domain Operation: the authorization read
 * and the state-transition write happen inside the SAME callback (TOCTOU-
 * safe, D-03) — a status that changed between read and write aborts via
 * shipMilestoneHierarchy's own compare-and-swap rather than overwriting.
 */
export function shipMilestone(input: ShipMilestoneInput): ShipMilestoneReceipt {
  const milestoneId = requiredText(input.milestoneId, "milestoneId");
  const operation = executeDomainOperation(
    operationRequest(input.invocation, { milestoneId }),
    (context) => {
      const authorization = readMilestoneShipAuthorization({
        projectId: context.projectId,
        milestoneId,
      });
      if (!authorization.authorized) {
        throw new MilestoneLifecycleValidationError(
          `Milestone ${milestoneId} is not authorized to ship (${describeMilestoneShipBlockers(authorization.blockers)})`,
        );
      }
      const result = shipMilestoneHierarchy(context, { milestoneId });
      const snapshot = captureMilestoneArchiveSnapshot(milestoneId, result.shippedAt);
      return {
        events: [{
          eventType: MILESTONE_SHIPPED_EVENT_TYPE,
          entityType: "milestone",
          entityId: milestoneId,
          payload: {
            milestoneLifecycleId: result.milestoneLifecycleId,
            shippedAt: result.shippedAt,
            previousLegacyStatus: result.previousLegacyStatus,
            legacyStatus: result.legacyStatus,
            certifyEventId: authorization.certifyEventId,
            certifyRevision: authorization.certifyRevision,
            auditEventId: authorization.auditEventId,
            auditRevision: authorization.auditRevision,
            snapshot: snapshot as unknown as DomainJsonValue,
            lifecycleShadowKind: result.shadow.kind,
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `archive/${milestoneId}`.toLowerCase(),
          projectionKind: MILESTONE_ARCHIVE_PROJECTION_KIND,
          rendererVersion: MILESTONE_SHIP_RENDERER_VERSION,
        }],
      };
    },
  );
  const stored = storedShipPayload(operation.operationId, milestoneId);
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
    milestoneLifecycleId: stored.milestoneLifecycleId,
    legacyStatus: stored.legacyStatus,
    shippedAt: stored.shippedAt,
  };
}
