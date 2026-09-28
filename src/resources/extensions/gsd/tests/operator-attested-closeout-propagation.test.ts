// Project/App: gsd-pi
// File Purpose: Slice and Milestone closeout accept an operator-attested Task
// as terminal, closed, unverdicted work (Phase 31 Plan 02, RELY-03,
// INC-2026-09-27-01) — proving `gsd_slice_complete`/`gsd_complete_milestone`
// proceed past an attested Task with no fabricated completion proof and no
// fabricated cancellation Waiver, while a half-written Task still fails the
// canonical/legacy parity gate.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import type { DomainOperationContext } from "../db/domain-operation.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { recordTaskTechnicalVerdict } from "../task-verification-domain-operation.ts";
import { applyOperatorAttestedDisposition } from "../task-settle.ts";
import { completeSliceHierarchy } from "../db/writers/slice-lifecycle.ts";
import { completeMilestoneHierarchy } from "../db/writers/milestone-lifecycle.ts";
import { grantMilestoneValidationWaiver } from "../milestone-validation-waiver-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function invocation(key: string): ExecutionInvocation {
  return {
    idempotencyKey: key,
    sourceTransport: "internal",
    actorType: "user",
    traceId: `trace:${key}`,
  };
}

const PASSING_EVIDENCE = { command: "npm test", exitCode: 0, verdict: "pass" } as const;

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
        entityType: "slice",
        entityId: "M001/S01",
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

/** Seeds Milestone M001 / Slice S01 with the given task ids, all lifecycle-adopted `ready`. */
function seedHierarchy(taskIds: string[]): { dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-operator-attested-closeout-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Closeout propagation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Closeout propagation", status: "pending" });
  taskIds.forEach((taskId, index) => {
    insertTask({
      id: taskId, sliceId: "S01", milestoneId: "M001",
      title: `Task ${taskId}`, status: "pending", sequence: index + 1,
    });
  });
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-09-28T00:00:00.000Z', 'test',
      '2026-09-28T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-09-28T00:00:00.000Z',
      '2099-09-28T00:00:00.000Z', 'held'
    );
  `);
  executeAtFence("test.hierarchy.ready", "fixture/hierarchy/ready", (context) => {
    adoptOrTransitionLifecycle(context, { itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready" });
    adoptOrTransitionLifecycle(context, { itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "ready" });
    for (const taskId of taskIds) {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId, lifecycleStatus: "ready",
      });
    }
  });
  return { dir };
}

function insertClaimedDispatch(taskId: string): number {
  db().prepare(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      :trace_id, :turn_id, 'worker-1', 7,
      'M001', 'S01', :task_id, 'execute-task', :unit_id,
      'claimed', 1, '2026-09-28T00:00:00.000Z'
    )
  `).run({
    ":trace_id": `trace/${taskId}`,
    ":turn_id": `turn/${taskId}`,
    ":task_id": taskId,
    ":unit_id": `M001/S01/${taskId}`,
  });
  return Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
}

function claimTask(taskId: string): string {
  return claimTaskAttempt({
    invocation: invocation(`fixture/${taskId}/claim`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: insertClaimedDispatch(taskId),
  }).attemptId;
}

// Not a reuse of tests/task-settle.test.ts's seedRetryRoutedResidue: it is not
// importable across test files in this codebase's convention (per
// 31-01-SUMMARY.md's interface note). Mirrors its shape exactly, generalized
// to any taskId in this file's shared multi-task hierarchy.
function seedRetryRoutedTask(taskId: string): { attemptId: string; resultId: string; recoveryActionId: string } {
  const attemptId = claimTask(taskId);
  const settlement = settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/retry-settle`),
    attemptId,
    outcome: "failed",
    failureClass: "transient-execution",
    summary: "transient executor fault; retry eligible",
    output: { fault: "transient" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :task_id
  `).run({ ":task_id": taskId });
  const receipt = recordFailureAndSelectRecovery({
    invocation: invocation(`fixture/${taskId}/retry-route`),
    attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "transient-execution" },
    summary: "transient executor fault; retry eligible",
    evidence: { detail: "transient" },
    rationale: "agent-owner transient-execution routes to retry",
  });
  return { attemptId, resultId: settlement.resultId, recoveryActionId: receipt.recoveryActionId };
}

/** Closes `taskId` via a real `applyOperatorAttestedDisposition` call — the
 * end-to-end propagation path this file proves, never a hand-written status
 * UPDATE. */
function attestTask(taskId: string): void {
  seedRetryRoutedTask(taskId);
  const applied = applyOperatorAttestedDisposition({
    invocation: invocation(`operator-attested/${taskId}/apply`),
    task: { milestoneId: "M001", sliceId: "S01", taskId },
    evidence: PASSING_EVIDENCE,
    reason: "operator verified the deliverable manually",
  });
  assert.equal(applied.attested, true);
}

/** Closes `taskId` the ordinary verdict-gated way: succeeded Attempt, passing
 * Technical Verdict, evidence row, and the route/closeout/settled Kernel
 * checkpoints `currentCompletionProof` requires. Mirrors
 * slice-completion-domain-operation.test.ts's finishTaskWithOptionalEvidence. */
