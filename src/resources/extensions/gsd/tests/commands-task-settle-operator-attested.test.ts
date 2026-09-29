// Project/App: gsd-pi
// File Purpose: /gsd task settle --operator-attested CLI coverage (Phase 31 /
// RELY-03). Sandboxed with the withCommandCwd convention (STATE.md phase 17
// records a real incident where an unsandboxed CLI test leaked 13 rows into
// the live project .gsd/gsd.db).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { withCommandCwd } from "../commands/context.ts";
import { handleTaskSettle } from "../commands-task-settle.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { executeDomainOperation } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  claimTaskAttempt,
  settleTaskAttempt,
} from "../task-execution-domain-operation.ts";
import { recordFailureAndSelectRecovery } from "../task-recovery-domain-operation.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { applyTaskSettle } from "../task-settle.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-commands-task-settle-operator-attested-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function makeMockCtx(): ExtensionCommandContext & { _notifications: Array<{ message: string; type: string }> } {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    ui: {
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
    },
    _notifications: notifications,
  } as unknown as ExtensionCommandContext & { _notifications: typeof notifications };
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function taskRow(): { status: string } {
  return db().prepare("SELECT status AS status FROM tasks WHERE id = 'T01'").get() as { status: string };
}

// Not a reuse of task-settle.test.ts's fixtures: fixtures are not importable
// across test files (31-01's interface note). This mirrors seedRunningAttempt
// + seedRetryRoutedResidue's shape exactly.

function seedRunningAttempt(): { attemptId: string } {
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
    idempotencyKey: "fixture/commands-task-settle-operator-attested/task-ready",
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
        projectionKey: "test/commands-task-settle-operator-attested/m001/s01/t01",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
  const dispatchRow = db().prepare("SELECT id FROM unit_dispatches").get() as { id: number | bigint };
  const claim = claimTaskAttempt({
    invocation: internalExecutionInvocation("test/commands-task-settle-operator-attested/claim"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    workerId: "worker-1",
    milestoneLeaseToken: 7,
    coordinationDispatchId: Number(dispatchRow.id),
  });
  return { attemptId: claim.attemptId };
}

function seedRetryRoutedResidue(): { attemptId: string; resultId: string } {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: internalExecutionInvocation("test/commands-task-settle-operator-attested/settle"),
    attemptId,
    outcome: "failed",
    failureClass: "transient-execution",
    summary: "transient executor fault; retry eligible",
    output: { fault: "transient" },
  });
  db().prepare(`
    UPDATE tasks SET status = 'in_progress' WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = 'T01'
  `).run();
  recordFailureAndSelectRecovery({
    invocation: internalExecutionInvocation("test/commands-task-settle-operator-attested/route"),
    attemptId,
    resultId: settlement.resultId,
    owner: "agent",
    classification: { failureKind: "transient-execution" },
    summary: "transient executor fault; retry eligible",
    evidence: { detail: "transient" },
    rationale: "agent-owner transient-execution routes to retry",
  });
  return { attemptId, resultId: settlement.resultId };
}

// RELY-03 recurrence (INC-2026-09-27-01): the plain `gsd task settle` path
// (no --operator-attested / --blocker-accepted flag) settles the running
// Attempt as interrupted/operator-settle without ever routing the failure —
// exercised via applyTaskSettle directly to mirror the live incident's exact
// call path, not a hand-rolled settleTaskAttempt shortcut.
function seedOperatorSettleInterruptedResidue(): { attemptId: string } {
  const { attemptId } = seedRunningAttempt();
  const applied = applyTaskSettle({
    invocation: internalExecutionInvocation("test/commands-task-settle-operator-attested/operator-settle"),
    task: { milestoneId: "M001", sliceId: "S01", taskId: "T01" },
    reason: "false verification failure settled the Attempt out from under the session",
  });
  assert.equal(applied.settled, true, "fixture precondition: applyTaskSettle must settle the running Attempt");
  return { attemptId };
}

