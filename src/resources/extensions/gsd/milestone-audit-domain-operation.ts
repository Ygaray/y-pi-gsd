// Project/App: gsd-pi
// File Purpose: Durable, replayable independent-audit-stage verdict recording.
// Reuses the milestone-validation domain-operation machinery
// (recordMilestoneVerdict) under the locked "milestone-audit" policy so the
// audit's evidence trail (policyId, operationType, event type, criterionKey
// namespace, projection) is genuinely separate from both validate-milestone's
// and certify's — D-01/D-03. The audit's actual coverage/wiring re-derivation
// lives in `milestone-audit-coverage.ts`; this file wires that derivation
// through the shared verdict-recording machinery. Never imports
// milestone-certify-*, milestone-validation-gates, or tools/validate-milestone
// — the audit's conclusion must never be a function of the signal it
// independently checks (D-01, RESEARCH Pitfall 3).

import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import {
  MILESTONE_AUDIT_POLICY,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import {
  auditCrossSliceWiring,
  auditRequirementCoverage,
  type CrossSliceWiringFinding,
  type CrossSliceWiringFindingClass,
  type RequirementCoverageFinding,
  type RequirementCoverageFindingClass,
} from "./milestone-audit-coverage.js";
import { insertAuditGates } from "./milestone-close-gates.js";
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

function tallyByClass<T extends string>(classes: readonly T[]): string {
  if (classes.length === 0) return "none";
  const counts = new Map<T, number>();
  for (const cls of classes) counts.set(cls, (counts.get(cls) ?? 0) + 1);
  return [...counts.entries()].map(([cls, count]) => `${cls}=${count}`).join(", ");
}

function coverageRationale(
  requirementsExamined: number,
  mappedRequirementCount: number,
  findings: RequirementCoverageFinding[],
): string {
  const breakdown = tallyByClass(findings.map((f) => f.findingClass));
  if (mappedRequirementCount === 0) {
    return `Examined ${requirementsExamined} requirement(s); 0 mapped to a slice of this milestone `
      + `(zero requirements mapped) — coverage is inconclusive. Findings by class: ${breakdown}.`;
  }
  return `Examined ${requirementsExamined} requirement(s), ${mappedRequirementCount} mapped to a slice of this milestone. `
    + `${findings.length} finding(s). Findings by class: ${breakdown}.`;
}

function wiringRationale(findings: CrossSliceWiringFinding[]): string {
  const breakdown = tallyByClass(findings.map((f) => f.findingClass));
  return findings.length === 0
    ? "No wiring disagreement observed between slices.depends and slice_dependencies."
    : `Found ${findings.length} wiring disagreement(s) between slices.depends and slice_dependencies. `
      + `Findings by class: ${breakdown}.`;
}

function findingsText<T extends { detail: string }>(findings: T[]): string {
  return findings.map((f) => f.detail).join("; ");
}

/**
 * The overall milestone verdict is computed by the SAME fail > inconclusive >
 * pass priority the shared writer's own `aggregateVerdict` uses internally
 * (`db/writers/milestone-validation.ts`) — recordMilestoneVerdict rejects a
 * verdict that does not match the aggregate of its criteria's own verdicts,
 * so this function's result must always agree with `worstVerdict(wiring,
 * coverage)` below.
 */
function worstVerdict(...verdicts: MilestoneValidationVerdict[]): MilestoneValidationVerdict {
  if (verdicts.some((v) => v === "fail")) return "fail";
  if (verdicts.some((v) => v === "inconclusive")) return "inconclusive";
  return "pass";
}

/**
 * Run the independent audit pass (CERT-02): independently re-derive
 * cross-slice wiring (AUD01, `auditCrossSliceWiring`) and requirement
 * coverage (AUD02, `auditRequirementCoverage`) from durable DB state, record
 * the audit's own `milestone.audit.recorded` verdict, and write its AUD01/
 * AUD02 gate rows. `inconclusive` when zero requirements mapped to any slice
 * of this milestone (never `pass`); `fail` when any coverage or wiring
 * finding exists; `pass` only when at least one requirement mapped and no
 * finding exists.
 */
export function auditMilestone(input: AuditMilestoneInput): AuditMilestoneReceipt {
  const milestoneId = input.milestoneId;

  const coverage = auditRequirementCoverage({ milestoneId });
  const wiringFindings = auditCrossSliceWiring({ milestoneId });

  const evaluatedAt = readAuditEvaluatedAt(input.invocation.idempotencyKey) ?? new Date().toISOString();

  const coverageVerdict: MilestoneValidationVerdict = coverage.mappedRequirementCount === 0
    ? "inconclusive"
    : coverage.findings.length > 0
      ? "fail"
      : "pass";
  const wiringVerdict: MilestoneValidationVerdict = wiringFindings.length > 0 ? "fail" : "pass";

  const wiringCriterion = buildCriterion(
    "milestone-audit:cross-slice-wiring",
    "Independently cross-check the slices.depends column against the slice_dependencies table.",
    milestoneId,
    wiringVerdict,
    wiringRationale(wiringFindings),
    evaluatedAt,
    { findingCount: String(wiringFindings.length) },
  );
  const coverageCriterion = buildCriterion(
    "milestone-audit:requirement-coverage",
    "Independently confirm every requirement mapped to a slice of this milestone is genuinely satisfied.",
    milestoneId,
    coverageVerdict,
    coverageRationale(coverage.requirementsExamined, coverage.mappedRequirementCount, coverage.findings),
    evaluatedAt,
    { findingCount: String(coverage.findings.length) },
  );

  const milestoneVerdict = worstVerdict(wiringVerdict, coverageVerdict);
  const outcome = milestoneVerdict === "pass" ? "succeeded" as const : "failed" as const;
  const failureClass = milestoneVerdict === "pass"
    ? "none"
    : milestoneVerdict === "inconclusive"
      ? "audit-no-requirements-mapped"
      : "audit-finding";
  const rationale = `Audit recorded ${milestoneVerdict} for ${milestoneId}: `
    + `${coverage.findings.length} coverage finding(s), ${wiringFindings.length} wiring finding(s).`;

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
      coverageFindingCount: coverage.findings.length,
      wiringFindingCount: wiringFindings.length,
      mappedRequirementCount: coverage.mappedRequirementCount,
    },
    criteria: [wiringCriterion, coverageCriterion],
  });

  // Mirrors certifyMilestone's own insertCertifyGates placement: gate rows
  // are a separate, replay-guarded write AFTER the verdict Domain Operation
  // commits, never inside it.
  if (receipt.status !== "replayed") {
    const wiringGateVerdict = wiringVerdict === "fail" ? "flag" as const : "pass" as const;
    const coverageGateVerdict = coverageVerdict === "pass" ? "pass" as const : "flag" as const;
    insertAuditGates(milestoneId, {
      wiring: {
        verdict: wiringGateVerdict,
        rationale: wiringCriterion.rationale,
        findings: findingsText(wiringFindings),
      },
      coverage: {
        verdict: coverageGateVerdict,
        rationale: coverageCriterion.rationale,
        findings: findingsText(coverage.findings),
      },
    }, milestoneVerdict === "pass" ? "pass" : "flag", evaluatedAt);
  }

  return receipt;
}

// Re-exported so importers of the domain-operation file can name the finding
// class unions without a second import from milestone-audit-coverage.ts.
export type { RequirementCoverageFindingClass, CrossSliceWiringFindingClass };
