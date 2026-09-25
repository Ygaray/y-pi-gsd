// Project/App: gsd-pi
// File Purpose: Intent-first contracts for atomic adopted Milestone completion.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _setDomainOperationFaultForTest } from "../db/domain-operation.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { grantSliceCancellationWaiver } from "../db/writers/slice-lifecycle.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertGateRow,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  saveGateResult,
} from "../gsd-db.ts";
import { createTrackerItem, resolveTrackerItem } from "../db/writers/tracker-item.ts";
import { proveMilestoneCloseout } from "../milestone-closeout-proof.ts";
import type { MilestoneCloseoutResidualItem } from "../milestone-closeout-residual-capture.ts";
import { registerGate2HumanUatPending } from "../milestone-gate2-human-uat-domain-operation.ts";
import { completeMilestone } from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import {
  deferredToPhaseDispositionTag,
  milestoneScopeTag,
  MUST_FIX_IN_EXECUTE_DISPOSITION_TAG,
  PLAN_REVIEW_RESIDUAL_HIGH_TAG,
} from "../plan-review-residual-disposition.ts";
import {
  grantTaskWaiver,
  recordTaskRequirementDisposition,
} from "../task-recovery-domain-operation.ts";
import { handleCompleteMilestone } from "../tools/complete-milestone.ts";
import {
  handleValidateMilestone,
  type ValidateMilestoneParams,
} from "../tools/validate-milestone.ts";
import type { GateId } from "../types.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

const tempDirs = new Set<string>();
let testedSourceRevision = "";

interface MilestoneCompletionCloseout {
  title: string;
  oneLiner: string;
  narrative: string;
  successCriteriaResults: string;
  definitionOfDoneResults: string;
  requirementOutcomes: string;
  keyDecisions: string[];
  keyFiles: string[];
  lessonsLearned: string[];
  followUps: string;
  deviations: string;
  residualItems?: MilestoneCloseoutResidualItem[];
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "milestone-completion-test",
    traceId: `trace/${idempotencyKey}`,
    turnId: `turn/${idempotencyKey}`,
  };
}

function closeout(
  overrides: Partial<MilestoneCompletionCloseout> = {},
): MilestoneCompletionCloseout {
  return {
    title: "Atomic Milestone completion",
    oneLiner: "Completed one validated Milestone from database facts.",
    narrative: "The Milestone completed through one durable Domain Operation.",
    successCriteriaResults: "All success criteria passed.",
    definitionOfDoneResults: "All completion conditions passed.",
    requirementOutcomes: "All required outcomes are covered.",
    keyDecisions: ["The database is authoritative"],
    keyFiles: ["src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts"],
    lessonsLearned: ["Descendants are verified, not rewritten"],
    followUps: "None.",
    deviations: "None.",
    ...overrides,
  };
}

function input(
  idempotencyKey: string,
  closeoutOverrides: Partial<MilestoneCompletionCloseout> = {},
) {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    sourceRevision: testedSourceRevision,
    closeout: closeout(closeoutOverrides),
    audit: {
      actorName: "completion-contract",
      triggerReason: "Current validation and terminal descendants",
    },
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event?: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, string>;
  },
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
    const emitted = event?.() ?? {
      eventType: operationType,
      entityType: "milestone",
      entityId: "M001",
      payload: { idempotencyKey },
    };
    return {
      events: [{
        ...emitted,
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

function lifecycleId(itemKind: "slice" | "task", sliceId: string, taskId?: string): string {
  const taskClause = taskId === undefined ? "task_id IS NULL" : `task_id = '${taskId}'`;
  return String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles
    WHERE item_kind = '${itemKind}' AND milestone_id = 'M001'
      AND slice_id = '${sliceId}' AND ${taskClause}
  `).lifecycle_id);
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-completion-domain-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'milestone completion';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) assert.fail(source.error);
  testedSourceRevision = source.snapshot.aggregateRevision;

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Atomic completion", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "skipped" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", status: "skipped" });
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-14T00:00:00.000Z', 'test',
      '2026-07-14T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-14T00:00:00.000Z',
      '2099-07-14T00:00:00.000Z', 'held'
    );
  `);
  executeAtFence("test.milestone-completion.ready", "fixture/milestone-completion/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T02",
      lifecycleStatus: "cancelled",
    });
  });
  const sliceLifecycleId = lifecycleId("slice", "S02");
  let waiverId = "";
  executeAtFence("slice.cancel", "fixture/milestone-completion/waiver", (context) => {
    waiverId = grantSliceCancellationWaiver(context, {
      lifecycleId: sliceLifecycleId,
      milestoneId: "M001",
      sliceId: "S02",
      rationale: "S02 is intentionally omitted from this Milestone.",
      grantedByActorType: "policy",
    }).waiverId;
  }, () => {
    return {
      eventType: "slice.cancelled",
      entityType: "slice",
      entityId: "M001/S02",
      payload: { sliceLifecycleId, waiverId },
    };
  });
  return basePath;
}

