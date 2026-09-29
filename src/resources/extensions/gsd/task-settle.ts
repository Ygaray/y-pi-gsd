// Project/App: gsd-pi
// File Purpose: Operator Task settle — human-gated, dry-run-first reconciliation
// of a running Task Attempt whose executor is gone, plus optional lifecycle
// adopt after an interrupted Attempt or succeeded completion (#1749, #2018),
// and the `blocker-accepted` operator closeout disposition (#2202).

import { executeDomainOperation, type DomainJsonValue } from "./db/domain-operation.js";
import { getDb } from "./db/engine.js";
import { isAutoWorkerLive } from "./db/auto-workers.js";
import {
  claimMilestoneLease,
  getMilestoneLease,
  releaseMilestoneLease,
} from "./db/milestone-leases.js";
import { normalizeLegacyLifecycleStatus } from "./db/lifecycle-shadow-comparison.js";
import {
  adoptOrTransitionLifecycle,
  appendKernelCheckpoint,
  closeLegacyTaskAsBlockerAccepted,
  closeLegacyTaskAsOperatorAttested,
  readDomainOperationFence,
  type CanonicalLifecycleStatus,
} from "./db/writers/lifecycle-commands.js";
import type { ExecutionInvocation } from "./execution-invocation.js";
import { TASK_LIFECYCLE_PROJECTION_KIND } from "./projection-identity.js";
import {
  readLatestTaskAttempt,
  settleTaskAttempt,
} from "./task-execution-domain-operation.js";
import { readTaskRecoveryRoute } from "./task-recovery-domain-operation.js";

export interface TaskSettleTask {
  milestoneId: string;
  sliceId: string;
  taskId: string;
}

export interface TaskSettleRow {
  attemptId: string;
  currentStatus: string;
  targetStatus: "interrupted";
  rationale: string;
  leaseHeld: boolean;
}

export interface TaskLifecycleReconcileRow {
  currentStatus: string;
  targetStatus: "paused" | "ready" | "completed";
  rationale: string;
}

export interface TaskSettleProof {
  attemptId: string | null;
  note: string;
}

export interface TaskSettlePlan {
  task: TaskSettleTask;
  rows: TaskSettleRow[];
  lifecycleRows: TaskLifecycleReconcileRow[];
  proof: TaskSettleProof | null;
}

export interface TaskSettleOptions {
  reconcileLifecycle?: boolean;
}

interface RunningAttemptRow {
  attempt_id: string;
  worker_id: string | null;
  milestone_lease_token: number | null;
}

interface TaskLifecycleState {
  legacyStatus: string;
  lifecycleStatus: CanonicalLifecycleStatus | null;
}

function unitId(task: TaskSettleTask): string {
  return `${task.milestoneId}/${task.sliceId}/${task.taskId}`;
}

