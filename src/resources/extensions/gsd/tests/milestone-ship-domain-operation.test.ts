// Project/App: gsd-pi
// File Purpose: End-to-end contract proving shipMilestone() ships a real,
// already-completed milestone through the three-way gate (certify + audit +
// Gate-2) to a terminal "shipped" legacy status, one immutable
// milestone.shipped event carrying a point-in-time snapshot, and one
// archive/{id} projection row — and refuses when any gate is unmet (15-01
// Task 1).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { DatabaseSync } from "node:sqlite";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { shipMilestoneHierarchy } from "../db/writers/milestone-lifecycle.ts";
import { readMilestoneShipAuthorization } from "../db/milestone-ship-readiness.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { isClosedStatus, isShippedStatus, toStatus } from "../status-guards.ts";
import {
  compareLifecycleShadow,
  normalizeLegacyLifecycleStatus,
} from "../db/lifecycle-shadow-comparison.ts";
import { renderMilestoneArchive } from "../markdown-renderer.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import { clearPathCache, targetMilestoneFile } from "../paths.ts";
import { downgradeToV57 } from "./helpers/schema-downgrade-v57.ts";

const tempDirs = new Set<string>();

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
    actorId: "ship-milestone-test",
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

function recordVerdict(
  eventType: string,
  operationType: string,
  idempotencyKey: string,
  overallVerdict: string,
  milestoneId = "M001",
): void {
  executeAtFence(operationType, idempotencyKey, () => {}, () => ({
    eventType,
    entityType: "milestone",
    entityId: milestoneId,
    payload: { overallVerdict },
  }));
}

function recordPassingCertify(idempotencyKey = "fixture/ship/certify", milestoneId = "M001"): void {
  recordVerdict("milestone.certify.recorded", "milestone.certify", idempotencyKey, "pass", milestoneId);
}

function recordPassingAudit(idempotencyKey = "fixture/ship/audit", milestoneId = "M001"): void {
  recordVerdict("milestone.audit.recorded", "milestone.audit", idempotencyKey, "pass", milestoneId);
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-ship-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Ship stage", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice one", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertRequirement({
    id: "REQ-01",
    class: "must",
    status: "active",
    description: "Ship works end to end.",
    why: "Proves the gate.",
    source: "test",
    primary_owner: "S01",
    supporting_slices: "S01",
    validation: "test",
    notes: "",
    full_content: "REQ-01",
    superseded_by: null,
    // Phase 33 / RELY-05 / D-04: the archive snapshot now scopes by this
    // schema-level column, not by primary_owner/supporting_slices matching.
    milestone_id: "M001",
  });

  // Adopt the milestone lifecycle to "ready" first, under its own fence — the
  // causal-provenance trigger (trg_workflow_lifecycle_causal_provenance)
  // requires last_project_revision to strictly advance across an UPDATE, so
  // the ready->completed transition below must be a SEPARATE operation.
  executeAtFence("test.ship.fixture", "fixture/ship/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });

  // Bring the milestone to canonical+legacy "completed" the same way a real
  // completeMilestone would: the lifecycle transition and the legacy status
  // write happen under a fence whose operation_type is 'milestone.complete',
  // because trg_workflow_lifecycle_milestone_completion_insert and
  // trg_workflow_lifecycle_transition both require it for any milestone row
  // reaching 'completed'.
  executeAtFence("milestone.complete", "fixture/ship/complete", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });

  return basePath;
}

function shipInput(idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId: "M001" };
}

// ---------------------------------------------------------------------------
// Task 2 (D-04, D-02): SC-3 regression net through the real ship operation.
// makeBase() above is single-milestone (hardcoded "M001"); the tests below
// need two independently-ready milestones in the SAME database, so they use
// this parameterized pair instead — makeShipDb() opens a bare database, then
// makeMilestoneReadyToShip() brings one milestone through the identical
// ready -> completed path makeBase() uses, under its own milestone id.
// ---------------------------------------------------------------------------

function makeShipDb(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-ship-sc3-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function makeMilestoneReadyToShip(options: {
  milestoneId: string;
  sliceId: string;
  requirementId: string;
  requirementDescription?: string;
  primaryOwner?: string;
  supportingSlices?: string;
}): void {
  const { milestoneId, sliceId, requirementId } = options;
  const taskId = `${sliceId}-T01`;

  insertMilestone({ id: milestoneId, title: `Milestone ${milestoneId}`, status: "active" });
  insertSlice({ id: sliceId, milestoneId, title: `Slice ${sliceId}`, status: "complete" });
  insertTask({ id: taskId, sliceId, milestoneId, status: "complete" });
  insertRequirement({
    id: requirementId,
    class: "must",
    status: "active",
    description: options.requirementDescription ?? `Requirement ${requirementId} for ${milestoneId}.`,
    why: "Proves SC-2/SC-3.",
    source: "test",
    primary_owner: options.primaryOwner ?? sliceId,
    supporting_slices: options.supportingSlices ?? "",
    validation: "test",
    notes: "",
    full_content: requirementId,
    superseded_by: null,
    milestone_id: milestoneId,
  });

  executeAtFence("test.ship.fixture", `fixture/ship/${milestoneId}/ready`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId, lifecycleStatus: "ready",
    });
  });
  executeAtFence("milestone.complete", `fixture/ship/${milestoneId}/complete`, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId, lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = :id
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z", ":id": milestoneId });
  });
}

