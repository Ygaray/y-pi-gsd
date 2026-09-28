// Project/App: gsd-pi
// File Purpose: Executable V58 contract for schema-level requirement-to-
// milestone attribution (Phase 33, RELY-05, TRACK-002, RD-01/RD-02): a
// requirement id reused across two milestones persists as two rows, the
// ship archive snapshot scopes by the `milestone_id` column with no
// cross-milestone bleed even when milestones share a slice id, the
// plan-reconciliation waiver path survives the V58 foreign-key widening
// end-to-end, and a populated pre-V58 database migrates without row loss
// or attribution mis-derivation.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle, readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { grantPlanReconciliationWaiver } from "../db/writers/slice-lifecycle.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { shipMilestone } from "../milestone-ship-domain-operation.ts";
import {
  SCHEMA_VERSION,
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getRequirementsForMilestone,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  upsertRequirement,
} from "../gsd-db.ts";
import { LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION } from "../legacy-import-contract.ts";
import { rebuildRequirementsForMilestoneAttribution } from "../db-requirement-milestone-attribution-schema.ts";
import { REBUILT_TABLE_NAMES, downgradeToV57 } from "./helpers/schema-downgrade-v57.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function freshDbPath(prefix = "gsd-requirement-milestone-attribution-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "requirement-milestone-attribution-test",
  };
}

/** Mirrors milestone-ship-domain-operation.test.ts's `executeAtFence`. */
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
      entityId: "test",
      payload: { idempotencyKey },
    };
    return {
      events: [{ ...emitted, destinations: ["test"] }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function recordPassingCertify(milestoneId: string, idempotencyKey: string): void {
  executeAtFence("milestone.certify", idempotencyKey, () => {}, () => ({
    eventType: "milestone.certify.recorded",
    entityType: "milestone",
    entityId: milestoneId,
    payload: { overallVerdict: "pass" },
  }));
}

function recordPassingAudit(milestoneId: string, idempotencyKey: string): void {
  executeAtFence("milestone.audit", idempotencyKey, () => {}, () => ({
    eventType: "milestone.audit.recorded",
    entityType: "milestone",
    entityId: milestoneId,
    payload: { overallVerdict: "pass" },
  }));
}

/** Parameterized analog of milestone-ship-domain-operation.test.ts's `makeBase`. */
function makeShippableMilestone(milestoneId: string, sliceId: string, requirementId: string): void {
  insertMilestone({ id: milestoneId, title: `Milestone ${milestoneId}`, status: "active" });
  insertSlice({ id: sliceId, milestoneId, title: "Slice one", status: "complete" });
  insertTask({ id: "T01", sliceId, milestoneId, status: "complete" });
  insertRequirement({
    id: requirementId,
    class: "must",
    status: "active",
    description: `Requirement for ${milestoneId}`,
    why: "Proves the gate.",
    source: "test",
    primary_owner: sliceId,
    supporting_slices: sliceId,
    validation: "test",
    notes: "",
    full_content: requirementId,
    superseded_by: null,
    milestone_id: milestoneId,
  });

  executeAtFence("test.ship.fixture", `fixture/${milestoneId}/ready`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId, lifecycleStatus: "ready",
    });
  });

  executeAtFence("milestone.complete", `fixture/${milestoneId}/complete`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId, lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = :id
    `).run({ ":completed_at": "2026-09-28T00:00:00.000Z", ":id": milestoneId });
  });
}

function shippedRequirementIds(milestoneId: string): unknown[] {
  const eventRow = db().prepare(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.shipped' AND entity_id = :milestone_id
  `).get({ ":milestone_id": milestoneId }) ?? {};
  const payload = JSON.parse(String(eventRow["payload_json"])) as Record<string, unknown>;
  const snapshot = payload["snapshot"] as Record<string, unknown>;
  return (snapshot["requirements"] as Array<Record<string, unknown>>).map((r) => r["id"]);
}

