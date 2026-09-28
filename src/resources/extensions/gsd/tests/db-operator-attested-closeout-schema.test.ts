// Project/App: gsd-pi
// File Purpose: Executable v57 contract for the `operator-attested` closeout
// disposition schema (Phase 31 / RELY-03 / INC-2026-09-27-01): a v56
// database upgrades in place, lifecycle rows and foreign keys survive the
// CHECK relaxation, the transition trigger admits exactly the disposition's
// edges (including the Task 1 decision-c reopen authorization), and the
// rebuild is idempotent — including against a database that already ran the
// V50 rebuild.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import {
  SCHEMA_VERSION,
  closeDatabase,
  openDatabase,
  _getAdapter,
} from "../gsd-db.ts";
import { rebuildWorkflowItemLifecyclesForOperatorAttested } from "../db-operator-attested-closeout-schema.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function freshDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), "gsd-operator-attested-schema-"));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

/**
 * Downgrade an upgraded database to its V56 shape: the strict lifecycle
 * CHECK (blocker-accepted admitted, operator-attested not yet), the V50
 * transition trigger Task 2's migration replaced, a schema_version of 56,
 * and one hierarchy fixture with a lifecycle row plus a foreign-key child
 * row.
 */
function downgradeToV56(dbPath: string): void {
  const db = new DatabaseSync(dbPath);
  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  db.exec("BEGIN");
  try {
    const externalTriggers = db.prepare(`
      SELECT name, sql FROM sqlite_master
      WHERE type = 'trigger'
        AND tbl_name != 'workflow_item_lifecycles'
        AND sql LIKE '%workflow_item_lifecycles%'
    `).all() as Array<Record<string, unknown>>;
    for (const trigger of externalTriggers) {
      db.exec(`DROP TRIGGER IF EXISTS ${String(trigger.name)}`);
    }
    db.exec("DROP TRIGGER IF EXISTS trg_workflow_lifecycle_transition");
    db.exec(`
      CREATE TRIGGER trg_workflow_lifecycle_transition
      BEFORE UPDATE ON workflow_item_lifecycles
      WHEN NOT (
          NEW.lifecycle_status != OLD.lifecycle_status
          AND (
            NEW.last_project_revision <= OLD.last_project_revision
            OR NEW.last_authority_epoch < OLD.last_authority_epoch
          )
        )
        AND (
          NEW.lifecycle_status = OLD.lifecycle_status
          OR NEW.state_version != OLD.state_version + 1
          OR NEW.updated_at = OLD.updated_at
          OR NOT (
            (OLD.lifecycle_status = 'pending' AND NEW.lifecycle_status IN ('ready', 'cancelled')) OR
            (OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status IN ('in_progress', 'paused', 'cancelled')) OR
            (OLD.item_kind = 'slice' AND OLD.lifecycle_status = 'ready' AND NEW.lifecycle_status = 'completed') OR
            (
              OLD.item_kind = 'milestone'
              AND OLD.lifecycle_status IN ('ready', 'in_progress')
              AND NEW.lifecycle_status = 'completed'
              AND EXISTS (
                SELECT 1
                FROM workflow_operations operation
                WHERE operation.operation_id = NEW.last_operation_id
                  AND operation.project_id = NEW.project_id
                  AND operation.operation_type = 'milestone.complete'
                  AND operation.resulting_revision = NEW.last_project_revision
                  AND operation.resulting_authority_epoch = NEW.last_authority_epoch
              )
            )
            OR (
              OLD.lifecycle_status = 'in_progress'
              AND NEW.lifecycle_status IN ('paused', 'completed', 'cancelled')
              AND NOT (OLD.item_kind = 'milestone' AND NEW.lifecycle_status = 'completed')
            )
            OR (
              OLD.item_kind = 'task'
              AND OLD.lifecycle_status = 'in_progress'
              AND NEW.lifecycle_status = 'blocker-accepted'
            )
            OR (OLD.lifecycle_status = 'paused' AND NEW.lifecycle_status IN ('ready', 'in_progress', 'cancelled'))
            OR (OLD.lifecycle_status IN ('completed', 'cancelled', 'blocker-accepted') AND NEW.lifecycle_status = 'ready')
            OR (
              OLD.lifecycle_status = 'completed'
              AND NEW.lifecycle_status = 'cancelled'
              AND EXISTS (
                SELECT 1
                FROM workflow_operations operation
                WHERE operation.operation_id = NEW.last_operation_id
                  AND operation.project_id = NEW.project_id
                  AND operation.operation_type = 'import.forward_repair'
                  AND operation.resulting_revision = NEW.last_project_revision
                  AND operation.resulting_authority_epoch = NEW.last_authority_epoch
              )
            )
          )
        )
      BEGIN
        SELECT RAISE(ABORT, 'invalid workflow lifecycle transition');
      END
    `);
    db.exec(`
      CREATE TABLE lifecycle_v56 (
        lifecycle_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        item_kind TEXT NOT NULL CHECK (item_kind IN ('milestone', 'slice', 'task')),
        milestone_id TEXT NOT NULL,
        slice_id TEXT DEFAULT NULL,
        task_id TEXT DEFAULT NULL,
        lifecycle_status TEXT NOT NULL CHECK (
          lifecycle_status IN (
            'pending', 'ready', 'in_progress', 'paused', 'completed', 'cancelled', 'blocker-accepted'
          )
        ),
        state_version INTEGER NOT NULL DEFAULT 0 CHECK (state_version >= 0),
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        last_operation_id TEXT NOT NULL,
        last_project_revision INTEGER NOT NULL CHECK (last_project_revision > 0),
        last_authority_epoch INTEGER NOT NULL CHECK (last_authority_epoch >= 0),
        UNIQUE (lifecycle_id, project_id),
        CHECK (
          (item_kind = 'milestone' AND slice_id IS NULL AND task_id IS NULL) OR
          (item_kind = 'slice' AND slice_id IS NOT NULL AND task_id IS NULL) OR
          (item_kind = 'task' AND slice_id IS NOT NULL AND task_id IS NOT NULL)
        ),
        FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
        FOREIGN KEY (milestone_id) REFERENCES milestones(id),
        FOREIGN KEY (milestone_id, slice_id) REFERENCES slices(milestone_id, id),
        FOREIGN KEY (milestone_id, slice_id, task_id) REFERENCES tasks(milestone_id, slice_id, id),
        FOREIGN KEY (last_operation_id, project_id, last_project_revision, last_authority_epoch)
          REFERENCES workflow_operations(
            operation_id, project_id, resulting_revision, resulting_authority_epoch
          )
      )
    `);
    db.exec(`
      INSERT INTO lifecycle_v56 SELECT * FROM workflow_item_lifecycles
    `);
    db.exec("DROP TABLE workflow_item_lifecycles");
    db.exec("ALTER TABLE lifecycle_v56 RENAME TO workflow_item_lifecycles");
    for (const trigger of externalTriggers) {
      db.exec(String(trigger.sql));
    }
    db.prepare("DELETE FROM schema_version WHERE version > 56").run();
    db.exec("COMMIT");
  } catch (error) {
    db.exec("ROLLBACK");
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA legacy_alter_table = OFF");
  }
  db.close();
}

