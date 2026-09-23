// Project/App: gsd-pi
// File Purpose: Durable, replayable certify-stage verdict recording. Reuses the
// milestone-validation domain-operation machinery (recordMilestoneVerdict) under
// the locked "milestone-certify" policy so certify's evidence trail (policyId,
// operationType, event type, criterionKey namespace, projection) is genuinely
// separate from validate-milestone's — D-01/D-03.

import { getMilestoneSlices } from "./db/queries.js";
import type { DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import type { Gate2HumanUatPartialCriterion } from "./db/writers/milestone-gate2-human-uat.js";
import { readDomainOperationFence } from "./db/writers/lifecycle-commands.js";
import {
  MILESTONE_CERTIFY_POLICY,
  type MilestoneValidationEvidenceClass,
  type MilestoneValidationObservation,
  type MilestoneValidationVerdict,
} from "./db/writers/milestone-validation.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { auditMilestoneSliceGates } from "./milestone-certify-audit.js";
import {
  registerGate2HumanUatPending,
  type Gate2HumanUatRegistrationReceipt,
} from "./milestone-gate2-human-uat-domain-operation.js";
import { formatBlockedNoticeWithPauseKind } from "./stop-notice.js";
import {
  insertCertifyGates,
  type CertifyAuditGateVerdict,
  type CertifyGatePerSliceInput,
} from "./milestone-close-gates.js";
import {
  CERTIFY_SELF_FIX_MAX_ATTEMPTS,
  countCertifySelfFixAttemptsForGap,
  recordCertifySelfFixAttempt,
  type CertifyGap,
} from "./milestone-certify-self-fix.js";
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
 * Certify now derives its own verdict, criteria, and evidence from durable DB
 * state (Task 3) — the caller supplies only enough identity to run the pass.
 * `policyId`/`policyVersion` are locked module constants, never caller-supplied
 * (D-01/T-14-01), and `criteria` is no longer a caller input at all: a
 * caller-supplied criterion would reopen exactly the "certify trusts its own
 * unverified self-report" hole D-01 exists to close.
 */
export interface CertifyMilestoneInput {
  invocation: ExecutionInvocation;
  milestoneId: string;
  testedSourceRevision: string;
}

export type CertifyMilestoneReceipt = ValidateMilestoneReceipt;

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
  /**
   * Operator-facing pause reason, carrying the `certify-escalation`
   * pause-kind marker plus the Gate-2 entry id (Phase 16, DRIVER-02) so a
   * later resume-condition has a durable id to `SELECT` on. 16-01's
   * Assumption A1 established that `certifyMilestone` has no live
   * `/gsd auto` notify dispatch site today — this result field, not the
   * DB-stored `human_uat_pending.reason`, is the point where the
   * "escalated" disposition is actually surfaced to a caller, so it is
   * tagged here rather than at a live notify call site that does not yet
   * exist (16-04-PLAN.md Task 2's documented fallback).
   */
  reason: string;
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
  const rawReason = `certify escalation for ${input.milestoneId}/${input.sliceId}: `
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
    reason: rawReason,
    partialCriteria,
  });

  // Phase 16 DRIVER-02: tag AFTER registration so the entry id (only known
  // once the row exists) can ride the same reason a resume-condition will
  // later read. Built through the shared formatter, never string
  // concatenation, so emitter and parser cannot drift (stop-notice.ts).
  const reason = formatBlockedNoticeWithPauseKind(
    `${rawReason} (gate2-entry: ${receipt.entryId})`,
    "certify-escalation",
  );

  return {
    disposition: receipt.created ? "escalated" : "already-escalated",
    entryId: receipt.entryId,
    reason,
    receipt,
  };
}

export interface CertifyMilestoneGapOutcome {
  gap: CertifyGap;
  disposition: CertifyGapDisposition;
  cycle?: number;
  priorAttempts?: number;
}

/**
 * `certifyMilestone`'s receipt extends the underlying verdict receipt with
 * the full gap-accounting Task 3 requires: every gap the audit derived lands
 * in exactly one of `selfFixAttempted` / `escalated` / `alreadyEscalated` —
 * the mechanical form of the "no gap may vanish" prohibition.
 */
export interface CertifyMilestoneFullReceipt extends CertifyMilestoneReceipt {
  gaps: CertifyGap[];
  selfFixAttempted: CertifyMilestoneGapOutcome[];
  escalated: CertifyMilestoneGapOutcome[];
  alreadyEscalated: CertifyMilestoneGapOutcome[];
}

function findingsForSlice(gaps: CertifyGap[], dispositionByGapId: ReadonlyMap<string, CertifyGapDisposition>): string {
  if (gaps.length === 0) return "";
  return gaps
    .map((gap) => `${gap.gapId} (${gap.gapClass}): ${dispositionByGapId.get(gap.gapId) ?? "unresolved"}`)
    .join("; ");
}

function evidenceEnvironment(extra: Record<string, string>): { [key: string]: DomainJsonValue } {
  return { runner: "certify-milestone", ...extra };
}