function makeBasePath(...milestoneIds: string[]): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-requirement-milestone-attribution-ship-"));
  tempDirs.add(basePath);
  for (const milestoneId of milestoneIds) {
    mkdirSync(join(basePath, ".gsd", "milestones", milestoneId), { recursive: true });
  }
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

test("SCHEMA_VERSION and the legacy-import base database version both read 58", () => {
  assert.equal(SCHEMA_VERSION, 58);
  assert.equal(LEGACY_IMPORT_BASE_DATABASE_SCHEMA_VERSION, 58);
});

// Test 1 (D-01, SC-3 core): today's bare-PK `INSERT OR REPLACE` collapses
// these into one row — this is the red case the composite PK fixes.
test("a requirement id reused across two milestones persists as two distinct rows", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);

  upsertRequirement({
    id: "GREEN-04", class: "functional", status: "active",
    description: "M-A description", why: "", source: "test",
    primary_owner: "S01", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  upsertRequirement({
    id: "GREEN-04", class: "functional", status: "active",
    description: "M-B description", why: "", source: "test",
    primary_owner: "S01", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });

  const requirementRows = rows(
    "SELECT milestone_id, description FROM requirements WHERE id = 'GREEN-04' ORDER BY milestone_id",
  );
  assert.equal(requirementRows.length, 2);
  assert.equal(requirementRows[0]!["milestone_id"], "M-A");
  assert.equal(requirementRows[0]!["description"], "M-A description");
  assert.equal(requirementRows[1]!["milestone_id"], "M-B");
  assert.equal(requirementRows[1]!["description"], "M-B description");
});

// Test 2 (D-04, SC-2): with slices and requirements seeded under both M-A
// and M-B, the M-A snapshot lists exactly M-A's requirement ids.
test("the shipped snapshot returns exactly one milestone's requirements, never another's", () => {
  makeBasePath("M-A", "M-B");
  makeShippableMilestone("M-A", "SA01", "REQ-A");
  makeShippableMilestone("M-B", "SB01", "REQ-B");

  recordPassingCertify("M-A", "fixture/M-A/certify");
  recordPassingAudit("M-A", "fixture/M-A/audit");
  shipMilestone({ invocation: invocation("ship/M-A/snapshot"), milestoneId: "M-A" });

  assert.deepEqual(shippedRequirementIds("M-A"), ["REQ-A"]);
});

// Test 3 (SC-3, the bleed case D-04 exists for): M-A and M-B share a slice
// id; the retired `primary_owner`/`supporting_slices` matching returned
// both requirements for both milestones — this is the red case.
test("the shipped snapshot does not bleed across milestones sharing a slice id", () => {
  makeBasePath("M-A", "M-B");
  makeShippableMilestone("M-A", "S01", "REQ-A");
  makeShippableMilestone("M-B", "S01", "REQ-B");

  recordPassingCertify("M-A", "fixture/M-A/bleed-certify");
  recordPassingAudit("M-A", "fixture/M-A/bleed-audit");
  shipMilestone({ invocation: invocation("ship/M-A/bleed"), milestoneId: "M-A" });

  recordPassingCertify("M-B", "fixture/M-B/bleed-certify");
  recordPassingAudit("M-B", "fixture/M-B/bleed-audit");
  shipMilestone({ invocation: invocation("ship/M-B/bleed"), milestoneId: "M-B" });

  assert.deepEqual(shippedRequirementIds("M-A"), ["REQ-A"]);
  assert.deepEqual(shippedRequirementIds("M-B"), ["REQ-B"]);
});