const validation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |\n| S02 | waived |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

async function prepareFixture(
  mutate?: (basePath: string) => void,
): Promise<string> {
  const basePath = makeBase();
  mutate?.(basePath);
  const result = await handleValidateMilestone(validation, basePath, {
    invocation: invocation("fixture/milestone-completion/validate"),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in result), `validation fixture failed: ${"error" in result ? result.error : ""}`);
  return basePath;
}

function descendantSnapshot(): Record<string, unknown> {
  return {
    slices: rows("SELECT * FROM slices WHERE milestone_id = 'M001' ORDER BY id"),
    tasks: rows("SELECT * FROM tasks WHERE milestone_id = 'M001' ORDER BY slice_id, id"),
    lifecycles: rows(`
      SELECT * FROM workflow_item_lifecycles
      WHERE milestone_id = 'M001' AND item_kind IN ('slice', 'task')
      ORDER BY item_kind, slice_id, task_id
    `),
    attempts: rows(`
      SELECT attempt.* FROM workflow_execution_attempts attempt
      JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = attempt.lifecycle_id
      WHERE lifecycle.milestone_id = 'M001' AND lifecycle.item_kind IN ('slice', 'task')
      ORDER BY attempt.lifecycle_id, attempt.attempt_number
    `),
    results: rows(`
      SELECT result.* FROM workflow_attempt_results result
      JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = result.lifecycle_id
      WHERE lifecycle.milestone_id = 'M001' AND lifecycle.item_kind IN ('slice', 'task')
      ORDER BY result.lifecycle_id, result.created_at
    `),
    waivers: rows("SELECT * FROM workflow_waivers ORDER BY project_revision, waiver_id"),
  };
}

