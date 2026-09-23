// Project/App: gsd-pi
// File Purpose: Executable v54 contract for the milestone run-log schema's
// trigger guards and invariant indexes (DRIVER-01, Task 3 hardening): the
// row cannot be deleted, cannot have its identity changed, cannot take a
// status transition outside the locked whitelist, a second concurrently
// running row for one milestone is refused by the database, and a
// pause/resume cycle produces a new attempt row instead of upserting.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import {
  MILESTONE_RUN_LOG_OPERATION_TYPE,
  registerMilestoneRunLogRow,
  transitionMilestoneRunLogRow,
  type MilestoneRunLogStatus,
} from "../db/writers/milestone-run-log.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { recordMilestoneRunLifecycle } from "../milestone-run-log-domain-operation.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params?: Record<string, unknown>): Record<string, unknown> | undefined {
  return params ? db().prepare(sql).get(params) : db().prepare(sql).get();
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "test",
  };
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-schema-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Run log schema", status: "active" });
  return basePath;
}

/** Insert one running row through the real writer/domain-op path. */
function insertRunning(runId: string, attempt: number): string {
  const receipt = recordMilestoneRunLifecycle({
    invocation: invocation(`fixture/run-log-schema/insert/${runId}/a${attempt}`),
    milestoneId: "M001",
    runId,
    attempt,
    status: "running",
  });
  return receipt.entryId;
}