function projectIdOf(db: DatabaseSync): string {
  const row = db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get() as { project_id: string } | undefined;
  assert.ok(row);
  return String(row.project_id);
}

function seedOperations(
  exec: (sql: string) => void,
  projectId: string,
  specs: Array<{ revision: number; type: string }>,
): void {
  const inserts = specs.map(({ revision, type }) => `
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, expected_authority_epoch,
      resulting_revision, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      'op-seed-${revision}', '${projectId}', '${type}', 'seed/op/${revision}',
      ${revision - 1}, 0, ${revision}, 0,
      'test', 'test', 'sha256:${"0".repeat(64)}',
      '2026-09-27T00:00:${String(revision).padStart(2, "0")}.000Z'
    );
  `).join("\n");
  exec(inserts);
}

function seedHierarchy(exec: (sql: string) => void, projectId: string): void {
  seedOperations(exec, projectId, [1, 2, 3, 4, 5, 6].map((revision) => ({ revision, type: "attempt.claim" })));
  exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Upgrade', 'active', '2026-09-27T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Upgrade slice', 'active', '2026-09-27T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Wedge task', 'in_progress');
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lc-seed-1', '${projectId}', 'task', 'M001', 'S01', 'T01',
      'in_progress', 2, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z',
      'op-seed-2', 2, 0
    );
  `);
}

/**
 * Seed a task, a ready task, and a slice lifecycle row, plus a `task.reopen`
 * operation, so the trigger-edge test can exercise both the admitted and the
 * refused edges without cross-contaminating a single row's revision history.
 */
function seedTriggerHierarchy(exec: (sql: string) => void, projectId: string): void {
  seedOperations(exec, projectId, [
    ...[1, 2, 3, 4, 5, 6, 7].map((revision) => ({ revision, type: "attempt.claim" })),
    { revision: 8, type: "task.reopen" },
  ]);
  exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('M001', 'Upgrade', 'active', '2026-09-27T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('M001', 'S01', 'Upgrade slice', 'active', '2026-09-27T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T01', 'Wedge task', 'in_progress');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('M001', 'S01', 'T02', 'Ready task', 'ready');
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lc-task-1', '${projectId}', 'task', 'M001', 'S01', 'T01',
      'in_progress', 2, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z',
      'op-seed-2', 2, 0
    );
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lc-task-ready-1', '${projectId}', 'task', 'M001', 'S01', 'T02',
      'ready', 0, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z',
      'op-seed-2', 2, 0
    );
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lc-slice-1', '${projectId}', 'slice', 'M001', 'S01', NULL,
      'in_progress', 2, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:01.000Z',
      'op-seed-2', 2, 0
    );
  `);
}