function readRunningAttempts(task: TaskSettleTask): RunningAttemptRow[] {
  return getDb().prepare(`
    SELECT attempt.attempt_id, attempt.worker_id, attempt.milestone_lease_token
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND attempt.attempt_state = 'running'
    ORDER BY attempt.attempt_number DESC
  `).all({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as unknown as RunningAttemptRow[];
}

function readLeaseHeld(row: RunningAttemptRow, milestoneId: string): boolean {
  if (!row.worker_id || row.milestone_lease_token === null) return false;
  const lease = getDb().prepare(`
    SELECT 1 AS held
    FROM milestone_leases
    WHERE milestone_id = :milestone_id
      AND worker_id = :worker_id
      AND fencing_token = :fencing_token
      AND status = 'held'
      AND expires_at > strftime('%Y-%m-%dT%H:%M:%fZ', 'now')
  `).get({
    ":milestone_id": milestoneId,
    ":worker_id": row.worker_id,
    ":fencing_token": row.milestone_lease_token,
  });
  return lease !== undefined;
}

function canReclaimLease(row: RunningAttemptRow, milestoneId: string): boolean {
  if (!row.worker_id || row.milestone_lease_token === null) return false;
  if (isAutoWorkerLive(row.worker_id)) return false;
  const lease = getMilestoneLease(milestoneId);
  if (!lease || lease.fencing_token < row.milestone_lease_token) return false;
  return lease.status !== "held" || Date.parse(lease.expires_at) <= Date.now();
}

function claimRecoveryLease(
  row: RunningAttemptRow,
  milestoneId: string,
): { workerId: string; milestoneLeaseToken: number } | null {
  if (!canReclaimLease(row, milestoneId) || !row.worker_id || row.milestone_lease_token === null) {
    return null;
  }
  const claimed = claimMilestoneLease(row.worker_id, milestoneId);
  if (!claimed.ok) return null;
  if (claimed.token <= row.milestone_lease_token) {
    releaseMilestoneLease(row.worker_id, milestoneId, claimed.token);
    return null;
  }
  return { workerId: row.worker_id, milestoneLeaseToken: claimed.token };
}

function requireSingleRunningAttempt(task: TaskSettleTask): RunningAttemptRow | null {
  const lifecycle = getDb().prepare(`
    SELECT 1 AS present
    FROM workflow_item_lifecycles
    WHERE item_kind = 'task'
      AND milestone_id = :milestone_id
      AND slice_id = :slice_id
      AND task_id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  });
  if (!lifecycle) {
    throw new Error(
      `gsd_task_settle: unknown Task ${task.milestoneId}/${task.sliceId}/${task.taskId}`,
    );
  }
  const running = readRunningAttempts(task);
  if (running.length === 0) return null;
  if (running.length > 1) {
    throw new Error(
      `gsd_task_settle: ${task.milestoneId}/${task.sliceId}/${task.taskId} has ` +
      `${running.length} running Attempts; refusing to guess — settle them by Attempt id in the DB.`,
    );
  }
  return running[0];
}

function readTaskLifecycleState(task: TaskSettleTask): TaskLifecycleState {
  const state = getDb().prepare(`
    SELECT task.status AS task_status, lifecycle.lifecycle_status
    FROM tasks task
    LEFT JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.item_kind = 'task'
     AND lifecycle.milestone_id = task.milestone_id
     AND lifecycle.slice_id = task.slice_id
     AND lifecycle.task_id = task.id
    WHERE task.milestone_id = :milestone_id
      AND task.slice_id = :slice_id
      AND task.id = :task_id
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as Record<string, unknown> | undefined;
  if (!state) {
    throw new Error(`gsd_task_settle: unknown Task ${unitId(task)}`);
  }
  return {
    legacyStatus: String(state["task_status"]),
    lifecycleStatus: state["lifecycle_status"]
      ? String(state["lifecycle_status"]) as CanonicalLifecycleStatus
      : null,
  };
}

function readPassingProofAttempt(task: TaskSettleTask): string | null {
  const row = getDb().prepare(`
    SELECT attempt.attempt_id
    FROM workflow_item_lifecycles lifecycle
    JOIN workflow_execution_attempts attempt
      ON attempt.lifecycle_id = lifecycle.lifecycle_id
     AND attempt.project_id = lifecycle.project_id
     AND attempt.attempt_state = 'settled'
    JOIN workflow_attempt_results result
      ON result.attempt_id = attempt.attempt_id
     AND result.lifecycle_id = lifecycle.lifecycle_id
     AND result.outcome = 'succeeded'
    JOIN workflow_acceptance_criteria criterion
      ON criterion.lifecycle_id = lifecycle.lifecycle_id
     AND criterion.criterion_key = 'host-technical-verification'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_acceptance_criteria successor
       WHERE successor.supersedes_criterion_id = criterion.criterion_id
     )
    JOIN workflow_technical_verdicts verdict
      ON verdict.criterion_id = criterion.criterion_id
     AND verdict.attempt_id = attempt.attempt_id
     AND verdict.verdict = 'pass'
     AND NOT EXISTS (
       SELECT 1 FROM workflow_technical_verdicts successor
       WHERE successor.supersedes_verdict_id = verdict.verdict_id
     )
    JOIN workflow_verification_evidence evidence
      ON evidence.verdict_id = verdict.verdict_id
     AND evidence.attempt_id = attempt.attempt_id
     AND evidence.observation = 'passed'
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
    ORDER BY attempt.attempt_number DESC
    LIMIT 1
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) as { attempt_id?: string } | undefined;
  return row?.attempt_id ? String(row.attempt_id) : null;
}

function planCompletionProof(
  task: TaskSettleTask,
  lifecycleRows: TaskLifecycleReconcileRow[],
): TaskSettleProof | null {
  if (!lifecycleRows.some((row) => row.targetStatus === "completed")) return null;
  const attemptId = readPassingProofAttempt(task);
  if (attemptId) {
    return {
      attemptId,
      note: `current passing Technical Verdict is on Attempt ${attemptId}`,
    };
  }
  return {
    attemptId: null,
    note: "no current passing Technical Verdict — gsd_slice_complete will still refuse until one is recorded",
  };
}

function targetCanonicalStatus(legacyStatus: string): "ready" | "completed" {
  const normalized = normalizeLegacyLifecycleStatus(legacyStatus);
  if (normalized === "pending") return "ready";
  if (normalized === "completed") return "completed";
  throw new Error(
    `gsd_task_settle: reconcileLifecycle only repairs a pending/complete mismatch ` +
    `after an interrupted Attempt or succeeded completion; tasks.status is ${legacyStatus}`,
  );
}

function lifecycleTransitionSteps(
  from: CanonicalLifecycleStatus,
  to: "ready" | "completed",
): Array<"paused" | "ready" | "completed"> {
  if (from === to) return [];
  if (to === "ready") {
    if (from === "in_progress") return ["paused", "ready"];
    if (from === "paused") return ["ready"];
  } else if (from === "in_progress") {
    return ["completed"];
  }
  throw new Error(
    `gsd_task_settle: cannot reconcile lifecycle ${from} → ${to} after an interrupted ` +
    `Attempt or succeeded completion`,
  );
}

function planLifecycleReconcile(
  task: TaskSettleTask,
  reason: string,
  hasRunningAttempt: boolean,
): TaskLifecycleReconcileRow[] {
  const latest = readLatestTaskAttempt(task);
  const state = readTaskLifecycleState(task);
  const succeededCompletion = latest?.outcome === "succeeded" &&
    normalizeLegacyLifecycleStatus(state.legacyStatus) === "completed";
  if (!hasRunningAttempt && latest?.outcome !== "interrupted" && !succeededCompletion) {
    throw new Error(
      "gsd_task_settle: reconcileLifecycle requires an interrupted Attempt or a succeeded " +
      "Attempt with tasks.status complete (settle the running Attempt first)",
    );
  }
  const target = targetCanonicalStatus(state.legacyStatus);
  const fromStatus = state.lifecycleStatus;
  if (fromStatus === null) {
    throw new Error(`gsd_task_settle: Task ${unitId(task)} has no canonical lifecycle to reconcile`);
  }
  if (fromStatus === target) return [];
  const steps = lifecycleTransitionSteps(fromStatus, target);
  const rows: TaskLifecycleReconcileRow[] = [];
  let current: CanonicalLifecycleStatus = fromStatus;
  for (const next of steps) {
    rows.push({
      currentStatus: current,
      targetStatus: next,
      rationale:
        `${reason} (adopt ${target} to match tasks.status=${state.legacyStatus}; ` +
        "SUMMARY projections are left in place)",
    });
    current = next;
  }
  return rows;
}

function applyLifecycleReconcile(
  invocation: ExecutionInvocation,
  task: TaskSettleTask,
  reason: string,
  rows: TaskLifecycleReconcileRow[],
): void {
  const entityId = unitId(task);
  for (const step of rows) {
    const idempotencyKey = `${invocation.idempotencyKey}:lifecycle:${step.targetStatus}`;
    const fence = readDomainOperationFence(idempotencyKey);
    executeDomainOperation({
      operationType: "task.lifecycle.reconcile",
      idempotencyKey,
      expectedRevision: fence.revision,
      expectedAuthorityEpoch: fence.authorityEpoch,
      actorType: invocation.actorType,
      ...(invocation.actorId ? { actorId: invocation.actorId } : {}),
      sourceTransport: invocation.sourceTransport,
      ...(invocation.traceId ? { traceId: invocation.traceId } : {}),
      ...(invocation.turnId ? { turnId: invocation.turnId } : {}),
      payload: {
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        from: step.currentStatus,
        to: step.targetStatus,
        reason,
      },
    }, (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "task",
        milestoneId: task.milestoneId,
        sliceId: task.sliceId,
        taskId: task.taskId,
        lifecycleStatus: step.targetStatus,
      });
      return {
        events: [{
          eventType: "task.lifecycle.reconciled",
          entityType: "task",
          entityId,
          payload: {
            from: step.currentStatus,
            to: step.targetStatus,
            reason,
          },
          destinations: ["projection"],
        }],
        projections: [{
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        }],
      };
    });
  }
}

/**
 * Read-only settle plan: the exact Attempt and optional lifecycle rows an
 * apply would change. Zero rows of both kinds means an apply is a no-op.
 */
export function planTaskSettle(
  task: TaskSettleTask,
  reason: string,
  options: TaskSettleOptions = {},
): TaskSettlePlan {
  const attempt = requireSingleRunningAttempt(task);
  const lifecycleRows = options.reconcileLifecycle
    ? planLifecycleReconcile(task, reason, attempt !== null)
    : [];
  const proof = planCompletionProof(task, lifecycleRows);
  if (!attempt) return { task, rows: [], lifecycleRows, proof };
  const leaseHeld = readLeaseHeld(attempt, task.milestoneId);
  const rationale = leaseHeld
    ? reason
    : canReclaimLease(attempt, task.milestoneId)
      ? `${reason} (the orphaned Attempt's worker is gone and its milestone lease is ` +
        "expired or released — apply will reclaim it with a newer fencing token)"
      : `${reason} (warning: the Attempt's milestone lease is no longer held, but a live ` +
        "worker or replacement lease prevents safe recovery — apply will refuse)";
  return {
    task,
    rows: [{
      attemptId: attempt.attempt_id,
      currentStatus: "running",
      targetStatus: "interrupted",
      rationale,
      leaseHeld,
    }],
    lifecycleRows,
    proof,
  };
}

/**
 * Settle the Task's one running Attempt as `interrupted`. The own-lease path
 * uses a plain attempt.settle (V47 dispatch-scope rule). If the owner is no
 * longer live and its lease is expired or released, the operator reclaims the
 * lease with a newer fencing token and uses attempt.interrupt (#1907). A live
 * owner or replacement lease remains fail-closed.
 *
 * Optional `reconcileLifecycle` then adopts ready/completed to match
 * tasks.status after an interrupted Attempt or succeeded completion, without
 * reopening or deleting SUMMARY projections (#1749).
 */
export function applyTaskSettle(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
  reconcileLifecycle?: boolean;
}): TaskSettlePlan & { settled: boolean; reconciled: boolean; resultId?: string } {
  const plan = planTaskSettle(input.task, input.reason, {
    reconcileLifecycle: input.reconcileLifecycle,
  });
  let settled = false;
  let resultId: string | undefined;
  if (plan.rows.length > 0) {
    const row = plan.rows[0];
    const attempt = requireSingleRunningAttempt(input.task);
    if (!attempt || attempt.attempt_id !== row.attemptId) {
      throw new Error("gsd_task_settle: running Attempt changed after the dry-run plan; retry the operation");
    }
    const recovery = row.leaseHeld
      ? null
      : claimRecoveryLease(attempt, input.task.milestoneId);
    if (!row.leaseHeld && !recovery) {
      throw new Error(
        `gsd_task_settle: Attempt ${row.attemptId} was claimed under a milestone lease that is ` +
        "no longer held, but a live worker or replacement lease prevents safe recovery. " +
        "Re-enter `/gsd auto` to recover under the current replacement lease.",
      );
    }
    try {
      const settlement = settleTaskAttempt({
        invocation: input.invocation,
        attemptId: row.attemptId,
        outcome: "interrupted",
        failureClass: "operator-settle",
        summary: input.reason,
        output: {
          operator: true,
          milestoneId: input.task.milestoneId,
          sliceId: input.task.sliceId,
          taskId: input.task.taskId,
          reason: input.reason,
        },
        ...(recovery ? { recovery: {
          workerId: recovery.workerId,
          milestoneLeaseToken: recovery.milestoneLeaseToken,
        } } : {}),
      });
      settled = true;
      resultId = settlement.resultId;
    } finally {
      if (recovery) {
        releaseMilestoneLease(
          recovery.workerId,
          input.task.milestoneId,
          recovery.milestoneLeaseToken,
        );
      }
    }
  }
  let lifecycleRows = plan.lifecycleRows;
  let proof = plan.proof;
  let reconciled = false;
  if (input.reconcileLifecycle) {
    const after = planTaskSettle(input.task, input.reason, { reconcileLifecycle: true });
    lifecycleRows = after.lifecycleRows;
    proof = after.proof;
    if (lifecycleRows.length > 0) {
      applyLifecycleReconcile(input.invocation, input.task, input.reason, lifecycleRows);
      reconciled = true;
    }
  }
  return {
    ...plan,
    lifecycleRows,
    proof,
    settled,
    reconciled,
    ...(resultId ? { resultId } : {}),
  };
}

// ── blocker-accepted operator closeout (#2202) ──────────────────────────────
//
// A Task whose execute-task Attempt settled as failed/blocker-discovered at the
// route stage with no running Attempt has no supported closeout: replan rejects
// it (not closed), settle has nothing to settle, and resume only authorizes a
// repaired retry. The `blocker-accepted` disposition accepts the discovered
// blocker explicitly: it closes the Task as terminal `blocker-accepted` in both
// vocabularies, records the blocker provenance on the canonical plan, and
// consumes the route Kernel head with a terminal closeout decision so the
// historical failure can never be re-routed. It never fabricates success
// evidence and never satisfies verdict-gated completion.

export type TaskSettleDisposition = "blocker-accepted" | "operator-attested";

export interface TaskBlockerAcceptedRow {
  attemptId: string;
  resultId: string;
  /** The discovered-blocker summary carried by the failed Result. */
  blockerSummary: string;
  currentStatus: string;
  targetStatus: "blocker-accepted";
  lifecycleFrom: CanonicalLifecycleStatus;
  /** True when the route Kernel head is consumed with a closeout decision. */
  routeConsumed: boolean;
  supersededRecoveryActionId: string | null;
  blockerId: string | null;
  rationale: string;
}

export interface TaskBlockerAcceptedPlan {
  task: TaskSettleTask;
  /** Zero rows means an apply is a no-op (the disposition already committed). */
  rows: TaskBlockerAcceptedRow[];
  alreadyAccepted: boolean;
}

export interface TaskBlockerAcceptedApplyResult {
  task: TaskSettleTask;
  accepted: boolean;
  alreadyAccepted: boolean;
  attemptId: string | null;
  resultId: string | null;
  routeConsumed: boolean;
}

interface RouteHeadRow {
  kernel_checkpoint_id: string;
  lifecycle_id: string;
  attempt_id: string;
  next_stage: string;
}

function readRouteHead(task: TaskSettleTask): RouteHeadRow | null {
  return (getDb().prepare(`
    SELECT head.kernel_checkpoint_id, head.lifecycle_id, head.attempt_id, head.next_stage
    FROM workflow_kernel_checkpoints head
    JOIN workflow_item_lifecycles lifecycle
      ON lifecycle.lifecycle_id = head.lifecycle_id
     AND lifecycle.project_id = head.project_id
    WHERE lifecycle.item_kind = 'task'
      AND lifecycle.milestone_id = :milestone_id
      AND lifecycle.slice_id = :slice_id
      AND lifecycle.task_id = :task_id
      AND NOT EXISTS (
        SELECT 1 FROM workflow_kernel_checkpoints successor
        WHERE successor.previous_kernel_checkpoint_id = head.kernel_checkpoint_id
      )
  `).get({
    ":milestone_id": task.milestoneId,
    ":slice_id": task.sliceId,
    ":task_id": task.taskId,
  }) ?? null) as RouteHeadRow | null;
}

/**
 * Read-only disposition plan: the exact Attempt, lifecycle, legacy status, and
 * route-head transitions an apply would write. Guards fail closed with the
 * exact prerequisite and the supported next action.
 */
export function planBlockerAcceptedDisposition(
  task: TaskSettleTask,
  reason: string,
): TaskBlockerAcceptedPlan {
  const state = readTaskLifecycleState(task);
  if (state.lifecycleStatus === "blocker-accepted" || state.legacyStatus === "blocker-accepted") {
    return { task, rows: [], alreadyAccepted: true };
  }
  const running = readRunningAttempts(task);
  if (running.length > 0) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires no running Attempt for ${unitId(task)} — ` +
      "settle the running Attempt first (gsd_task_settle without settleDisposition).",
    );
  }
  if (state.lifecycleStatus !== "in_progress") {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the Task lifecycle in_progress; found ` +
      `${state.lifecycleStatus ?? "none"} for ${unitId(task)} — only an active Task with a ` +
      "discovered blocker can be closed by accepting the blocker.",
    );
  }
  const attempt = readLatestTaskAttempt(task);
  if (
    !attempt || attempt.state !== "settled" || attempt.outcome !== "failed" ||
    attempt.nextStage !== "route" || attempt.resultFailureClass !== "blocker-discovered"
  ) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the latest Attempt of ${unitId(task)} settled ` +
      `as failed/blocker-discovered at the route stage; found ` +
      `${attempt ? `${attempt.state}/${attempt.outcome ?? "no-result"}` : "no Attempt"} at ` +
      `${attempt?.nextStage ?? "no Kernel head"}${attempt?.resultFailureClass ? ` (${attempt.resultFailureClass})` : ""}. ` +
      "Repair-and-retry is the separate successor-Attempt path (gsd_task_recovery_resume).",
    );
  }
  if (!attempt.resultId) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the failed Result identity of Attempt ` +
      `${attempt.attemptId} for ${unitId(task)}; the Attempt has no Result to preserve.`,
    );
  }
  const head = readRouteHead(task);
  if (!head || head.next_stage !== "route" || head.attempt_id !== attempt.attemptId) {
    throw new Error(
      `gsd_task_settle: blocker-accepted requires the route Kernel head of ${unitId(task)} on ` +
      `Attempt ${attempt.attemptId}; found ${head ? `next_stage ${head.next_stage}` : "no Kernel head"}. ` +
      "The disposition consumes the route head with a terminal closeout decision.",
    );
  }
  const route = readTaskRecoveryRoute(attempt.attemptId);
  return {
    task,
    rows: [{
      attemptId: attempt.attemptId,
      resultId: attempt.resultId,
      blockerSummary: attempt.resultSummary ?? "",
      currentStatus: state.legacyStatus,
      targetStatus: "blocker-accepted",
      lifecycleFrom: state.lifecycleStatus,
      routeConsumed: true,
      supersededRecoveryActionId: route?.recoveryActionId ?? null,
      blockerId: route?.blocker?.blockerId ?? null,
      rationale: reason,
    }],
    alreadyAccepted: false,
  };
}

/**
 * Apply the `blocker-accepted` disposition: one Domain Operation writes the
 * terminal `blocker-accepted` status to both vocabularies, the blocker
 * provenance event on the canonical plan, and the terminal closeout Kernel
 * decision that consumes the route head. A repeated applied run is a no-op.
 */
export function applyBlockerAcceptedDisposition(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  reason: string;
}): TaskBlockerAcceptedApplyResult {
  const plan = planBlockerAcceptedDisposition(input.task, input.reason);
  if (plan.alreadyAccepted || plan.rows.length === 0) {
    return {
      task: input.task,
      accepted: false,
      alreadyAccepted: true,
      attemptId: null,
      resultId: null,
      routeConsumed: false,
    };
  }
  const row = plan.rows[0];
  const entityId = unitId(input.task);
  const acceptedAt = new Date().toISOString();
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  executeDomainOperation({
    operationType: "task.settle.blocker-accepted",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      attemptId: row.attemptId,
      resultId: row.resultId,
      disposition: "blocker-accepted",
      rationale: input.reason,
    },
  }, (context) => {
    // Consume the route head first: the terminal closeout decision makes the
    // historical failure unreachable for recovery routing.
    const head = readRouteHead(input.task);
    if (!head || head.next_stage !== "route" || head.attempt_id !== row.attemptId) {
      throw new Error(
        `gsd_task_settle: the route Kernel head of ${entityId} changed after the dry-run plan; ` +
        "retry the operation",
      );
    }
    const closeout = appendKernelCheckpoint(context, {
      lifecycleId: head.lifecycle_id,
      attemptId: row.attemptId,
      nextStage: "closeout",
      previousKernelCheckpointId: head.kernel_checkpoint_id,
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      lifecycleStatus: "blocker-accepted",
    });
    closeLegacyTaskAsBlockerAccepted(context, input.task);
    return {
      events: [{
        eventType: "task.blocker.accepted",
        entityType: "task",
        entityId,
        payload: {
          disposition: "blocker-accepted",
          from: row.lifecycleFrom,
          to: "blocker-accepted",
          attemptId: row.attemptId,
          resultId: row.resultId,
          blockerSummary: row.blockerSummary,
          ...(row.supersededRecoveryActionId
            ? { supersededRecoveryActionId: row.supersededRecoveryActionId }
            : {}),
          ...(row.blockerId ? { blockerId: row.blockerId } : {}),
          rationale: input.reason,
          acceptedAt,
          closeoutKernelCheckpointId: closeout.kernelCheckpointId,
        },
        destinations: ["projection"],
      }],
      projections: [
        {
          projectionKey: `task.blocker.accepted/${entityId}`.toLowerCase(),
          projectionKind: "task-recovery",
          rendererVersion: "1",
        },
        {
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        },
      ],
    };
  });
  return {
    task: input.task,
    accepted: true,
    alreadyAccepted: false,
    attemptId: row.attemptId,
    resultId: row.resultId,
    routeConsumed: row.routeConsumed,
  };
}

