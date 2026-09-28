// Project/App: gsd-pi
// File Purpose: Operator contract for gsd_task_settle — dry-run-first,
// idempotent, never-guessing Task Attempt settlement (#1749).

import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { executeDomainOperation, type DomainJsonValue } from "../db/domain-operation.ts";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  readDomainOperationFence,
} from "../db/writers/lifecycle-commands.ts";
import {
  claimTaskAttempt,
  readTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import {
  applyBlockerAcceptedDisposition,
  applyOperatorAttestedDisposition,
  applyTaskSettle,
  planBlockerAcceptedDisposition,
  planOperatorAttestedDisposition,
  planTaskSettle,
} from "../task-settle.ts";
import { resolveTaskCompletionAuthority } from "../task-completion-compatibility-adapter.ts";
import { isClosedStatus } from "../status-guards.ts";
import {
  normalizeLegacyLifecycleStatus,
  compareLifecycleShadow,
} from "../db/lifecycle-shadow-comparison.ts";
import {
  readTaskRecoveryRoute,
  recordFailureAndSelectRecovery,
} from "../task-recovery-domain-operation.ts";
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

const TASK = { milestoneId: "M001", sliceId: "S01", taskId: "T01" };

function seedRunningAttempt(): { attemptId: string; dispatchId: number; dir: string } {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-settle-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Settle', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Settle operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Settle atomically', 'pending');
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-1', 'test-host', 1, '2026-07-13T00:00:00.000Z', 'test',
      '2026-07-13T00:00:00.000Z', 'active', '/tmp/project'
    );
    INSERT INTO milestone_leases (
      milestone_id, worker_id, fencing_token, acquired_at, expires_at, status
    ) VALUES (
      'M001', 'worker-1', 7, '2026-07-13T00:00:00.000Z',
      '2099-07-13T00:00:00.000Z', 'held'
    );
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'dispatch-trace-1', 'dispatch-turn-1', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', 1, '2026-07-13T00:00:00.000Z'
    );
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.ready",
    idempotencyKey: "fixture/task-ready",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId: "T01" },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.task.ready",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchId = Number(row("SELECT id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation("fixture/claim"),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
  });
  return { attemptId: claim.attemptId, dispatchId, dir };
}

function orphanClaimedAttempt(dispatchId: number): void {
  // The executor died: its dispatch left ('claimed','running') but the
  // Attempt it claimed is still running (#1749's manual-repair state).
  db().prepare(`
    UPDATE unit_dispatches SET status = 'stuck', ended_at = '2026-07-13T00:10:00.000Z'
    WHERE id = :id
  `).run({ ":id": dispatchId });
}

test("dry-run prints the exact row and mutates nothing", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planTaskSettle(TASK, "operator repair after manual investigation");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].currentStatus, "running");
  assert.equal(plan.rows[0].targetStatus, "interrupted");
  assert.match(plan.rows[0].rationale, /operator repair/);
  assert.equal(plan.rows[0].leaseHeld, true);
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
    "dry-run must not settle the Attempt",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("apply settles the orphaned Attempt and a second apply is a no-op", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const applied = applyTaskSettle({
    invocation: invocation("settle/apply/1"),
    task: TASK,
    reason: "operator repair after manual investigation",
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, false);
  assert.equal(applied.rows[0].attemptId, attemptId);
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "interrupted");
  assert.equal(settled?.resultFailureClass, "operator-settle");
  assert.equal(
    row(`
      SELECT lifecycle_status AS status
      FROM workflow_item_lifecycles
      WHERE item_kind = 'task' AND task_id = 'T01'
    `).status,
    "in_progress",
    "settle without reconcileLifecycle must not adopt canonical status",
  );

  const again = applyTaskSettle({
    invocation: invocation("settle/apply/2"),
    task: TASK,
    reason: "operator repair after manual investigation",
  });
  assert.equal(again.settled, false);
  assert.equal(again.rows.length, 0, "a second apply reports nothing to do");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the idempotent re-apply writes no second Result",
  );
});

test("a typo'd task id errors without writes", () => {
  seedRunningAttempt();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  assert.throws(
    () => planTaskSettle({ milestoneId: "M001", sliceId: "S01", taskId: "T99" }, "typo"),
    /unknown Task M001\/S01\/T99/,
  );
  assert.throws(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/typo"),
      task: { milestoneId: "M001", sliceId: "S01", taskId: "T99" },
      reason: "typo",
    }),
    /unknown Task M001\/S01\/T99/,
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "a typo'd identifier must not write",
  );
  assert.equal(
    row("SELECT attempt_state AS state FROM workflow_execution_attempts").state,
    "running",
  );
});

