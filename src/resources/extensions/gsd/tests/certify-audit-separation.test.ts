// Project/App: gsd-pi
// File Purpose: The D-01 acceptance suite for the whole phase — proves
// validate-milestone, certify, and audit leave three genuinely disjoint sets
// of evidence (verdicts, criteria, events, gate ids) for the same milestone,
// that certify and audit can disagree without either changing the other, and
// that the audit's import graph never reaches certify/validate-milestone's
// own implementation modules (14-03-PLAN.md Task 3).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import { getOwnerTurn } from "../gate-registry.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertRequirement,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { auditMilestone } from "../milestone-audit-domain-operation.ts";
import { certifyMilestone } from "../milestone-certify-domain-operation.ts";
import { insertMilestoneValidationGates } from "../milestone-validation-gates.ts";
import {
  validateMilestone,
  type ValidateMilestoneCriterionInput,
} from "../milestone-validation-domain-operation.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return db().prepare(sql).all(params);
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "certify-audit-separation-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function evidenceFor(ref: string) {
  return [{
    evidenceClass: "artifact" as const,
    commandOrTool: "separation-test-harness",
    workingDirectory: "/tmp",
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: "2026-09-22T10:00:01.000Z",
    observation: "passed" as const,
    durableOutputRef: ref,
    environment: { runner: "test" },
  }];
}

function validationCriteria(): ValidateMilestoneCriterionInput[] {
  return [{
    criterionKey: "milestone-validation:contract",
    evidenceClass: "artifact",
    description: "Contract criterion.",
    verdict: "pass",
    rationale: "Contract passed.",
    evidence: evidenceFor("artifact://validate/contract"),
  }];
}

/** Insert a passing quality_gates row directly — mirrors the certify-fixture
 * precedent in tests/milestone-certify-domain-operation.test.ts. */