// ── operator-attested operator closeout (Phase 31, RELY-03, INC-2026-09-27-01) ──
//
// A Task whose execute-task Attempt settled as failed at the route stage with
// a `retry`-classified recovery action (D-02) has no supported closeout:
// `replan` rejects it, `settle` has nothing to settle, and
// `gsd_task_recovery_resume`'s eligibility guard structurally refuses a
// `retry` action before any later check runs
// (task-recovery-domain-operation.ts:741-746 — `readTaskRecoveryResumeEligibility`
// rejects with `failedGuard: "abort-action"`). The `operator-attested`
// disposition (D-01/D-03) lets an operator submit structured verification
// evidence that the Task's deliverable is actually complete and closes the
// Task terminal in both vocabularies. It is deliberately NOT literal
// `completed` — that requires a succeeded Attempt plus a passing host
// Technical Verdict, neither of which can exist for a settled/failed
// Attempt — so a verified completion and an operator-attested one remain
// distinguishable in the DB (D-03). It never fabricates a passing Technical
// Verdict and never satisfies verdict-gated completion.
//
// RELY-03 recurrence (INC-2026-09-27-01): a second settled shape has the
// identical dead-end. `applyTaskSettle`'s plain settle path above (outcome
// `interrupted`, failureClass `operator-settle`) never calls
// recordFailureAndSelectRecovery — it settles the running Attempt and stops,
// so the resulting route-stage checkpoint carries NO recovery action at all.
// `gsd_task_recovery_resume` has nothing to resume (no recoveryActionId was
// ever recorded) and `gsd_task_complete` dead-ends on "no running Attempt to
// close … re-enter `/gsd auto`" even when the deliverable is verifiably
// complete (e.g. a false verification failure triggered the settle). This
// disposition now also accepts that exact shape — settled/interrupted/
// operator-settle at the route stage with no recorded recovery route — under
// the same evidence gate, so an operator can close the Task without
// re-entering `/gsd auto`.

