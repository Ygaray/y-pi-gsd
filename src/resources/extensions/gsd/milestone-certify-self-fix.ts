// Project/App: gsd-pi
// File Purpose: Durable, per-gap self-fix cap and gate re-open for the
// certify stage (CERT-01, D-02). `countCertifySelfFixAttemptsForGap`'s
// DB-derived COUNT(*) over `workflow_domain_events` is the SOLE cap
// authority — never hook state, never a `.gsd` journal file — mirroring
// Phase 12's `countReworkBriefsForSlice` discipline but keyed per-gap, not
// per-slice, so two gaps on one slice never share a budget (RESEARCH
// Pitfall 1, T-14-09).

import {
  executeDomainOperation,
  type DomainJsonValue,
  type DomainOperationResult,
} from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { getGateDefinition } from "./gate-registry.js";
import { upsertQualityGate } from "./gsd-db.js";

/** Hard per-gap cap (D-02). Comparison is always `>=`, never `>`. */
export const CERTIFY_SELF_FIX_MAX_ATTEMPTS = 3;

export type CertifyGapClass =
  | "gate-pending"
  | "gate-flagged"
  | "gate1-record-missing"
  | "integration-gap";

/**
 * A single derived certify gap. `gapId` must be a pure, deterministic
 * function of `(gapClass, sliceId, gateId)` (see `certifyGapId` in
 * `milestone-certify-audit.ts`) — it is the sole discriminator the self-fix
 * cap counts by, so a non-deterministic id would silently reset the budget
 * on every certify pass.
 */
export interface CertifyGap {
  gapId: string;
  gapClass: CertifyGapClass;
  milestoneId: string;
  sliceId: string;
  gateId: string;
  ownerTurn: string;
  fixable: boolean;
  description: string;
  evidence: string;
}

export type CertifySelfFixDisposition = "self-fix-attempted" | "escalated";

export interface CertifySelfFixAttemptResult {
  disposition: CertifySelfFixDisposition;
  priorAttempts: number;
  cycle?: number;
  receipt?: DomainOperationResult;
}

export interface RecordCertifySelfFixAttemptInput {
  invocation: ExecutionInvocation;
  projectId: string;
  milestoneId: string;
  gap: CertifyGap;
}

function requireNonBlank(value: string, field: string): string {
  const normalized = value.trim();
  if (normalized.length === 0) throw new Error(`${field} must not be blank`);
  return normalized;
}

/**
 * Internal-only signal thrown by the mid-transaction re-check below to abort
 * the Domain Operation's write (rolling back the SQL transaction) without
 * committing an event. Caught immediately around the `executeDomainOperation`
 * call in `recordCertifySelfFixAttempt` and translated into the documented
 * `{ disposition: "escalated" }` return — this class must never escape that
 * catch, so `recordCertifySelfFixAttempt` keeps its "never throws past the
 * caller" contract even when the cap is hit by a concurrent racer between
 * the pre-check and this transaction opening.
 */
class CertifySelfFixCapExceededMidTransactionError extends Error {
  readonly attemptsAtRecheck: number;

  constructor(attemptsAtRecheck: number) {
    super(
      `certify self-fix cap reached mid-transaction `
      + `(${attemptsAtRecheck} attempt(s) already recorded, max ${CERTIFY_SELF_FIX_MAX_ATTEMPTS})`,
    );
    this.name = "CertifySelfFixCapExceededMidTransactionError";
    this.attemptsAtRecheck = attemptsAtRecheck;
  }
}

/**
 * Sole cap authority for certify's per-gap self-fix budget (D-02). Counts
 * durable `milestone.certify.self-fix-attempted` events keyed to the exact
 * `(projectId, milestoneId, sliceId, gapId)` tuple. Mirrors
 * `readOutstandingGate2HumanUat`'s `json_extract` event-head query shape —
 * never a cached field on a returned object, never a second source of truth.
 */
export function countCertifySelfFixAttemptsForGap(
  projectId: string,
  milestoneId: string,
  sliceId: string,
  gapId: string,
): number {
  const row = getDb().prepare(`
    SELECT COUNT(*) AS n
    FROM workflow_domain_events
    WHERE event_type = 'milestone.certify.self-fix-attempted'
      AND project_id = :project_id
      AND json_extract(payload_json, '$.milestoneId') = :milestone_id
      AND json_extract(payload_json, '$.sliceId') = :slice_id
      AND json_extract(payload_json, '$.gapId') = :gap_id
  `).get({
    ":project_id": projectId,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
    ":gap_id": gapId,
  }) as Record<string, unknown> | undefined;
  return Number(row?.["n"] ?? 0);
}

