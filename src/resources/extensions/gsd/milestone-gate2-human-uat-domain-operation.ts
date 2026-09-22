// Project/App: gsd-pi
// File Purpose: Durable Gate-2 human-UAT pending ledger registration and the
// event-head read the milestone close guard uses (LEDGER-01/02/03).

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  registerGate2HumanUatPendingRow,
  type Gate2HumanUatPartialCriterion,
} from "./db/writers/milestone-gate2-human-uat.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export interface RegisterGate2HumanUatPendingInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sliceId: string;
  taskId?: string;
  artifactPath?: string;
  reason: string;
  partialCriteria: Gate2HumanUatPartialCriterion[];
}

export interface Gate2HumanUatRegistrationReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  entryId: string;
  created: boolean;
}

export interface OutstandingGate2HumanUat {
  entryId: string;
  milestoneId: string;
  sliceId: string;
  eventId: string;
}

interface RegisteredEventPayload {
  entryId: string;
  created: boolean;
}

interface OutstandingRow {
  event_id: string;
  entry_id: string;
  milestone_id: string;
  slice_id: string;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

function operationReceipt(operation: DomainOperationResult) {
  return {
    status: operation.status,
    operationId: operation.operationId,
    resultingRevision: operation.resultingRevision,
    resultingAuthorityEpoch: operation.resultingAuthorityEpoch,
    eventIds: operation.eventIds,
    outboxIds: operation.outboxIds,
    projectionWorkIds: operation.projectionWorkIds,
  };
}

/**
 * On an idempotent replay, `executeDomainOperation`'s `mutate()` callback
 * does not run — the registered entryId must be recovered from the durable
 * event payload instead (mirrors `storedPreparation`/`storedWaiver` in the
 * sibling subjective-UAT / validation-waiver operations).
 */
function storedRegistration(operationId: string): RegisteredEventPayload {
  const row = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = 'milestone.gate2-human-uat-required'
  `).get({ ":operation_id": operationId }) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Gate-2 human-UAT registration receipt is missing");
  const payload = JSON.parse(String(row["payload_json"])) as Record<string, unknown>;
  const entryId = payload["entryId"];
  if (typeof entryId !== "string" || entryId.trim().length === 0) {
    throw new Error("Gate-2 human-UAT registration receipt entryId is invalid");
  }
  return { entryId, created: false };
}

/**
 * Register a Gate-2 human-UAT pending entry: ONE Domain Operation transaction
 * commits the `human_uat_pending` row, the `milestone.gate2-human-uat-required`
 * domain event, and that event's `workflow_outbox` row atomically (D-03 #1).
 * Host-side only — never call this from the agentic-tester subagent's own
 * tool surface (LEDGER-02, T-13-01).
 */
export function registerGate2HumanUatPending(
  input: RegisterGate2HumanUatPendingInput,
): Gate2HumanUatRegistrationReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const sliceId = requireNonBlank(input.sliceId, "sliceId");
  const reason = requireNonBlank(input.reason, "reason");
  const taskId = input.taskId === undefined ? null : requireNonBlank(input.taskId, "taskId");
  const artifactPath = input.artifactPath === undefined
    ? null
    : requireNonBlank(input.artifactPath, "artifactPath");
  if (!Array.isArray(input.partialCriteria)) {
    throw new Error("partialCriteria must be an array");
  }
  const partialCriteria = input.partialCriteria;

  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let registered: RegisteredEventPayload | undefined;
  const operation = executeDomainOperation({
    operationType: "milestone.gate2-human-uat.require",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      milestoneId,
      sliceId,
      taskId,
      artifactPath,
      reason,
      partialCriteria: partialCriteria as unknown as DomainJsonValue,
    },
  }, (context) => {
    const result = registerGate2HumanUatPendingRow(context, {
      milestoneId,
      sliceId,
      taskId,
      artifactPath,
      reason,
      partialCriteria,
    });
    registered = { entryId: result.entryId, created: result.created };
    const eventPayload: DomainJsonValue = {
      entryId: result.entryId,
      milestoneId,
      sliceId,
      taskId,
      artifactPath,
      reason,
      partialCriteria: partialCriteria as unknown as DomainJsonValue,
    };
    return {
      events: [{
        eventType: "milestone.gate2-human-uat-required",
        entityType: "milestone",
        entityId: milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `human-uat-pending/${milestoneId}/${sliceId}`.toLowerCase(),
        projectionKind: "human-uat-pending",
        rendererVersion: "1",
      }],
    };
  });

  const stored = registered ?? storedRegistration(operation.operationId);
  return {
    ...operationReceipt(operation),
    entryId: stored.entryId,
    created: stored.created,
  };
}

/**
 * The milestone close guard's EVENT-HEAD read (D-03 #3) — never reads
 * `human_uat_pending`. An entry is outstanding when EITHER trip-wire fires:
 * (a) no `milestone.gate2-human-uat-resolved` event yet carries the matching
 * `entryId`, OR (b) an un-delivered `workflow_outbox` row still exists for the
 * requiring event. De-duplicated by `entryId`, keeping the earliest.
 */
export function readOutstandingGate2HumanUat(input: {
  projectId: string;
  milestoneId: string;
}): OutstandingGate2HumanUat[] {
  const rows = getDb().prepare(`
    SELECT
      event.event_id AS event_id,
      json_extract(event.payload_json, '$.entryId') AS entry_id,
      json_extract(event.payload_json, '$.milestoneId') AS milestone_id,
      json_extract(event.payload_json, '$.sliceId') AS slice_id
    FROM workflow_domain_events event
    WHERE event.event_type = 'milestone.gate2-human-uat-required'
      AND event.project_id = :project_id
      AND event.entity_id = :milestone_id
      AND (
        NOT EXISTS (
          SELECT 1 FROM workflow_domain_events resolution
          WHERE resolution.event_type = 'milestone.gate2-human-uat-resolved'
            AND resolution.project_id = event.project_id
            AND json_extract(resolution.payload_json, '$.entryId')
              = json_extract(event.payload_json, '$.entryId')
        )
        OR EXISTS (
          SELECT 1 FROM workflow_outbox outbox
          WHERE outbox.event_id = event.event_id
            AND outbox.delivered_at IS NULL
        )
      )
    ORDER BY event.created_at ASC, event.event_index ASC
  `).all({
    ":project_id": input.projectId,
    ":milestone_id": input.milestoneId,
  }) as unknown as OutstandingRow[];

  const seen = new Set<string>();
  const outstanding: OutstandingGate2HumanUat[] = [];
  for (const row of rows) {
    if (seen.has(row.entry_id)) continue;
    seen.add(row.entry_id);
    outstanding.push({
      entryId: row.entry_id,
      milestoneId: row.milestone_id,
      sliceId: row.slice_id,
      eventId: row.event_id,
    });
  }
  return outstanding;
}