/** Evidence contract pinned at Task 1's checkpoint: all three fields required. */
export interface OperatorAttestationEvidence {
  /** The verification command the operator actually ran; non-blank after trim. */
  command: string;
  /** Must be the integer 0 — a non-zero exit is not evidence of completion. */
  exitCode: 0;
  /** Must be exactly "pass" — a "fail" verdict contradicts a completion attestation. */
  verdict: "pass";
}

export interface TaskOperatorAttestedRow {
  attemptId: string;
  resultId: string;
  currentStatus: string;
  targetStatus: "operator-attested";
  lifecycleFrom: CanonicalLifecycleStatus;
  /** True when the route Kernel head is consumed with a closeout decision. */
  routeConsumed: boolean;
  supersededRecoveryActionId: string | null;
  evidence: OperatorAttestationEvidence;
  rationale: string;
  /**
   * True for the original settled/failed + `retry`-routed shape (a recovery
   * route must still read back "retry" at apply time); false for the
   * RELY-03 settled/interrupted/operator-settle shape (INC-2026-09-27-01),
   * which expects no recorded recovery route at all. Threads the plan's
   * shape decision through to the apply's in-transaction re-validation so it
   * re-checks the correct invariant rather than assuming "retry".
   */
  expectsRoutedRetry: boolean;
}