function durableSnapshot(): Record<string, unknown> {
  return {
    authority: rows("SELECT * FROM project_authority"),
    milestones: rows("SELECT * FROM milestones ORDER BY id"),
    descendants: descendantSnapshot(),
    operations: rows("SELECT * FROM workflow_operations ORDER BY resulting_revision"),
    events: rows("SELECT * FROM workflow_domain_events ORDER BY project_revision, event_index"),
    outbox: rows("SELECT * FROM workflow_outbox ORDER BY outbox_id"),
    projections: rows("SELECT * FROM workflow_projection_work ORDER BY source_project_revision, projection_key"),
    qualityGates: rows("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, task_id, gate_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
  };
}

function qualityGateSnapshot(): Record<string, unknown> {
  return {
    qualityGates: rows("SELECT * FROM quality_gates ORDER BY milestone_id, slice_id, task_id, gate_id"),
    gateRuns: rows("SELECT * FROM gate_runs ORDER BY id"),
  };
}

function cleanupFixtures(): void {
  _setDomainOperationFaultForTest(null);
  testedSourceRevision = "";
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
}

async function rejectWithoutResidue(
  idempotencyKey: string,
  pattern: RegExp,
): Promise<void> {
  const before = durableSnapshot();
  await assert.rejects(
    async () => completeMilestone(input(idempotencyKey)),
    pattern,
  );
  assert.deepEqual(durableSnapshot(), before, "rejected completion must leave exact zero residue");
}

function setNonterminal(kind: "slice" | "task"): void {
  executeAtFence(`${kind}.reopen`, `fixture/${kind}/nonterminal`, (context) => {
    if (kind === "slice") {
      adoptOrTransitionLifecycle(context, {
        itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready",
      });
      db().prepare("UPDATE slices SET status = 'in_progress' WHERE milestone_id = 'M001' AND id = 'S01'").run();
      return;
    }
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "ready",
    });
    db().prepare(`
      UPDATE tasks SET status = 'pending'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
  });
}

function insertActiveAttempt(state: "claimed" | "running"): void {
  executeAtFence("attempt.claim", `fixture/attempt/${state}`, (context) => {
    const running = state === "running";
    db().prepare(`
      INSERT INTO workflow_execution_attempts (
        attempt_id, project_id, lifecycle_id, attempt_number, retry_of_attempt_id,
        attempt_state, coordination_dispatch_id, worker_id, milestone_lease_token,
        claimed_at, started_at, ended_at,
        claim_operation_id, claim_project_revision, claim_authority_epoch,
        settle_operation_id, settle_project_revision, settle_authority_epoch
      ) VALUES (
        :attempt_id, :project_id, :lifecycle_id, 1, NULL,
        :attempt_state, NULL, :worker_id, :lease_token,
        '2026-07-14T00:01:00.000Z', :started_at, NULL,
        :operation_id, :project_revision, :authority_epoch,
        NULL, NULL, NULL
      )
    `).run({
      ":attempt_id": `attempt-${state}`,
      ":project_id": context.projectId,
      ":lifecycle_id": lifecycleId("task", "S01", "T01"),
      ":attempt_state": state,
      ":worker_id": running ? "worker-1" : null,
      ":lease_token": running ? 7 : null,
      ":started_at": running ? "2026-07-14T00:01:00.000Z" : null,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
    });
  });
}

function endCancellationWaiver(status: "expired" | "revoked"): void {
  executeAtFence(`test.waiver.${status}`, `fixture/waiver/${status}`, (context) => {
    db().prepare(`
      UPDATE workflow_waivers
      SET waiver_status = :status,
          ended_at = '2026-07-14T00:02:00.000Z',
          ended_operation_id = :operation_id,
          ended_project_revision = :project_revision,
          ended_authority_epoch = :authority_epoch
      WHERE lifecycle_id = :lifecycle_id AND waiver_status = 'active'
    `).run({
      ":status": status,
      ":operation_id": context.operationId,
      ":project_revision": context.resultingRevision,
      ":authority_epoch": context.resultingAuthorityEpoch,
      ":lifecycle_id": lifecycleId("slice", "S02"),
    });
  });
}

function addAuthorizedEmptyCancelledSlice(): void {
  insertSlice({ id: "S03", milestoneId: "M001", status: "skipped" });
  executeAtFence("test.slice.cancelled", "fixture/empty-slice/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S03",
      lifecycleStatus: "cancelled",
    });
  });
  const sliceLifecycleId = lifecycleId("slice", "S03");
  let waiverId = "";
  executeAtFence("slice.cancel", "fixture/empty-slice/waiver", (context) => {
    waiverId = grantSliceCancellationWaiver(context, {
      lifecycleId: sliceLifecycleId,
      milestoneId: "M001",
      sliceId: "S03",
      rationale: "The empty Slice is intentionally omitted.",
      grantedByActorType: "policy",
    }).waiverId;
  }, () => ({
    eventType: "slice.cancelled",
    entityType: "slice",
    entityId: "M001/S03",
    payload: { sliceLifecycleId, waiverId },
  }));
}

function authorizeCancelledTaskWithTwoRequirements(): {
  waiverIds: string[];
  dispositionIds: string[];
} {
  executeAtFence("task.reopen", "fixture/cancelled-task/reopen", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
  });
  executeAtFence("test.task.cancel", "fixture/cancelled-task/cancel", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "cancelled",
    });
    db().prepare(`
      UPDATE tasks SET status = 'skipped', completed_at = NULL
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
    `).run();
  });
  const taskLifecycleId = lifecycleId("task", "S01", "T01");
  db().exec(`
    INSERT INTO requirements (id, class, status, description) VALUES
      ('R-CANCEL-ONE', 'quality-attribute', 'active', 'First authorized omission'),
      ('R-CANCEL-TWO', 'quality-attribute', 'active', 'Second authorized omission')
  `);
  const waiverIds: string[] = [];
  const dispositionIds: string[] = [];
  for (const requirementId of ["R-CANCEL-ONE", "R-CANCEL-TWO"]) {
    const waiver = grantTaskWaiver({
      invocation: invocation(`fixture/cancelled-task/waiver/${requirementId}`),
      lifecycleId: taskLifecycleId,
      requirementId,
      scope: "M001/S01/T01 cancellation",
      rationale: `The current omission covers ${requirementId}.`,
      grantedByActorType: "policy",
    });
    waiverIds.push(waiver.waiverId);
    const disposition = recordTaskRequirementDisposition({
      invocation: invocation(`fixture/cancelled-task/disposition/${requirementId}`),
      requirementId,
      disposition: "waived",
      waiverId: waiver.waiverId,
      rationale: `The current Waiver authorizes ${requirementId}.`,
    });
    dispositionIds.push(disposition.dispositionId);
  }
  return { waiverIds, dispositionIds };
}

function createShadowMismatch(kind: "slice" | "task"): void {
  if (kind === "slice") {
    db().prepare("UPDATE slices SET status = 'in_progress' WHERE milestone_id = 'M001' AND id = 'S01'").run();
    return;
  }
  db().prepare(`
    UPDATE tasks SET status = 'pending'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
}

afterEach(cleanupFixtures);

test("adopted closeout proof inspects quality gates without mutating them", async () => {
  const basePath = await prepareFixture();
  writeFileSync(
    join(basePath, ".gsd", "milestones", "M001", "M001-SUMMARY.md"),
    "# Milestone Summary\n",
  );
  const before = qualityGateSnapshot();

  const result = proveMilestoneCloseout("M001", {
    allowOpenMilestone: true,
    summaryArtifactBasePath: basePath,
  });

  assert.deepEqual(result, { ok: true });
  assert.deepEqual(qualityGateSnapshot(), before);
});

test("Milestone completion rejects unresolved pending quality gates without residue", async () => {
  await prepareFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    gateId: "Q5",
    scope: "task",
    status: "pending",
  });

  await rejectWithoutResidue(
    "milestone-complete/pending-quality-gate",
    /quality gate Q5 is still pending for S01/i,
  );
});