// Test 4 (RD-01 / Pitfall NEW-1 regression net): drives the real
// grantPlanReconciliationWaiver export end-to-end against a database
// migrated to (created fresh at) 58. RESEARCH proved this throws
// `foreign key mismatch` if the child tables are left unwidened.
test("grantPlanReconciliationWaiver completes end-to-end and both new rows carry the slice's milestone id", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);

  insertMilestone({ id: "M001", title: "Plan reconciliation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "active" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "in_progress" });

  executeAtFence("test.task.fixture", "fixture/plan-reconciliation/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "in_progress",
    });
  });

  let authorization: { taskId: string; requirementId: string; waiverId: string } | undefined;
  executeAtFence("workflow.slice.plan", "fixture/plan-reconciliation/grant", (context) => {
    authorization = grantPlanReconciliationWaiver(context, {
      milestoneId: "M001", sliceId: "S01", taskId: "T01",
    });
  });

  assert.ok(authorization);
  const requirementRow = row(
    `SELECT milestone_id FROM requirements WHERE id = '${authorization!.requirementId}'`,
  );
  assert.equal(requirementRow["milestone_id"], "M001");

  const waiverRow = row(
    `SELECT milestone_id FROM workflow_waivers WHERE waiver_id = '${authorization!.waiverId}'`,
  );
  assert.equal(waiverRow["milestone_id"], "M001");

  assert.deepEqual(rows("PRAGMA foreign_key_check"), []);
});

// Test 5 (SC-1): a requirement inserted through `insertRequirement` with a
// milestone id reads back with that milestone id through `rowToRequirement`.
test("a requirement inserted with a milestone id reads back with that milestone id", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);

  insertRequirement({
    id: "REQ-77", class: "functional", status: "active",
    description: "desc", why: "", source: "test",
    primary_owner: "S01", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });

  const found = getRequirementsForMilestone("M-A");
  assert.equal(found.length, 1);
  assert.equal(found[0]!.id, "REQ-77");
  assert.equal(found[0]!.milestone_id, "M-A");
});

// ---------------------------------------------------------------------------
// Task 3: hardening against real, populated (pre-V58) databases.
// ---------------------------------------------------------------------------
// REBUILT_TABLE_NAMES / captureSchemaObjects / downgradeToV57 live in
// helpers/schema-downgrade-v57.ts (extracted 33-04 Task 2, so
// milestone-ship-domain-operation.test.ts can reuse this exact downgrade
// shape without importing a sibling .test.ts module).

function rawProjectId(raw: DatabaseSync): string {
  const found = raw.prepare(
    "SELECT project_id FROM project_authority WHERE singleton = 1",
  ).get() as { project_id: string } | undefined;
  assert.ok(found);
  return String(found.project_id);
}

function rawSeedOperations(raw: DatabaseSync, projectId: string, revisions: number[]): void {
  const inserts = revisions.map((revision) => `
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, expected_authority_epoch,
      resulting_revision, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      'op-v57-seed-${revision}', '${projectId}', 'attempt.claim', 'seed/v57/op/${revision}',
      ${revision - 1}, 0, ${revision}, 0,
      'test', 'test', 'sha256:${"0".repeat(64)}',
      '2026-09-28T00:00:${String(revision).padStart(2, "0")}.000Z'
    );
  `).join("\n");
  raw.exec(inserts);
}

/**
 * Seed a full, bare-id (pre-V58) hierarchy under `milestoneId`/`sliceId`: a
 * requirement plus one row in each of the three child tables, all pointing
 * at that one requirement — the "real, populated database" Task 3 hardens
 * the migration against.
 */