/**
 * The two settled-Attempt shapes `operator-attested` may close (Task 1 D-02,
 * extended by RELY-03 / INC-2026-09-27-01):
 *  - `retry-failure`: settled/failed at the route stage, routed to "retry".
 *  - `operator-settle-interrupted`: settled/interrupted/operator-settle at
 *    the route stage with NO recovery route recorded at all — the shape
 *    `applyTaskSettle`'s plain settle path (above) leaves behind, since it
 *    never calls recordFailureAndSelectRecovery.
 * Returns null when the Attempt matches neither shape.
 */
type OperatorAttestedShape = "retry-failure" | "operator-settle-interrupted";

function classifyOperatorAttestedShape(
  attempt: ReturnType<typeof readLatestTaskAttempt>,
): OperatorAttestedShape | null {
  if (!attempt || attempt.state !== "settled" || attempt.nextStage !== "route") return null;
  if (attempt.outcome === "failed") return "retry-failure";
  if (attempt.outcome === "interrupted" && attempt.resultFailureClass === "operator-settle") {
    return "operator-settle-interrupted";
  }
  return null;
}

/**
 * Read-only CLI hint probe (commands-task-settle.ts, RELY-03 /
 * INC-2026-09-27-01): true when the latest Attempt of `task` is the
 * settled/interrupted/operator-settle shape with no recorded recovery
 * route — the exact dead-end `gsd_task_complete` and `gsd_task_recovery_resume`
 * both refuse. Deliberately does NOT require or validate evidence (unlike
 * planOperatorAttestedDisposition, D-03) — it only decides whether the
 * plain settle command's "nothing to do" messaging should point at
 * `--operator-attested` as the next step, never whether to skip its
 * evidence gate.
 */