/** Reads back the one milestone.shipped event's snapshot requirement list for `milestoneId`. */
function shippedSnapshotRequirements(
  milestoneId: string,
): Array<{ id: string; description: string; status: string; primaryOwner: string; supportingSlices: string }> {
  const eventRow = row(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.shipped' AND entity_id = '${milestoneId}'
  `);
  const payload = JSON.parse(String(eventRow["payload_json"])) as Record<string, unknown>;
  const snapshot = payload["snapshot"] as Record<string, unknown>;
  return snapshot["requirements"] as Array<{
    id: string; description: string; status: string; primaryOwner: string; supportingSlices: string;
  }>;
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("shipMilestone ships a fully-authorized milestone to the shipped legacy literal", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  shipMilestone(shipInput("ship/public/basic"));

  const milestone = getMilestone("M001");
  assert.ok(milestone);
  assert.equal(milestone!.status, "shipped");
  assert.notEqual(milestone!.status, "complete");
});

test("shipMilestone commits exactly one milestone.shipped event and one archive/<id> projection row", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  shipMilestone(shipInput("ship/public/event-and-projection"));

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.shipped'
  `);
  assert.equal(eventRows.length, 1);

  const projectionRows = rows(`
    SELECT * FROM workflow_projection_work
    WHERE projection_key = 'archive/m001'
  `);
  assert.equal(projectionRows.length, 1);
  assert.equal(projectionRows[0]!["projection_kind"], "milestone-archive");
});

test("shipping preserves canonical lifecycle at completed and the shadow stays matched", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  const before = row(`
    SELECT state_version FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `);

  shipMilestone(shipInput("ship/public/shadow"));

  const after = row(`
    SELECT lifecycle_status, state_version FROM workflow_item_lifecycles
    WHERE item_kind = 'milestone' AND milestone_id = 'M001'
  `);
  assert.equal(after["lifecycle_status"], "completed");
  assert.equal(after["state_version"], before["state_version"]);

  assert.equal(compareLifecycleShadow("shipped", "completed").kind, "semantic_match_exact_delta");
});

test("the shipped event payload carries a non-empty point-in-time snapshot and the authorizing event ids", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  shipMilestone(shipInput("ship/public/snapshot"));

  const eventRow = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'milestone.shipped'
  `);
  const payload = JSON.parse(String(eventRow["payload_json"])) as Record<string, unknown>;
  const snapshot = payload["snapshot"] as Record<string, unknown>;
  assert.equal((snapshot["milestone"] as Record<string, unknown>)["id"], "M001");
  assert.equal((snapshot["slices"] as unknown[]).length, 1);
  assert.equal((snapshot["requirements"] as unknown[]).length, 1);
  assert.ok(typeof payload["certifyEventId"] === "string" && payload["certifyEventId"]);
  assert.ok(typeof payload["auditEventId"] === "string" && payload["auditEventId"]);
});

test("a full markdown render sweep writes a real ARCHIVE artifact naming the milestone id and shipped timestamp", async () => {
  const basePath = makeBase();
  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput("ship/public/render"));

  const rendered = await renderMilestoneArchive(basePath, "M001");
  assert.equal(rendered, true);

  const absPath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship stage");
  const content = readFileSync(absPath, "utf8");
  assert.match(content, /M001/);
  const eventRow = row(`
    SELECT payload_json FROM workflow_domain_events WHERE event_type = 'milestone.shipped'
  `);
  const payload = JSON.parse(String(eventRow["payload_json"])) as Record<string, unknown>;
  assert.match(content, new RegExp(String(payload["shippedAt"]).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("replaying shipMilestone with the same idempotency key does not append a second shipped event", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  const key = "ship/public/replay";

  const first = shipMilestone(shipInput(key));
  assert.equal(first.status, "committed");

  const replayed = shipMilestone(shipInput(key));
  assert.equal(replayed.status, "replayed");

  const eventRows = rows(`SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.shipped'`);
  assert.equal(eventRows.length, 1);
});

test("a different idempotency key on an already-shipped milestone is refused, never double-shipping", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput("ship/public/first-ship"));

  assert.throws(() => shipMilestone(shipInput("ship/public/second-ship")));

  const eventRows = rows(`SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.shipped'`);
  assert.equal(eventRows.length, 1);
});