function rawSeedV57Fixture(
  raw: DatabaseSync,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  requirementId: string,
  milestoneStatus: string,
): void {
  const projectId = rawProjectId(raw);
  const revBase = rawNextRevision(raw);
  rawSeedOperations(raw, projectId, [revBase, revBase + 1, revBase + 2, revBase + 3]);

  raw.exec(`
    INSERT INTO milestones (id, title, status, created_at)
    VALUES ('${milestoneId}', 'Milestone ${milestoneId}', '${milestoneStatus}', '2026-09-28T00:00:00.000Z');
    INSERT INTO slices (milestone_id, id, title, status, created_at)
    VALUES ('${milestoneId}', '${sliceId}', 'Slice ${sliceId}', 'complete', '2026-09-28T00:00:00.000Z');
    INSERT INTO tasks (milestone_id, slice_id, id, title, status)
    VALUES ('${milestoneId}', '${sliceId}', '${taskId}', 'Task ${taskId}', 'complete');
    INSERT INTO workflow_item_lifecycles (
      lifecycle_id, project_id, item_kind, milestone_id, slice_id, task_id,
      lifecycle_status, state_version, created_at, updated_at,
      last_operation_id, last_project_revision, last_authority_epoch
    ) VALUES (
      'lc-${requirementId}', '${projectId}', 'task', '${milestoneId}', '${sliceId}', '${taskId}',
      'completed', 1, '2026-09-28T00:00:00.000Z', '2026-09-28T00:00:00.000Z',
      'op-v57-seed-${revBase}', ${revBase}, 0
    );
    INSERT INTO requirements (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
    VALUES ('${requirementId}', 'must', 'active', 'Requirement ${requirementId}', 'why', 'test', '${sliceId}', '${sliceId}', 'test', '', '${requirementId}', NULL);
    INSERT INTO workflow_waivers (
      waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
      waiver_status, scope, rationale, granted_by_actor_type,
      granted_by_actor_id, granted_at, expires_at, ended_at, operation_id,
      project_revision, authority_epoch
    ) VALUES (
      'wv-${requirementId}', '${projectId}', 'lc-${requirementId}', '${requirementId}', NULL,
      'active', 'task:${milestoneId}/${sliceId}/${taskId}', 'seed', 'policy',
      NULL, '2026-09-28T00:00:00.000Z', NULL, NULL, 'op-v57-seed-${revBase + 1}',
      ${revBase + 1}, 0
    );
    INSERT INTO workflow_requirement_dispositions (
      disposition_id, project_id, requirement_id, disposition,
      waiver_id, supersedes_disposition_id, rationale, created_at,
      operation_id, project_revision, authority_epoch
    ) VALUES (
      'disp-${requirementId}', '${projectId}', '${requirementId}', 'unsatisfied',
      NULL, NULL, 'seed', '2026-09-28T00:00:00.000Z',
      'op-v57-seed-${revBase + 2}', ${revBase + 2}, 0
    );
    INSERT INTO workflow_acceptance_criteria (
      criterion_id, criterion_key, project_id, lifecycle_id,
      requirement_id, criterion_kind, evidence_class, required, description,
      supersedes_criterion_id, created_at, operation_id, project_revision,
      authority_epoch
    ) VALUES (
      'crit-${requirementId}', '${`crit-${requirementId}`.toLowerCase()}', '${projectId}', 'lc-${requirementId}',
      '${requirementId}', 'technical', 'command', 1, 'seed criterion',
      NULL, '2026-09-28T00:00:00.000Z', 'op-v57-seed-${revBase + 3}', ${revBase + 3}, 0
    );
  `);
}

function rawNextRevision(raw: DatabaseSync): number {
  const found = raw.prepare("SELECT MAX(resulting_revision) AS v FROM workflow_operations").get() as
    | { v: number | null }
    | undefined;
  return Number(found?.v ?? 0) + 1;
}

function rawCounts(raw: DatabaseSync): Record<string, number> {
  const out: Record<string, number> = {};
  for (const name of REBUILT_TABLE_NAMES) {
    out[name] = Number((raw.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as { c: number }).c);
  }
  return out;
}