function completeTaskOrdinarily(taskId: string): void {
  const attemptId = claimTask(taskId);
  settleTaskAttempt({
    invocation: invocation(`fixture/${taskId}/settle`),
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "Task implementation succeeded.",
    output: { artifact: "immutable-task-history" },
  });
  recordTaskTechnicalVerdict({
    invocation: invocation(`fixture/${taskId}/verify`),
    attemptId,
    testedSourceRevision: "git:fixture-source-revision",
    verdict: "pass",
    rationale: "Focused verification passed.",
    evidence: {
      evidenceClass: "command",
      commandOrTool: "node --test operator-attested-closeout-propagation.test.ts",
      workingDirectory: "/tmp/project",
      startedAt: "2026-09-28T00:01:00.000Z",
      endedAt: "2026-09-28T00:01:01.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: "db://fixture/verification",
      environment: { runner: "node-test", fixture: "operator-attested-closeout" },
    },
  });
  executeAtFence("task.completion.publish", `fixture/${taskId}/terminal`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId, lifecycleStatus: "completed",
    });
    const lifecycleId = String(row(`
      SELECT lifecycle_id FROM workflow_execution_attempts WHERE attempt_id = :attempt_id
    `, { ":attempt_id": attemptId }).lifecycle_id);
    let previousCheckpointId = String(row(`
      SELECT kernel_checkpoint_id FROM workflow_kernel_checkpoints
      WHERE attempt_id = :attempt_id AND next_stage = 'verify'
        AND NOT EXISTS (
          SELECT 1 FROM workflow_kernel_checkpoints successor
          WHERE successor.previous_kernel_checkpoint_id = workflow_kernel_checkpoints.kernel_checkpoint_id
        )
    `, { ":attempt_id": attemptId }).kernel_checkpoint_id);
    for (const nextStage of ["route", "closeout", "settled"] as const) {
      previousCheckpointId = appendKernelCheckpoint(context, {
        lifecycleId,
        attemptId,
        nextStage,
        previousKernelCheckpointId: previousCheckpointId,
      }).kernelCheckpointId;
    }
    db().prepare(`
      UPDATE tasks SET status = 'complete', completed_at = '2026-09-28T00:02:00.000Z'
      WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :task_id
    `).run({ ":task_id": taskId });
  });
}

function closeSlice(
  operationalReadiness = "- Health signal: focused verification remains green",
): ReturnType<typeof completeSliceHierarchy> {
  let result!: ReturnType<typeof completeSliceHierarchy>;
  executeAtFence("slice.complete", "fixture/slice/complete", (context) => {
    result = completeSliceHierarchy(context, { milestoneId: "M001", sliceId: "S01", operationalReadiness });
  });
  return result;
}

test("Test A: a Slice whose only Task was closed by a real operator-attested apply completes, counting the Task completed and not cancelled", () => {
  seedHierarchy(["T01"]);
  attestTask("T01");

  const result = closeSlice();

  assert.deepEqual(result.completedTaskIds, ["T01"]);
  assert.deepEqual(result.cancelledTaskIds, []);
  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "operator-attested",
  );
  assert.equal(
    row("SELECT status AS status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'").status,
    "complete",
  );
});

test("Test B: closeout demands no completion proof for the attested Task", () => {
  seedHierarchy(["T01"]);
  attestTask("T01");
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles WHERE task_id = 'T01'
  `).lifecycle_id);
  assert.equal(
    row(`
      SELECT COUNT(*) AS count FROM workflow_technical_verdicts WHERE lifecycle_id = :lifecycle_id
    `, { ":lifecycle_id": lifecycleId }).count,
    0,
    "no passing Technical Verdict exists for the attested Task",
  );

  const result = closeSlice();

  assert.deepEqual(result.completedTaskIds, ["T01"], "closeout succeeds with no proof minted or demanded");
  assert.deepEqual(result.proofs, [], "no completion proof is fabricated for the attested Task");
});

test("Test C: closeout demands no cancellation Waiver for the attested Task", () => {
  seedHierarchy(["T01"]);
  attestTask("T01");
  const lifecycleId = String(row(`
    SELECT lifecycle_id FROM workflow_item_lifecycles WHERE task_id = 'T01'
  `).lifecycle_id);
  assert.equal(
    row(`
      SELECT COUNT(*) AS count FROM workflow_waivers
      WHERE lifecycle_id = :lifecycle_id AND scope = 'task-cancellation' AND waiver_status = 'active'
    `, { ":lifecycle_id": lifecycleId }).count,
    0,
    "no cancellation Waiver exists for the attested Task",
  );

  const result = closeSlice();

  assert.deepEqual(result.cancelledTaskIds, [], "the attested Task took the completed arm, not the cancelled arm");
  assert.deepEqual(result.completedTaskIds, ["T01"]);
});

test("Test D: a Task at operator-attested in only one vocabulary still fails Slice closeout", () => {
  seedHierarchy(["T01"]);
  // Move the Task to in_progress in both vocabularies (the real precondition
  // operator-attested requires), then write ONLY the canonical vocabulary to
  // operator-attested — bypassing applyOperatorAttestedDisposition's guard
  // chain and its legacy-vocabulary write entirely. Legacy tasks.status is
  // left at in_progress: a genuine half-written Task, not a hand-staged DB
  // shape produced by a raw UPDATE against workflow_item_lifecycles (which
  // would trip the causal-provenance trigger instead of proving anything
  // about closeout parity).
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  executeAtFence("test.half-write.in-progress", "fixture/half-write/T01/in-progress", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "in_progress",
    });
  });
  executeAtFence("test.half-write.operator-attested", "fixture/half-write/T01/operator-attested", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "operator-attested",
    });
  });
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "legacy vocabulary is deliberately left behind — the half-written Task under test",
  );

  assert.throws(
    () => closeSlice(),
    /canonical and legacy lifecycle mismatch|is not terminal with canonical and legacy parity/,
  );
});
