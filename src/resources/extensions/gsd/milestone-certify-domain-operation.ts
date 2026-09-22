// Project/App: gsd-pi
// File Purpose: Durable, replayable certify-stage verdict recording. Reuses the
// milestone-validation domain-operation machinery (recordMilestoneVerdict) under
// the locked "milestone-certify" policy so certify's evidence trail (policyId,
// operationType, event type, criterionKey namespace, projection) is genuinely
// separate from validate-milestone's — D-01/D-03.

import type { DomainJsonValue } from "./db/domain-operation.js";
import type { Gate2HumanUatPartialCriterion } from "./db/writers/milestone-gate2-human-uat.js";
import {
  MILESTONE_CERTIFY_POLICY,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  registerGate2HumanUatPending,
  type Gate2HumanUatRegistrationReceipt,
} from "./milestone-gate2-human-uat-domain-operation.js";
import type { CertifyGap } from "./milestone-certify-self-fix.js";
import {
  recordMilestoneVerdict,
  type ValidateMilestoneReceipt,
} from "./milestone-validation-domain-operation.js";

/** Locked constants — never caller-supplied (D-01: a caller cannot impersonate the validation policy). */
export const MILESTONE_CERTIFY_POLICY_ID = "milestone-certify";
export const MILESTONE_CERTIFY_POLICY_VERSION = "1";

export interface CertifyMilestoneEvidenceInput {
  evidenceClass: MilestoneValidationEvidenceClass;
  commandOrTool: string;
  workingDirectory: string;
  startedAt: string;
  endedAt: string;
  exitCode?: number;
  observation: MilestoneValidationObservation;
  durableOutputRef: string;
  environment: { [key: string]: DomainJsonValue };
}

export interface CertifyMilestoneCriterionInput {
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  description: string;
  required?: boolean;
  requirementId?: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: CertifyMilestoneEvidenceInput[];
}

/**
 * Mirrors `ValidateMilestoneInput` but deliberately omits `policyId`/
 * `policyVersion` — those are locked module constants for certify, not a
 * caller-supplied free string (D-01/T-14-01).
 */
export interface CertifyMilestoneInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  testedSourceRevision: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  outcome: "succeeded" | "failed" | "interrupted";
  failureClass: string;
  summary: string;
  output: DomainJsonValue;
  criteria: CertifyMilestoneCriterionInput[];
}

export type CertifyMilestoneReceipt = ValidateMilestoneReceipt;

export function certifyMilestone(input: CertifyMilestoneInput): CertifyMilestoneReceipt {
  return recordMilestoneVerdict({
    ...input,
    policyId: MILESTONE_CERTIFY_POLICY_ID,
    policyVersion: MILESTONE_CERTIFY_POLICY_VERSION,
    policy: MILESTONE_CERTIFY_POLICY,
  });
}

/** Every gap certify derives lands in exactly one of these buckets — none may vanish. */
export type CertifyGapDisposition = "self-fix-attempted" | "escalated" | "already-escalated";

/**
 * A gap bundled for escalation, carrying whatever cap/attempt context the
 * caller already has (e.g. a cap-exhausted fixable gap's attempt count) so
 * `escalateCertifyGapsToGate2` can name it in the Gate-2 `rootCause` without
 * certify's audit read (`CertifyGap`) needing to carry mutable state itself.
 */
export interface CertifyEscalationGap {
  gap: CertifyGap;
  /** Present only for cap-exhausted fixable gaps; omitted for non-fixable classes. */
  attemptCount?: number;
}

export interface EscalateCertifyGapsToGate2Input {
  invocation: ExecutionInvocation;
  milestoneId: string;
  sliceId: string;
  gaps: ReadonlyArray<CertifyEscalationGap | CertifyGap>;
}

export interface EscalateCertifyGapsToGate2Result {
  disposition: "escalated" | "already-escalated";
  entryId: string;
  receipt: Gate2HumanUatRegistrationReceipt;
}

function normalizeEscalationGap(entry: CertifyEscalationGap | CertifyGap): CertifyEscalationGap {
  return "gap" in entry ? entry : { gap: entry };
}

function escalationRootCause(entry: CertifyEscalationGap): string {
  return entry.attemptCount === undefined
    ? entry.gap.gapClass
    : `${entry.gap.gapClass} (self-fix cap exhausted at ${entry.attemptCount} attempt(s))`;
}

/**
 * Batch EVERY escalating gap for ONE slice into a SINGLE
 * `registerGate2HumanUatPending` call (T-14-11): `idx_human_uat_pending_one_open`
 * permits only one open entry per (project, milestone, slice), so a per-gap
 * call would silently drop every gap after the first. Host-side only — never
 * added to any subagent tool surface (T-14-12).
 */
export function escalateCertifyGapsToGate2(
  input: EscalateCertifyGapsToGate2Input,
): EscalateCertifyGapsToGate2Result {
  const entries = input.gaps.map(normalizeEscalationGap);
  const gapSummary = entries.map((entry) => `${entry.gap.gapClass}:${entry.gap.gapId}`).join(", ");
  const reason = `certify escalation for ${input.milestoneId}/${input.sliceId}: `
    + `${entries.length} gap(s) requiring human review (${gapSummary})`;
  const partialCriteria: Gate2HumanUatPartialCriterion[] = entries.map((entry) => ({
    criterion: entry.gap.description,
    evidence: entry.gap.evidence,
    rootCause: escalationRootCause(entry),
  }));

  const receipt = registerGate2HumanUatPending({
    invocation: input.invocation,
    milestoneId: input.milestoneId,
    sliceId: input.sliceId,
    reason,
    partialCriteria,
  });

  return {
    disposition: receipt.created ? "escalated" : "already-escalated",
    entryId: receipt.entryId,
    receipt,
  };
}