// Test 6 (row fidelity): a database seeded with requirements, waivers,
// dispositions, and acceptance criteria at version 57 has identical row
// counts in all four tables after migrating to 58, and a spot-checked row's
// non-milestone column values are unchanged. Also confirms Assumption A3
// (RESEARCH): the hoisted, foreign-keys-off rebuild is exercised here with
// real child rows present under normal foreign-key enforcement.
test("Test 6: migrating a populated V57 database preserves every row and non-milestone field", () => {
  const dbPath = freshDbPath("gsd-requirement-milestone-attribution-fidelity-");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  downgradeToV57(dbPath);

  const raw = new DatabaseSync(dbPath);
  rawSeedV57Fixture(raw, "M-SHIPPED", "S01", "T01", "REQ-FIDELITY", "shipped");
  const before = rawCounts(raw);
  raw.close();

  assert.equal(openDatabase(dbPath), true);

  const after: Record<string, number> = {};
  for (const name of REBUILT_TABLE_NAMES) {
    after[name] = Number(row(`SELECT COUNT(*) AS c FROM ${name}`)["c"]);
  }
  assert.deepEqual(after, before);

  const spotCheck = row("SELECT description, status FROM requirements WHERE id = 'REQ-FIDELITY'");
  assert.equal(spotCheck["description"], "Requirement REQ-FIDELITY");
  assert.equal(spotCheck["status"], "active");
});

// Test 7 (Pitfall NEW-2): the active, non-terminal milestone's own
// pre-migration requirement rows carry its id, not NULL; a shipped
// milestone's requirement stays NULL. The payoff: getRequirementsForMilestone
// (which captureMilestoneArchiveSnapshot now calls) lists the active
// milestone's own pre-migration requirement.
test("Test 7: the single active milestone's pre-migration requirement is carved out; a shipped milestone's is not", () => {
  const dbPath = freshDbPath("gsd-requirement-milestone-attribution-carveout-");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  downgradeToV57(dbPath);

  const raw = new DatabaseSync(dbPath);
  rawSeedV57Fixture(raw, "M-ACTIVE", "S01", "T01", "REQ-ACTIVE", "active");
  rawSeedV57Fixture(raw, "M-SHIPPED", "S02", "T02", "REQ-SHIPPED", "shipped");
  raw.close();

  assert.equal(openDatabase(dbPath), true);

  const activeRow = row("SELECT milestone_id FROM requirements WHERE id = 'REQ-ACTIVE'");
  assert.equal(activeRow["milestone_id"], "M-ACTIVE");
  const shippedRow = row("SELECT milestone_id FROM requirements WHERE id = 'REQ-SHIPPED'");
  assert.equal(shippedRow["milestone_id"], null);

  const payoff = getRequirementsForMilestone("M-ACTIVE");
  assert.deepEqual(payoff.map((r) => r.id), ["REQ-ACTIVE"]);
});

// Test 8 (RD-01 triggers intact): after migration, each of the three child
// tables still raises on UPDATE and on DELETE of an existing row, and the
// sqlite_master entry for each names the composite foreign key onto
// requirements(milestone_id, id).
test("Test 8: the tamper-evident triggers and composite foreign keys survive the rebuild", () => {
  const dbPath = freshDbPath("gsd-requirement-milestone-attribution-triggers-");
  assert.equal(openDatabase(dbPath), true);
  closeDatabase();

  downgradeToV57(dbPath);

  const raw = new DatabaseSync(dbPath);
  rawSeedV57Fixture(raw, "M-TRIG", "S01", "T01", "REQ-TRIG", "active");
  raw.close();

  assert.equal(openDatabase(dbPath), true);

  for (const name of [
    "workflow_waivers",
    "workflow_requirement_dispositions",
    "workflow_acceptance_criteria",
  ]) {
    const sql = String(row(
      `SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${name}'`,
    )["sql"] ?? "");
    assert.match(sql, /FOREIGN KEY \(milestone_id, requirement_id\) REFERENCES requirements\(milestone_id, id\)/);
  }

  // `trg_workflow_waiver_transition` fires first (it treats the resulting
  // no-op `waiver_status` as an invalid transition target), ahead of
  // `trg_workflow_waiver_grant_immutable` — either message proves the row
  // rejects the UPDATE.
  assert.throws(
    () => db().prepare("UPDATE workflow_waivers SET rationale = 'mutated' WHERE waiver_id = 'wv-REQ-TRIG'").run(),
    /immutable|invalid workflow waiver transition/,
  );
  assert.throws(
    () => db().prepare("DELETE FROM workflow_waivers WHERE waiver_id = 'wv-REQ-TRIG'").run(),
    /durable history/,
  );
  assert.throws(
    () => db().prepare("UPDATE workflow_requirement_dispositions SET rationale = 'mutated' WHERE disposition_id = 'disp-REQ-TRIG'").run(),
    /immutable/,
  );
  assert.throws(
    () => db().prepare("DELETE FROM workflow_requirement_dispositions WHERE disposition_id = 'disp-REQ-TRIG'").run(),
    /immutable/,
  );
  assert.throws(
    () => db().prepare("UPDATE workflow_acceptance_criteria SET description = 'mutated' WHERE criterion_id = 'crit-REQ-TRIG'").run(),
    /immutable/,
  );
  assert.throws(
    () => db().prepare("DELETE FROM workflow_acceptance_criteria WHERE criterion_id = 'crit-REQ-TRIG'").run(),
    /immutable/,
  );
});