/**
 * Advance the seeded lifecycle to `status` under `revision`, mirroring the
 * causal-provenance contract: the composite FK to workflow_operations stays
 * satisfied and the revision strictly advances.
 */
function transitionLifecycle(
  db: { exec(sql: string): void },
  status: string,
  revision: number,
  updatedAt: string,
): void {
  db.exec(`
    UPDATE workflow_item_lifecycles
    SET lifecycle_status = '${status}',
        state_version = state_version + 1,
        last_operation_id = 'op-seed-${revision}',
        last_project_revision = ${revision},
        updated_at = '${updatedAt}'
    WHERE lifecycle_id = 'lc-seed-1'
  `);
}

function transitionLifecycleById(
  db: { exec(sql: string): void },
  lifecycleId: string,
  status: string,
  revision: number,
  updatedAt: string,
): void {
  db.exec(`
    UPDATE workflow_item_lifecycles
    SET lifecycle_status = '${status}',
        state_version = state_version + 1,
        last_operation_id = 'op-seed-${revision}',
        last_project_revision = ${revision},
        updated_at = '${updatedAt}'
    WHERE lifecycle_id = '${lifecycleId}'
  `);
}

test("a v56 database upgrades in place and admits the operator-attested closeout edges", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  downgradeToV56(dbPath);

  // Inspect the downgraded shape directly before re-opening.
  const raw = new DatabaseSync(dbPath);
  const projectId = projectIdOf(raw);
  seedHierarchy((sql) => raw.exec(sql), projectId);
  const strictCheck = String(raw.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get()?.sql ?? "");
  assert.ok(!strictCheck.includes("'operator-attested'"), "fixture must carry the strict V56 CHECK");
  assert.ok(strictCheck.includes("'blocker-accepted'"), "fixture must still admit blocker-accepted");
  raw.close();

  // Re-opening migrates 56 → 57: the hoisted rebuild relaxes the CHECK and
  // the V57 step restores the trigger set with the disposition edges.
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  const version = db.prepare("SELECT MAX(version) AS v FROM schema_version").get() as { v: number };
  assert.equal(Number(version.v), SCHEMA_VERSION);

  const upgradedCheck = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get()?.sql ?? "");
  assert.ok(upgradedCheck.includes("'operator-attested'"), "the CHECK must admit operator-attested");

  // Durable lifecycle rows and their FK children survive the rebuild.
  assert.deepEqual(
    db.prepare("SELECT lifecycle_id, lifecycle_status FROM workflow_item_lifecycles").all(),
    [{ lifecycle_id: "lc-seed-1", lifecycle_status: "in_progress" }],
  );

  // The disposition edge is admitted: task in_progress → operator-attested.
  transitionLifecycle(db, "operator-attested", 3, "2026-09-27T00:02:00.000Z");
  assert.equal(
    String(db.prepare(
      "SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'lc-seed-1'",
    ).get()?.lifecycle_status),
    "operator-attested",
  );

  // Foreign keys remain enforced on the rebuilt table.
  assert.throws(
    () => db.prepare(`
      INSERT INTO workflow_item_lifecycles (
        lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
        lifecycle_status, state_version, created_at, updated_at,
        last_operation_id, last_project_revision, last_authority_epoch
      ) VALUES (
        'lc-orphan', '${projectId}', 'task', 'M999', 'S99', 'T99',
        'ready', 0, '2026-09-27T00:00:00.000Z', '2026-09-27T00:00:00.000Z',
        'op-seed-1', 2, 0
      )
    `).run(),
    /FOREIGN KEY/,
  );

  const violations = db.prepare("PRAGMA foreign_key_check").all();
  assert.deepEqual(violations, [], "the rebuild must not leave FK violations");
});