test("Milestone completion repairs every pending gate for a skipped slice in one call", async () => {
  const basePath = await prepareFixture();
  for (const gate of [
    { gateId: "Q3", scope: "slice" },
    { gateId: "Q4", scope: "slice" },
    { gateId: "Q5", scope: "task", taskId: "T02" },
    { gateId: "Q6", scope: "task", taskId: "T02" },
    { gateId: "Q7", scope: "task", taskId: "T02" },
    { gateId: "Q8", scope: "slice" },
  ] as const) {
    insertGateRow({
      milestoneId: "M001",
      sliceId: "S02",
      gateId: gate.gateId,
      scope: gate.scope,
      taskId: "taskId" in gate ? gate.taskId : undefined,
    });
  }

  const result = await handleCompleteMilestone({
    milestoneId: "M001",
    verificationPassed: true,
    ...closeout(),
  }, basePath, invocation("milestone-complete/skipped-slice-gates"));

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.deepEqual(rows(`
    SELECT gate_id, status, verdict
    FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S02'
    ORDER BY gate_id
  `), ["Q3", "Q4", "Q5", "Q6", "Q7", "Q8"].map((gateId) => ({
    gate_id: gateId,
    status: "complete",
    verdict: "omitted",
  })));
});

test("Milestone completion ignores completed unregistered legacy quality gates", async () => {
  await prepareFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "UAT" as GateId,
    scope: "slice",
    status: "pending",
  });
  saveGateResult({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "UAT",
    verdict: "pass",
    rationale: "Historical UAT passed before the current gate registry was introduced.",
    findings: "legacy receipt",
  });

  const result = await completeMilestone(input("milestone-complete/terminal-legacy-gate"));

  assert.equal(result.status, "committed");
  assert.deepEqual(row(`
    SELECT status, verdict, rationale, findings
    FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'UAT'
  `), {
    status: "complete",
    verdict: "pass",
    rationale: "Historical UAT passed before the current gate registry was introduced.",
    findings: "legacy receipt",
  });
});

test("Milestone completion rejects pending unregistered legacy quality gates", async () => {
  await prepareFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "UAT" as GateId,
    scope: "slice",
    status: "pending",
  });

  await rejectWithoutResidue(
    "milestone-complete/pending-legacy-gate",
    /quality gate UAT is still pending for S01/i,
  );
});

test("Milestone completion rejects malformed unregistered legacy gate status", async () => {
  await prepareFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "UAT" as GateId,
    scope: "slice",
    status: "pending",
  });
  db().prepare(`
    UPDATE quality_gates SET status = 'blocked'
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'UAT'
  `).run();

  await rejectWithoutResidue(
    "milestone-complete/malformed-legacy-gate",
    /quality gate UAT is still pending for S01/i,
  );
});

