// Project/App: gsd-pi
// File Purpose: Executable contract for Plan 33-02 — the single
// `resolveRequirementMilestoneId` decision point (Task 1) and the seven
// remaining production write sites across `workflow_waivers`,
// `workflow_requirement_dispositions`, and `workflow_acceptance_criteria`
// that now bind it (Task 2). See 33-02-PLAN.md's write-site inventory and
// 33-01's already-covered `grantPlanReconciliationWaiver` write site
// (tests/requirement-milestone-attribution.test.ts), which this file does
// not re-test.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { resolveRequirementMilestoneId } from "../db/requirement-milestone-resolution.ts";
import {
  grantPlanReconciliationWaiver,
  grantSliceCancellationWaiver,
  recordPlanReconciliationDisposition,
} from "../db/writers/slice-lifecycle.ts";
import {
  grantRecoveryWaiver,
  recordRequirementDisposition,
  terminateRecoveryWaiver,
} from "../db/writers/task-recovery.ts";
import {
  MILESTONE_VALIDATION_POLICY,
  writeMilestoneValidation,
  writeMilestoneValidationWaiver,
} from "../db/writers/milestone-validation.ts";
import { prepareMilestoneSubjectiveUatQuestion } from "../db/writers/milestone-subjective-uat.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function freshDbPath(prefix = "gsd-requirement-milestone-child-writes-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function rows(sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return db().prepare(sql).all(params);
}

let fenceCounter = 0;

/** Mirrors requirement-milestone-attribution.test.ts's `executeAtFence`. */
function executeAtFence(
  operationType: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  fenceCounter += 1;
  const idempotencyKey = `fence/${operationType}/${fenceCounter}`;
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
        entityId: "test",
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

function seedMilestone(milestoneId: string): void {
  insertMilestone({ id: milestoneId, title: `Milestone ${milestoneId}`, status: "active" });
}

function seedRequirement(id: string, milestoneId?: string): void {
  insertRequirement({
    id,
    class: "must",
    status: "active",
    description: `Requirement ${id}`,
    why: "",
    source: "test",
    primary_owner: "",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
    ...(milestoneId !== undefined ? { milestone_id: milestoneId } : {}),
  });
}

function adoptTaskLifecycle(milestoneId: string, sliceId: string, taskId: string): string {
  let lifecycleId = "";
  executeAtFence("test.fixture.adopt-task", (context) => {
    lifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId, sliceId, taskId, lifecycleStatus: "in_progress",
    }).lifecycleId;
  });
  return lifecycleId;
}

function seedTaskHierarchy(milestoneId: string, sliceId: string, taskId: string): void {
  seedMilestone(milestoneId);
  insertSlice({ id: sliceId, milestoneId, title: `Slice ${sliceId}`, status: "active" });
  insertTask({ id: taskId, sliceId, milestoneId, title: `Task ${taskId}`, status: "in_progress" });
}

// ---------------------------------------------------------------------------
// Task 1: resolveRequirementMilestoneId
// ---------------------------------------------------------------------------

test("Test 1: resolves to the caller's own milestone when a matching row exists", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-1", "M-A");
  assert.equal(resolveRequirementMilestoneId("REQ-1", "M-A"), "M-A");
});

test("Test 2: returns null for a legacy NULL-milestone row rather than the caller's context", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-2");
  assert.equal(resolveRequirementMilestoneId("REQ-2", "M-A"), null);
});

test("Test 3: the same id under both the caller's milestone and another milestone resolves to the caller's, deterministically", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-3", "M-A");
  seedRequirement("REQ-3", "M-B");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(resolveRequirementMilestoneId("REQ-3", "M-A"), "M-A");
  }
  assert.equal(resolveRequirementMilestoneId("REQ-3", "M-B"), "M-B");
});

test("Test 4: an id that exists only under some other milestone resolves to null", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-4", "M-OTHER");
  assert.equal(resolveRequirementMilestoneId("REQ-4", "M-A"), null);
});

test("Test 5: an id with no matching requirement row at all resolves to null", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  assert.equal(resolveRequirementMilestoneId("REQ-MISSING", "M-A"), null);
});

test("Test 6: a null or empty requirement id resolves to null without querying (no database open)", () => {
  // Deliberately no openDatabase() call — if the resolver queried the DB
  // before short-circuiting, getDb() would throw "No database open" here.
  assert.equal(resolveRequirementMilestoneId(null, "M-A"), null);
  assert.equal(resolveRequirementMilestoneId(undefined, "M-A"), null);
  assert.equal(resolveRequirementMilestoneId("", "M-A"), null);
  assert.equal(resolveRequirementMilestoneId("   ", "M-A"), null);
});