test("the V57 trigger admits exactly the disposition's edges and refuses the rest, including reopen authorization", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  const projectId = String(db.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get()?.project_id);
  seedTriggerHierarchy((sql) => db.exec(sql), projectId);

  // task in_progress -> operator-attested succeeds.
  transitionLifecycleById(db, "lc-task-1", "operator-attested", 3, "2026-09-27T00:03:00.000Z");
  assert.equal(
    String(db.prepare(
      "SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'lc-task-1'",
    ).get()?.lifecycle_status),
    "operator-attested",
  );

  // the same edge is refused for a slice.
  assert.throws(
    () => transitionLifecycleById(db, "lc-slice-1", "operator-attested", 3, "2026-09-27T00:03:00.000Z"),
    /invalid workflow lifecycle transition/,
  );

  // ready -> operator-attested is refused (only in_progress -> operator-attested is admitted).
  assert.throws(
    () => transitionLifecycleById(db, "lc-task-ready-1", "operator-attested", 3, "2026-09-27T00:03:00.000Z"),
    /invalid workflow lifecycle transition/,
  );

  // operator-attested -> ready WITHOUT a matching reopen operation row aborts.
  assert.throws(
    () => transitionLifecycleById(db, "lc-task-1", "ready", 4, "2026-09-27T00:04:00.000Z"),
    /invalid workflow lifecycle reopen authorization/,
  );

  // operator-attested -> ready WITH a matching task.reopen operation row succeeds
  // — this is what makes Task 1 decision c an enforced contract, not a comment.
  transitionLifecycleById(db, "lc-task-1", "ready", 8, "2026-09-27T00:05:00.000Z");
  assert.equal(
    String(db.prepare(
      "SELECT lifecycle_status FROM workflow_item_lifecycles WHERE lifecycle_id = 'lc-task-1'",
    ).get()?.lifecycle_status),
    "ready",
  );
});

test("rebuildWorkflowItemLifecyclesForOperatorAttested is idempotent against an already-upgraded database", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);
  const db = _getAdapter();
  assert.ok(db);

  const before = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get()?.sql ?? "");
  assert.ok(before.includes("'operator-attested'"), "a fresh install already carries the literal");

  // Must tolerate a database that already ran the V50 rebuild (this one has
  // — it was created fresh, at the current SCHEMA_VERSION) and complete with
  // no error, leaving the table definition byte-for-byte unchanged.
  rebuildWorkflowItemLifecyclesForOperatorAttested(db);
  rebuildWorkflowItemLifecyclesForOperatorAttested(db);

  const after = String(db.prepare(`
    SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'workflow_item_lifecycles'
  `).get()?.sql ?? "");
  assert.equal(after, before, "a no-op rebuild must not alter the table definition");
});