test("Milestone completion commits one receipt and preserves every descendant fact", async () => {
  await prepareFixture();
  const descendantsBefore = descendantSnapshot();
  const validationGatesBefore = rows(`
    SELECT gate_id, status, verdict, rationale FROM quality_gates
    WHERE milestone_id = 'M001' AND scope = 'milestone'
    ORDER BY gate_id
  `);
  const gateRunsBefore = Number(row("SELECT COUNT(*) AS count FROM gate_runs").count);
  const beforeRevision = Number(row("SELECT revision FROM project_authority").revision);
  const request = input("milestone-complete/direct/success");

  const result = await completeMilestone(request);

  assert.equal(result.status, "committed");
  assert.equal(result.canonicalStatus, "completed");
  assert.equal(result.legacyStatus, "complete");
  assert.equal(result.isCurrent, true);
  assert.equal(result.resultingRevision, beforeRevision + 1);
  assert.deepEqual(row(`
    SELECT milestone.status AS legacy_status, milestone.completed_at,
           lifecycle.lifecycle_status AS canonical_status
    FROM milestones milestone
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'milestone'
     AND lifecycle.milestone_id = milestone.id
     AND lifecycle.slice_id IS NULL
     AND lifecycle.task_id IS NULL
    WHERE milestone.id = 'M001'
  `), {
    legacy_status: "complete",
    completed_at: result.completedAt,
    canonical_status: "completed",
  });
  assert.ok(validationGatesBefore.length > 0);
  assert.ok(validationGatesBefore.every((gate) => !String(gate.rationale).includes(result.validationEventId)));
  const validationGatesAfter = rows(`
    SELECT gate_id, status, verdict, rationale FROM quality_gates
    WHERE milestone_id = 'M001' AND scope = 'milestone'
    ORDER BY gate_id
  `);
  assert.equal(validationGatesAfter.length, validationGatesBefore.length);
  assert.ok(validationGatesAfter.every((gate) => gate.status === "complete" && gate.verdict === "pass"));
  assert.ok(validationGatesAfter.every((gate) => String(gate.rationale).includes(result.validationEventId)));
  assert.equal(
    Number(row("SELECT COUNT(*) AS count FROM gate_runs").count),
    gateRunsBefore + validationGatesAfter.length,
  );
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE operation_type = 'milestone.complete' AND operation_id = '${result.operationId}'
  `).count, 1);
  const event = row(`
    SELECT event_type, entity_type, entity_id, payload_json
    FROM workflow_domain_events WHERE operation_id = '${result.operationId}'
  `);
  assert.deepEqual({
    event_type: event.event_type,
    entity_type: event.entity_type,
    entity_id: event.entity_id,
  }, {
    event_type: "milestone.completed",
    entity_type: "milestone",
    entity_id: "M001",
  });
  const payload = JSON.parse(String(event.payload_json)) as Record<string, unknown>;
  assert.deepEqual(payload["closeout"], request.closeout);
  assert.equal(payload["completedAt"], result.completedAt);
  assert.equal(payload["validationEventId"], result.validationEventId);
  assert.equal(payload["validationRevision"], result.validationRevision);
  assert.deepEqual(row(`
    SELECT projection_key, projection_kind
    FROM workflow_projection_work WHERE enqueue_operation_id = '${result.operationId}'
  `), {
    projection_key: "lifecycle/m001",
    projection_kind: "milestone-lifecycle",
  });
  assert.deepEqual(descendantSnapshot(), descendantsBefore, "completion must verify descendants without rewriting them");
});

test("Milestone completion adopts missing completed legacy descendant lifecycles", async () => {
  const basePath = await prepareFixture(() => {
    insertSlice({ id: "S00", milestoneId: "M001", status: "complete" });
    insertTask({ id: "T00", sliceId: "S00", milestoneId: "M001", status: "complete" });
    db().prepare(`
      UPDATE slices SET depends = '["S00"]'
      WHERE milestone_id = 'M001' AND id = 'S01'
    `).run();
  });
  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND slice_id = 'S00'
  `).count, 0);

  const result = await handleCompleteMilestone({
    milestoneId: "M001",
    verificationPassed: true,
    ...closeout(),
  }, basePath, invocation("milestone-complete/public/legacy-descendants"));

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
  assert.ok(result.operationId);
  const payload = JSON.parse(String(row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE operation_id = '${result.operationId}' AND event_type = 'milestone.completed'
  `).payload_json)) as Record<string, unknown>;
  assert.ok((payload["completedSliceIds"] as string[]).includes("S00"));
  assert.ok((payload["completedTaskIds"] as string[]).includes("S00/T00"));
  assert.deepEqual(rows(`
    SELECT item_kind, lifecycle_status, state_version, last_operation_id
    FROM workflow_item_lifecycles
    WHERE milestone_id = 'M001' AND slice_id = 'S00'
    ORDER BY item_kind
  `), [{
    item_kind: "slice",
    lifecycle_status: "completed",
    state_version: 0,
    last_operation_id: result.operationId,
  }, {
    item_kind: "task",
    lifecycle_status: "completed",
    state_version: 0,
    last_operation_id: result.operationId,
  }]);
  assert.deepEqual(proveMilestoneCloseout("M001", { summaryArtifactBasePath: basePath }), { ok: true });
});

test("Milestone completion replays its receipt and conflicts on changed closeout", async () => {
  await prepareFixture();
  const request = input("milestone-complete/direct/replay");

  const committed = await completeMilestone(request);
  const afterCommit = durableSnapshot();
  const replayed = await completeMilestone(request);

  assert.equal(committed.status, "committed");
  assert.equal(replayed.status, "replayed");
  assert.deepEqual({ ...replayed, status: "committed" }, committed);
  assert.deepEqual(durableSnapshot(), afterCommit, "exact replay must add no lineage");

  await assert.rejects(
    async () => completeMilestone(input(request.invocation.idempotencyKey, {
      narrative: "Conflicting closeout under the same execution identity.",
    })),
    /idempotency conflict/i,
  );
  assert.deepEqual(durableSnapshot(), afterCommit, "changed reuse must leave exact zero residue");
});

test("Milestone completion rolls back hierarchy, gate, ledger, event, and delivery writes", async () => {
  await prepareFixture();
  const before = durableSnapshot();
  _setDomainOperationFaultForTest("after-mutation");

  await assert.rejects(
    async () => completeMilestone(input("milestone-complete/fault/after-mutation")),
    /domain operation fault: after-mutation/i,
  );

  _setDomainOperationFaultForTest(null);
  assert.deepEqual(durableSnapshot(), before, "precommit failure must leave exact zero residue");
});

test("Milestone completion rejects nonterminal Slice and Task descendants", async (t) => {
  for (const kind of ["slice", "task"] as const) {
    await t.test(kind, async () => {
      await prepareFixture(() => setNonterminal(kind));
      await rejectWithoutResidue(`milestone-complete/nonterminal/${kind}`, /terminal|incomplete|ready/i);
      cleanupFixtures();
    });
  }
});

test("Milestone completion rejects claimed and running descendant Attempts", async (t) => {
  for (const state of ["claimed", "running"] as const) {
    await t.test(state, async () => {
      await prepareFixture(() => insertActiveAttempt(state));
      await rejectWithoutResidue(`milestone-complete/attempt/${state}`, /active|attempt|claimed|running/i);
      cleanupFixtures();
    });
  }
});

test("Milestone completion requires a current cancellation Waiver", async (t) => {
  for (const status of ["expired", "revoked"] as const) {
    await t.test(status, async () => {
      await prepareFixture(() => endCancellationWaiver(status));
      await rejectWithoutResidue(`milestone-complete/waiver/${status}`, /waiver|authorized|cancellation/i);
      cleanupFixtures();
    });
  }
});

test("Milestone completion accepts an authorized empty cancelled Slice", async () => {
  await prepareFixture(() => addAuthorizedEmptyCancelledSlice());

  const result = await completeMilestone(input("milestone-complete/empty-cancelled-slice"));

  assert.equal(result.status, "committed");
  assert.deepEqual(result.cancelledSliceIds, ["S02", "S03"]);
  assert.equal(result.waiverIds.length, 2);
});

test("Milestone completion records every current Waiver for a cancelled Task", async () => {
  let taskAuthorizations: ReturnType<typeof authorizeCancelledTaskWithTwoRequirements> | undefined;
  await prepareFixture(() => {
    taskAuthorizations = authorizeCancelledTaskWithTwoRequirements();
  });
  assert.ok(taskAuthorizations);
  const sliceWaiverId = String(row(`
    SELECT waiver.waiver_id
    FROM workflow_waivers waiver
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = waiver.lifecycle_id
    WHERE lifecycle.item_kind = 'slice' AND lifecycle.milestone_id = 'M001'
      AND lifecycle.slice_id = 'S02' AND waiver.waiver_status = 'active'
  `).waiver_id);

  const result = await completeMilestone(input("milestone-complete/multiple-task-waivers"));

  assert.equal(result.status, "committed");
  assert.deepEqual(result.cancelledTaskIds, ["S01/T01", "S02/T02"]);
  assert.deepEqual(
    [...result.dispositionIds].sort(),
    [...taskAuthorizations.dispositionIds].sort(),
  );
  assert.deepEqual(
    [...result.waiverIds].sort(),
    [sliceWaiverId, ...taskAuthorizations.waiverIds].sort(),
  );
});

test("Milestone completion rejects Slice and Task shadow mismatches", async (t) => {
  for (const kind of ["slice", "task"] as const) {
    await t.test(kind, async () => {
      await prepareFixture(() => createShadowMismatch(kind));
      await rejectWithoutResidue(`milestone-complete/mismatch/${kind}`, /canonical|legacy|shadow|mismatch/i);
      cleanupFixtures();
    });
  }
});

// ─── GREEN-05/D-05: close-time residual capture never halts, never bypasses
// a hard block ──────────────────────────────────────────────────────────

function trackerItemCount(): number {
  return Number(row("SELECT COUNT(*) AS count FROM tracker_items").count);
}

function storedEventPayload(operationId: string): Record<string, unknown> {
  const event = row(`
    SELECT payload_json FROM workflow_domain_events WHERE operation_id = '${operationId}'
  `);
  return JSON.parse(String(event.payload_json)) as Record<string, unknown>;
}

test("Milestone completion never halts for an unresolvable residual item: it commits and reports the capture on the receipt", async () => {
  await prepareFixture();

  const result = await completeMilestone(input("milestone-complete/residual/never-halts", {
    residualItems: [{ title: "Deferred item the operator never resolved", severity: "MEDIUM" }],
  }));

  assert.equal(result.status, "committed");
  assert.equal(result.residualCapture.created.length, 1);
  assert.equal(result.residualCapture.skipped.length, 0);
  // WR-02/IN-01 fix: `failures` is failure-only, never populated on success.
  assert.equal(result.residualCapture.failures.length, 0);
  assert.equal(
    Number(row(
      "SELECT COUNT(*) AS count FROM tracker_items WHERE title = 'Deferred item the operator never resolved'",
    ).count),
    1,
  );
});

test("Milestone completion with no residual items reports an empty capture and leaves the tracker untouched", async () => {
  await prepareFixture();
  const trackerBefore = trackerItemCount();

  const result = await completeMilestone(input("milestone-complete/residual/absent-is-noop"));

  assert.equal(result.status, "committed");
  assert.deepEqual(result.residualCapture, { created: [], skipped: [], failures: [] });
  assert.equal(trackerItemCount(), trackerBefore);

  const storedCloseout = storedEventPayload(result.operationId)["closeout"] as Record<string, unknown>;
  assert.ok(
    !("residualItems" in storedCloseout),
    "closeout must omit residualItems entirely when the caller never supplied it",
  );
});

test("Milestone completion residual items never bypass hard block 1: canonical validation not current", async () => {
  makeBase(); // no validation recorded — authorization.authorized is false
  const trackerBefore = trackerItemCount();

  await assert.rejects(
    async () => completeMilestone(input("milestone-complete/residual/hard-block-authorization", {
      residualItems: [{ title: "Must not unblock an unauthorized close" }],
    })),
    /canonical validation is not current/,
  );

  assert.equal(trackerItemCount(), trackerBefore);
});

test("Milestone completion residual items never bypass hard block 2: unresolved pending quality gate", async () => {
  await prepareFixture();
  insertGateRow({
    milestoneId: "M001",
    sliceId: "S01",
    taskId: "T01",
    gateId: "Q5",
    scope: "task",
    status: "pending",
  });
  const trackerBefore = trackerItemCount();

  await assert.rejects(
    async () => completeMilestone(input("milestone-complete/residual/hard-block-gate", {
      residualItems: [{ title: "Must not unblock a pending quality gate" }],
    })),
    /quality gate Q5 is still pending for S01/i,
  );

  assert.equal(trackerItemCount(), trackerBefore);
});

test("Milestone completion residual items never bypass hard block 3: outstanding Gate-2 human UAT", async () => {
  await prepareFixture();
  registerGate2HumanUatPending({
    invocation: invocation("fixture/residual/gate2-pending"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "Awaiting human sign-off before this Milestone may close.",
    partialCriteria: [],
  });
  const trackerBefore = trackerItemCount();

  await assert.rejects(
    async () => completeMilestone(input("milestone-complete/residual/hard-block-gate2", {
      residualItems: [{ title: "Must not unblock outstanding Gate-2 human UAT" }],
    })),
    /outstanding Gate-2 human UAT/,
  );

  assert.equal(trackerItemCount(), trackerBefore);
});

test("Milestone completion still commits when the residual capture reports a failure", async () => {
  await prepareFixture();

  const result = await completeMilestone(input("milestone-complete/residual/capture-failure-still-commits", {
    // A whitespace-only title trips createTrackerItem's own
    // validateCreateTrackerItemInput ("title is required") — a real
    // production failure path, forcing captureMilestoneCloseoutResiduals to
    // record a failure without throwing.
    residualItems: [{ title: "   " }],
  }));

  assert.equal(result.status, "committed");
  assert.equal(result.canonicalStatus, "completed");
  assert.equal(result.residualCapture.created.length, 0);
  assert.equal(result.residualCapture.failures.length, 1);
  assert.match(result.residualCapture.failures[0]!, /title is required/);

  assert.equal(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE operation_id = '${result.operationId}' AND event_type = 'milestone.completed'
  `).count, 1);
  assert.deepEqual(row(`
    SELECT lifecycle.lifecycle_status AS canonical_status
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = 'M001'
      AND lifecycle.slice_id IS NULL AND lifecycle.task_id IS NULL
  `), { canonical_status: "completed" });
});