export function isOperatorSettleInterruptedResidue(task: TaskSettleTask): boolean {
  const attempt = readLatestTaskAttempt(task);
  if (classifyOperatorAttestedShape(attempt) !== "operator-settle-interrupted") return false;
  return readTaskRecoveryRoute(attempt!.attemptId) === null;
}

export interface TaskOperatorAttestedPlan {
  task: TaskSettleTask;
  /** Zero rows means an apply is a no-op (the disposition already committed). */
  rows: TaskOperatorAttestedRow[];
  alreadyAttested: boolean;
}

export interface TaskOperatorAttestedApplyResult {
  task: TaskSettleTask;
  attested: boolean;
  alreadyAttested: boolean;
  attemptId: string | null;
  resultId: string | null;
  routeConsumed: boolean;
}

/**
 * Validate the operator's completion evidence. This runs FIRST in
 * `planOperatorAttestedDisposition` — before the already-closed short-circuit
 * and before any DB read — so no caller (a direct domain-layer call included,
 * D-03) can probe state or ride an already-closed no-op past the evidence
 * gate. Reuses the non-empty-object rejection `requireRepairEvidence` uses
 * (task-recovery-domain-operation.ts:303-313) rather than a second hand-rolled
 * variant, then requires the three pinned fields (Task 1 decision b), each
 * with its own error naming the field and why the value is inadequate.
 */
export function requireOperatorAttestationEvidence(
  evidence: DomainJsonValue,
): OperatorAttestationEvidence {
  if (
    evidence === null ||
    Array.isArray(evidence) ||
    typeof evidence !== "object" ||
    Object.keys(evidence).length === 0
  ) {
    throw new Error("evidence must be a non-empty object");
  }
  const obj = evidence as Record<string, unknown>;
  const command = typeof obj["command"] === "string" ? obj["command"].trim() : "";
  if (!command) {
    throw new Error(
      "gsd_task_settle: operator-attested requires evidence.command to be a non-blank string " +
      "naming the verification command the operator actually ran.",
    );
  }
  const exitCode = obj["exitCode"];
  if (exitCode !== 0) {
    throw new Error(
      "gsd_task_settle: operator-attested requires evidence.exitCode to be exactly the integer " +
      `0; found ${typeof exitCode === "number" ? exitCode : JSON.stringify(exitCode)} — a ` +
      "non-zero exit is not evidence a deliverable is complete.",
    );
  }
  const verdict = obj["verdict"];
  if (verdict !== "pass") {
    throw new Error(
      "gsd_task_settle: operator-attested requires evidence.verdict to be exactly \"pass\"; found " +
      `${typeof verdict === "string" ? verdict : JSON.stringify(verdict)} — a "fail" verdict is a ` +
      "contradiction in a completion attestation.",
    );
  }
  return { command, exitCode: 0, verdict: "pass" };
}