test("apply reclaims an expired lease and interrupts its orphaned Attempt (#1907)", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec(`
    UPDATE milestone_leases
    SET status = 'held', expires_at = '2000-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /orphaned.*apply will reclaim/i);
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK, "completion/orphaned"),
    /orphaned running Attempt.*gsd_task_settle.*reclaimable.*\/gsd auto/s,
  );

  const applied = applyTaskSettle({
    invocation: invocation("settle/apply/released"),
    task: TASK,
    reason: "operator repair",
  });
  assert.equal(applied.settled, true);
  assert.equal(readTaskAttempt(attemptId)?.state, "settled");
  assert.deepEqual(
    row(`
      SELECT recovery_worker_id AS worker, recovery_milestone_lease_token AS token
      FROM workflow_execution_attempts WHERE attempt_id = '${attemptId}'
    `),
    { worker: "worker-1", token: 8 },
  );
  assert.equal(row("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").status, "released");
  assert.throws(
    () => resolveTaskCompletionAuthority(TASK, "completion/no-running"),
    /no running Attempt.*\/gsd auto/s,
  );
});

test("apply reclaims a released lease and interrupts its orphaned Attempt (#1907)", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec("UPDATE milestone_leases SET status = 'released' WHERE milestone_id = 'M001'");

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /orphaned.*apply will reclaim/i);

  const applied = applyTaskSettle({
    invocation: invocation("settle/apply/released"),
    task: TASK,
    reason: "operator repair",
  });
  assert.equal(applied.settled, true);
  assert.equal(readTaskAttempt(attemptId)?.state, "settled");
  assert.equal(row("SELECT status FROM milestone_leases WHERE milestone_id = 'M001'").status, "released");
});

test("apply refuses an expired lease while its original worker is live (#1907)", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().prepare(`
    UPDATE workers
    SET host = :host, pid = :pid, last_heartbeat_at = :heartbeat
    WHERE worker_id = 'worker-1'
  `).run({
    ":host": hostname(),
    ":pid": process.pid,
    ":heartbeat": new Date().toISOString(),
  });
  db().exec(`
    UPDATE milestone_leases
    SET status = 'held', expires_at = '2000-01-01T00:00:00.000Z'
    WHERE milestone_id = 'M001'
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /apply will refuse/i);
  assert.throws(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/live-owner"),
      task: TASK,
      reason: "operator repair",
    }),
    /live worker or replacement lease.*\/gsd auto/s,
  );
  assert.equal(readTaskAttempt(attemptId)?.state, "running");
});