test("Milestone completion's event payload carries the supplied residual items even when the tracker write fails", async () => {
  await prepareFixture();
  const items: MilestoneCloseoutResidualItem[] = [{ title: "   " }];

  const result = await completeMilestone(input("milestone-complete/residual/provenance", {
    residualItems: items,
  }));

  assert.equal(result.residualCapture.created.length, 0);
  const storedCloseout = storedEventPayload(result.operationId)["closeout"] as Record<string, unknown>;
  assert.deepEqual(storedCloseout["residualItems"], items);
});

// GREEN-05/D-05 never-halt guarantee, stated as a named regression: a
// future refactor that reintroduces error propagation at the capture call
// site (the exact mistake this requirement exists to prevent) must trip
// this test.
test("GREEN-05 never-halt guarantee: a forced residual-capture failure still yields a successful receipt with a completed milestone", async () => {
  await prepareFixture();

  const result = await completeMilestone(input("milestone-complete/residual/never-halt-guarantee", {
    // Whitespace-only title forces createTrackerItem's own validation to
    // fail — captureMilestoneCloseoutResiduals must record this in
    // `failures` and never rethrow, per the file-purpose header on
    // milestone-closeout-residual-capture.ts.
    residualItems: [{ title: "   " }],
  }));

  assert.equal(result.status, "committed");
  assert.equal(result.residualCapture.failures.length > 0, true);
  assert.deepEqual(row(`
    SELECT lifecycle.lifecycle_status AS canonical_status
    FROM workflow_item_lifecycles lifecycle
    WHERE lifecycle.item_kind = 'milestone' AND lifecycle.milestone_id = 'M001'
      AND lifecycle.slice_id IS NULL AND lifecycle.task_id IS NULL
  `), { canonical_status: "completed" });
});

