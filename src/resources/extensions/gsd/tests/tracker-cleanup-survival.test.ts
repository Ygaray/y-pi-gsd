// Project/App: gsd-pi
// File Purpose: The literal proof of TRACK-01 Success Criterion 1 —
// ".planning/ROADMAP.md Phase 17 Success Criterion 1: 'An item filed
// against a live phase survives the real ship/archive operation, the
// deletion of its phase directory, and a database close/reopen — with its
// back-references intact.'" 17-PATTERNS.md found no analog for this test
// shape anywhere in the tree — it is the first test to exercise a
// tracker-shaped write path and the real archive path (`shipMilestone` +
// `rebuildMarkdownProjectionsFromDb`) in one run (17-RESEARCH.md Pitfall 3).
// The fixture scaffolding below is copied verbatim from
// `milestone-archive-projection.test.ts`'s `makeShippableMilestone` rather
// than hand-rolled, per this plan's FA-9.

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { rebuildMarkdownProjectionsFromDb } from "../commands-maintenance.ts";
import type { DomainJsonValue, DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { createTrackerItem } from "../db/writers/tracker-item.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import {
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
  readTrackerItems,
} from "../tracker-projection.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "tracker-cleanup-survival-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, DomainJsonValue>;
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
    return {
      events: [{ ...event(), destinations: ["test"] }],
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
  milestoneId: string,
): void {
  executeAtFence(operationType, idempotencyKey, () => {}, () => ({
    eventType,
    entityType: "milestone",
    entityId: milestoneId,
    payload: { overallVerdict },
  }));
}

function recordPassingCertify(milestoneId: string): void {
  recordVerdict(
    "milestone.certify.recorded",
    "milestone.certify",
    `fixture/tracker-survival/certify/${milestoneId}`,
    "pass",
    milestoneId,
  );
}

function recordPassingAudit(milestoneId: string): void {
  recordVerdict(
    "milestone.audit.recorded",
    "milestone.audit",
    `fixture/tracker-survival/audit/${milestoneId}`,
    "pass",
    milestoneId,
  );
}

/** Copied verbatim (renamed idempotency keys only) from
 * `milestone-archive-projection.test.ts`'s `makeShippableMilestone` — the
 * ready->completed two-step lifecycle adoption is load-bearing because the
 * causal-provenance trigger requires `last_project_revision` to strictly
 * advance across an UPDATE (15-01 precedent). Requirements are NOT
 * milestone-scoped in the schema, so each milestone needs its own
 * requirement id. */