test("apply refuses to steal a live replacement lease (#1907)", () => {
  const { attemptId, dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().exec(`
    INSERT INTO workers (
      worker_id, host, pid, started_at, version, last_heartbeat_at, status,
      project_root_realpath
    ) VALUES (
      'worker-2', 'test-host', 2, '2026-07-13T00:05:00.000Z', 'test',
      '2099-07-13T00:05:00.000Z', 'active', '/tmp/project'
    );
    UPDATE milestone_leases
    SET worker_id = 'worker-2', fencing_token = 8, status = 'held',
        expires_at = '2099-07-13T00:06:00.000Z'
    WHERE milestone_id = 'M001';
  `);

  const plan = planTaskSettle(TASK, "operator repair");
  assert.equal(plan.rows[0].leaseHeld, false);
  assert.match(plan.rows[0].rationale, /apply will refuse/i);

  assert.throws(
    () => applyTaskSettle({
      invocation: invocation("settle/apply/live-replacement"),
      task: TASK,
      reason: "operator repair",
    }),
    /live worker or replacement lease.*\/gsd auto/s,
  );
  assert.equal(
    readTaskAttempt(attemptId)?.state,
    "running",
    "the live peer's Attempt remains untouched",
  );
});

function taskLifecycleStatus(): string {
  return String(row(`
    SELECT lifecycle_status AS status
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task' AND task_id = 'T01'
  `).status);
}

function restoreSummary(dir: string, body: string, status: "pending" | "complete"): string {
  const summaryPath = join(dir, "T01-SUMMARY.md");
  writeFileSync(summaryPath, body);
  db().prepare(`
    UPDATE tasks SET status = :status, full_summary_md = :body
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run({ ":status": status, ":body": body });
  return summaryPath;
}

test("reconcileLifecycle adopts ready for pending after interrupt without deleting SUMMARYs", () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);

  const dryRun = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(dryRun.rows.length, 1);
  assert.deepEqual(
    dryRun.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );
  assert.equal(taskLifecycleStatus(), "in_progress", "dry-run must not adopt lifecycle");

  const settled = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/settle"),
    task: TASK,
    reason: "operator repair",
  });
  assert.equal(settled.settled, true);
  const summaryPath = restoreSummary(dir, "# Pending repair SUMMARY", "pending");

  const planned = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(planned.rows.length, 0);
  assert.deepEqual(
    planned.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->paused", "paused->ready"],
  );

  const applied = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, true);
  assert.equal(taskLifecycleStatus(), "ready");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "pending");
  assert.equal(row("SELECT full_summary_md AS body FROM tasks WHERE id = 'T01'").body, "# Pending repair SUMMARY");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Pending repair SUMMARY");

  const again = applyTaskSettle({
    invocation: invocation("settle/reconcile/pending/2"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(again.settled, false);
  assert.equal(again.reconciled, false);
  assert.equal(taskLifecycleStatus(), "ready");
});

test("reconcileLifecycle adopts completed for complete after interrupt without deleting SUMMARYs", () => {
  const { dispatchId, dir } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  const summaryPath = restoreSummary(dir, "# Completed repair SUMMARY", "complete");

  const applied = applyTaskSettle({
    invocation: invocation("settle/reconcile/complete"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, true);
  assert.equal(applied.reconciled, true);
  assert.deepEqual(
    applied.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->completed"],
  );
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(row("SELECT status FROM tasks WHERE id = 'T01'").status, "complete");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Completed repair SUMMARY");
  assert.equal(applied.proof?.attemptId ?? null, null);
  assert.match(
    applied.proof?.note ?? "",
    /no current passing Technical Verdict/,
  );
});

test("reconcileLifecycle adopts completed after an out-of-band succeeded Attempt (#2018)", () => {
  const { attemptId, dir } = seedRunningAttempt();
  settleTaskAttempt({
    invocation: invocation("fixture/succeed"),
    attemptId,
    outcome: "succeeded",
    failureClass: "none",
    summary: "executor completed out of band",
    output: { completed: true },
  });
  assert.equal(readTaskAttempt(attemptId)?.outcome, "succeeded");
  assert.equal(taskLifecycleStatus(), "in_progress");

  assert.throws(
    () => planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true }),
    /succeeded Attempt with tasks.status complete/,
    "a succeeded Attempt must not reconcile a legacy pending task back to ready",
  );

  const summaryPath = restoreSummary(dir, "# Out-of-band completion SUMMARY", "complete");
  const planned = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(planned.rows.length, 0);
  assert.deepEqual(
    planned.lifecycleRows.map((row) => `${row.currentStatus}->${row.targetStatus}`),
    ["in_progress->completed"],
  );

  const applied = applyTaskSettle({
    invocation: invocation("settle/reconcile/succeeded"),
    task: TASK,
    reason: "operator repair",
    reconcileLifecycle: true,
  });
  assert.equal(applied.settled, false);
  assert.equal(applied.reconciled, true);
  assert.equal(taskLifecycleStatus(), "completed");
  assert.equal(existsSync(summaryPath), true);
  assert.equal(readFileSync(summaryPath, "utf8"), "# Out-of-band completion SUMMARY");
});

test("reconcileLifecycle reports when completed repair still lacks passing proof (#1749)", () => {
  const { dispatchId } = seedRunningAttempt();
  orphanClaimedAttempt(dispatchId);
  db().prepare(`
    UPDATE tasks SET status = 'complete' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  const plan = planTaskSettle(TASK, "operator repair", { reconcileLifecycle: true });
  assert.equal(plan.proof?.attemptId ?? null, null);
  assert.match(
    plan.proof?.note ?? "",
    /gsd_slice_complete will still refuse/,
  );
});

// ── blocker-accepted closeout disposition (#2202) ───────────────────────────

function seedBlockerDiscoveredResidue(): { attemptId: string; resultId: string } {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/blocker-settle"),
    attemptId,
    outcome: "failed",
    failureClass: "blocker-discovered",
    summary: "API contract invalidates the slice plan; no SUMMARY produced",
    output: { blocker: "plan-invalidating" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  return { attemptId, resultId: settlement.resultId };
}

test("blocker-accepted dry-run reports the exact transitions and mutates nothing", () => {
  const { attemptId, resultId } = seedBlockerDiscoveredResidue();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planBlockerAcceptedDisposition(TASK, "accept the discovered plan blocker");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.alreadyAccepted, false);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].resultId, resultId);
  assert.equal(plan.rows[0].currentStatus, "in_progress");
  assert.equal(plan.rows[0].targetStatus, "blocker-accepted");
  assert.equal(plan.rows[0].lifecycleFrom, "in_progress");
  assert.equal(plan.rows[0].routeConsumed, true);
  assert.match(plan.rows[0].blockerSummary, /plan blocker|API contract/);
  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "in_progress",
    "dry-run must not move the canonical lifecycle",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "dry-run must not close the legacy Task",
  );
  assert.equal(
    readTaskRecoveryRoute(attemptId),
    null,
    "dry-run must not consume the route head",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("blocker-accepted apply closes both vocabularies, records provenance, consumes the route head, and is idempotent", () => {
  const { attemptId, resultId } = seedBlockerDiscoveredResidue();

  const applied = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/1"),
    task: TASK,
    reason: "accept the discovered plan blocker",
  });
  assert.equal(applied.accepted, true);
  assert.equal(applied.alreadyAccepted, false);
  assert.equal(applied.attemptId, attemptId);
  assert.equal(applied.resultId, resultId);
  assert.equal(applied.routeConsumed, true);

  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "blocker-accepted",
    "canonical lifecycle must move to terminal blocker-accepted",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "blocker-accepted",
    "the replan gate reads legacy tasks.status",
  );
  assert.equal(isClosedStatus("blocker-accepted"), true);
  assert.equal(normalizeLegacyLifecycleStatus("blocker-accepted"), "blocker-accepted");
  assert.equal(
    compareLifecycleShadow("blocker-accepted", "blocker-accepted").kind,
    "match",
    "both vocabularies must agree so closeout reads no shadow drift",
  );
  assert.equal(readLatestTaskAttemptSnapshotStage(), "closeout", "the route head must be consumed");

  const provenance = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'task.blocker.accepted'
  `);
  assert.ok(provenance.payload_json, "the disposition must record its provenance event");
  const payload = JSON.parse(String(provenance.payload_json)) as Record<string, unknown>;
  assert.equal(payload["disposition"], "blocker-accepted");
  assert.equal(payload["attemptId"], attemptId);
  assert.equal(payload["resultId"], resultId);
  assert.equal(payload["rationale"], "accept the discovered plan blocker");
  assert.equal(
    payload["blockerSummary"],
    "API contract invalidates the slice plan; no SUMMARY produced",
  );

  // The failed Attempt/Result remain immutable history.
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "failed");
  assert.equal(settled?.resultId, resultId);
  assert.equal(settled?.resultFailureClass, "blocker-discovered");
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the disposition must not fabricate a second Result",
  );

  const again = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/2"),
    task: TASK,
    reason: "accept the discovered plan blocker",
  });
  assert.equal(again.accepted, false);
  assert.equal(again.alreadyAccepted, true);
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'task.blocker.accepted'").count,
    1,
    "a repeated applied run is a no-op",
  );
});

test("blocker-accepted refuses a running Attempt with the exact prerequisite", () => {
  seedRunningAttempt();
  assert.throws(
    () => planBlockerAcceptedDisposition(TASK, "accept"),
    /blocker-accepted requires no running Attempt.*settle the running Attempt first \(gsd_task_settle without settleDisposition\)/s,
  );
});

test("blocker-accepted refuses when the latest Attempt is not a discovered blocker at route", () => {
  const { attemptId } = seedRunningAttempt();
  settleTaskAttempt({
    invocation: invocation("fixture/plain-failure"),
    attemptId,
    outcome: "failed",
    failureClass: "executor-error",
    summary: "plain executor failure",
    output: {},
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();

  assert.throws(
    () => planBlockerAcceptedDisposition(TASK, "accept"),
    /failed\/blocker-discovered at the route stage.*Repair-and-retry is the separate successor-Attempt path \(gsd_task_recovery_resume\)/s,
  );
});

test("blocker-accepted preserves a completed sibling Task and refuses after other closure", () => {
  seedBlockerDiscoveredResidue();
  db().exec(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T02', 'Completed sibling', 'complete');
  `);

  const applied = applyBlockerAcceptedDisposition({
    invocation: invocation("blocker-accepted/apply/sibling"),
    task: TASK,
    reason: "accept",
  });
  assert.equal(applied.accepted, true);
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T02'").status,
    "complete",
    "completed sibling tasks remain intact",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "blocker-accepted",
  );

  // A task closed some other way is not a disposition candidate.
  const other = { milestoneId: "M001", sliceId: "S01", taskId: "T02" };
  assert.throws(
    () => applyBlockerAcceptedDisposition({
      invocation: invocation("blocker-accepted/apply/wrong-lifecycle"),
      task: other,
      reason: "accept",
    }),
    /blocker-accepted requires the Task lifecycle in_progress; found none/,
  );
});