/**
 * Read-only disposition plan: the exact Attempt, lifecycle, legacy status, and
 * route-head transitions an apply would write. Guards fail closed with the
 * exact prerequisite and the supported next action.
 */
export function planOperatorAttestedDisposition(
  task: TaskSettleTask,
  evidence: DomainJsonValue,
  reason: string,
): TaskOperatorAttestedPlan {
  // Step 1 (load-bearing ordering, D-03): validate evidence FIRST, before any
  // DB read — no caller can probe state or ride an already-closed no-op past
  // the evidence gate.
  const validatedEvidence = requireOperatorAttestationEvidence(evidence);

  const state = readTaskLifecycleState(task);
  if (state.lifecycleStatus === "operator-attested" || state.legacyStatus === "operator-attested") {
    return { task, rows: [], alreadyAttested: true };
  }
  const running = readRunningAttempts(task);
  if (running.length > 0) {
    throw new Error(
      `gsd_task_settle: operator-attested requires no running Attempt for ${unitId(task)} — ` +
      "settle the running Attempt first (gsd_task_settle without settleDisposition).",
    );
  }
  if (state.lifecycleStatus !== "in_progress") {
    throw new Error(
      `gsd_task_settle: operator-attested requires the Task lifecycle in_progress; found ` +
      `${state.lifecycleStatus ?? "none"} for ${unitId(task)} — only an active Task with a ` +
      "settled/failed Attempt awaiting recovery routing can be closed by operator attestation.",
    );
  }
  const attempt = readLatestTaskAttempt(task);
  const shape = classifyOperatorAttestedShape(attempt);
  if (!attempt || !shape) {
    throw new Error(
      `gsd_task_settle: operator-attested requires the latest Attempt of ${unitId(task)} settled ` +
      `as failed at the route stage; found ` +
      `${attempt
        ? `${attempt.state}/${attempt.outcome ?? "no-result"}${
          attempt.outcome === "interrupted" && attempt.resultFailureClass
            ? `/${attempt.resultFailureClass}`
            : ""
        }`
        : "no Attempt"} at ` +
      `${attempt?.nextStage ?? "no Kernel head"}. ` +
      "gsd_task_recovery_resume is the separate successor-Attempt path for abort/remediate routes. " +
      "(RELY-03, INC-2026-09-27-01): a latest Attempt settled as interrupted/operator-settle at the " +
      "route stage with no recovery route is also accepted.",
    );
  }
  if (!attempt.resultId) {
    throw new Error(
      `gsd_task_settle: operator-attested requires the failed Result identity of Attempt ` +
      `${attempt.attemptId} for ${unitId(task)}; the Attempt has no Result to preserve.`,
    );
  }
  // D-02: filter specifically on the routed recovery action being "retry" —
  // a broad "any settled/failed Attempt" filter would over-widen and overlap
  // blocker-accepted (blocker-discovered) and gsd_task_recovery_resume
  // (abort/remediate). The RELY-03 operator-settle-interrupted shape is
  // never routed at all (applyTaskSettle's plain settle path never calls
  // recordFailureAndSelectRecovery), so it expects no recovery route rather
  // than a "retry" one; if one unexpectedly exists, name the path that
  // actually owns it instead of silently overriding it.
  const route = readTaskRecoveryRoute(attempt.attemptId);
  if (shape === "retry-failure" && (!route || route.action !== "retry")) {
    throw new Error(
      `gsd_task_settle: operator-attested requires the routed recovery action for Attempt ` +
      `${attempt.attemptId} of ${unitId(task)} to be "retry"; found ` +
      `${route ? route.action : "no routed recovery action"}. ` +
      "A \"blocker-discovered\" route is closed by blocker-accepted; an \"abort\"/\"remediate\" " +
      "route is resumed by gsd_task_recovery_resume.",
    );
  }
  if (shape === "operator-settle-interrupted" && route) {
    throw new Error(
      `gsd_task_settle: operator-attested requires an operator-settled interrupted Attempt with ` +
      `no recorded recovery route for ${unitId(task)}; Attempt ${attempt.attemptId} was already ` +
      `routed to "${route.action}". A "retry" route is closed by the settled/failed operator-attested ` +
      "path above; an \"abort\"/\"remediate\" route is resumed by gsd_task_recovery_resume; a " +
      "\"blocker-discovered\" route is closed by blocker-accepted.",
    );
  }
  const head = readRouteHead(task);
  if (!head || head.next_stage !== "route" || head.attempt_id !== attempt.attemptId) {
    throw new Error(
      `gsd_task_settle: operator-attested requires the route Kernel head of ${unitId(task)} on ` +
      `Attempt ${attempt.attemptId}; found ${head ? `next_stage ${head.next_stage}` : "no Kernel head"}. ` +
      "The disposition consumes the route head with a terminal closeout decision.",
    );
  }
  return {
    task,
    rows: [{
      attemptId: attempt.attemptId,
      resultId: attempt.resultId,
      currentStatus: state.legacyStatus,
      targetStatus: "operator-attested",
      lifecycleFrom: state.lifecycleStatus,
      routeConsumed: true,
      supersededRecoveryActionId: route?.recoveryActionId ?? null,
      evidence: validatedEvidence,
      rationale: reason,
      expectsRoutedRetry: shape === "retry-failure",
    }],
    alreadyAttested: false,
  };
}

