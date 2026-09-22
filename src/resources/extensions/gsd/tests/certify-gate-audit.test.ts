// Project/App: gsd-pi
// File Purpose: Proves certify derives every slice's gaps deterministically
// from four durable DB sources only — quality_gates, rework_briefs,
// human_uat_pending, slice_dependencies — never the filesystem, and never
// silently treats a missing Gate-1 record as a pass (14-02-PLAN.md Task 2,
// RESEARCH Anti-pattern 3, T-14-10).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExecutionInvocation } from "../execution-invocation.ts";
import { getOwnerTurn } from "../gate-registry.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { auditMilestoneSliceGates, certifyGapId } from "../milestone-certify-audit.ts";
import { registerGate2HumanUatPending } from "../milestone-gate2-human-uat-domain-operation.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "certify-gate-audit-test",
  };
}

/**
 * Deliberately does NOT create the `.gsd/milestones/<id>` CONTEXT directory
 * every other fixture in this repo creates for lifecycle-adoption purposes —
 * `auditMilestoneSliceGates` reads only the database, never the filesystem
 * (Test 10).
 */
function openFixture(): { projectId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-certify-gate-audit-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  const dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Certify audit", status: "active" });
  const projectId = readDomainOperationFence().projectId;
  return { projectId };
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a slice with a pending quality_gates row yields one fixable gate-pending gap", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.gapClass, "gate-pending");
  assert.equal(gaps[0]!.fixable, true);
  assert.equal(gaps[0]!.gateId, "Q8");
  assert.equal(gaps[0]!.ownerTurn, getOwnerTurn("Q8"));
});

test("a slice with a complete/flag quality_gates row yields one fixable gate-flagged gap", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, findings, evaluated_at)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'complete', 'flag', 'stale evidence', '2026-09-22T00:00:00.000Z')
  `).run();

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.gapClass, "gate-flagged");
  assert.equal(gaps[0]!.fixable, true);
});

test("certify's own CERT01/CERT02 rows never feed back in as gate-pending/gate-flagged gaps", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
    VALUES ('M001', 'S01', 'CERT01', 'slice', '', 'complete', 'flag', '2026-09-22T00:00:00.000Z')
  `).run();
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'CERT02', 'slice', '', 'pending')
  `).run();

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.equal(gaps.length, 0);
});

test("a terminal slice with no rework briefs, no human_uat_pending, and no evaluated CERT01 row yields one non-fixable gate1-record-missing gap", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.equal(gaps.length, 1);
  assert.equal(gaps[0]!.gapClass, "gate1-record-missing");
  assert.equal(gaps[0]!.fixable, false);
  assert.equal(gaps[0]!.gateId, "CERT01");
});

test("a terminal slice with any one durable Gate-1 signal present yields no gate1-record-missing gap", () => {
  // Signal 1: a gap-closure rework brief.
  {
    const { projectId } = openFixture();
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    db().prepare(`
      INSERT INTO rework_briefs (id, milestone_id, slice_id, task_id, created_at, updated_at)
      VALUES ('RB-M001-S01-T01-gap-1', 'M001', 'S01', 'T01', '2026-09-22T00:00:00.000Z', '2026-09-22T00:00:00.000Z')
    `).run();
    const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
    assert.equal(gaps.some((g) => g.gapClass === "gate1-record-missing"), false);
    closeDatabase();
  }
  // Signal 2: a Gate-2 human_uat_pending entry.
  {
    const { projectId } = openFixture();
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    registerGate2HumanUatPending({
      invocation: invocation("fixture/human-uat/S01"),
      milestoneId: "M001",
      sliceId: "S01",
      reason: "fixture partial",
      partialCriteria: [{ criterion: "c", evidence: "e" }],
    });
    const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
    assert.equal(gaps.some((g) => g.gapClass === "gate1-record-missing"), false);
    closeDatabase();
  }
  // Signal 3: a prior evaluated CERT01 quality_gates row.
  {
    const { projectId } = openFixture();
    insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
    db().prepare(`
      INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
      VALUES ('M001', 'S01', 'CERT01', 'slice', '', 'complete', 'pass', '2026-09-22T00:00:00.000Z')
    `).run();
    const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
    assert.equal(gaps.some((g) => g.gapClass === "gate1-record-missing"), false);
  }
});

test("a terminal slice depending on a non-terminal slice yields one integration-gap", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S01', 'S02')
  `).run();

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  const integrationGaps = gaps.filter((g) => g.gapClass === "integration-gap");
  assert.equal(integrationGaps.length, 1);
  assert.equal(integrationGaps[0]!.fixable, false);
  assert.equal(integrationGaps[0]!.sliceId, "S01");
});

test("a slice_dependencies row pointing at a slice id absent from the milestone yields one integration-gap", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  // The production schema's FK ties depends_on_slice_id to an existing
  // (milestone_id, id) slice row — a genuinely absent target can only arise
  // from data drift (e.g. a partially-repaired import), so the fixture
  // toggles FK enforcement off for this one insert to reproduce that state.
  db().exec("PRAGMA foreign_keys = OFF");
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S01', 'MISSING-SLICE')
  `).run();
  db().exec("PRAGMA foreign_keys = ON");

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  const integrationGaps = gaps.filter((g) => g.gapClass === "integration-gap");
  assert.equal(integrationGaps.length, 1);
  assert.equal(integrationGaps[0]!.fixable, false);
});

test("a milestone with zero slices returns an empty array and throws nothing", () => {
  const { projectId } = openFixture();
  assert.doesNotThrow(() => {
    const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
    assert.deepEqual(gaps, []);
  });
});

test("gaps are sorted by sliceId then gapId ascending and repeated calls are deep-equal", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S02', 'Q8', 'slice', '', 'pending')
  `).run();
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();

  const first = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  const expected = [
    { gapId: certifyGapId("gate-pending", "S01", "Q8"), sliceId: "S01" },
    { gapId: certifyGapId("gate-pending", "S02", "Q8"), sliceId: "S02" },
  ];
  assert.deepEqual(first.map((g) => ({ gapId: g.gapId, sliceId: g.sliceId })), expected);

  const second = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.deepEqual(second, first);
});

test("certifyGapId is a pure deterministic function of (gapClass, sliceId, gateId)", () => {
  const a1 = certifyGapId("gate-pending", "S01", "CERT01");
  const a2 = certifyGapId("gate-pending", "S01", "CERT01");
  assert.equal(a1, a2);

  const flagged = certifyGapId("gate-flagged", "S01", "CERT01");
  assert.notEqual(a1, flagged);
});

test("auditMilestoneSliceGates reads only the database — no .gsd/milestones directory is required", () => {
  const { projectId } = openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();

  const gaps = auditMilestoneSliceGates({ projectId, milestoneId: "M001" });
  assert.equal(gaps.length, 1);
});