function readLatestTaskAttemptSnapshotStage(): string | null {
  const head = row(`
    SELECT head.next_stage AS stage
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = head.lifecycle_id
    WHERE lifecycle.task_id = 'T01'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `);
  return head.stage ? String(head.stage) : null;
}

// ── operator-attested closeout disposition (Phase 31 / RELY-03 / INC-2026-09-27-01) ──
//
// Not a reuse of seedBlockerDiscoveredResidue: settleTaskAttempt alone does
// not populate workflow_recovery_actions. This fixture additionally routes
// the failed Attempt via recordFailureAndSelectRecovery with an agent-owner
// "transient-execution" classification so readTaskRecoveryRoute(attemptId)
// reads back action "retry" (recovery-policy.ts:110-112's budgetedRule).

const PASSING_EVIDENCE = { command: "npm test", exitCode: 0, verdict: "pass" } as const;

function seedRetryRoutedResidue(): { attemptId: string; resultId: string; recoveryActionId: string } {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/retry-settle"),
    attemptId,
    outcome: "failed",
    failureClass: "transient-execution",
    summary: "transient executor fault; retry eligible",
    output: { fault: "transient" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const receipt = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/retry-route"),
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

test("seedRetryRoutedResidue fixture reads back as a retry-classified settled/failed Attempt at route with no running Attempt", () => {
  const { attemptId, resultId, recoveryActionId } = seedRetryRoutedResidue();
  assert.ok(resultId, "fixture must produce a Result id");
  assert.ok(recoveryActionId, "fixture must produce a recovery action id");

  const route = readTaskRecoveryRoute(attemptId);
  assert.equal(route?.action, "retry", "the routed recovery action must be retry");

  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled", "the latest Attempt must be settled");
  assert.equal(settled?.outcome, "failed", "the latest Attempt must be failed");
  assert.equal(settled?.nextStage, "route", "the Kernel head must still be at the route stage");

  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "legacy tasks.status must be in_progress",
  );

  assert.equal(
    row(`
      SELECT COUNT(*) AS count
      FROM workflow_item_lifecycles lifecycle
      JOIN workflow_execution_attempts attempt
        ON attempt.lifecycle_id = lifecycle.lifecycle_id
       AND attempt.project_id = lifecycle.project_id
      WHERE lifecycle.item_kind = 'task'
        AND lifecycle.task_id = 'T01'
        AND attempt.attempt_state = 'running'
    `).count,
    0,
    "zero running Attempts must remain",
  );
});

test("operator-attested dry-run reports the exact transitions and mutates nothing", () => {
  const { attemptId, resultId, recoveryActionId } = seedRetryRoutedResidue();
  const before = row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count;

  const plan = planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified the deliverable manually");

  assert.equal(plan.rows.length, 1);
  assert.equal(plan.alreadyAttested, false);
  assert.equal(plan.rows[0].attemptId, attemptId);
  assert.equal(plan.rows[0].resultId, resultId);
  assert.equal(plan.rows[0].currentStatus, "in_progress");
  assert.equal(plan.rows[0].targetStatus, "operator-attested");
  assert.equal(plan.rows[0].lifecycleFrom, "in_progress");
  assert.equal(plan.rows[0].routeConsumed, true);
  assert.equal(plan.rows[0].supersededRecoveryActionId, recoveryActionId);
  assert.deepEqual(plan.rows[0].evidence, PASSING_EVIDENCE);
  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "in_progress",
    "dry-run must not move the canonical lifecycle",
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "dry-run must not close the legacy Task",
  );
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    before,
    "dry-run must not write a Result",
  );
});