/** Transition an existing row through the real writer's own Domain Operation. */
function transitionAtFence(
  entryId: string,
  status: MilestoneRunLogStatus,
  idempotencyKey: string,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: MILESTONE_RUN_LOG_OPERATION_TYPE,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { entryId, status },
  }, (context) => {
    transitionMilestoneRunLogRow(context, {
      entryId,
      status,
      resumeFrom: null,
      pauseKind: null,
      reason: null,
    });
    return {
      events: [{
        eventType: "test.run-log.transitioned",
        entityType: "milestone",
        entityId: "M001",
        payload: { entryId },
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

/** Run a write at a fence under an arbitrary Domain Operation type. */
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

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("legal transitions out of running: paused, completed, and failed each succeed", () => {
  makeBase();
  const paused = insertRunning("R-paused", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused', updated_at = updated_at WHERE entry_id = :id`)
    .run({ ":id": paused });
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": paused })?.["status"], "paused");

  const completed = insertRunning("R-completed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'completed', updated_at = updated_at WHERE entry_id = :id`)
    .run({ ":id": completed });
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": completed })?.["status"], "completed");

  const failed = insertRunning("R-failed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'failed', updated_at = updated_at WHERE entry_id = :id`)
    .run({ ":id": failed });
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": failed })?.["status"], "failed");
});

test("legal transitions out of paused: resumed and failed each succeed", () => {
  makeBase();
  const resumed = insertRunning("R-resumed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": resumed });
  db().prepare(`UPDATE milestone_run_log SET status = 'resumed', updated_at = updated_at WHERE entry_id = :id`)
    .run({ ":id": resumed });
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": resumed })?.["status"], "resumed");

  const pausedFailed = insertRunning("R-paused-failed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": pausedFailed });
  db().prepare(`UPDATE milestone_run_log SET status = 'failed', updated_at = updated_at WHERE entry_id = :id`)
    .run({ ":id": pausedFailed });
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": pausedFailed })?.["status"], "failed");
});

test("illegal transitions abort with the transition trigger's named error", () => {
  makeBase();

  const backToRunning = insertRunning("R-back-to-running", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": backToRunning });
  assert.throws(
    () => db().prepare(`UPDATE milestone_run_log SET status = 'running', updated_at = updated_at WHERE entry_id = :id`)
      .run({ ":id": backToRunning }),
    /invalid milestone run-log status transition/,
  );

  const outOfResumed = insertRunning("R-out-of-resumed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": outOfResumed });
  db().prepare(`UPDATE milestone_run_log SET status = 'resumed' WHERE entry_id = :id`).run({ ":id": outOfResumed });
  assert.throws(
    () => db().prepare(`UPDATE milestone_run_log SET status = 'running', updated_at = updated_at WHERE entry_id = :id`)
      .run({ ":id": outOfResumed }),
    /invalid milestone run-log status transition/,
  );

  const outOfCompleted = insertRunning("R-out-of-completed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'completed' WHERE entry_id = :id`).run({ ":id": outOfCompleted });
  assert.throws(
    () => db().prepare(`UPDATE milestone_run_log SET status = 'paused', updated_at = updated_at WHERE entry_id = :id`)
      .run({ ":id": outOfCompleted }),
    /invalid milestone run-log status transition/,
  );

  const outOfFailed = insertRunning("R-out-of-failed", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'failed' WHERE entry_id = :id`).run({ ":id": outOfFailed });
  assert.throws(
    () => db().prepare(`UPDATE milestone_run_log SET status = 'paused', updated_at = updated_at WHERE entry_id = :id`)
      .run({ ":id": outOfFailed }),
    /invalid milestone run-log status transition/,
  );

  const runningToResumed = insertRunning("R-running-to-resumed", 1);
  assert.throws(
    () => db().prepare(`UPDATE milestone_run_log SET status = 'resumed', updated_at = updated_at WHERE entry_id = :id`)
      .run({ ":id": runningToResumed }),
    /invalid milestone run-log status transition/,
  );
});

test("identity columns are immutable even when the status transition on the same UPDATE would be legal", () => {
  makeBase();
  const entryId = insertRunning("R-identity", 1);

  const identityColumns: Array<[string, string]> = [
    ["entry_id", "'RUN-M001-R-identity-a999'"],
    ["project_id", "'other-project'"],
    ["milestone_id", "'M999'"],
    ["run_id", "'R999'"],
    ["attempt", "999"],
    ["host_pid", "999999"],
    ["started_at", "'1999-01-01T00:00:00.000Z'"],
    ["created_operation_id", "'op-forged'"],
  ];
  for (const [column, value] of identityColumns) {
    assert.throws(
      () => db().prepare(`
        UPDATE milestone_run_log SET status = 'paused', ${column} = ${value} WHERE entry_id = :id
      `).run({ ":id": entryId }),
      /milestone run-log identity is immutable/,
      `expected ${column} to be immutable`,
    );
  }
  // The row is untouched: still running, still under its original entry_id.
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": entryId })?.["status"], "running");
});

test("run-log rows cannot be deleted: DELETE is rejected by the delete-blocking trigger", () => {
  makeBase();
  const entryId = insertRunning("R-delete", 1);
  assert.throws(
    () => db().prepare(`DELETE FROM milestone_run_log WHERE entry_id = :id`).run({ ":id": entryId }),
    /milestone run-log records are durable history/,
  );
  assert.equal(rows(`SELECT entry_id FROM milestone_run_log WHERE entry_id = :id`.replace(":id", `'${entryId}'`)).length, 1);
});

test("single-active-run: a second concurrently-running row for one milestone violates the partial unique index", () => {
  makeBase();
  const first = insertRunning("R-first-active", 1);

  assert.throws(() => insertRunning("R-second-active", 1));

  // Once the first run is paused, a second running row for the same
  // milestone is admitted -- the constraint is on (project, milestone,
  // status='running'), not on run identity.
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": first });
  const second = insertRunning("R-second-active", 1);
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": second })?.["status"], "running");
});

test("attempt-numbered identity: recording attempt 2 inserts a second row, leaving attempt 1 intact", () => {
  makeBase();
  const attempt1 = insertRunning("R-attempts", 1);
  db().prepare(`UPDATE milestone_run_log SET status = 'paused' WHERE entry_id = :id`).run({ ":id": attempt1 });
  const attempt2 = insertRunning("R-attempts", 2);

  assert.notEqual(attempt1, attempt2);
  assert.equal(attempt1, "RUN-M001-R-attempts-a1");
  assert.equal(attempt2, "RUN-M001-R-attempts-a2");
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": attempt1 })?.["status"], "paused");
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": attempt2 })?.["status"], "running");
  assert.equal(
    Number(row(`SELECT COUNT(*) AS count FROM milestone_run_log WHERE milestone_id = 'M001' AND run_id = 'R-attempts'`)?.["count"] ?? 0),
    2,
  );
});

test("context guard: registerMilestoneRunLogRow rejects a wrong Domain Operation context and inserts nothing", () => {
  makeBase();
  assert.throws(
    () => executeAtFence("test.fixture.wrong-op", "fixture/run-log-schema/wrong-op", (context) => {
      registerMilestoneRunLogRow(context, {
        milestoneId: "M001",
        runId: "R-wrong-op",
        attempt: 1,
        status: "running",
        resumeFrom: null,
        pauseKind: null,
        reason: null,
      });
    }),
    /requires its Domain Operation/,
  );
  assert.equal(
    Number(row(`SELECT COUNT(*) AS count FROM milestone_run_log`)?.["count"] ?? -1),
    0,
  );
});

test("transitionMilestoneRunLogRow: unknown entry_id and an already-terminal row each throw a distinct error before any UPDATE runs", () => {
  makeBase();
  assert.throws(
    () => transitionAtFence("RUN-M001-does-not-exist-a1", "paused", "fixture/run-log-schema/unknown-entry"),
    /not found/,
  );

  const terminal = insertRunning("R-terminal", 1);
  transitionAtFence(terminal, "completed", "fixture/run-log-schema/terminal-setup");
  assert.throws(
    () => transitionAtFence(terminal, "failed", "fixture/run-log-schema/terminal-retry"),
    /already terminal/,
  );
  // The row is unchanged -- still completed.
  assert.equal(row(`SELECT status FROM milestone_run_log WHERE entry_id = :id`, { ":id": terminal })?.["status"], "completed");
});