/**
 * Apply the `operator-attested` disposition: one Domain Operation writes the
 * terminal `operator-attested` status to both vocabularies, the evidence
 * payload on the canonical plan, and the terminal closeout Kernel decision
 * that consumes the route head. A repeated applied run is a no-op.
 */
export function applyOperatorAttestedDisposition(input: {
  invocation: ExecutionInvocation;
  task: TaskSettleTask;
  evidence: DomainJsonValue;
  reason: string;
}): TaskOperatorAttestedApplyResult {
  const plan = planOperatorAttestedDisposition(input.task, input.evidence, input.reason);
  if (plan.alreadyAttested || plan.rows.length === 0) {
    return {
      task: input.task,
      attested: false,
      alreadyAttested: true,
      attemptId: null,
      resultId: null,
      routeConsumed: false,
    };
  }
  const row = plan.rows[0];
  const entityId = unitId(input.task);
  const attestedAt = new Date().toISOString();
  const fence = readDomainOperationFence(input.invocation.idempotencyKey);
  executeDomainOperation({
    operationType: "task.settle.operator-attested",
    idempotencyKey: input.invocation.idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: input.invocation.actorType,
    ...(input.invocation.actorId ? { actorId: input.invocation.actorId } : {}),
    sourceTransport: input.invocation.sourceTransport,
    ...(input.invocation.traceId ? { traceId: input.invocation.traceId } : {}),
    ...(input.invocation.turnId ? { turnId: input.invocation.turnId } : {}),
    payload: {
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      attemptId: row.attemptId,
      resultId: row.resultId,
      disposition: "operator-attested",
      evidence: {
        command: row.evidence.command,
        exitCode: row.evidence.exitCode,
        verdict: row.evidence.verdict,
      },
      rationale: input.reason,
    },
  }, (context) => {
    // Consume the route head first: the terminal closeout decision makes the
    // historical failure unreachable for recovery routing. Re-validate BOTH
    // the route head (still `route`, still this Attempt) AND the routed
    // recovery state before writing — strictly stronger than the
    // blocker-accepted precedent, which re-checks only the head; this closes
    // the TOCTOU window a concurrent retry claim or a fresh recovery route
    // could open between the dry-run plan and this apply (T-31-05). The
    // RELY-03 operator-settle/interrupted shape (INC-2026-09-27-01) expects
    // NO recovery route rather than a "retry" one (row.expectsRoutedRetry
    // carries the plan's shape decision through to this re-check).
    const head = readRouteHead(input.task);
    if (!head || head.next_stage !== "route" || head.attempt_id !== row.attemptId) {
      throw new Error(
        `gsd_task_settle: the route Kernel head of ${entityId} changed after the dry-run plan; ` +
        "retry the operation",
      );
    }
    const route = readTaskRecoveryRoute(row.attemptId);
    let supersededRecoveryActionId: string | null;
    if (row.expectsRoutedRetry) {
      if (!route || route.action !== "retry") {
        throw new Error(
          `gsd_task_settle: the routed recovery action of ${entityId} changed after the dry-run ` +
          "plan; retry the operation",
        );
      }
      supersededRecoveryActionId = route.recoveryActionId;
    } else {
      if (route) {
        throw new Error(
          `gsd_task_settle: a recovery route appeared for the operator-settled interrupted Attempt ` +
          `of ${entityId} after the dry-run plan; retry the operation`,
        );
      }
      supersededRecoveryActionId = null;
    }
    const closeout = appendKernelCheckpoint(context, {
      lifecycleId: head.lifecycle_id,
      attemptId: row.attemptId,
      nextStage: "closeout",
      previousKernelCheckpointId: head.kernel_checkpoint_id,
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: input.task.milestoneId,
      sliceId: input.task.sliceId,
      taskId: input.task.taskId,
      lifecycleStatus: "operator-attested",
    });
    closeLegacyTaskAsOperatorAttested(context, input.task);
    return {
      events: [{
        eventType: "task.operator.attested",
        entityType: "task",
        entityId,
        payload: {
          disposition: "operator-attested",
          from: row.lifecycleFrom,
          to: "operator-attested",
          attemptId: row.attemptId,
          resultId: row.resultId,
          command: row.evidence.command,
          exitCode: row.evidence.exitCode,
          verdict: row.evidence.verdict,
          ...(supersededRecoveryActionId
            ? { supersededRecoveryActionId }
            : {}),
          rationale: input.reason,
          attestedAt,
          closeoutKernelCheckpointId: closeout.kernelCheckpointId,
        },
        destinations: ["projection"],
      }],
      projections: [
        {
          projectionKey: `task.operator.attested/${entityId}`.toLowerCase(),
          projectionKind: "task-recovery",
          rendererVersion: "1",
        },
        {
          projectionKey: `lifecycle/${entityId}`.toLowerCase(),
          projectionKind: TASK_LIFECYCLE_PROJECTION_KIND,
          rendererVersion: "1",
        },
      ],
    };
  });
  return {
    task: input.task,
    attested: true,
    alreadyAttested: false,
    attemptId: row.attemptId,
    resultId: row.resultId,
    routeConsumed: row.routeConsumed,
  };
}