/**
 * Re-arm the gap's owning gate: restores the `quality_gates` row to
 * `pending` with an empty verdict so the untouched auto-loop picks the gate
 * back up. Mirrors Phase 12's `_routeAgenticGateGapClosure`, which restores
 * state rather than inventing a dispatch primitive — Phase 15 owns the
 * actual re-dispatch trigger point (RESEARCH Open Question 3).
 */
export function reopenOwningGateForGap(gap: CertifyGap, evaluatedAt: string): void {
  const definition = getGateDefinition(gap.gateId);
  const scope = definition?.scope ?? "slice";
  upsertQualityGate({
    milestoneId: gap.milestoneId,
    sliceId: gap.sliceId,
    gateId: gap.gateId,
    scope,
    taskId: "",
    status: "pending",
    verdict: "",
    rationale: `certify self-fix re-opened gate ${gap.gateId} for gap ${gap.gapId}`,
    findings: "",
    evaluatedAt,
  });
}

/**
 * Record one certify self-fix attempt for a single gap, capped hard at
 * `CERTIFY_SELF_FIX_MAX_ATTEMPTS` (D-02, T-14-08, T-14-09). The hard stop
 * happens BEFORE any write: at or over the cap, this returns a disposition
 * without opening a Domain Operation, so a 4th attempt event is never
 * produced. Under the cap, the count is re-checked again inside the
 * transaction (the concurrency-safe re-check) before the gate is reopened
 * and the attempt event committed. Every failure mode returns a disposition
 * rather than throwing past the caller, matching the Phase 12 precedent.
 */
export function recordCertifySelfFixAttempt(
  input: RecordCertifySelfFixAttemptInput,
): CertifySelfFixAttemptResult {
  const projectId = requireNonBlank(input.projectId, "projectId");
  const milestoneId = requireNonBlank(input.milestoneId, "milestoneId");
  const gap = input.gap;

  const priorAttempts = countCertifySelfFixAttemptsForGap(
    projectId, milestoneId, gap.sliceId, gap.gapId,
  );
  if (priorAttempts >= CERTIFY_SELF_FIX_MAX_ATTEMPTS) {
    return { disposition: "escalated", priorAttempts };
  }
  const cycle = priorAttempts + 1;

  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  let receipt: DomainOperationResult;
  try {
    receipt = executeDomainOperation({
      operationType: "milestone.certify.self-fix",
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
        sliceId: gap.sliceId,
        gapId: gap.gapId,
        gapClass: gap.gapClass,
        gateId: gap.gateId,
        ownerTurn: gap.ownerTurn,
        cycle,
      },
    }, (context) => {
      // Concurrency-safe re-check: abort before any write if the cap was hit
      // between the pre-check above and this transaction opening. Throwing
      // here rolls back the SQL transaction (no event, no gate reopen is
      // committed); the throw is caught immediately below and translated
      // into the documented "escalated" disposition rather than propagating
      // to the caller.
      const inTransactionCount = countCertifySelfFixAttemptsForGap(
        context.projectId, milestoneId, gap.sliceId, gap.gapId,
      );
      if (inTransactionCount >= CERTIFY_SELF_FIX_MAX_ATTEMPTS) {
        throw new CertifySelfFixCapExceededMidTransactionError(inTransactionCount);
      }
      const reopenedAt = new Date().toISOString();
      reopenOwningGateForGap(gap, reopenedAt);
      const payload: DomainJsonValue = {
        milestoneId,
        sliceId: gap.sliceId,
        gapId: gap.gapId,
        gapClass: gap.gapClass,
        gateId: gap.gateId,
        ownerTurn: gap.ownerTurn,
        cycle,
        reopenedAt,
      };
      return {
        events: [{
          eventType: "milestone.certify.self-fix-attempted",
          entityType: "milestone",
          entityId: milestoneId,
          payload,
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `certify/${milestoneId}`.toLowerCase(),
          projectionKind: "milestone-certify",
          rendererVersion: "1",
        }],
      };
    });
  } catch (error) {
    if (error instanceof CertifySelfFixCapExceededMidTransactionError) {
      return { disposition: "escalated", priorAttempts: error.attemptsAtRecheck };
    }
    throw error;
  }

  return { disposition: "self-fix-attempted", priorAttempts, cycle, receipt };
}