function insertGateRow(
  sliceId: string,
  gateId: string,
  verdict: "pass" | "flag",
): void {
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
    VALUES ('M001', :slice_id, :gate_id, 'slice', '', 'complete', :verdict, '2026-09-22T00:00:00.000Z')
  `).run({ ":slice_id": sliceId, ":gate_id": gateId, ":verdict": verdict });
}

function openBase(withContextDir = true): void {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-certify-audit-separation-"));
  tempDirs.add(basePath);
  if (withContextDir) {
    mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
    writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  } else {
    mkdirSync(join(basePath, ".gsd"), { recursive: true });
  }
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Separation test", status: "active" });
  executeAtFence("test.separation.fixture", "fixture/separation/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
}

/** All three stages run once, clean (no findings), against ONE milestone. */
function runAllThreeStagesClean(): void {
  openBase();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "R001",
    why: "test",
    source: "test",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
  });
  // A single complete+pass CERT01 row satisfies BOTH certify's own
  // gate1-record-missing avoidance AND audit's no-passing-gate coverage
  // check — a genuinely clean, gap-free slice for all three stages.
  insertGateRow("S01", "CERT01", "pass");

  const validateReceipt = validateMilestone({
    invocation: invocation("separation/all-three/validate"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "Validate stage found no gaps.",
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation recorded a passing verdict.",
    output: { stage: "validate" },
    criteria: validationCriteria(),
  });
  insertMilestoneValidationGates("M001", "S01", validateReceipt.verdict, "2026-09-22T00:00:00.000Z");

  certifyMilestone({
    invocation: invocation("separation/all-three/certify"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });

  auditMilestone({
    invocation: invocation("separation/all-three/audit"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Test 1: validate/certify/audit leave three disjoint, non-empty workflow_technical_verdicts groups by policy_id", () => {
  runAllThreeStagesClean();

  const grouped = rows(`
    SELECT policy_id, COUNT(*) AS cnt FROM workflow_technical_verdicts GROUP BY policy_id ORDER BY policy_id
  `);
  const total = Number(row(`SELECT COUNT(*) AS cnt FROM workflow_technical_verdicts`)["cnt"]);

  assert.deepEqual(grouped.map((r) => String(r["policy_id"])), [
    "milestone-audit", "milestone-certify", "milestone-validation",
  ]);
  for (const group of grouped) {
    assert.ok(Number(group["cnt"]) > 0, `policy_id ${String(group["policy_id"])} group must not be empty`);
  }
  const sum = grouped.reduce((acc, group) => acc + Number(group["cnt"]), 0);
  assert.equal(sum, total);
});

test("Test 2: three disjoint acceptance-criteria prefixes stay current and required after all three runs", () => {
  runAllThreeStagesClean();

  function currentCriteriaWithPrefix(prefix: string): Array<Record<string, unknown>> {
    return rows(`
      SELECT criterion_id, criterion_key, required
      FROM workflow_acceptance_criteria criterion
      WHERE criterion.criterion_key LIKE :prefix ESCAPE '\\'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_acceptance_criteria successor
          WHERE successor.supersedes_criterion_id = criterion.criterion_id
        )
      ORDER BY criterion.criterion_key
    `, { ":prefix": `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}:%` });
  }

  const validationCurrent = currentCriteriaWithPrefix("milestone-validation");
  const certifyCurrent = currentCriteriaWithPrefix("milestone-certify");
  const auditCurrent = currentCriteriaWithPrefix("milestone-audit");

  assert.ok(validationCurrent.length > 0);
  assert.ok(certifyCurrent.length > 0);
  assert.ok(auditCurrent.length > 0);

  const allKeys = [...validationCurrent, ...certifyCurrent, ...auditCurrent]
    .map((r) => String(r["criterion_key"]));
  assert.equal(new Set(allKeys).size, allKeys.length, "criterion_key sets must be disjoint");

  for (const criterion of [...validationCurrent, ...certifyCurrent, ...auditCurrent]) {
    assert.equal(Boolean(criterion["required"]), true);
  }
});

test("Test 3: three disjoint milestone.*.recorded event types, exactly one row each", () => {
  runAllThreeStagesClean();

  const grouped = rows(`
    SELECT event_type, COUNT(*) AS cnt
    FROM workflow_domain_events
    WHERE event_type IN ('milestone.validation.recorded', 'milestone.certify.recorded', 'milestone.audit.recorded')
    GROUP BY event_type
    ORDER BY event_type
  `);
  assert.deepEqual(grouped.map((r) => String(r["event_type"])), [
    "milestone.audit.recorded", "milestone.certify.recorded", "milestone.validation.recorded",
  ]);
  for (const group of grouped) {
    assert.equal(Number(group["cnt"]), 1);
  }
  const sum = grouped.reduce((acc, group) => acc + Number(group["cnt"]), 0);
  assert.equal(sum, 3);
});

test("Test 4: quality_gates holds MV01-MV04, CERT01/CERT02, AUD01/AUD02 — eight distinct ids, each owned by its own turn", () => {
  runAllThreeStagesClean();

  const gateRows = rows(`SELECT DISTINCT gate_id FROM quality_gates WHERE milestone_id = 'M001'`);
  const gateIds = gateRows.map((r) => String(r["gate_id"])).sort();
  assert.deepEqual(gateIds, [
    "AUD01", "AUD02", "CERT01", "CERT02", "MV01", "MV02", "MV03", "MV04",
  ]);

  const expectedTurnByPrefix: Record<string, string> = {
    MV: "validate-milestone",
    CERT: "certify-milestone",
    AUD: "audit-milestone",
  };
  for (const gateId of gateIds) {
    const prefix = gateId.replace(/[0-9]+$/, "");
    const owner = getOwnerTurn(gateId as import("../types.ts").GateId);
    assert.equal(owner, expectedTurnByPrefix[prefix], `${gateId} must be owned by ${expectedTurnByPrefix[prefix]}`);
  }
});

test("Test 5: certify records pass while audit records fail for the same milestone, and neither changes the other", () => {
  openBase();
  // S01 is terminal with a pre-existing durable CERT01 Gate-1 signal, so
  // certify's gap derivation finds nothing to flag for it. S02 is
  // deliberately NON-terminal and carries no quality_gates rows at all —
  // certify's terminal-only gap classes (gate1-record-missing,
  // integration-gap) never even examine it, and its empty gate-pending/
  // gate-flagged loop finds nothing either, so certify's overall pass is
  // genuine. The requirement maps to S02, which audit's INDEPENDENT
  // coverage check flags as slice-not-terminal — a real disagreement that
  // does not depend on certify's own CERT01/CERT02 attestation rows at all
  // (using those directly would let certify's own "pass" write trivially
  // satisfy audit's coverage check, recoupling the two stages).
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "R001",
    why: "test",
    source: "test",
    primary_owner: "S02",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
  });
  insertGateRow("S01", "CERT01", "pass");

  const certifyReceipt = certifyMilestone({
    invocation: invocation("separation/disagreement/certify"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });
  assert.equal(certifyReceipt.verdict, "pass");

  const auditReceipt = auditMilestone({
    invocation: invocation("separation/disagreement/audit"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });
  assert.equal(auditReceipt.verdict, "fail");

  // Neither stage's recorded verdict changed as a result of the other running.
  const certifyPolicyRow = row(`
    SELECT verdict FROM workflow_technical_verdicts WHERE policy_id = 'milestone-certify' LIMIT 1
  `);
  assert.equal(certifyPolicyRow["verdict"], "pass");
  const auditPolicyRows = rows(`
    SELECT verdict FROM workflow_technical_verdicts WHERE policy_id = 'milestone-audit'
  `);
  assert.ok(auditPolicyRows.some((r) => r["verdict"] === "fail"));
});

test("Test 6: the audit's own module import graph reaches no certify/validation-gates/validate-milestone module", () => {
  const auditDomainOperationSource = readFileSync(
    join(process.cwd(), "src/resources/extensions/gsd/milestone-audit-domain-operation.ts"),
    "utf8",
  );
  const auditCoverageSource = readFileSync(
    join(process.cwd(), "src/resources/extensions/gsd/milestone-audit-coverage.ts"),
    "utf8",
  );

  const importSpecifiers = (source: string): string[] => {
    const specifiers: string[] = [];
    const importRe = /from\s+["']([^"']+)["']/g;
    let match: RegExpExecArray | null;
    while ((match = importRe.exec(source)) !== null) {
      specifiers.push(match[1]!);
    }
    return specifiers;
  };

  const forbidden = [/milestone-certify/, /milestone-validation-gates/, /tools\/validate-milestone/];
  for (const source of [auditDomainOperationSource, auditCoverageSource]) {
    for (const specifier of importSpecifiers(source)) {
      for (const pattern of forbidden) {
        assert.doesNotMatch(specifier, pattern, `forbidden import "${specifier}" found`);
      }
    }
  }
});

test("Test 7: re-running audit with a new idempotency key leaves the FIRST milestone.audit.recorded event byte-identical", () => {
  runAllThreeStagesClean();

  const firstRow = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'milestone.audit.recorded'
  `);
  const firstPayload = String(firstRow["payload_json"]);

  auditMilestone({
    invocation: invocation("separation/all-three/audit-again"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });

  // event_id is a UUID (insertion-order-independent) — order by
  // project_revision, the append-only monotonic sequence, not event_id.
  const eventRows = rows(`
    SELECT project_revision, payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.audit.recorded'
    ORDER BY project_revision ASC
  `);
  assert.equal(eventRows.length, 2);
  assert.equal(String(eventRows[0]!["payload_json"]), firstPayload);
});