test("operator-attested apply closes both vocabularies, matches shadow, consumes the route head, and records the evidence event", () => {
  const { attemptId, resultId } = seedRetryRoutedResidue();

  const applied = applyOperatorAttestedDisposition({
    invocation: invocation("operator-attested/apply/1"),
    task: TASK,
    evidence: PASSING_EVIDENCE,
    reason: "operator verified the deliverable manually",
  });
  assert.equal(applied.attested, true);
  assert.equal(applied.alreadyAttested, false);
  assert.equal(applied.attemptId, attemptId);
  assert.equal(applied.resultId, resultId);
  assert.equal(applied.routeConsumed, true);

  // 1. canonical lifecycle
  assert.equal(
    row("SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = 'T01'").status,
    "operator-attested",
  );
  // 2. legacy tasks.status
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "operator-attested",
  );
  // 3. isClosedStatus
  assert.equal(isClosedStatus("operator-attested"), true);
  // 4. shadow comparison
  assert.equal(
    compareLifecycleShadow("operator-attested", "operator-attested").kind,
    "match",
    "both vocabularies must agree so closeout reads no shadow drift",
  );
  // 5. route Kernel head advanced to closeout, chained off the pre-apply route head
  assert.equal(readLatestTaskAttemptSnapshotStage(), "closeout", "the route head must be consumed");
  const closeoutCheckpoint = row(`
    SELECT head.previous_kernel_checkpoint_id AS previous_id, route.kernel_checkpoint_id AS route_id
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = head.lifecycle_id
    JOIN workflow_kernel_checkpoints route
      ON route.lifecycle_id = head.lifecycle_id AND route.next_stage = 'route'
    WHERE lifecycle.task_id = 'T01'
      AND head.next_stage = 'closeout'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `);
  assert.equal(closeoutCheckpoint.previous_id, closeoutCheckpoint.route_id);
  // 6. exactly one task.operator.attested event carrying the evidence verbatim
  assert.equal(
    row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'task.operator.attested'
    `).count,
    1,
  );
  const provenance = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'task.operator.attested'
  `);
  const payload = JSON.parse(String(provenance.payload_json)) as Record<string, unknown>;
  assert.equal(payload["disposition"], "operator-attested");
  assert.equal(payload["attemptId"], attemptId);
  assert.equal(payload["resultId"], resultId);
  assert.equal(payload["command"], PASSING_EVIDENCE.command);
  assert.equal(payload["exitCode"], PASSING_EVIDENCE.exitCode);
  assert.equal(payload["verdict"], PASSING_EVIDENCE.verdict);
  assert.equal(payload["rationale"], "operator verified the deliverable manually");

  // The failed Attempt/Result remain immutable history — no fabricated verdict.
  const settled = readTaskAttempt(attemptId);
  assert.equal(settled?.state, "settled");
  assert.equal(settled?.outcome, "failed");
  assert.equal(settled?.resultId, resultId);
  assert.equal(
    row("SELECT COUNT(*) AS count FROM workflow_attempt_results").count,
    1,
    "the disposition must not fabricate a second Result",
  );

  // Idempotent second apply is a no-op.
  const again = applyOperatorAttestedDisposition({
    invocation: invocation("operator-attested/apply/2"),
    task: TASK,
    evidence: PASSING_EVIDENCE,
    reason: "operator verified the deliverable manually",
  });
  assert.equal(again.attested, false);
  assert.equal(again.alreadyAttested, true);
  assert.equal(
    row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'task.operator.attested'
    `).count,
    1,
    "a repeated applied run is a no-op",
  );
});

// ── operator-attested guard-chain refusal net (Phase 31 Plan 04, RELY-03) ───
//
// Every test below calls planOperatorAttestedDisposition /
// applyOperatorAttestedDisposition directly -- the exported domain functions
// -- with no MCP tool or CLI wrapper anywhere in the call path. A guard that
// had drifted into a wrapper would leave these refusals unraised (D-03).

function taskStateSnapshot(taskId: string): {
  lifecycleStatus: string | null;
  legacyStatus: string | null;
  headAttemptId: string | null;
  headNextStage: string | null;
} {
  const lifecycle = row(
    `SELECT lifecycle_status AS status FROM workflow_item_lifecycles WHERE task_id = :task_id`,
    { ":task_id": taskId },
  );
  const legacy = row(`SELECT status AS status FROM tasks WHERE id = :task_id`, { ":task_id": taskId });
  const head = row(`
    SELECT head.attempt_id AS attempt_id, head.next_stage AS next_stage
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = head.lifecycle_id
    WHERE lifecycle.task_id = :task_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `, { ":task_id": taskId });
  return {
    lifecycleStatus: lifecycle.status != null ? String(lifecycle.status) : null,
    legacyStatus: legacy.status != null ? String(legacy.status) : null,
    headAttemptId: head.attempt_id != null ? String(head.attempt_id) : null,
    headNextStage: head.next_stage != null ? String(head.next_stage) : null,
  };
}

/**
 * Shared post-refusal state check: every refusal test asserts the canonical
 * lifecycle status, the legacy task status, and the route head's attempt id
 * and next stage are all unchanged from their pre-call values. A refusal
 * that leaves a partial write is the failure mode ROADMAP SC-3 actually
 * cares about.
 */
function assertUnchangedTaskState(
  taskId: string,
  before: ReturnType<typeof taskStateSnapshot>,
): void {
  assert.deepEqual(
    taskStateSnapshot(taskId),
    before,
    "a refusal must leave the Task's two status vocabularies and route head untouched",
  );
}

/**
 * D-02's negative fixture: an agent-owner "tool-schema" classification
 * routes to "repair" (recovery-policy.ts's budgetedRule), not "retry" -- a
 * genuine non-retry route distinct from seedRetryRoutedResidue's "retry"
 * route. Asserts the produced action itself so a future policy-mapping
 * change fails this fixture rather than silently voiding Test A.
 */
function seedNonRetryRoutedResidue(): {
  attemptId: string;
  resultId: string;
  recoveryActionId: string;
  action: string;
} {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: invocation("fixture/non-retry-settle"),
    attemptId,
    outcome: "failed",
    failureClass: "tool-schema",
    summary: "tool schema mismatch; requires deterministic repair",
    output: { fault: "tool-schema" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  const receipt = recordFailureAndSelectRecovery({
    invocation: invocation("fixture/non-retry-route"),
    attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "tool-schema" },
    summary: "tool schema mismatch; requires deterministic repair",
    evidence: { detail: "tool-schema" },
    rationale: "agent-owner tool-schema routes to repair",
  });
  const route = readTaskRecoveryRoute(attemptId);
  assert.ok(route, "fixture must produce a recovery route");
  assert.equal(route.action, "repair", "fixture must produce a non-retry (repair) recovery action");
  return {
    attemptId,
    resultId: settlement.resultId,
    recoveryActionId: receipt.recoveryActionId,
    action: route.action,
  };
}

/**
 * Claims a genuine retry Attempt (retryOfAttemptId) for TASK, moving the
 * route Kernel head off whichever Attempt currently owns it. Mirrors
 * task-recovery-domain-operation.test.ts's insertClaimedDispatch helper.
 */
function claimRetryAttempt(retryOfAttemptId: string, attemptNumber: number): string {
  db().exec(`
    INSERT INTO unit_dispatches (
      trace_id, turn_id, worker_id, milestone_lease_token,
      milestone_id, slice_id, task_id, unit_type, unit_id,
      status, attempt_n, started_at
    ) VALUES (
      'retry-trace-${attemptNumber}', 'retry-turn-${attemptNumber}', 'worker-1', 7,
      'M001', 'S01', 'T01', 'execute-task', 'M001/S01/T01',
      'claimed', ${attemptNumber}, '2026-07-13T02:00:00.000Z'
    );
  `);
  const dispatchId = Number(row("SELECT MAX(id) AS id FROM unit_dispatches").id);
  const claim = claimTaskAttempt({
    invocation: invocation(`fixture/retry-claim-${attemptNumber}`),
    task: TASK,
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: dispatchId,
    retryOfAttemptId,
  });
  return claim.attemptId;
}

/**
 * Advances the route Kernel head for attemptId one step past "route" (to
 * "closeout") without going through either closeout disposition -- reaching
 * the "settled/failed but not at the route stage" state for Test E.
 */
function advanceHeadToCloseout(attemptId: string): void {
  const head = row(`
    SELECT head.kernel_checkpoint_id AS id, head.lifecycle_id AS lifecycle_id
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle ON lifecycle.lifecycle_id = head.lifecycle_id
    WHERE lifecycle.task_id = 'T01'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.checkpoint-advance",
    idempotencyKey: `fixture/advance-${attemptId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { attemptId },
  }, (context) => {
    appendKernelCheckpoint(context, {
      lifecycleId: String(head.lifecycle_id),
      attemptId,
      nextStage: "closeout",
      previousKernelCheckpointId: String(head.id),
    });
    return {
      events: [{
        eventType: "test.checkpoint.advanced",
        entityType: "task",
        entityId: "M001/S01/T01",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/m001/s01/t01/advance",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

/**
 * An in_progress canonical lifecycle with zero Attempts recorded (Test D).
 * Opens its own fresh database (mirroring seedRunningAttempt) since this is
 * the first fixture call in its test.
 */
function seedInProgressNoAttempt(taskId: string): void {
  const dir = mkdtempSync(join(tmpdir(), "gsd-task-settle-"));
  tempDirs.add(dir);
  assert.equal(openDatabase(join(dir, "gsd.db")), true);
  db().exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Settle', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Settle operation', 'active', '2026-07-13T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', '${taskId}', 'No attempt yet', 'in_progress');
  `);
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.task.in-progress",
    idempotencyKey: `fixture/task-in-progress-${taskId}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { taskId },
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId,
      lifecycleStatus: "in_progress",
    });
    return {
      events: [{
        eventType: "test.task.in-progress",
        entityType: "task",
        entityId: `M001/S01/${taskId}`,
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/m001/s01/${taskId.toLowerCase()}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

test("operator-attested refuses a settled/failed Attempt whose recovery action is not retry, naming the action found and the supported alternative (D-02, Test A)", () => {
  seedNonRetryRoutedResidue();
  const before = taskStateSnapshot("T01");
  assert.throws(
    () => planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified the deliverable manually"),
    /requires the routed recovery action for Attempt .* to be "retry"; found repair\..*blocker-accepted.*gsd_task_recovery_resume/s,
  );
  assertUnchangedTaskState("T01", before);
});

test("operator-attested refuses a running Attempt with the exact prerequisite (Test B)", () => {
  seedRunningAttempt();
  const before = taskStateSnapshot("T01");
  assert.throws(
    () => planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually"),
    /operator-attested requires no running Attempt.*settle the running Attempt first \(gsd_task_settle without settleDisposition\)/s,
  );
  assertUnchangedTaskState("T01", before);
});

test("operator-attested refuses a Task lifecycle other than in_progress, naming the lifecycle found (Test C)", () => {
  seedRetryRoutedResidue();
  db().exec(`
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T02', 'No lifecycle yet', 'pending');
  `);
  const other = { milestoneId: "M001", sliceId: "S01", taskId: "T02" };
  const before = taskStateSnapshot("T02");
  assert.throws(
    () => planOperatorAttestedDisposition(other, PASSING_EVIDENCE, "operator verified manually"),
    /operator-attested requires the Task lifecycle in_progress; found none for M001\/S01\/T02/,
  );
  assertUnchangedTaskState("T02", before);
});

test("operator-attested refuses a Task with no Attempt at all (Test D)", () => {
  seedInProgressNoAttempt("T02");
  const other = { milestoneId: "M001", sliceId: "S01", taskId: "T02" };
  const before = taskStateSnapshot("T02");
  assert.throws(
    () => planOperatorAttestedDisposition(other, PASSING_EVIDENCE, "operator verified manually"),
    /operator-attested requires the latest Attempt of M001\/S01\/T02 settled as failed at the route stage; found no Attempt at no Kernel head/,
  );
  assertUnchangedTaskState("T02", before);
});

test("operator-attested refuses a settled/failed Attempt whose Kernel head has advanced past the route stage (Test E)", () => {
  const { attemptId } = seedRetryRoutedResidue();
  advanceHeadToCloseout(attemptId);
  const before = taskStateSnapshot("T01");
  assert.throws(
    () => planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually"),
    /requires the latest Attempt of M001\/S01\/T01 settled as failed at the route stage; found settled\/failed at closeout/,
  );
  assertUnchangedTaskState("T01", before);
});

/**
 * Test F. The domain's kernel-checkpoint chain trigger
 * (trg_workflow_kernel_checkpoint_chain, requiring attempt jumps to only
 * ever move forward via a genuine retry claim) and its strict attempt-number
 * sequencing (trg_workflow_attempt_number_sequence, requiring each new
 * Attempt's number be exactly MAX+1) together guarantee that the route
 * Kernel head always belongs to whichever Attempt readLatestTaskAttempt
 * resolves to -- a single plan() call can never observe the two diverge
 * (confirmed empirically: attempting to fabricate a lower-numbered "stale"
 * Attempt is rejected by the sequencing trigger). The reachable analog is:
 * a retry Attempt gets claimed for real, genuinely moving the head off the
 * originally-eligible, retry-routed Attempt, and a fresh plan() call is
 * refused using CURRENT live state (the running-Attempt guard) rather than
 * the stale Attempt's own now-superseded eligibility -- proving the guard
 * always re-reads live state rather than trusting a Task's history.
 */
test("operator-attested refuses once a retry Attempt has been claimed and the route head has moved off the originally-eligible Attempt (Test F)", () => {
  const { attemptId: firstAttemptId } = seedRetryRoutedResidue();
  const secondAttemptId = claimRetryAttempt(firstAttemptId, 2);
  const before = taskStateSnapshot("T01");
  assert.equal(
    before.headAttemptId,
    secondAttemptId,
    "the route Kernel head must have genuinely moved to the claimed retry Attempt, off the original",
  );
  assert.throws(
    () => planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually"),
    /operator-attested requires no running Attempt.*settle the running Attempt first/s,
  );
  assertUnchangedTaskState("T01", before);
});

test("operator-attested's non-retry refusal is raised by the exported domain function directly, with no MCP tool or CLI wrapper in the call path (Test G, D-03)", () => {
  seedNonRetryRoutedResidue();
  // Deliberately calling the domain function directly, with no MCP tool and
  // no CLI wrapper anywhere in the call path: the point is that a caller
  // reaching straight into the domain layer is equally gated (D-03).
  let thrown: Error | undefined;
  try {
    planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually");
  } catch (err) {
    thrown = err as Error;
  }
  assert.ok(thrown, "the direct domain-layer call must throw");
  assert.match(thrown.message, /^gsd_task_settle: operator-attested requires the routed recovery action/);
});

// ── operator-attested evidence-refusal net, dry-run purity, idempotency, ───
// ── and the dry-run-to-apply race (Phase 31 Plan 04, RELY-03) ──────────────

/**
 * Table-driven evidence refusals (Tests H-P): each row supplies one
 * inadequate evidence shape and the regex its refusal must match. Adding a
 * future required field is one row, not a new test body.
 */
const EVIDENCE_REFUSAL_CASES: ReadonlyArray<{
  readonly name: string;
  readonly evidence: DomainJsonValue;
  readonly pattern: RegExp;
}> = [
  { name: "null evidence (Test H)", evidence: null, pattern: /evidence must be a non-empty object/ },
  { name: "array evidence (Test I)", evidence: [], pattern: /evidence must be a non-empty object/ },
  { name: "non-object primitive evidence (Test J)", evidence: 42, pattern: /evidence must be a non-empty object/ },
  { name: "empty object evidence (Test K)", evidence: {}, pattern: /evidence must be a non-empty object/ },
  {
    name: "blank command (Test L)",
    evidence: { command: "   ", exitCode: 0, verdict: "pass" },
    pattern: /operator-attested requires evidence\.command to be a non-blank string/,
  },
  {
    name: "missing command key (Test M)",
    evidence: { exitCode: 0, verdict: "pass" },
    pattern: /operator-attested requires evidence\.command to be a non-blank string/,
  },
  {
    name: "non-zero integer exitCode (Test N)",
    evidence: { command: "npm test", exitCode: 1, verdict: "pass" },
    pattern: /operator-attested requires evidence\.exitCode to be exactly the integer 0; found 1\b/,
  },
  {
    name: "non-integer exitCode (Test O)",
    evidence: { command: "npm test", exitCode: 0.5, verdict: "pass" },
    pattern: /operator-attested requires evidence\.exitCode to be exactly the integer 0; found 0\.5/,
  },
  {
    name: "non-numeric exitCode (Test O)",
    evidence: { command: "npm test", exitCode: "0", verdict: "pass" },
    pattern: /operator-attested requires evidence\.exitCode to be exactly the integer 0; found "0"/,
  },
  {
    name: "verdict fail (Test P)",
    evidence: { command: "npm test", exitCode: 0, verdict: "fail" },
    pattern: /operator-attested requires evidence\.verdict to be exactly "pass"; found fail/,
  },
  {
    name: "verdict wrong type (Test P)",
    evidence: { command: "npm test", exitCode: 0, verdict: 1 },
    pattern: /operator-attested requires evidence\.verdict to be exactly "pass"; found 1\b/,
  },
];

for (const evidenceCase of EVIDENCE_REFUSAL_CASES) {
  test(`operator-attested refuses ${evidenceCase.name}, naming the offending field`, () => {
    seedRetryRoutedResidue();
    const before = taskStateSnapshot("T01");
    assert.throws(
      () => planOperatorAttestedDisposition(TASK, evidenceCase.evidence, "operator verified manually"),
      evidenceCase.pattern,
    );
    assertUnchangedTaskState("T01", before);
  });
}

test("operator-attested still refuses inadequate evidence on an already-attested Task, proving the evidence validator runs ahead of the already-attested short-circuit (Test Q)", () => {
  seedRetryRoutedResidue();
  applyOperatorAttestedDisposition({
    invocation: invocation("operator-attested/ordering/apply"),
    task: TASK,
    evidence: PASSING_EVIDENCE,
    reason: "operator verified the deliverable manually",
  });
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "operator-attested",
    "fixture precondition: the Task must already be closed under this disposition",
  );
  assert.throws(
    () => planOperatorAttestedDisposition(
      TASK,
      { command: "npm test", exitCode: 1, verdict: "pass" },
      "operator verified manually",
    ),
    /evidence\.exitCode to be exactly the integer 0/,
    "an already-closed Task must not let inadequate evidence ride the already-attested no-op past the gate",
  );
});

/** Six-field before/after snapshot for the dry-run-purity and idempotency tests. */
function fullDispositionSnapshot(taskId: string) {
  const state = taskStateSnapshot(taskId);
  return {
    attemptCount: Number(row("SELECT COUNT(*) AS count FROM workflow_execution_attempts").count),
    lifecycleStatus: state.lifecycleStatus,
    legacyStatus: state.legacyStatus,
    headAttemptId: state.headAttemptId,
    headNextStage: state.headNextStage,
    eventCount: Number(row("SELECT COUNT(*) AS count FROM workflow_domain_events").count),
  };
}

test("operator-attested dry-run plan with adequate evidence writes nothing, across a six-field snapshot (Test R)", () => {
  seedRetryRoutedResidue();
  const before = fullDispositionSnapshot("T01");
  const plan = planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually");
  assert.equal(plan.rows.length, 1, "the plan must still report the eligible transition");
  const after = fullDispositionSnapshot("T01");
  assert.deepEqual(after, before, "a dry-run plan must write nothing at all");
});

test("operator-attested second apply after a successful first is a clean no-op writing no second event (Test S)", () => {
  seedRetryRoutedResidue();
  applyOperatorAttestedDisposition({
    invocation: invocation("operator-attested/idempotent/apply-1"),
    task: TASK,
    evidence: PASSING_EVIDENCE,
    reason: "operator verified manually",
  });
  const afterFirst = fullDispositionSnapshot("T01");
  const again = applyOperatorAttestedDisposition({
    invocation: invocation("operator-attested/idempotent/apply-2"),
    task: TASK,
    evidence: PASSING_EVIDENCE,
    reason: "operator verified manually",
  });
  assert.equal(again.attested, false);
  assert.equal(again.alreadyAttested, true);
  assert.deepEqual(
    fullDispositionSnapshot("T01"),
    afterFirst,
    "a repeated apply must leave the terminal state exactly as the first call left it",
  );
});

/**
 * Test T (TOCTOU). Both legs move the Task's CURRENT governing Attempt
 * forward via a genuine retry claim rather than mutating the original
 * Attempt's already-immutable recovery action in place --
 * recordFailureAndSelectRecovery cannot re-route the SAME Attempt's SAME
 * Result twice (requireRoutableResult refuses with "Task Result already has
 * a recovery observation", confirmed empirically).
 *
 * Leg 1: a retry Attempt claimed between the dry-run plan and the apply
 * moves the route head off the planned Attempt; apply's own fresh internal
 * re-plan (not a stale value carried from the earlier dry-run call) catches
 * this via the running-Attempt guard before any write.
 *
 * Leg 2: a second Attempt claimed, settled, and routed to a non-retry action
 * between plan and apply is caught by the recovery-action guard, naming the
 * non-retry action found. Both legs assert the Task remains un-closed
 * afterward -- a refusal that half-wrote is the actual danger.
 */
test("operator-attested apply refuses when the route head or the recovery action changed since the dry-run plan (Test T)", () => {
  // Leg 1: the route head moves to a claimed retry Attempt.
  const { attemptId: legOneFirstAttemptId } = seedRetryRoutedResidue();
  const legOnePlan = planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually");
  assert.equal(legOnePlan.rows.length, 1);
  claimRetryAttempt(legOneFirstAttemptId, 2);
  assert.throws(
    () => applyOperatorAttestedDisposition({
      invocation: invocation("operator-attested/toctou/leg1"),
      task: TASK,
      evidence: PASSING_EVIDENCE,
      reason: "operator verified manually",
    }),
    /operator-attested requires no running Attempt/,
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "leg 1: the Task must remain un-closed after the refused apply",
  );

  // Leg 2 (fresh fixture): the recovery action governing the Task's current
  // Attempt changes to a non-retry value between plan and apply.
  closeDatabase();
  const { attemptId: legTwoFirstAttemptId } = seedRetryRoutedResidue();
  const legTwoPlan = planOperatorAttestedDisposition(TASK, PASSING_EVIDENCE, "operator verified manually");
  assert.equal(legTwoPlan.rows.length, 1);
  const legTwoSecondAttemptId = claimRetryAttempt(legTwoFirstAttemptId, 2);
  const legTwoSettlement = settleTaskAttempt({
    invocation: invocation("fixture/toctou-leg2-settle"),
    attemptId: legTwoSecondAttemptId,
    outcome: "failed",
    failureClass: "tool-schema",
    summary: "tool schema mismatch on retry",
    output: { fault: "tool-schema" },
  });
  recordFailureAndSelectRecovery({
    invocation: invocation("fixture/toctou-leg2-route"),
    attemptId: legTwoSecondAttemptId,
    resultId: legTwoSettlement.resultId,
    owner: "agent",
    classification: { failureKind: "tool-schema" },
    summary: "tool schema mismatch on retry",
    evidence: { detail: "tool-schema" },
    rationale: "routes the retry Attempt to a non-retry action",
  });
  assert.throws(
    () => applyOperatorAttestedDisposition({
      invocation: invocation("operator-attested/toctou/leg2"),
      task: TASK,
      evidence: PASSING_EVIDENCE,
      reason: "operator verified manually",
    }),
    /requires the routed recovery action for Attempt .* to be "retry"; found repair/,
  );
  assert.equal(
    row("SELECT status AS status FROM tasks WHERE id = 'T01'").status,
    "in_progress",
    "leg 2: the Task must remain un-closed after the refused apply",
  );
});