/**
 * On a replay of the SAME outer idempotency key, `certifyMilestone` must
 * reproduce byte-identical evidence timestamps or the verdict Domain
 * Operation's request-hash check rejects the replay as a conflict (mirrors
 * `readMilestoneValidationAggregateTimestamp`'s identical role for
 * validate-milestone).
 */
function readCertifyEvaluatedAt(idempotencyKey: string): string | null {
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
      AND operation.operation_type = 'milestone.certify'
      AND criterion.criterion_key = 'milestone-certify:gate-audit'
    LIMIT 1
  `).get({ ":idempotency_key": idempotencyKey }) as Record<string, unknown> | undefined;
  return row ? String(row["started_at"]) : null;
}

function buildAggregateCriterion(
  criterionKey: string,
  description: string,
  milestoneId: string,
  scopedGaps: CertifyGap[],
  sliceCount: number,
  dispositionByGapId: ReadonlyMap<string, CertifyGapDisposition>,
  evaluatedAt: string,
): CertifyMilestoneCriterionInput {
  const verdict: MilestoneValidationVerdict = sliceCount === 0
    ? "inconclusive"
    : scopedGaps.length === 0
      ? "pass"
      : "fail";
  const observation: MilestoneValidationObservation = verdict === "pass"
    ? "passed"
    : verdict === "fail"
      ? "failed"
      : "inconclusive";
  const rationale = sliceCount === 0
    ? "No slices were available to audit."
    : scopedGaps.length === 0
      ? "No gaps found for this check."
      : `Found ${scopedGaps.length} gap(s): `
        + scopedGaps.map((gap) => `${gap.gapId} (${dispositionByGapId.get(gap.gapId) ?? "unresolved"})`).join(", ");
  return {
    criterionKey,
    evidenceClass: "artifact",
    description,
    verdict,
    rationale,
    evidence: [{
      evidenceClass: "artifact",
      commandOrTool: "certify-milestone",
      workingDirectory: "certify",
      startedAt: evaluatedAt,
      endedAt: evaluatedAt,
      observation,
      durableOutputRef: `certify/${milestoneId}`,
      environment: evidenceEnvironment({ sliceCount: String(sliceCount), gapCount: String(scopedGaps.length) }),
    }],
  };
}

/**
 * Run the full certify pass (CERT-01): derive every slice's gaps from
 * durable state (`auditMilestoneSliceGates`), self-fix fixable gaps under
 * the durable per-gap cap of 3 (`recordCertifySelfFixAttempt`), batch every
 * remaining gap into one Gate-2 escalation per slice
 * (`escalateCertifyGapsToGate2`), then record certify's own CERT01/CERT02
 * gate rows and its `milestone.certify.recorded` verdict. Every gap lands in
 * exactly one disposition bucket — implemented as an exhaustive switch so an
 * unhandled disposition is a compile error, never a silently dropped gap.
 */
export function certifyMilestone(input: CertifyMilestoneInput): CertifyMilestoneFullReceipt {
  const milestoneId = input.milestoneId;
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  const projectId = fence.projectId;

  const sliceCount = getMilestoneSlices(milestoneId).length;
  const gaps = auditMilestoneSliceGates({ projectId, milestoneId });

  const dispositionByGapId = new Map<string, CertifyGapDisposition>();
  const selfFixAttempted: CertifyMilestoneGapOutcome[] = [];
  const escalationBySlice = new Map<string, CertifyEscalationGap[]>();

  function bucketForEscalation(gap: CertifyGap, attemptCount?: number): void {
    const bucket = escalationBySlice.get(gap.sliceId) ?? [];
    bucket.push({ gap, ...(attemptCount === undefined ? {} : { attemptCount }) });
    escalationBySlice.set(gap.sliceId, bucket);
  }

  for (const gap of gaps) {
    if (!gap.fixable) {
      bucketForEscalation(gap);
      continue;
    }
    const priorAttempts = countCertifySelfFixAttemptsForGap(projectId, milestoneId, gap.sliceId, gap.gapId);
    if (priorAttempts >= CERTIFY_SELF_FIX_MAX_ATTEMPTS) {
      bucketForEscalation(gap, priorAttempts);
      continue;
    }
    const result = recordCertifySelfFixAttempt({
      invocation: {
        ...input.invocation,
        idempotencyKey: `${input.invocation.idempotencyKey}/self-fix/${gap.gapId}`,
      },
      projectId,
      milestoneId,
      gap,
    });
    if (result.disposition === "self-fix-attempted") {
      dispositionByGapId.set(gap.gapId, "self-fix-attempted");
      selfFixAttempted.push({
        gap, disposition: "self-fix-attempted", cycle: result.cycle, priorAttempts: result.priorAttempts,
      });
    } else {
      bucketForEscalation(gap, result.priorAttempts);
    }
  }

  const escalated: CertifyMilestoneGapOutcome[] = [];
  const alreadyEscalated: CertifyMilestoneGapOutcome[] = [];
  for (const [sliceId, entries] of escalationBySlice) {
    const result = escalateCertifyGapsToGate2({
      invocation: {
        ...input.invocation,
        idempotencyKey: `${input.invocation.idempotencyKey}/escalate/${sliceId}`,
      },
      milestoneId,
      sliceId,
      gaps: entries,
    });
    for (const entry of entries) {
      dispositionByGapId.set(entry.gap.gapId, result.disposition);
      const outcome: CertifyMilestoneGapOutcome = { gap: entry.gap, disposition: result.disposition };
      switch (result.disposition) {
        case "escalated":
          escalated.push(outcome);
          break;
        case "already-escalated":
          alreadyEscalated.push(outcome);
          break;
        default: {
          const exhaustive: never = result.disposition;
          throw new Error(`unhandled escalation disposition: ${String(exhaustive)}`);
        }
      }
    }
  }

  const evaluatedAt = readCertifyEvaluatedAt(input.invocation.idempotencyKey) ?? new Date().toISOString();
  const integrationGaps = gaps.filter((gap) => gap.gapClass === "integration-gap");
  const nonIntegrationGaps = gaps.filter((gap) => gap.gapClass !== "integration-gap");
  const gateAuditCriterion = buildAggregateCriterion(
    "milestone-certify:gate-audit",
    "Every slice's durable gate evidence must be current and passing, with fixable gaps self-fixed or escalated.",
    milestoneId,
    nonIntegrationGaps,
    sliceCount,
    dispositionByGapId,
    evaluatedAt,
  );
  const integrationCriterion = buildAggregateCriterion(
    "milestone-certify:integration-check",
    "Certify's own deterministic cross-slice dependency check must find every terminal slice's dependencies terminal.",
    milestoneId,
    integrationGaps,
    sliceCount,
    dispositionByGapId,
    evaluatedAt,
  );

  const milestoneVerdict: MilestoneValidationVerdict = sliceCount === 0
    ? "inconclusive"
    : gaps.length === 0
      ? "pass"
      : "fail";
  const outcome = milestoneVerdict === "pass"
    ? "succeeded" as const
    : milestoneVerdict === "fail"
      ? "failed" as const
      : "interrupted" as const;
  const failureClass = milestoneVerdict === "pass"
    ? "none"
    : milestoneVerdict === "fail"
      ? "certify-gap"
      : "certify-no-slices";
  const rationale = sliceCount === 0
    ? `Certify found no slices to audit for milestone ${milestoneId}.`
    : gaps.length === 0
      ? `Certify found no gaps across ${sliceCount} slice(s).`
      : `Certify found ${gaps.length} gap(s) across ${sliceCount} slice(s): `
        + `${selfFixAttempted.length} self-fix-attempted, ${escalated.length} escalated, `
        + `${alreadyEscalated.length} already-escalated.`;

  const receipt = recordMilestoneVerdict({
    invocation: input.invocation,
    milestoneId,
    testedSourceRevision: input.testedSourceRevision,
    policyId: MILESTONE_CERTIFY_POLICY_ID,
    policyVersion: MILESTONE_CERTIFY_POLICY_VERSION,
    policy: MILESTONE_CERTIFY_POLICY,
    verdict: milestoneVerdict,
    rationale,
    outcome,
    failureClass,
    summary: `Certify recorded ${milestoneVerdict} for ${milestoneId}.`,
    output: {
      stage: "certify",
      gapCount: gaps.length,
      selfFixAttempted: selfFixAttempted.length,
      escalated: escalated.length,
      alreadyEscalated: alreadyEscalated.length,
    },
    criteria: [gateAuditCriterion, integrationCriterion],
  });

  // Mirrors validate-milestone's own insertMilestoneValidationGates placement
  // (tools/validate-milestone.ts): gate rows are a separate, replay-guarded
  // write AFTER the verdict Domain Operation commits, never inside it.
  if (receipt.status !== "replayed") {
    const gapsBySlice = new Map<string, CertifyGap[]>();
    for (const gap of gaps) {
      const bucket = gapsBySlice.get(gap.sliceId) ?? [];
      bucket.push(gap);
      gapsBySlice.set(gap.sliceId, bucket);
    }
    const perSlice: CertifyGatePerSliceInput[] = getMilestoneSlices(milestoneId).map((slice) => {
      const sliceGaps = gapsBySlice.get(slice.id) ?? [];
      return {
        sliceId: slice.id,
        verdict: sliceGaps.length === 0 ? "pass" : "flag",
        rationale: sliceGaps.length === 0
          ? "No certify gaps found for this slice."
          : `${sliceGaps.length} certify gap(s) found for this slice.`,
        findings: findingsForSlice(sliceGaps, dispositionByGapId),
      };
    });
    const gateVerdict: CertifyAuditGateVerdict = milestoneVerdict === "pass" ? "pass" : "flag";
    insertCertifyGates(milestoneId, perSlice, gateVerdict, evaluatedAt);
  }

  return { ...receipt, gaps, selfFixAttempted, escalated, alreadyEscalated };
}
