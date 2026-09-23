// Project/App: gsd-pi
// File Purpose: Durable milestone run-log lifecycle recording (DRIVER-01).
//
// This is the phase's tracer: `recordMilestoneRunLifecycle` is the FIRST
// write-path from the headless host process (`src/headless-run-log.ts`)
// into a Domain Operation in this repository -- every prior host-side
// module (`headless-milestone-readiness.ts`, etc.) only reads.

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  registerMilestoneRunLogRow,
  MILESTONE_RUN_LOG_OPERATION_TYPE,
  type MilestoneRunLogStatus,
} from "./db/writers/milestone-run-log.js";
import type { ExecutionInvocation } from "./execution-invocation.js";

export { MILESTONE_RUN_LOG_OPERATION_TYPE };
export const MILESTONE_RUN_LOG_EVENT_TYPE = "milestone.run-log.recorded";

export interface RecordMilestoneRunLifecycleInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  runId: string;
  attempt: number;
  status: MilestoneRunLogStatus;
  resumeFrom?: number | null;
  pauseKind?: string | null;
  reason?: string | null;
}

export interface MilestoneRunLifecycleReceipt {
  status: "committed" | "replayed";
  operationId: string;
  resultingRevision: number;
  resultingAuthorityEpoch: number;
  eventIds: string[];
  outboxIds: number[];
  projectionWorkIds: string[];
  entryId: string;
}

interface RecordedRunLogPayload {
  entryId: string;
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
 * does not run -- the registered entryId must be recovered from the durable
 * event payload instead (mirrors `storedRegistration` in the Gate-2 sibling
 * operation).
 */
function storedRunLogRecord(operationId: string): RecordedRunLogPayload {
  const row = getDb().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = :operation_id AND event_type = :event_type
  `).get({
    ":operation_id": operationId,
    ":event_type": MILESTONE_RUN_LOG_EVENT_TYPE,
  }) as Record<string, unknown> | undefined;
  if (!row) throw new Error("Milestone run-log recording receipt is missing");
  const payload = JSON.parse(String(row["payload_json"])) as Record<string, unknown>;
  const entryId = payload["entryId"];
  if (typeof entryId !== "string" || entryId.trim().length === 0) {
    throw new Error("Milestone run-log recording receipt entryId is invalid");
  }
  return { entryId };
}

/**
 * Record a milestone run-log lifecycle transition: ONE Domain Operation
 * transaction commits the `milestone_run_log` row and the
 * `milestone.run-log.recorded` event atomically (D-01, RESEARCH Pattern 2).
 * Host-side only -- called from `src/headless-run-log.ts`, never from an
 * agent-callable tool surface.
 */
export function recordMilestoneRunLifecycle(
  input: RecordMilestoneRunLifecycleInput,
): MilestoneRunLifecycleReceipt {
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const runId = requireNonBlank(input.runId, "runId");
  if (!Number.isInteger(input.attempt) || input.attempt < 1) {
    throw new Error("attempt must be an integer >= 1");
  }
  const attempt = input.attempt;
  const resumeFrom = input.resumeFrom ?? null;
  const pauseKind = input.pauseKind ?? null;
  const reason = input.reason ?? null;

  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let recorded: RecordedRunLogPayload | undefined;
  const operation = executeDomainOperation({
    operationType: MILESTONE_RUN_LOG_OPERATION_TYPE,
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
      runId,
      attempt,
      status: input.status,
      resumeFrom,
      pauseKind,
      reason,
    },
  }, (context) => {
    const result = registerMilestoneRunLogRow(context, {
      milestoneId,
      runId,
      attempt,
      status: input.status,
      resumeFrom,
      pauseKind,
      reason,
    });
    recorded = { entryId: result.entryId };
    const eventPayload: DomainJsonValue = {
      entryId: result.entryId,
      milestoneId,
      runId,
      attempt,
      status: input.status,
      resumeFrom,
      pauseKind,
      reason,
    };
    return {
      events: [{
        eventType: MILESTONE_RUN_LOG_EVENT_TYPE,
        entityType: "milestone",
        entityId: milestoneId,
        payload: eventPayload,
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: `run-log/${milestoneId}`.toLowerCase(),
        projectionKind: "milestone-run-log",
        rendererVersion: "1",
      }],
    };
  });

  const stored = recorded ?? storedRunLogRecord(operation.operationId);
  return {
    ...operationReceipt(operation),
    entryId: stored.entryId,
  };
}
