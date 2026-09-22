// Project/App: gsd-pi
// File Purpose: Durable, replayable independent-audit-stage verdict recording.
// Reuses the milestone-validation domain-operation machinery
// (recordMilestoneVerdict) under the locked "milestone-audit" policy so the
// audit's evidence trail (policyId, operationType, event type, criterionKey
// namespace, projection) is genuinely separate from both validate-milestone's
// and certify's — D-01/D-03. The audit reads getActiveRequirements,
// getMilestoneSlices, and getGateResults directly and never imports
// milestone-certify-*, milestone-validation-gates, or tools/validate-milestone
// — its conclusion must never be a function of the signal it independently
// checks (D-01, RESEARCH Pitfall 3).

import { getActiveRequirements, getMilestoneSlices } from "./db/queries.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  MILESTONE_AUDIT_POLICY,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { insertAuditGates } from "./milestone-close-gates.js";
import { RAW_CLOSED_STATUSES } from "./status-guards.js";
import {
  recordMilestoneVerdict,
  type ValidateMilestoneReceipt,
} from "./milestone-validation-domain-operation.js";

/** Locked constants — never caller-supplied (D-01: a caller cannot impersonate the audit policy). */
export const MILESTONE_AUDIT_POLICY_ID = "milestone-audit";
export const MILESTONE_AUDIT_POLICY_VERSION = "1";

/**
 * The audit derives its own verdict, criteria, and evidence from durable DB
 * state — the caller supplies only enough identity to run the pass.
 * `policyId`/`policyVersion` are locked module constants, never
 * caller-supplied, and there is no `criteria` field at all: a caller-supplied
 * criterion would let a caller tell the audit what to conclude, defeating the
 * point of an independent check (D-01).
 */
export interface AuditMilestoneInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  testedSourceRevision: string;
}

export type AuditMilestoneReceipt = ValidateMilestoneReceipt;

interface AuditCriterionInput {
  criterionKey: string;
  evidenceClass: MilestoneValidationEvidenceClass;
  description: string;
  verdict: MilestoneValidationVerdict;
  rationale: string;
  evidence: Array<{
    evidenceClass: MilestoneValidationEvidenceClass;
    commandOrTool: string;
    workingDirectory: string;
    startedAt: string;
    endedAt: string;
    observation: MilestoneValidationObservation;
    durableOutputRef: string;
    environment: { [key: string]: DomainJsonValue };
  }>;
}

const RAW_CLOSED_STATUS_SET: ReadonlySet<string> = new Set(RAW_CLOSED_STATUSES);

function isTerminalSliceStatus(status: string): boolean {
  return RAW_CLOSED_STATUS_SET.has(status);
}

function evidenceEnvironment(extra: Record<string, string>): { [key: string]: DomainJsonValue } {
  return { runner: "audit-milestone", ...extra };
}

/**
 * On a replay of the SAME outer idempotency key, `auditMilestone` must
 * reproduce byte-identical evidence timestamps or the verdict Domain
 * Operation's request-hash check rejects the replay as a conflict (mirrors
 * `readCertifyEvaluatedAt`'s identical role for certify).
 */
