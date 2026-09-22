// Project/App: gsd-pi
// File Purpose: Durable, replayable certify-stage verdict recording. Reuses the
// milestone-validation domain-operation machinery (recordMilestoneVerdict) under
// the locked "milestone-certify" policy so certify's evidence trail (policyId,
// operationType, event type, criterionKey namespace, projection) is genuinely
// separate from validate-milestone's — D-01/D-03.

import type { DomainJsonValue } from "./db/domain-operation.js";
import {
  MILESTONE_CERTIFY_POLICY,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
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