function makeShippableMilestone(milestoneId: string): void {
  const sliceId = "S01";
  const taskId = "T01";
  const requirementId = `REQ-${milestoneId}`;

  insertMilestone({
    id: milestoneId,
    title: "Tracker cleanup survival ship stage",
    status: "active",
  });
  insertSlice({
    id: sliceId,
    milestoneId,
    title: "Slice one",
    status: "complete",
  });
  insertTask({ id: taskId, sliceId, milestoneId, status: "complete" });
  insertRequirement({
    id: requirementId,
    class: "must",
    status: "active",
    description: "Ship works end to end.",
    why: "Proves the gate.",
    source: "test",
    primary_owner: sliceId,
    supporting_slices: sliceId,
    validation: "test",
    notes: "",
    full_content: requirementId,
    superseded_by: null,
  });

  executeAtFence(
    "test.ship.fixture",
    `fixture/tracker-survival/ready/${milestoneId}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone", milestoneId, lifecycleStatus: "ready",
      });
    },
    () => ({
      eventType: "test.ship.fixture",
      entityType: "milestone",
      entityId: milestoneId,
      payload: {},
    }),
  );

  executeAtFence(
    "milestone.complete",
    `fixture/tracker-survival/complete/${milestoneId}`,
    (context) => {
      adoptOrTransitionLifecycle(context, {
        itemKind: "milestone", milestoneId, lifecycleStatus: "completed",
      });
      db().prepare(`
        UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = :id
      `).run({ ":completed_at": "2026-09-24T00:00:00.000Z", ":id": milestoneId });
    },
    () => ({
      eventType: "milestone.complete",
      entityType: "milestone",
      entityId: milestoneId,
      payload: {},
    }),
  );
}

function shipInput(milestoneId: string, idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId };
}

const PHASE_DIR_NAME = "17-per-project-tracker-foundation";

function makeBase(): { basePath: string; dbPath: string; phaseDirPath: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-cleanup-survival-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);

  const phaseDirPath = join(basePath, ".planning", "phases", PHASE_DIR_NAME);
  mkdirSync(phaseDirPath, { recursive: true });
  writeFileSync(join(phaseDirPath, "17-03-PLAN.md"), "# placeholder phase artifact\n", "utf-8");
  // Assert against the literal phase directory name (not just the constant)
  // so the back-reference below genuinely names a real, on-disk
  // "17-per-project-tracker-foundation" phase directory that the test then
  // deletes -- not an arbitrary placeholder string.
  assert.ok(phaseDirPath.endsWith("17-per-project-tracker-foundation"));

  return { basePath, dbPath, phaseDirPath };
}

afterEach(() => {
  try {
    closeDatabase();
  } catch {
    // already closed by the test body
  }
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Test 1: the literal Success Criterion ───────────────────────────────

test("an incident filed with a phase back-reference survives ship, phase-directory deletion, and a DB close/reopen", async () => {
  const { basePath, dbPath, phaseDirPath } = makeBase();

  makeShippableMilestone("M001");

  const { trackId } = createTrackerItem({
    type: "incident",
    title: "harness defect found during M001",
    severity: "HIGH",
    refs: [
      { refKind: "phase", refValue: PHASE_DIR_NAME },
      { refKind: "requirement", refValue: "TRACK-01" },
    ],
  }, basePath);

  recordPassingCertify("M001");
  recordPassingAudit("M001");

  const receipt = shipMilestone(shipInput("M001", "fixture/tracker-survival/ship/M001"));
  assert.equal(receipt.legacyStatus, "shipped");

  const renderResult = await rebuildMarkdownProjectionsFromDb(basePath);
  assert.deepEqual(renderResult.errors, []);

  assert.equal(existsSync(phaseDirPath), true);
  rmSync(phaseDirPath, { recursive: true, force: true });
  assert.equal(existsSync(phaseDirPath), false, "the phase directory must genuinely be gone");

  closeDatabase();
  assert.equal(openDatabase(dbPath), true, "reopen through a FRESH handle, not the one that wrote the row");

  const row = db().prepare(
    `SELECT status, severity FROM tracker_items WHERE id = :id`,
  ).get({ ":id": trackId }) as Record<string, unknown> | undefined;
  assert.ok(row, "the tracker row must still be present after ship + phase deletion + reopen");
  assert.equal(row!.status, "open");
  assert.equal(row!.severity, "HIGH");

  const rows = readTrackerItems();
  const rehydrated = rows.find((r) => r.id === trackId);
  assert.ok(rehydrated, "readTrackerItems() must still resolve the row through the fresh handle");
  const refPairs = rehydrated!.refs.map((ref) => `${ref.refKind}:${ref.refValue}`).sort();
  assert.deepEqual(refPairs, [`phase:${PHASE_DIR_NAME}`, "requirement:TRACK-01"].sort());

  const incidentsContent = readFileSync(join(basePath, ".gsd", TRACKER_INCIDENTS_PROJECTION_FILENAME), "utf-8");
  assert.ok(incidentsContent.includes(trackId), ".gsd/INCIDENTS.md must still contain the id after the full render sweep");
});

// ─── Test 2: cleanup cannot delete, only restatus ─────────────────────────

test("cleanup-shaped DELETE is refused after the milestone is shipped and the phase directory is gone; only status can change", async () => {
  const { basePath, phaseDirPath } = makeBase();
  makeShippableMilestone("M001");

  const { trackId } = createTrackerItem({
    type: "incident",
    title: "cleanup cannot delete this",
    severity: "MEDIUM",
    refs: [{ refKind: "phase", refValue: PHASE_DIR_NAME }],
  }, basePath);

  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "fixture/tracker-survival/ship-2/M001"));
  await rebuildMarkdownProjectionsFromDb(basePath);
  rmSync(phaseDirPath, { recursive: true, force: true });

  assert.throws(
    () => db().prepare(`DELETE FROM tracker_items WHERE id = :id`).run({ ":id": trackId }),
    /tracker items are durable history/,
  );
  const stillPresent = db().prepare(`SELECT id FROM tracker_items WHERE id = :id`).get({ ":id": trackId });
  assert.ok(stillPresent, "the row must still be present after the refused DELETE");

  const now = new Date().toISOString();
  assert.doesNotThrow(() =>
    db().prepare(
      `UPDATE tracker_items SET status = 'closed', resolved_at = :resolved_at, updated_at = :updated_at WHERE id = :id`,
    ).run({ ":resolved_at": now, ":updated_at": now, ":id": trackId }));
  const closedRow = db().prepare(`SELECT status FROM tracker_items WHERE id = :id`).get({ ":id": trackId }) as Record<string, unknown>;
  assert.equal(closedRow.status, "closed");
});

// ─── Test 3: refs survive a deleted sibling reference target ─────────────

test("a track_item ref survives its target moving to a terminal status; nothing cascades", () => {
  const { basePath } = makeBase();
  makeShippableMilestone("M001");

  const first = createTrackerItem({
    type: "incident",
    title: "the original incident",
    severity: "HIGH",
  }, basePath);
  const second = createTrackerItem({
    type: "backlog",
    title: "a sibling item that references the first",
    refs: [{ refKind: "track_item", refValue: first.trackId }],
  }, basePath);

  db().prepare(
    `UPDATE tracker_items SET status = 'closed', resolved_at = :now WHERE id = :id`,
  ).run({ ":now": new Date().toISOString(), ":id": first.trackId });

  const rows = readTrackerItems();
  const secondRow = rows.find((r) => r.id === second.trackId);
  assert.ok(secondRow);
  assert.deepEqual(
    secondRow!.refs.map((ref) => `${ref.refKind}:${ref.refValue}`),
    [`track_item:${first.trackId}`],
  );
  const firstRow = rows.find((r) => r.id === first.trackId);
  assert.ok(firstRow);
  assert.equal(firstRow!.status, "closed", "the referenced item itself moved to closed, nothing cascaded onto it beyond that");
});

// ─── Test 4: a second milestone's archive does not disturb the first's rows ─

test("a second milestone's ship/archive does not disturb the first milestone-era tracker row or its refs", async () => {
  const { basePath, phaseDirPath } = makeBase();
  makeShippableMilestone("M001");

  const { trackId } = createTrackerItem({
    type: "incident",
    title: "M001-era incident",
    severity: "HIGH",
    refs: [{ refKind: "phase", refValue: PHASE_DIR_NAME }],
  }, basePath);

  recordPassingCertify("M001");
  recordPassingAudit("M001");
  shipMilestone(shipInput("M001", "fixture/tracker-survival/ship-m001/M001"));
  await rebuildMarkdownProjectionsFromDb(basePath);
  rmSync(phaseDirPath, { recursive: true, force: true });

  const before = db().prepare(`SELECT status, severity, title FROM tracker_items WHERE id = :id`).get({ ":id": trackId });
  const refsBefore = readTrackerItems().find((r) => r.id === trackId)!.refs
    .map((ref) => `${ref.refKind}:${ref.refValue}`).sort();

  makeShippableMilestone("M002");
  recordPassingCertify("M002");
  recordPassingAudit("M002");
  shipMilestone(shipInput("M002", "fixture/tracker-survival/ship-m002/M002"));
  await rebuildMarkdownProjectionsFromDb(basePath);

  const after = db().prepare(`SELECT status, severity, title FROM tracker_items WHERE id = :id`).get({ ":id": trackId });
  const refsAfter = readTrackerItems().find((r) => r.id === trackId)!.refs
    .map((ref) => `${ref.refKind}:${ref.refValue}`).sort();

  assert.deepEqual(after, before, "the M001-era row must be byte-identical to its pre-M002 values");
  assert.deepEqual(refsAfter, refsBefore, "the M001-era refs must be byte-identical to their pre-M002 values");
});