// ─── CONV-05: residualHighSummary — tracker-sourced run-end visibility ─────

function seedResidualHigh(
  basePath: string,
  overrides: {
    milestoneId?: string;
    phase?: string;
    disposition?: string;
    title?: string;
  } = {},
): { trackId: string } {
  const milestoneId = overrides.milestoneId ?? "M001";
  const disposition = overrides.disposition ?? MUST_FIX_IN_EXECUTE_DISPOSITION_TAG;
  const phase = overrides.phase ?? "S01";
  return createTrackerItem(
    {
      type: "incident",
      severity: "HIGH",
      title: overrides.title ?? `Residual HIGH seeded for ${milestoneId}/${phase}/${disposition}`,
      detail: "{}",
      dispositionTags: [PLAN_REVIEW_RESIDUAL_HIGH_TAG, milestoneScopeTag(milestoneId), disposition],
      refs: [{ refKind: "phase", refValue: phase }],
    },
    basePath,
  );
}

test("completeMilestone's residualHighSummary counts every disposition and lists distinct phases in first-seen order", async () => {
  const basePath = await prepareFixture();
  seedResidualHigh(basePath, { phase: "S01", disposition: MUST_FIX_IN_EXECUTE_DISPOSITION_TAG, title: "S01 must-fix" });
  seedResidualHigh(basePath, { phase: "S02", disposition: deferredToPhaseDispositionTag("22"), title: "S02 deferred" });

  const result = await completeMilestone(input("milestone-complete/residual-high/two-phase"));

  assert.deepEqual(result.residualHighSummary, { count: 2, phases: ["S01", "S02"] });
});