test("shipMilestone refuses a non-passing certify verdict, leaving status and event count unchanged", () => {
  makeBase();
  recordVerdict("milestone.certify.recorded", "milestone.certify", "fixture/ship/certify-fail", "fail");
  recordPassingAudit();

  assert.throws(() => shipMilestone(shipInput("ship/public/certify-fail")));

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  const eventRows = rows(`SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.shipped'`);
  assert.equal(eventRows.length, 0);
});

test("readMilestoneShipAuthorization reports every unmet gate at once, not just the first", () => {
  makeBase();
  // Neither certify nor audit has been recorded, and Gate-2 is untouched:
  // both certify-missing and audit-missing should surface together.
  const authority = row(`SELECT project_id FROM project_authority WHERE singleton = 1`);
  const authorization = readMilestoneShipAuthorization({
    projectId: String(authority["project_id"]),
    milestoneId: "M001",
  });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  const kinds = authorization.blockers.map((blocker) => blocker.kind);
  assert.ok(kinds.includes("certify-missing"));
  assert.ok(kinds.includes("audit-missing"));
  assert.ok(authorization.blockers.length >= 2);
});

test("shipMilestoneHierarchy invoked under a milestone.complete context throws, leaving status unchanged", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  assert.throws(() => {
    executeAtFence("milestone.complete", "fixture/ship/bypass-attempt", (context) => {
      shipMilestoneHierarchy(context, { milestoneId: "M001" });
    });
  });

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
});

test("toStatus/isClosedStatus/normalizeLegacyLifecycleStatus treat shipped and archived as a distinct terminal literal", () => {
  assert.equal(toStatus("shipped"), "shipped");
  assert.notEqual(toStatus("shipped"), "complete");
  assert.equal(isClosedStatus("shipped"), true);
  assert.equal(isClosedStatus("archived"), true);
  assert.equal(isShippedStatus("shipped"), true);
  assert.equal(isShippedStatus("archived"), true);
  assert.equal(isShippedStatus("complete"), false);
  assert.equal(normalizeLegacyLifecycleStatus("shipped"), "completed");
  assert.equal(normalizeLegacyLifecycleStatus("archived"), "completed");
});

// ---------------------------------------------------------------------------
// Task 2 (D-04, D-02): SC-3 regression net — five scenarios, all driven
// through the real shipMilestone() operation and read back from the durable
// workflow_domain_events row it writes, never from
// captureMilestoneArchiveSnapshot's return value in isolation.
// ---------------------------------------------------------------------------

test("Test A (SC-3, headline): two milestones sharing a slice id each ship with their own requirement and none of the other's", () => {
  makeShipDb();
  makeMilestoneReadyToShip({ milestoneId: "M-A", sliceId: "S01", requirementId: "REQ-A" });
  makeMilestoneReadyToShip({ milestoneId: "M-B", sliceId: "S01", requirementId: "REQ-B" });

  recordPassingCertify("fixture/ship/certify/m-a", "M-A");
  recordPassingAudit("fixture/ship/audit/m-a", "M-A");
  recordPassingCertify("fixture/ship/certify/m-b", "M-B");
  recordPassingAudit("fixture/ship/audit/m-b", "M-B");

  shipMilestone({ invocation: invocation("ship/sc3/test-a/m-a"), milestoneId: "M-A" });
  shipMilestone({ invocation: invocation("ship/sc3/test-a/m-b"), milestoneId: "M-B" });

  assert.deepEqual(shippedSnapshotRequirements("M-A").map((r) => r.id), ["REQ-A"]);
  assert.deepEqual(shippedSnapshotRequirements("M-B").map((r) => r.id), ["REQ-B"]);
});

test("Test B (SC-3, reused requirement id): two milestones each own a requirement with the same id and different descriptions, and each snapshot carries its own", () => {
  makeShipDb();
  makeMilestoneReadyToShip({
    milestoneId: "M-C", sliceId: "S01", requirementId: "GREEN-04",
    requirementDescription: "M-C's own description.",
  });
  makeMilestoneReadyToShip({
    milestoneId: "M-D", sliceId: "S02", requirementId: "GREEN-04",
    requirementDescription: "M-D's own description.",
  });

  recordPassingCertify("fixture/ship/certify/m-c", "M-C");
  recordPassingAudit("fixture/ship/audit/m-c", "M-C");
  recordPassingCertify("fixture/ship/certify/m-d", "M-D");
  recordPassingAudit("fixture/ship/audit/m-d", "M-D");

  shipMilestone({ invocation: invocation("ship/sc3/test-b/m-c"), milestoneId: "M-C" });
  shipMilestone({ invocation: invocation("ship/sc3/test-b/m-d"), milestoneId: "M-D" });

  const mcRequirements = shippedSnapshotRequirements("M-C");
  const mdRequirements = shippedSnapshotRequirements("M-D");
  assert.equal(mcRequirements.length, 1);
  assert.equal(mdRequirements.length, 1);
  assert.equal(mcRequirements[0]!.id, "GREEN-04");
  assert.equal(mdRequirements[0]!.id, "GREEN-04");
  assert.equal(mcRequirements[0]!.description, "M-C's own description.");
  assert.equal(mdRequirements[0]!.description, "M-D's own description.");
});