// ---------------------------------------------------------------------------
// Task 2: the seven remaining production write sites
// ---------------------------------------------------------------------------

// Test 7: grantSliceCancellationWaiver's requirement_id is a hardcoded NULL
// literal (it waives a Slice's Task set, not a specific Requirement) — the
// CHECK `milestone_id IS NULL OR requirement_id IS NOT NULL` (33-01) requires
// milestone_id to stay NULL right alongside it. Proves the column was added
// and bound consistently, and the FK/CHECK pair accepts the null-null row.
test("Test 7: grantSliceCancellationWaiver carries a null milestone_id alongside its always-null requirement_id", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedMilestone("M001");
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });

  let sliceLifecycleId = "";
  executeAtFence("test.fixture.adopt-slice", (context) => {
    sliceLifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "in_progress",
    }).lifecycleId;
  });

  let waiverId = "";
  executeAtFence("slice.cancel", (context) => {
    waiverId = grantSliceCancellationWaiver(context, {
      lifecycleId: sliceLifecycleId,
      milestoneId: "M001",
      sliceId: "S01",
      rationale: "test cancellation",
      grantedByActorType: "policy",
    }).waiverId;
  });

  const waiverRow = row(
    "SELECT requirement_id, milestone_id FROM workflow_waivers WHERE waiver_id = :id",
    { ":id": waiverId },
  );
  assert.equal(waiverRow["requirement_id"], null);
  assert.equal(waiverRow["milestone_id"], null);
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 8: recordPlanReconciliationDisposition's disposition row must carry
// the same milestone_id as the waiver grantPlanReconciliationWaiver (33-01)
// already stamped on the requirement it waives.
test("Test 8: recordPlanReconciliationDisposition's disposition carries the plan-reconciliation requirement's milestone_id", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedTaskHierarchy("M002", "S01", "T01");
  adoptTaskLifecycle("M002", "S01", "T01");

  let authorization: { taskId: string; requirementId: string; waiverId: string } | undefined;
  executeAtFence("workflow.slice.plan", (context) => {
    authorization = grantPlanReconciliationWaiver(context, {
      milestoneId: "M002", sliceId: "S01", taskId: "T01",
    });
  });
  assert.ok(authorization);

  executeAtFence("workflow.slice.plan.authorization", (context) => {
    recordPlanReconciliationDisposition(context, authorization!);
  });

  const dispositionRow = row(
    "SELECT milestone_id FROM workflow_requirement_dispositions WHERE requirement_id = :rid",
    { ":rid": authorization!.requirementId },
  );
  assert.equal(dispositionRow["milestone_id"], "M002");
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 9: task-recovery's grantRecoveryWaiver and recordRequirementDisposition
// both carry the requirement's milestone_id.
test("Test 9: task-recovery's waiver grant and disposition record both carry the requirement's milestone_id", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedTaskHierarchy("M003", "S01", "T01");
  const lifecycleId = adoptTaskLifecycle("M003", "S01", "T01");
  seedRequirement("REQ-RECOVERY", "M003");

  let waiverId = "";
  executeAtFence("task.waiver.grant", (context) => {
    waiverId = grantRecoveryWaiver(context, {
      lifecycleId,
      requirementId: "REQ-RECOVERY",
      milestoneId: "M003",
      scope: "task:M003/S01/T01",
      rationale: "recovery waiver",
      grantedByActorType: "policy",
    }).waiverId;
  });
  const waiverRow = row("SELECT milestone_id FROM workflow_waivers WHERE waiver_id = :id", { ":id": waiverId });
  assert.equal(waiverRow["milestone_id"], "M003");

  let dispositionId = "";
  executeAtFence("task.disposition.record", (context) => {
    dispositionId = recordRequirementDisposition(context, {
      requirementId: "REQ-RECOVERY",
      disposition: "waived",
      waiverId,
      milestoneId: "M003",
      rationale: "recorded by recovery",
    }).dispositionId;
  });
  const dispositionRow = row(
    "SELECT milestone_id FROM workflow_requirement_dispositions WHERE disposition_id = :id",
    { ":id": dispositionId },
  );
  assert.equal(dispositionRow["milestone_id"], "M003");
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

function evidenceFor(ref: string) {
  return [{
    evidenceClass: "artifact" as const,
    commandOrTool: "test-harness",
    workingDirectory: "/tmp",
    startedAt: "2026-09-28T10:00:00.000Z",
    endedAt: "2026-09-28T10:00:01.000Z",
    observation: "passed" as const,
    durableOutputRef: ref,
    environment: { runner: "test" },
  }];
}

// Test 10: milestone-validation's waiver write carries a null milestone_id
// (it waives the whole validation stage, not a specific requirement, so
// requirement_id is a hardcoded NULL there too); its criterion write carries
// the supplied requirement's milestone_id, and null when none is supplied.
test("Test 10: milestone-validation's waiver carries null; its criterion write carries the requirement's milestone_id, or null when none is supplied", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedMilestone("M004");
  seedRequirement("REQ-VALID", "M004");

  let milestoneLifecycleId = "";
  executeAtFence("test.fixture.adopt-milestone", (context) => {
    milestoneLifecycleId = adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M004", lifecycleStatus: "ready",
    }).lifecycleId;
  });

  const validationWaiverId = randomUUID();
  executeAtFence("milestone.validation.waive", (context) => {
    writeMilestoneValidationWaiver(context, {
      waiverId: validationWaiverId,
      lifecycleId: milestoneLifecycleId,
      rationale: "validation waiver",
      actorId: null,
      grantedAt: new Date().toISOString(),
    });
  });
  const validationWaiverRow = row(
    "SELECT requirement_id, milestone_id FROM workflow_waivers WHERE waiver_id = :id",
    { ":id": validationWaiverId },
  );
  assert.equal(validationWaiverRow["requirement_id"], null);
  assert.equal(validationWaiverRow["milestone_id"], null);

  executeAtFence(MILESTONE_VALIDATION_POLICY.operationType, (context) => {
    writeMilestoneValidation(context, {
      milestoneId: "M004",
      policy: MILESTONE_VALIDATION_POLICY,
      testedSourceRevision: "sha256:fixture-validate",
      policyId: "milestone-validation",
      policyVersion: "1",
      verdict: "pass",
      outcome: "succeeded",
      failureClass: "none",
      summary: "validation recorded",
      output: { stage: "validate" },
      criteria: [
        {
          criterionKey: "milestone-validation:with-requirement",
          evidenceClass: "artifact",
          description: "Criterion with a requirement",
          required: true,
          requirementId: "REQ-VALID",
          verdict: "pass",
          rationale: "pass",
          evidence: evidenceFor("artifact://with-requirement"),
        },
        {
          criterionKey: "milestone-validation:without-requirement",
          evidenceClass: "artifact",
          description: "Criterion without a requirement",
          required: true,
          verdict: "pass",
          rationale: "pass",
          evidence: evidenceFor("artifact://without-requirement"),
        },
      ],
    });
  });

  const withRequirement = row(
    "SELECT milestone_id FROM workflow_acceptance_criteria WHERE criterion_key = 'milestone-validation:with-requirement'",
  );
  assert.equal(withRequirement["milestone_id"], "M004");
  const withoutRequirement = row(
    "SELECT milestone_id FROM workflow_acceptance_criteria WHERE criterion_key = 'milestone-validation:without-requirement'",
  );
  assert.equal(withoutRequirement["milestone_id"], null);
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 11: the subjective-UAT criterion write carries the supplied
// requirement's milestone_id, and null when none is supplied.
test("Test 11: the subjective-UAT criterion write carries the requirement's milestone_id, or null when none is supplied", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedMilestone("M005");
  seedRequirement("REQ-SUBJ", "M005");
  executeAtFence("test.fixture.adopt-milestone", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M005", lifecycleStatus: "ready" });
  });

  let withReqCriterionId = "";
  executeAtFence("milestone.subjective-uat.prepare", (context) => {
    withReqCriterionId = prepareMilestoneSubjectiveUatQuestion(context, {
      milestoneId: "M005",
      criterionKey: "subjective:with-requirement",
      description: "desc",
      focusedPrompt: "prompt",
      recommendedDisposition: "accepted",
      recommendationRationale: "rationale",
      recommendationEvidence: "evidence",
      testedSourceRevision: "sha256:fixture-subj-1",
      recommendationConfidence: 0.9,
      required: true,
      requirementId: "REQ-SUBJ",
    }).criterionId;
  });
  const withReqRow = row(
    "SELECT milestone_id FROM workflow_acceptance_criteria WHERE criterion_id = :id",
    { ":id": withReqCriterionId },
  );
  assert.equal(withReqRow["milestone_id"], "M005");

  let withoutReqCriterionId = "";
  executeAtFence("milestone.subjective-uat.prepare", (context) => {
    withoutReqCriterionId = prepareMilestoneSubjectiveUatQuestion(context, {
      milestoneId: "M005",
      criterionKey: "subjective:without-requirement",
      description: "desc",
      focusedPrompt: "prompt",
      recommendedDisposition: "accepted",
      recommendationRationale: "rationale",
      recommendationEvidence: "evidence",
      testedSourceRevision: "sha256:fixture-subj-2",
      recommendationConfidence: 0.9,
      required: true,
    }).criterionId;
  });
  const withoutReqRow = row(
    "SELECT milestone_id FROM workflow_acceptance_criteria WHERE criterion_id = :id",
    { ":id": withoutReqCriterionId },
  );
  assert.equal(withoutReqRow["milestone_id"], null);
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 12 (the cross-milestone case this phase exists for): two milestones
// each hold a requirement with the same id. A waiver granted under milestone
// A resolves to A, and one granted under B resolves to B.
test("Test 12: a shared requirement id across two milestones resolves each waiver to its own granting milestone", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedTaskHierarchy("M-XA", "SA", "TA");
  seedTaskHierarchy("M-XB", "SB", "TB");
  const lifecycleA = adoptTaskLifecycle("M-XA", "SA", "TA");
  const lifecycleB = adoptTaskLifecycle("M-XB", "SB", "TB");
  seedRequirement("SHARED-REQ", "M-XA");
  seedRequirement("SHARED-REQ", "M-XB");

  let waiverA = "";
  executeAtFence("task.waiver.grant", (context) => {
    waiverA = grantRecoveryWaiver(context, {
      lifecycleId: lifecycleA,
      requirementId: "SHARED-REQ",
      milestoneId: "M-XA",
      scope: "task:M-XA/SA/TA",
      rationale: "shared-a",
      grantedByActorType: "policy",
    }).waiverId;
  });
  let waiverB = "";
  executeAtFence("task.waiver.grant", (context) => {
    waiverB = grantRecoveryWaiver(context, {
      lifecycleId: lifecycleB,
      requirementId: "SHARED-REQ",
      milestoneId: "M-XB",
      scope: "task:M-XB/SB/TB",
      rationale: "shared-b",
      grantedByActorType: "policy",
    }).waiverId;
  });

  assert.equal(row("SELECT milestone_id FROM workflow_waivers WHERE waiver_id = :id", { ":id": waiverA })["milestone_id"], "M-XA");
  assert.equal(row("SELECT milestone_id FROM workflow_waivers WHERE waiver_id = :id", { ":id": waiverB })["milestone_id"], "M-XB");
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 13 (waiver-ending UPDATEs): after a waiver is granted and then
// revoked through its real writer, the UPDATE completes and the row's
// milestone_id is unchanged (the waiver-ending UPDATE does not modify the
// composite key, so SQLite never re-validates the FK on it).
test("Test 13: terminating a recovery waiver leaves its milestone_id unchanged", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedTaskHierarchy("M006", "S01", "T01");
  const lifecycleId = adoptTaskLifecycle("M006", "S01", "T01");
  seedRequirement("REQ-END", "M006");

  let waiverId = "";
  executeAtFence("task.waiver.grant", (context) => {
    waiverId = grantRecoveryWaiver(context, {
      lifecycleId,
      requirementId: "REQ-END",
      milestoneId: "M006",
      scope: "task:M006/S01/T01",
      rationale: "terminable",
      grantedByActorType: "policy",
    }).waiverId;
  });
  assert.equal(row("SELECT milestone_id FROM workflow_waivers WHERE waiver_id = :id", { ":id": waiverId })["milestone_id"], "M006");

  executeAtFence("task.waiver.terminate", (context) => {
    terminateRecoveryWaiver(context, { waiverId, disposition: "revoked" });
  });
  const afterRow = row(
    "SELECT waiver_status, milestone_id FROM workflow_waivers WHERE waiver_id = :id",
    { ":id": waiverId },
  );
  assert.equal(afterRow["waiver_status"], "revoked");
  assert.equal(afterRow["milestone_id"], "M006");
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 14 (legacy tolerance): a waiver granted against a legacy requirement
// row whose milestone_id is NULL completes successfully and stores a NULL
// milestone_id, with no foreign-key error.
test("Test 14: granting a waiver against a legacy NULL-milestone requirement stores a null milestone_id without a foreign-key error", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedTaskHierarchy("M007", "S01", "T01");
  const lifecycleId = adoptTaskLifecycle("M007", "S01", "T01");
  seedRequirement("LEGACY-REQ");

  let waiverId = "";
  executeAtFence("task.waiver.grant", (context) => {
    waiverId = grantRecoveryWaiver(context, {
      lifecycleId,
      requirementId: "LEGACY-REQ",
      milestoneId: "M007",
      scope: "task:M007/S01/T01",
      rationale: "legacy tolerance",
      grantedByActorType: "policy",
    }).waiverId;
  });
  const waiverRow = row("SELECT milestone_id FROM workflow_waivers WHERE waiver_id = :id", { ":id": waiverId });
  assert.equal(waiverRow["milestone_id"], null);
  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});