function seedBlockerDiscoveredResidue(): { attemptId: string; resultId: string } {
  const { attemptId } = seedRunningAttempt();
  const settlement = settleTaskAttempt({
    invocation: internalExecutionInvocation("test/commands-task-settle-operator-attested/blocker-settle"),
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

const UNIT = "M001/S01/T01";
const EVIDENCE_JSON = '\'{"command":"npm test","exitCode":0,"verdict":"pass"}\'';

// ── Test A: dry-run reports the transition and mutates nothing ────────────

test("--operator-attested dry-run notifies the transition and changes nothing", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --operator-attested --evidence ${EVIDENCE_JSON}`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "info");
    assert.match(ctx._notifications[0].message, /operator-attested/);
    assert.equal(taskRow().status, "in_progress", "dry-run must not close the Task");
  });
});

// ── Test B: --apply closes the Task terminal ──────────────────────────────

test("--operator-attested --apply closes the Task terminal", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --apply --operator-attested --evidence ${EVIDENCE_JSON}`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "info");
    assert.match(ctx._notifications[0].message, /closed on operator attestation/);
    assert.equal(taskRow().status, "operator-attested");
  });
});

// ── Test C: malformed --evidence JSON is reported specifically ────────────

test("--operator-attested with malformed --evidence JSON notifies a specific parse error and changes nothing", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --operator-attested --evidence '{not valid json'`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "error");
    assert.match(ctx._notifications[0].message, /--evidence is not valid JSON/);
    assert.equal(taskRow().status, "in_progress");
  });
});

// ── Test D: missing --evidence is reported specifically ───────────────────

test("--operator-attested with no --evidence argument notifies a specific missing-evidence error and changes nothing", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --operator-attested`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "error");
    assert.match(ctx._notifications[0].message, /requires --evidence/);
    assert.equal(taskRow().status, "in_progress");
  });
});

// ── Test E: mutual exclusivity with --reconcile-lifecycle ─────────────────

test("--operator-attested combined with --reconcile-lifecycle notifies the mutual-exclusivity error and changes nothing", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --operator-attested --reconcile-lifecycle --evidence ${EVIDENCE_JSON}`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "error");
    assert.match(ctx._notifications[0].message, /mutually exclusive/);
    assert.equal(taskRow().status, "in_progress");
  });
});

// ── Test F: domain-layer refusal on inadequate evidence, not a CLI check ──

test("--operator-attested with a non-zero exit code notifies the domain layer's refusal and changes nothing", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedRetryRoutedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified" --operator-attested --evidence '{"command":"npm test","exitCode":1,"verdict":"pass"}'`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "error");
    assert.match(ctx._notifications[0].message, /exitCode/);
    assert.equal(taskRow().status, "in_progress");
  });
});

// ── Test G: --blocker-accepted remains unregressed ─────────────────────────

// ── Test H: --operator-attested closes the RELY-03 operator-settle shape ──
// ── (INC-2026-09-27-01) ────────────────────────────────────────────────────

test("--operator-attested --apply closes a settled operator-settle/interrupted Attempt with no recovery route", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedOperatorSettleInterruptedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "operator verified after a false verification failure" --apply --operator-attested --evidence ${EVIDENCE_JSON}`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "info");
    assert.match(ctx._notifications[0].message, /closed on operator attestation/);
    assert.equal(taskRow().status, "operator-attested");
  });
});

// ── Test I: the plain settle command's idle-repeat now names the escape ───
// ── hatch instead of a bare "nothing to do" dead end ──────────────────────

test("a plain settle re-run against an already-settled operator-settle Attempt hints at --operator-attested instead of a bare dead end", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedOperatorSettleInterruptedResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(`${UNIT} --reason "operator repair" --apply`, ctx, base);

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "info");
    assert.match(ctx._notifications[0].message, /has no running Attempt — nothing to do/);
    assert.match(ctx._notifications[0].message, /--operator-attested --evidence/);
    assert.notEqual(taskRow().status, "operator-attested", "the hint must not itself close the Task");
  });
});

test("--blocker-accepted still works unchanged on a blocker-discovered fixture", async () => {
  const base = makeBase();
  await withCommandCwd(base, async () => {
    seedBlockerDiscoveredResidue();
    const ctx = makeMockCtx();

    await handleTaskSettle(
      `${UNIT} --reason "accept the discovered plan blocker" --apply --blocker-accepted`,
      ctx,
      base,
    );

    assert.equal(ctx._notifications.length, 1);
    assert.equal(ctx._notifications[0].type, "info");
    assert.match(ctx._notifications[0].message, /Accepted blocker/);
    assert.equal(taskRow().status, "blocker-accepted");
  });
});