// Test 9 (idempotency): running the rebuild a second time against an
// already-migrated database is a no-op — row counts and each table's
// sqlite_master SQL are unchanged.
test("Test 9: rebuildRequirementsForMilestoneAttribution is idempotent against an already-migrated database", () => {
  const dbPath = freshDbPath("gsd-requirement-milestone-attribution-idempotent-");
  assert.equal(openDatabase(dbPath), true);

  insertRequirement({
    id: "REQ-IDEMPOTENT", class: "must", status: "active",
    description: "desc", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });

  const beforeSql: Record<string, string> = {};
  for (const name of REBUILT_TABLE_NAMES) {
    beforeSql[name] = String(row(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${name}'`)["sql"]);
  }
  const beforeCounts: Record<string, number> = {};
  for (const name of REBUILT_TABLE_NAMES) {
    beforeCounts[name] = Number(row(`SELECT COUNT(*) AS c FROM ${name}`)["c"]);
  }

  rebuildRequirementsForMilestoneAttribution(db());
  rebuildRequirementsForMilestoneAttribution(db());

  for (const name of REBUILT_TABLE_NAMES) {
    const afterSql = String(row(`SELECT sql FROM sqlite_master WHERE type = 'table' AND name = '${name}'`)["sql"]);
    assert.equal(afterSql, beforeSql[name], `${name} sqlite_master SQL must be unchanged`);
    const afterCount = Number(row(`SELECT COUNT(*) AS c FROM ${name}`)["c"]);
    assert.equal(afterCount, beforeCounts[name], `${name} row count must be unchanged`);
  }
});

// Test 10 (PR-2): two legacy rows sharing one id and both having a NULL
// milestone_id cannot coexist; a second such insert is rejected by
// idx_requirements_legacy_id. Separately, the same id under two real,
// different milestone ids inserts fine — the index does not defeat SC-3.
test("Test 10: the legacy-id partial unique index rejects duplicate NULL-milestone rows without defeating cross-milestone reuse", () => {
  const dbPath = freshDbPath("gsd-requirement-milestone-attribution-legacy-index-");
  assert.equal(openDatabase(dbPath), true);

  insertRequirement({
    id: "LEG-01", class: "functional", status: "active",
    description: "first legacy row", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null,
  });
  assert.throws(
    () => insertRequirement({
      id: "LEG-01", class: "functional", status: "active",
      description: "second legacy row", why: "", source: "test",
      primary_owner: "", supporting_slices: "", validation: "", notes: "",
      full_content: "", superseded_by: null,
    }),
    /UNIQUE constraint failed|idx_requirements_legacy_id/,
  );

  insertRequirement({
    id: "LEG-02", class: "functional", status: "active",
    description: "M-A", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  insertRequirement({
    id: "LEG-02", class: "functional", status: "active",
    description: "M-B", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });
  const leg02Rows = rows("SELECT milestone_id FROM requirements WHERE id = 'LEG-02' ORDER BY milestone_id");
  assert.equal(leg02Rows.length, 2);
});
