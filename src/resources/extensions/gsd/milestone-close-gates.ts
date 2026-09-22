/**
 * Certify/audit quality gate persistence — separate from
 * milestone-validation-gates.ts's MV01-MV04 rows (D-01).
 *
 * Mirrors milestone-validation-gates.ts's insertMilestoneValidationGates
 * structure exactly, but sources gate ids from the certify-milestone/
 * audit-milestone owner turns instead of validate-milestone. Neither
 * function below ever reads or writes an MV0x/Q3-Q8 row, and neither writes
 * a bare string literal gate id — every id comes from getGatesForTurn(...)
 * (RESEARCH Pitfall 2).
 */

import { isDbAvailable, upsertQualityGate } from "./gsd-db.js";
import { getGatesForTurn } from "./gate-registry.js";
import { getMilestoneSlices } from "./db/queries.js";

export type CertifyAuditGateVerdict = "pass" | "flag";

export interface CertifyGatePerSliceInput {
  sliceId: string;
  verdict: CertifyAuditGateVerdict;
  rationale: string;
  findings: string;
}

/**
 * Insert certify's own per-slice (CERT01) and milestone-scoped (CERT02)
 * quality_gates rows. `quality_gates` is INSERT OR REPLACE (current-status
 * only) — the durable per-gap self-fix history lives elsewhere (14-02); this
 * writer only records certify's current standing.
 *
 * A milestone with zero slices (empty `perSlice` and no anchor slice for
 * CERT02) is a no-op: neither gate id is written, and nothing throws.
 */
export function insertCertifyGates(
  milestoneId: string,
  perSlice: ReadonlyArray<CertifyGatePerSliceInput>,
  milestoneVerdict: CertifyAuditGateVerdict,
  evaluatedAt: string,
): void {
  if (!isDbAvailable()) return;

  const certifyGates = getGatesForTurn("certify-milestone");
  const sliceGate = certifyGates.find((def) => def.scope === "slice");
  const milestoneGate = certifyGates.find((def) => def.scope === "milestone");

  if (sliceGate) {
    for (const entry of perSlice) {
      upsertQualityGate({
        milestoneId,
        sliceId: entry.sliceId,
        gateId: sliceGate.id,
        scope: "slice",
        taskId: "",
        status: "complete",
        verdict: entry.verdict,
        rationale: entry.rationale,
        findings: entry.findings,
        evaluatedAt,
      });
    }
  }

  if (!milestoneGate) return;
  const gateSliceId = getMilestoneSlices(milestoneId)[0]?.id;
  if (!gateSliceId) return;
  upsertQualityGate({
    milestoneId,
    sliceId: gateSliceId,
    gateId: milestoneGate.id,
    scope: "milestone",
    taskId: "",
    status: "complete",
    verdict: milestoneVerdict,
    rationale: `${milestoneGate.promptSection} — certify verdict: ${milestoneVerdict}`,
    findings: "",
    evaluatedAt,
  });
}

export interface CertifyAuditFindingInput {
  verdict: CertifyAuditGateVerdict;
  rationale: string;
  findings: string;
}

export interface AuditGateFindingsInput {
  wiring: CertifyAuditFindingInput;
  coverage: CertifyAuditFindingInput;
}

/**
 * Insert audit's own independent (AUD01 wiring / AUD02 coverage)
 * quality_gates rows — both milestone-scoped, both anchored to the
 * milestone's first slice (the established closeout-consistency-gate.ts
 * convention for a milestone-scoped gate row). A milestone with no slices
 * is a no-op: no anchor slice exists, so nothing is written.
 */
export function insertAuditGates(
  milestoneId: string,
  findings: AuditGateFindingsInput,
  milestoneVerdict: CertifyAuditGateVerdict,
  evaluatedAt: string,
): void {
  if (!isDbAvailable()) return;

  const gateSliceId = getMilestoneSlices(milestoneId)[0]?.id;
  if (!gateSliceId) return;

  const auditGates = getGatesForTurn("audit-milestone");
  const wiringGate = auditGates.find((def) => def.promptSection === "Independent Cross-Slice Wiring");
  const coverageGate = auditGates.find((def) => def.promptSection === "Independent Requirement Coverage");

  if (wiringGate) {
    upsertQualityGate({
      milestoneId,
      sliceId: gateSliceId,
      gateId: wiringGate.id,
      scope: "milestone",
      taskId: "",
      status: "complete",
      verdict: findings.wiring.verdict,
      rationale: `${findings.wiring.rationale} (milestone verdict: ${milestoneVerdict})`,
      findings: findings.wiring.findings,
      evaluatedAt,
    });
  }

  if (coverageGate) {
    upsertQualityGate({
      milestoneId,
      sliceId: gateSliceId,
      gateId: coverageGate.id,
      scope: "milestone",
      taskId: "",
      status: "complete",
      verdict: findings.coverage.verdict,
      rationale: `${findings.coverage.rationale} (milestone verdict: ${milestoneVerdict})`,
      findings: findings.coverage.findings,
      evaluatedAt,
    });
  }
}