test("completeMilestone's residualHighSummary de-dups the phase list: two rows on one phase count as 2 rows, 1 phase", async () => {
  const basePath = await prepareFixture();
  seedResidualHigh(basePath, { phase: "S01", title: "S01 first" });
  seedResidualHigh(basePath, { phase: "S01", title: "S01 second" });

  const result = await completeMilestone(input("milestone-complete/residual-high/dedup-phase"));

  assert.deepEqual(result.residualHighSummary, { count: 2, phases: ["S01"] });
});

test("completeMilestone's residualHighSummary excludes Phase 19 closeout-residual rows even at severity HIGH", async () => {
  const basePath = await prepareFixture();
  createTrackerItem(
    {
      type: "incident",
      severity: "HIGH",
      title: "Closeout residual, not a plan-review residual HIGH",
      dispositionTags: [milestoneScopeTag("M001"), "milestone-closeout-residual"],
      refs: [{ refKind: "phase", refValue: "S01" }],
    },
    basePath,
  );

  const result = await completeMilestone(input("milestone-complete/residual-high/exclude-closeout-class"));

  assert.deepEqual(result.residualHighSummary, { count: 0, phases: [] });
});

test("completeMilestone's residualHighSummary excludes rows scoped to a different milestone", async () => {
  const basePath = await prepareFixture();
  seedResidualHigh(basePath, { milestoneId: "M999", phase: "S01", title: "Wrong milestone" });

  const result = await completeMilestone(input("milestone-complete/residual-high/exclude-other-milestone"));

  assert.deepEqual(result.residualHighSummary, { count: 0, phases: [] });
});

test("completeMilestone's residualHighSummary is {count:0, phases:[]} for a milestone with zero residual-HIGH rows", async () => {
  await prepareFixture();

  const result = await completeMilestone(input("milestone-complete/residual-high/empty"));

  assert.deepEqual(result.residualHighSummary, { count: 0, phases: [] });
});

test("completeMilestone's residualHighSummary coexists with residualCapture without interference", async () => {
  const basePath = await prepareFixture();
  seedResidualHigh(basePath, { phase: "S01", title: "Coexistence residual HIGH" });

  const result = await completeMilestone(input("milestone-complete/residual-high/coexistence", {
    residualItems: [{ title: "Deferred item the operator never resolved", severity: "MEDIUM" }],
  }));

  assert.equal(result.status, "committed");
  assert.equal(result.residualCapture.created.length, 1);
  assert.equal(result.residualCapture.skipped.length, 0);
  assert.equal(result.residualCapture.failures.length, 0);
  assert.deepEqual(result.residualHighSummary, { count: 1, phases: ["S01"] });
});

test("completeMilestone recomputes residualHighSummary on each call rather than caching it: a resolution between two completions is reflected on the second", async () => {
  const basePath = await prepareFixture();
  const { trackId } = seedResidualHigh(basePath, { phase: "S01", title: "Resolved between two completions" });

  const first = await completeMilestone(input("milestone-complete/residual-high/recompute-not-cache"));
  assert.deepEqual(first.residualHighSummary, { count: 1, phases: ["S01"] });

  resolveTrackerItem({ trackId, status: "resolved" }, basePath);

  const second = await completeMilestone(input("milestone-complete/residual-high/recompute-not-cache"));
  assert.equal(second.status, "replayed");
  assert.deepEqual(second.residualHighSummary, { count: 0, phases: [] });
});
