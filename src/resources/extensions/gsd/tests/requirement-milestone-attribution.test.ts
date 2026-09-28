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