test("Test C (SC-2): the snapshot's requirement set follows milestone_id, ignoring primary_owner/supporting_slices that point at the other milestone's slices", () => {
  makeShipDb();
  makeMilestoneReadyToShip({
    milestoneId: "M-E", sliceId: "S01", requirementId: "REQ-E",
    primaryOwner: "M-F/S01", supportingSlices: "M-F/S01",
  });
  makeMilestoneReadyToShip({
    milestoneId: "M-F", sliceId: "S01", requirementId: "REQ-F",
    primaryOwner: "M-E/S01", supportingSlices: "M-E/S01",
  });

  recordPassingCertify("fixture/ship/certify/m-e", "M-E");
  recordPassingAudit("fixture/ship/audit/m-e", "M-E");
  recordPassingCertify("fixture/ship/certify/m-f", "M-F");
  recordPassingAudit("fixture/ship/audit/m-f", "M-F");

  shipMilestone({ invocation: invocation("ship/sc2/test-c/m-e"), milestoneId: "M-E" });
  shipMilestone({ invocation: invocation("ship/sc2/test-c/m-f"), milestoneId: "M-F" });

  assert.deepEqual(shippedSnapshotRequirements("M-E").map((r) => r.id), ["REQ-E"]);
  assert.deepEqual(shippedSnapshotRequirements("M-F").map((r) => r.id), ["REQ-F"]);
});

test("Test D (Pitfall NEW-2 payoff, end to end): a milestone whose requirements predate the V58 migration ships with them present in its own snapshot", () => {
  // The carve-out only backfills the database's SOLE active (non-terminal)
  // milestone -- 'complete' is itself a closed/terminal status (RAW_CLOSED_
  // STATUSES), so the milestone must still be 'active' at migration time.
  // This mirrors the real Pitfall NEW-2 scenario exactly: v6 was the
  // currently-open milestone when this phase's own V58 migration ran, its
  // requirements already existed, and it completes and ships only later.
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-ship-sc3-carveout-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  const dbPath = join(basePath, ".gsd", "gsd.db");

  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Ship stage", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice one", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  executeAtFence("test.ship.fixture", "fixture/ship/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
  closeDatabase();

  downgradeToV57(dbPath);
  // Seed REQ-01 directly at the V57 raw level -- honestly pre-migration,
  // with no milestone_id column at all, rather than inserting a row that
  // already carries one.
  const raw = new DatabaseSync(dbPath);
  raw.exec(`
    INSERT INTO requirements (
      id, class, status, description, why, source, primary_owner,
      supporting_slices, validation, notes, full_content, superseded_by
    ) VALUES (
      'REQ-01', 'must', 'active', 'Ship works end to end.', 'Proves the gate.',
      'test', 'S01', 'S01', 'test', '', 'REQ-01', NULL
    )
  `);
  raw.close();

  // Re-opening runs the REAL V58 migration, including the Pitfall NEW-2
  // active-milestone carve-out: M001 is the database's sole non-terminal
  // milestone, so REQ-01 is re-derived to M001, not left NULL.
  assert.equal(openDatabase(dbPath), true);
  const carvedOut = row(`SELECT milestone_id FROM requirements WHERE id = 'REQ-01'`);
  assert.equal(carvedOut["milestone_id"], "M001");

  executeAtFence("milestone.complete", "fixture/ship/complete", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });

  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput("ship/sc3/test-d/migration-carveout"));

  assert.deepEqual(shippedSnapshotRequirements("M001").map((r) => r.id), ["REQ-01"]);
});

test("Test E (legacy tolerance): a requirement with a null milestone_id appears in no milestone's snapshot and causes no ship error", () => {
  makeBase();
  insertRequirement({
    id: "REQ-LEGACY",
    class: "must",
    status: "active",
    description: "Pre-attribution legacy row.",
    why: "",
    source: "test",
    primary_owner: "",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "REQ-LEGACY",
    superseded_by: null,
    milestone_id: null,
  });

  recordPassingCertify();
  recordPassingAudit();

  shipMilestone(shipInput("ship/sc3/test-e/legacy-null"));

  const requirementIds = shippedSnapshotRequirements("M001").map((r) => r.id);
  assert.deepEqual(requirementIds, ["REQ-01"]);
  assert.ok(!requirementIds.includes("REQ-LEGACY"));
});