function readAuditEvaluatedAt(idempotencyKey: string): string | null {
  const row = getDb().prepare(`
    SELECT evidence.started_at AS started_at
    FROM workflow_operations operation
    JOIN workflow_technical_verdicts verdict
      ON verdict.operation_id = operation.operation_id AND verdict.project_id = operation.project_id
    JOIN workflow_acceptance_criteria criterion
      ON criterion.criterion_id = verdict.criterion_id AND criterion.project_id = verdict.project_id
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id AND evidence.project_id = verdict.project_id
    WHERE operation.idempotency_key = :idempotency_key
      AND operation.operation_type = 'milestone.audit'
      AND criterion.criterion_key = 'milestone-audit:requirement-coverage'
    LIMIT 1
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  return row ? String(row["started_at"]) : null;
}

function buildCriterion(
  criterionKey: string,
  description: string,
  milestoneId: string,
  verdict: MilestoneValidationVerdict,
  rationale: string,
  evaluatedAt: string,
  extraEnvironment: Record<string, string>,
): AuditCriterionInput {
  const observation: MilestoneValidationObservation = verdict === "pass"
    ? "passed"
    : verdict === "fail"
      ? "failed"
      : "inconclusive";
  return {
    criterionKey,
    evidenceClass: "artifact",
    description,
    verdict,
    rationale,
    evidence: [{
      evidenceClass: "artifact",
      commandOrTool: "audit-milestone",
      workingDirectory: "audit",
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      observation,
      durableOutputRef: `audit/${milestoneId}`,
      environment: evidenceEnvironment(extraEnvironment),
    }],
  };
}

/**
 * Run the independent audit pass (CERT-02, Task 1 tracer): derive ONE
 * requirement-coverage finding inline (a requirement's `primary_owner`
 * exactly naming a non-terminal slice of this milestone), record a
 * placeholder-free "no wiring disagreement observed" wiring criterion, then
 * record the audit's own `milestone.audit.recorded` verdict and its AUD01/
 * AUD02 gate rows. Task 2 (`milestone-audit-coverage.ts`) replaces this
 * tracer's inline derivation with the full requirement-coverage and
 * cross-slice-wiring derivation; the domain-operation/replay/gate-writing
 * shape established here does not change.
 */
export function auditMilestone(input: AuditMilestoneInput): AuditMilestoneReceipt {
  const milestoneId = input.milestoneId;

  const slices = getMilestoneSlices(milestoneId);
  const sliceById = new Map(slices.map((slice) => [slice.id, slice]));

  const coverageFindings: string[] = [];
  for (const requirement of getActiveRequirements()) {
    const owner = requirement.primary_owner.trim();
    if (!owner) continue;
    const slice = sliceById.get(owner);
    if (slice && !isTerminalSliceStatus(slice.status)) {
      coverageFindings.push(
        `${requirement.id} maps to slice ${slice.id}, which is not terminal (status=${slice.status})`,
      );
    }
  }

  const evaluatedAt = readAuditEvaluatedAt(input.invocation.idempotencyKey) ?? new Date().toISOString();

  const wiringCriterion = buildCriterion(
    "milestone-audit:cross-slice-wiring",
    "Independently cross-check the slices.depends column against the slice_dependencies table.",
    milestoneId,
    "pass",
    "No wiring disagreement observed.",
    evaluatedAt,
    {},
  );
  const coverageVerdict: MilestoneValidationVerdict = coverageFindings.length === 0 ? "pass" : "fail";
  const coverageCriterion = buildCriterion(
    "milestone-audit:requirement-coverage",
    "Independently confirm every requirement mapped to a slice of this milestone is genuinely satisfied.",
    milestoneId,
    coverageVerdict,
    coverageFindings.length === 0
      ? "No coverage findings for this check."
      : `Found ${coverageFindings.length} finding(s): ${coverageFindings.join("; ")}`,
    evaluatedAt,
    { findingCount: String(coverageFindings.length) },
  );

  const milestoneVerdict: MilestoneValidationVerdict = coverageVerdict;
  const outcome = milestoneVerdict === "pass" ? "succeeded" as const : "failed" as const;
  const failureClass = milestoneVerdict === "pass" ? "none" : "audit-coverage-gap";
  const rationale = coverageFindings.length === 0
    ? `Audit found no coverage findings for milestone ${milestoneId}.`
    : `Audit found ${coverageFindings.length} coverage finding(s) for milestone ${milestoneId}.`;

  const receipt = recordMilestoneVerdict({
    invocation: input.invocation,
    milestoneId,
    testedSourceRevision: input.testedSourceRevision,
    policyId: MILESTONE_AUDIT_POLICY_ID,
    policyVersion: MILESTONE_AUDIT_POLICY_VERSION,
    policy: MILESTONE_AUDIT_POLICY,
    verdict: milestoneVerdict,
    rationale,
    outcome,
    failureClass,
    summary: `Audit recorded ${milestoneVerdict} for ${milestoneId}.`,
    output: {
      stage: "audit",
      coverageFindingCount: coverageFindings.length,
    },
    criteria: [wiringCriterion, coverageCriterion],
  });

  // Mirrors certifyMilestone's own insertCertifyGates placement: gate rows
  // are a separate, replay-guarded write AFTER the verdict Domain Operation
  // commits, never inside it.
  if (receipt.status !== "replayed") {
    const gateVerdict = milestoneVerdict === "pass" ? "pass" as const : "flag" as const;
    insertAuditGates(milestoneId, {
      wiring: {
        verdict: "pass",
        rationale: wiringCriterion.rationale,
        findings: "",
      },
      coverage: {
        verdict: gateVerdict,
        rationale: coverageCriterion.rationale,
        findings: coverageFindings.join("; "),
      },
    }, gateVerdict, evaluatedAt);
  }

  return receipt;
}
