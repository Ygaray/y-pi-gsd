// Project/App: gsd-pi
// File Purpose: Phase 33 (RELY-05) plan 33-03 — cuts the remaining requirement
// write and read paths over to milestone_id: the two live production save
// paths (db-writer.ts), the worktree reconcile merge, the state-manifest
// backup/restore round-trip, and the generic legacy-import Application's
// identity/allowlist. Proves Pitfalls NEW-3 (non-deterministic bare-id read),
// NEW-4 (reconcile cross-milestone bleed), NEW-5 (legacy-import identity),
// and NEW-8 (deleteRequirementById scoping) are closed, while NEW-6
// (project-wide reads stay project-wide) is left untouched.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  SCHEMA_VERSION,
  _getAdapter,
  closeDatabase,
  copyWorktreeDb,
  deleteRequirementById,
  getRequirementById,
  insertMilestone,
  insertRequirement,
  openDatabase,
  reconcileWorktreeDb,
  restoreManifest,
  upsertRequirement,
} from "../gsd-db.ts";
import { saveRequirementToDb, updateRequirementInDb } from "../db-writer.ts";
import { snapshotState } from "../workflow-manifest.ts";
import type { DomainOperationContext, ImportDomainOperationRequest } from "../db/domain-operation.ts";
import { executeImportDomainOperation } from "../db/domain-operation.ts";
import { readDomainOperationFence } from "../db/writers/lifecycle-commands.ts";
import { applyLegacyImportApplicationPlan } from "../db/writers/legacy-import-application.ts";
import { LegacyImportApplicationError } from "../legacy-import-application-error.ts";
import type {
  LegacyImportApplicationPlan,
  LegacyImportApplicationPlanInstruction,
} from "../legacy-import-application-plan.ts";
import {
  canonicalLegacyImportJson,
  hashLegacyImportValue,
  sealLegacyImportPreview,
  type LegacyImportPreviewArtifact,
} from "../legacy-import-preview.ts";

// ─── Shared fixture plumbing ────────────────────────────────────────────────

const tempDirs = new Set<string>();
const ORIGINAL_MILESTONE_LOCK = process.env.GSD_MILESTONE_LOCK;

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  if (ORIGINAL_MILESTONE_LOCK === undefined) delete process.env.GSD_MILESTONE_LOCK;
  else process.env.GSD_MILESTONE_LOCK = ORIGINAL_MILESTONE_LOCK;
});

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string, params: Record<string, unknown> = {}): Record<string, unknown> {
  return db().prepare(sql).get(params) ?? {};
}

function rows(sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return db().prepare(sql).all(params);
}

/** A basePath with a real .gsd/ tree, mirroring requirement-milestone-attribution.test.ts's makeBasePath. */
function makeBasePath(...milestoneIds: string[]): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-requirement-milestone-write-paths-"));
  tempDirs.add(basePath);
  for (const milestoneId of milestoneIds) {
    mkdirSync(join(basePath, ".gsd", "milestones", milestoneId), { recursive: true });
  }
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function freshDbPath(prefix = "gsd-requirement-milestone-write-paths-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

// ═══════════════════════════════════════════════════════════════════════════
// Task 1: Live save paths resolve the active milestone; bare-id reads
// become deterministic (D-03, D-01)
// ═══════════════════════════════════════════════════════════════════════════

// Test 1 (SC-1, D-03): saveRequirementToDb against a project with an active
// milestone reads back carrying that milestone's id.
test("saveRequirementToDb attributes a new requirement to the active milestone", async () => {
  const basePath = makeBasePath("M-A");
  insertMilestone({ id: "M-A", title: "Milestone A", status: "active" });

  const { id } = await saveRequirementToDb({
    class: "functional",
    description: "Must persist notes",
    why: "Core feature",
    source: "user",
  }, basePath);

  const found = getRequirementById(id, "M-A");
  assert.ok(found, "requirement should be readable under the active milestone");
  assert.equal(found!.milestone_id, "M-A");
});

// Test 2 (D-03's lock awareness): with GSD_MILESTONE_LOCK set to a milestone
// the DB alone would not pick, saveRequirementToDb attributes to the locked
// milestone. This is the entire reason D-03 names the async resolver over
// the synchronous database-only one.
test("saveRequirementToDb attributes to the locked milestone, not the DB's own default pick", async () => {
  const basePath = makeBasePath("M-FIRST", "M-LOCKED");
  // M-FIRST is inserted first and would be getActiveMilestoneIdFromDb's pick
  // (first non-terminal milestone in queue order); the lock overrides that.
  insertMilestone({ id: "M-FIRST", title: "Milestone First", status: "active" });
  insertMilestone({ id: "M-LOCKED", title: "Milestone Locked", status: "active" });

  process.env.GSD_MILESTONE_LOCK = "M-LOCKED";
  try {
    const { id } = await saveRequirementToDb({
      class: "functional",
      description: "Locked attribution",
      why: "Parallel worker correctness",
      source: "user",
    }, basePath);

    const lockedRow = getRequirementById(id, "M-LOCKED");
    assert.ok(lockedRow, "requirement should be attributed to the locked milestone");
    const firstRow = getRequirementById(id, "M-FIRST");
    assert.equal(firstRow, null, "requirement must not land under the DB's own default pick");
  } finally {
    delete process.env.GSD_MILESTONE_LOCK;
  }
});

// Test 3 (no active milestone): with no non-terminal milestone present,
// saveRequirementToDb completes and stores a null milestone_id rather than
// throwing or inventing one.
test("saveRequirementToDb stores a null milestone_id when no milestone is active", async () => {
  const basePath = makeBasePath("M-DONE");
  insertMilestone({ id: "M-DONE", title: "Already shipped", status: "complete" });

  const { id } = await saveRequirementToDb({
    class: "functional",
    description: "No active milestone",
    why: "Fallback path",
    source: "user",
  }, basePath);

  const found = getRequirementById(id, null);
  assert.ok(found, "requirement should be readable under the null-milestone fallback");
  assert.equal(found!.milestone_id, null);
});

// Test 3b (CR-01/WR-02 regression): two CONCURRENTLY ACTIVE milestones (not
// one active + one terminal) each save a requirement with the exact same
// description. Before CR-01's scoping fix, saveRequirementToDb's duplicate
// lookup matched globally, so the second save would silently reuse the
// first milestone's row id and inherit its primary_owner/supporting_slices
// fallback values. After the fix, the second save must mint its own,
// distinct id under its own milestone, and must not inherit any field from
// the other milestone's row.
test("saveRequirementToDb does not cross-attribute a description collision between two concurrently active milestones", async () => {
  const basePath = makeBasePath("M-ONE", "M-TWO");
  insertMilestone({ id: "M-ONE", title: "Milestone One", status: "active" });
  insertMilestone({ id: "M-TWO", title: "Milestone Two", status: "active" });

  process.env.GSD_MILESTONE_LOCK = "M-ONE";
  const first = await saveRequirementToDb({
    class: "functional",
    description: "Shared description across milestones",
    why: "First milestone's reason",
    source: "user",
    primary_owner: "S01",
    supporting_slices: "S01",
  }, basePath);

  process.env.GSD_MILESTONE_LOCK = "M-TWO";
  const second = await saveRequirementToDb({
    class: "functional",
    description: "Shared description across milestones",
    why: "Second milestone's own, different reason",
    source: "user",
    // Deliberately omit primary_owner/supporting_slices so the stale-fallback
    // path (WR-02) would kick in if CR-01's scoping regressed.
  }, basePath);

  assert.notEqual(second.id, first.id, "the two milestones' requirements must not collapse onto the same row");

  const firstRow = getRequirementById(first.id, "M-ONE");
  const secondRow = getRequirementById(second.id, "M-TWO");
  assert.ok(firstRow, "milestone one's requirement should still exist under its own milestone");
  assert.ok(secondRow, "milestone two's requirement should exist under its own milestone");
  assert.equal(firstRow!.milestone_id, "M-ONE");
  assert.equal(secondRow!.milestone_id, "M-TWO");
  assert.equal(secondRow!.why, "Second milestone's own, different reason");
  // The omitted fields on the second save must NOT have inherited milestone
  // one's values — they should fall back to the field's own default, not a
  // stale cross-milestone value.
  assert.equal(secondRow!.primary_owner, "", "must not inherit primary_owner from the other milestone's row");
  assert.equal(secondRow!.supporting_slices, "", "must not inherit supporting_slices from the other milestone's row");

  // Milestone one's row must be completely untouched by the second save.
  assert.equal(firstRow!.primary_owner, "S01");
  assert.equal(firstRow!.supporting_slices, "S01");
});

// Test 4 (Pitfall NEW-3): two milestones hold a requirement with the same id
// and different descriptions. updateRequirementInDb under the active
// milestone modifies only that milestone's row; the other milestone's row is
// byte-identical afterwards. Run the update twice and assert the same row is
// hit both times.
test("updateRequirementInDb modifies only the active milestone's row, repeatably", async () => {
  const basePath = makeBasePath("M-A", "M-B");
  insertMilestone({ id: "M-A", title: "Milestone A", status: "active" });
  // M-B is closed so getActiveMilestoneId deterministically resolves to M-A.
  insertMilestone({ id: "M-B", title: "Milestone B", status: "complete" });

  insertRequirement({
    id: "DUP-01", class: "functional", status: "active",
    description: "M-A description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  insertRequirement({
    id: "DUP-01", class: "functional", status: "active",
    description: "M-B description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });

  await updateRequirementInDb("DUP-01", { status: "validated" }, basePath);

  const mA1 = getRequirementById("DUP-01", "M-A");
  assert.equal(mA1?.status, "validated", "M-A's row is updated");
  const mB1 = getRequirementById("DUP-01", "M-B");
  assert.equal(mB1?.description, "M-B description", "M-B's row is untouched");
  assert.equal(mB1?.status, "active", "M-B's row status is untouched");

  await updateRequirementInDb("DUP-01", { notes: "second pass" }, basePath);

  const mA2 = getRequirementById("DUP-01", "M-A");
  assert.equal(mA2?.status, "validated", "M-A's row retains the first update");
  assert.equal(mA2?.notes, "second pass", "M-A's row is hit again by the second update");
  const mB2 = getRequirementById("DUP-01", "M-B");
  assert.deepEqual(mB2, mB1, "M-B's row is byte-identical across both updates");
});

// Test 5: getRequirementById called with a milestone argument returns that
// milestone's row; called for a milestone with no such row it returns null
// even though another milestone has one.
test("getRequirementById is milestone-scoped, not merely id-scoped", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);

  insertRequirement({
    id: "SCOPED-01", class: "functional", status: "active",
    description: "M-A row", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });

  const found = getRequirementById("SCOPED-01", "M-A");
  assert.equal(found?.description, "M-A row");

  const missing = getRequirementById("SCOPED-01", "M-C");
  assert.equal(missing, null, "a milestone with no such row returns null, not M-A's row");
});

// Test 6 (Pitfall NEW-8): deleteRequirementById with a milestone argument
// deletes only that milestone's row and leaves the other milestone's row
// present.
test("deleteRequirementById scoped by milestone deletes only that milestone's row", () => {
  const dbPath = freshDbPath();
  assert.equal(openDatabase(dbPath), true);

  insertRequirement({
    id: "DEL-01", class: "functional", status: "active",
    description: "M-A row", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  insertRequirement({
    id: "DEL-01", class: "functional", status: "active",
    description: "M-B row", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });

  deleteRequirementById("DEL-01", "M-A");

  assert.equal(getRequirementById("DEL-01", "M-A"), null, "M-A's row is deleted");
  assert.equal(getRequirementById("DEL-01", "M-B")?.description, "M-B row", "M-B's row survives");
});

// ═══════════════════════════════════════════════════════════════════════════
// Task 2: Reconcile and manifest-restore carry the composite key (D-01, D-02)
// ═══════════════════════════════════════════════════════════════════════════

function seedWorktreePair(): { mainDb: string; wtDb: string } {
  const mainDir = mkdtempSync(join(tmpdir(), "gsd-requirement-reconcile-main-"));
  const wtDir = mkdtempSync(join(tmpdir(), "gsd-requirement-reconcile-wt-"));
  tempDirs.add(mainDir);
  tempDirs.add(wtDir);
  return { mainDb: join(mainDir, "gsd.db"), wtDb: join(wtDir, "gsd.db") };
}

// Test 7 (Pitfall NEW-4, false conflict): a main database and a worktree
// database each hold a requirement with the same id under DIFFERENT
// milestones, neither edited relative to the other. The reconcile conflict
// check reports no conflict between them — today's bare-id join reports one.
test("reconcile reports no conflict when two milestones share a requirement id", () => {
  const { mainDb, wtDb } = seedWorktreePair();

  assert.equal(openDatabase(mainDb), true);
  insertRequirement({
    id: "SHARED-01", class: "functional", status: "active",
    description: "M-A description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  assert.equal(openDatabase(wtDb), true);
  db().prepare("DELETE FROM requirements WHERE id = 'SHARED-01'").run();
  insertRequirement({
    id: "SHARED-01", class: "functional", status: "active",
    description: "M-B description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.deepEqual(
    result.conflicts.filter((c) => c.includes("SHARED-01")),
    [],
    "two different milestones sharing an id must not report a conflict",
  );
});

// Test 8 (Pitfall NEW-4, genuine conflict still detected): the same id under
// the SAME milestone, edited on both sides, is still reported as a conflict.
test("reconcile still reports a genuine same-milestone conflict", () => {
  const { mainDb, wtDb } = seedWorktreePair();

  assert.equal(openDatabase(mainDb), true);
  insertRequirement({
    id: "CONFLICT-01", class: "functional", status: "active",
    description: "original", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  assert.equal(openDatabase(mainDb), true);
  db().prepare("UPDATE requirements SET description = 'main edit' WHERE id = 'CONFLICT-01'").run();
  closeDatabase();

  assert.equal(openDatabase(wtDb), true);
  db().prepare("UPDATE requirements SET description = 'worktree edit' WHERE id = 'CONFLICT-01'").run();
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  assert.ok(
    result.conflicts.some((c) => c.includes("CONFLICT-01")),
    "a same-milestone edit on both sides must still be reported as a conflict",
  );
});

// Test 9 (Pitfall NEW-4, merge): a worktree merge of a requirement carries
// its milestone_id into the main database and does not overwrite a same-id
// row belonging to a different milestone.
test("reconcile merge carries milestone_id and does not overwrite a different milestone's row", () => {
  const { mainDb, wtDb } = seedWorktreePair();

  assert.equal(openDatabase(mainDb), true);
  insertRequirement({
    id: "MERGE-01", class: "functional", status: "active",
    description: "M-A description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  closeDatabase();
  copyWorktreeDb(mainDb, wtDb);

  assert.equal(openDatabase(wtDb), true);
  insertRequirement({
    id: "MERGE-01", class: "functional", status: "active",
    description: "M-B description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-B",
  });
  closeDatabase();

  assert.equal(openDatabase(mainDb), true);
  reconcileWorktreeDb(mainDb, wtDb);

  const merged = rows("SELECT milestone_id, description FROM requirements WHERE id = 'MERGE-01' ORDER BY milestone_id");
  assert.equal(merged.length, 2, "both milestones' rows coexist after merge");
  assert.equal(merged[0]!["milestone_id"], "M-A");
  assert.equal(merged[0]!["description"], "M-A description", "M-A's row is untouched by the merge");
  assert.equal(merged[1]!["milestone_id"], "M-B");
  assert.equal(merged[1]!["description"], "M-B description", "M-B's row is carried in from the worktree");
});

// Test 10 (legacy rows): two legacy rows with null milestone_id and the same
// id, one per side, still compare as the same row. A null-unaware equality
// comparison (`=` instead of `IS`) never matches NULL to NULL, so the
// conflict-detection JOIN would silently skip them entirely and the merge
// would insert a second row alongside the first, duplicating it.
test("reconcile treats two legacy null-milestone rows sharing an id as the same row, not a duplicate", () => {
  const { mainDb, wtDb } = seedWorktreePair();

  assert.equal(openDatabase(mainDb), true);
  insertRequirement({
    id: "LEGACY-01", class: "functional", status: "active",
    description: "legacy description", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null,
  });
  closeDatabase();
  // Worktree carries the exact same, unedited legacy row — the "one per
  // side, neither edited relative to the other" case the plan describes.
  copyWorktreeDb(mainDb, wtDb);

  assert.equal(openDatabase(mainDb), true);
  const result = reconcileWorktreeDb(mainDb, wtDb);

  const legacyRows = rows("SELECT milestone_id, description FROM requirements WHERE id = 'LEGACY-01'");
  assert.equal(legacyRows.length, 1, "the two legacy rows must not duplicate");
  assert.equal(legacyRows[0]!["milestone_id"], null);
  assert.deepEqual(
    result.conflicts.filter((c) => c.includes("LEGACY-01")),
    [],
    "two identical legacy rows must not report as modified in both",
  );
});

// Test 11 (Assumption A1, now verified): a state manifest captured from a
// database holding requirements with milestone ids, then restored into an
// empty database, reproduces every milestone_id exactly.
test("a manifest backup and restore round-trips milestone_id exactly", () => {
  const sourcePath = freshDbPath("gsd-requirement-manifest-source-");
  assert.equal(openDatabase(sourcePath), true);

  insertMilestone({ id: "M-A", title: "Milestone A", status: "active" });
  insertRequirement({
    id: "MANIFEST-01", class: "functional", status: "active",
    description: "Carries milestone_id", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null, milestone_id: "M-A",
  });
  insertRequirement({
    id: "MANIFEST-02", class: "functional", status: "active",
    description: "Legacy null row", why: "", source: "test",
    primary_owner: "", supporting_slices: "", validation: "", notes: "",
    full_content: "", superseded_by: null,
  });

  const manifest = snapshotState();
  closeDatabase();

  const destPath = freshDbPath("gsd-requirement-manifest-dest-");
  assert.equal(openDatabase(destPath), true);
  restoreManifest(manifest);

  const restored = rows("SELECT id, milestone_id FROM requirements ORDER BY id");
  assert.deepEqual(restored, [
    { id: "MANIFEST-01", milestone_id: "M-A" },
    { id: "MANIFEST-02", milestone_id: null },
  ]);
});

// ═══════════════════════════════════════════════════════════════════════════
// Task 3: Widen the legacy-import identity without loosening its validation
// (D-01)
// ═══════════════════════════════════════════════════════════════════════════

let importSequence = 0;

/**
 * A new preview must be fenced against the project's CURRENT revision/epoch
 * — readDomainOperationFence() (each call in this file targets the same,
 * already-open DB), not a hardcoded 0. Sequential applyImport calls within
 * one test advance the revision, so a stale fence throws
 * GSD_REVISION_CONFLICT before the writer's own logic ever runs.
 */
function emptyPreview(): LegacyImportPreviewArtifact {
  const fence = readDomainOperationFence();
  const emptyHash = hashLegacyImportValue([]);
  return sealLegacyImportPreview({
    import_kind: "legacy-markdown",
    importer_version: "1",
    base: {
      snapshot_schema_version: 1,
      database_schema_version: SCHEMA_VERSION,
      authority: {
        singleton: 1,
        project_id: "project-1",
        project_root_realpath: `/tmp/project-1/requirement-milestone-write-paths-${importSequence}`,
        revision: fence.revision,
        authority_epoch: fence.authorityEpoch,
        created_at: "2026-09-28T00:00:00.000Z",
        updated_at: "2026-09-28T00:00:00.000Z",
      },
      rows: [],
      relevant_rows_hash: emptyHash,
    },
    source_set_hash: emptyHash,
    change_set_hash: emptyHash,
    counts: { create: 0, update: 0, delete: 0, preserve: 0, unparsed: 0, unresolved: 0 },
    sources: [],
    changes: [],
    diagnoses: [],
    resolutions: [],
  });
}

function deepFreeze<T>(value: T, seen = new Set<object>()): T {
  if (value === null || typeof value !== "object" || seen.has(value)) return value;
  seen.add(value);
  for (const child of Object.values(value)) deepFreeze(child, seen);
  return Object.freeze(value);
}

function rowInstruction(
  action: "create" | "update" | "delete",
  targetKey: string,
  identity: Record<string, null | number | string>,
  values: Record<string, null | number | string>,
  changeId: string,
): LegacyImportApplicationPlanInstruction {
  return {
    action, targetKind: "requirement", targetKey, rowSet: "requirements",
    identity, values, changeIds: [changeId],
  };
}

function planFor(
  artifact: LegacyImportPreviewArtifact,
  instructions: readonly LegacyImportApplicationPlanInstruction[],
): LegacyImportApplicationPlan {
  const mutationCounts = {
    create: instructions.filter((entry) => entry.action === "create").length,
    update: instructions.filter((entry) => entry.action === "update").length,
    delete: instructions.filter((entry) => entry.action === "delete").length,
    replaceSliceDependencies: 0,
    deleteSliceDependencies: 0,
    adoptLifecycle: 0,
    seedQualityGate: 0,
  };
  const changeIds = instructions.flatMap((entry) => [...entry.changeIds]);
  const receiptCounts = { ...artifact.preview.counts };
  const plan: LegacyImportApplicationPlan = {
    planSchemaVersion: 2,
    previewId: artifact.preview.preview_id,
    previewHash: artifact.preview_hash,
    baseProjectRevision: artifact.preview.base_project_revision,
    baseAuthorityEpoch: artifact.preview.base_authority_epoch,
    receiptCounts,
    instructions: structuredClone(instructions),
    accounting: {
      sourceIds: [], diagnosisIds: [], resolutionIds: [], changeIds,
      preserveChangeIds: [], unparsedSourceIds: [],
    },
    mutationCounts,
    affectedTargets: instructions.map((entry) => ({ targetKind: entry.targetKind, targetKey: entry.targetKey })),
    eventFacts: {
      previewId: artifact.preview.preview_id,
      previewHash: artifact.preview_hash,
      sourceSetHash: artifact.preview.source_set_hash,
      changeSetHash: artifact.preview.change_set_hash,
      receiptCounts,
      mutationCounts,
      affectedTargetHashes: [],
      sourceCount: 0,
      diagnosisCount: 0,
      resolutionCount: 0,
      preserveCount: receiptCounts.preserve,
      unparsedCount: receiptCounts.unparsed,
    },
    projectionKeys: [`legacy-import/${artifact.preview.preview_id}`],
  };
  return deepFreeze(structuredClone(plan));
}

function importRequest(artifact: LegacyImportPreviewArtifact): ImportDomainOperationRequest {
  importSequence += 1;
  return {
    operationType: "import.apply",
    idempotencyKey: `legacy-import/requirement-write-paths-${importSequence}`,
    expectedRevision: artifact.preview.base_project_revision,
    expectedAuthorityEpoch: artifact.preview.base_authority_epoch,
    actorType: "agent",
    actorId: "requirement-milestone-write-paths-test",
    sourceTransport: "internal",
    traceId: `trace-${importSequence}`,
    turnId: `turn-${importSequence}`,
    payload: artifact,
  };
}

function insertImportApplication(context: Readonly<DomainOperationContext>, artifact: LegacyImportPreviewArtifact): void {
  const preview = artifact.preview;
  db().prepare(`
    INSERT INTO workflow_import_applications (
      operation_id, project_id, import_kind, importer_version,
      preview_schema_version, preview_id, preview_hash,
      base_project_revision, base_authority_epoch, base_database_schema_version,
      source_set_hash, change_set_hash,
      create_count, update_count, delete_count, preserve_count, unparsed_count, unresolved_count,
      preview_json,
      backup_ref, backup_sha256, backup_byte_size, backup_schema_version,
      backup_project_revision, backup_authority_epoch, backup_quick_check, backup_verified_at,
      applied_at, resulting_project_revision, resulting_authority_epoch
    ) VALUES (
      :operation_id, :project_id, :import_kind, :importer_version,
      :preview_schema_version, :preview_id, :preview_hash,
      :base_project_revision, :base_authority_epoch, :base_database_schema_version,
      :source_set_hash, :change_set_hash,
      :create_count, :update_count, :delete_count, :preserve_count, :unparsed_count, :unresolved_count,
      :preview_json,
      '/tmp/verified-backup.sqlite', :backup_sha256, 1, :backup_schema_version,
      :backup_project_revision, :backup_authority_epoch, 'ok', '2026-09-28T00:00:00.000Z',
      '2026-09-28T00:00:01.000Z', :resulting_project_revision, :resulting_authority_epoch
    )
  `).run({
    ":operation_id": context.operationId,
    ":project_id": context.projectId,
    ":import_kind": preview.import_kind,
    ":importer_version": preview.importer_version,
    ":preview_schema_version": preview.preview_schema_version,
    ":preview_id": preview.preview_id,
    ":preview_hash": artifact.preview_hash,
    ":base_project_revision": preview.base_project_revision,
    ":base_authority_epoch": preview.base_authority_epoch,
    ":base_database_schema_version": preview.base_database_schema_version,
    ":source_set_hash": preview.source_set_hash,
    ":change_set_hash": preview.change_set_hash,
    ":create_count": preview.counts.create,
    ":update_count": preview.counts.update,
    ":delete_count": preview.counts.delete,
    ":preserve_count": preview.counts.preserve,
    ":unparsed_count": preview.counts.unparsed,
    ":unresolved_count": preview.counts.unresolved,
    ":preview_json": canonicalLegacyImportJson(preview),
    ":backup_sha256": `sha256:${"3".repeat(64)}`,
    ":backup_schema_version": preview.base_database_schema_version,
    ":backup_project_revision": preview.base_project_revision,
    ":backup_authority_epoch": preview.base_authority_epoch,
    ":resulting_project_revision": context.resultingRevision,
    ":resulting_authority_epoch": context.resultingAuthorityEpoch,
  });
}

function applyImport(artifact: LegacyImportPreviewArtifact, plan: LegacyImportApplicationPlan): void {
  executeImportDomainOperation(importRequest(artifact), (context) => {
    applyLegacyImportApplicationPlan(context, plan);
    insertImportApplication(context, artifact);
    return {
      events: [{
        eventType: "legacy-import.applied",
        entityType: "legacy-import",
        entityId: plan.previewId,
        payload: { previewId: plan.previewId, previewHash: plan.previewHash },
        destinations: ["projection"],
      }],
      projections: [{
        projectionKey: plan.projectionKeys[0]!,
        projectionKind: "markdown",
        rendererVersion: "v1",
      }],
    };
  });
}

function expectImportFailure(run: () => unknown, message: RegExp): void {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof LegacyImportApplicationError, "must fail with LegacyImportApplicationError");
  assert.match((observed as LegacyImportApplicationError).message, message);
}

/**
 * Unlike expectImportFailure, this does not require a LegacyImportApplicationError.
 * A raw DB-constraint violation (e.g. the idx_requirements_legacy_id partial
 * unique index rejecting a genuine duplicate create) propagates through
 * applyRow's plain INSERT and the domain-operation transaction as-is — it is
 * not wrapped by the writer's own validation layer, unlike a preflight
 * refusal. Both still fail the transaction and roll back; this helper
 * asserts the failure without over-specifying its class.
 */
function expectAnyImportFailure(run: () => unknown, message: RegExp): void {
  let observed: unknown;
  try {
    run();
  } catch (error) {
    observed = error;
  }
  assert.ok(observed instanceof Error, "must fail with an Error");
  assert.match((observed as Error).message, message);
}

// Test 12: an import instruction carrying milestone_id for a requirement is
// accepted and applies the row with that milestone id.
test("legacy import applies a create instruction carrying milestone_id", () => {
  const dbPath = freshDbPath("gsd-legacy-import-requirement-");
  assert.equal(openDatabase(dbPath), true);
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M-A', 'Milestone A', 'active')").run();

  const artifact = emptyPreview();
  applyImport(artifact, planFor(artifact, [
    rowInstruction("create", "M-A/IMPORT-01", { milestone_id: "M-A", id: "IMPORT-01" }, {
      milestone_id: "M-A", id: "IMPORT-01", description: "Imported with a milestone",
    }, "create-with-milestone"),
  ]));

  const created = row("SELECT milestone_id, description FROM requirements WHERE id = 'IMPORT-01'");
  assert.equal(created["milestone_id"], "M-A");
  assert.equal(created["description"], "Imported with a milestone");
});

// Test 13 (the security case, T-33-11): an import instruction naming a field
// that is not in the requirement allowlist is still rejected, with the same
// refusal it produces today. Widening the allowlist must add exactly one
// name, not open it.
test("legacy import still refuses an un-allowlisted requirement field", () => {
  const dbPath = freshDbPath("gsd-legacy-import-requirement-allowlist-");
  assert.equal(openDatabase(dbPath), true);
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M-A', 'Milestone A', 'active')").run();

  const artifact = emptyPreview();
  expectImportFailure(
    () => applyImport(artifact, planFor(artifact, [
      rowInstruction("create", "M-A/IMPORT-02", { milestone_id: "M-A", id: "IMPORT-02" }, {
        milestone_id: "M-A", id: "IMPORT-02", not_a_real_field: "should be refused",
      } as Record<string, string>, "create-bad-field"),
    ])),
    /legacy import values contains unsupported field not_a_real_field/,
  );

  assert.equal(row("SELECT COUNT(*) AS c FROM requirements")["c"], 0, "the refused create must not leave a row behind");
});

// Test 14: two import instructions for the same requirement id under two
// different milestones apply as two rows; a second instruction for the same
// id under the SAME milestone updates the existing row rather than adding
// one. This is the identity change actually taking effect.
test("legacy import applies two milestones' same-id requirements as two rows, and updates in place within one milestone", () => {
  const dbPath = freshDbPath("gsd-legacy-import-requirement-composite-");
  assert.equal(openDatabase(dbPath), true);
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M-A', 'Milestone A', 'active')").run();
  db().prepare("INSERT INTO milestones (id, title, status) VALUES ('M-B', 'Milestone B', 'active')").run();

  const createArtifact = emptyPreview();
  applyImport(createArtifact, planFor(createArtifact, [
    rowInstruction("create", "M-A/DUP-IMPORT", { milestone_id: "M-A", id: "DUP-IMPORT" }, {
      milestone_id: "M-A", id: "DUP-IMPORT", description: "M-A copy",
    }, "create-m-a"),
    rowInstruction("create", "M-B/DUP-IMPORT", { milestone_id: "M-B", id: "DUP-IMPORT" }, {
      milestone_id: "M-B", id: "DUP-IMPORT", description: "M-B copy",
    }, "create-m-b"),
  ]));

  const twoRows = rows("SELECT milestone_id, description FROM requirements WHERE id = 'DUP-IMPORT' ORDER BY milestone_id");
  assert.deepEqual(twoRows, [
    { milestone_id: "M-A", description: "M-A copy" },
    { milestone_id: "M-B", description: "M-B copy" },
  ]);

  const updateArtifact = emptyPreview();
  applyImport(updateArtifact, planFor(updateArtifact, [
    rowInstruction("update", "M-A/DUP-IMPORT", { milestone_id: "M-A", id: "DUP-IMPORT" }, {
      description: "M-A copy, revised",
    }, "update-m-a"),
  ]));

  const afterUpdate = rows("SELECT milestone_id, description FROM requirements WHERE id = 'DUP-IMPORT' ORDER BY milestone_id");
  assert.deepEqual(afterUpdate, [
    { milestone_id: "M-A", description: "M-A copy, revised" },
    { milestone_id: "M-B", description: "M-B copy" },
  ], "the same-milestone instruction updates the existing row rather than adding a third");
});

// Test 15: an import instruction for a requirement that supplies no
// milestone_id still applies, targeting the legacy null-milestone row.
test("legacy import applies a create instruction with no milestone_id to the legacy null row", () => {
  const dbPath = freshDbPath("gsd-legacy-import-requirement-legacy-");
  assert.equal(openDatabase(dbPath), true);

  const artifact = emptyPreview();
  applyImport(artifact, planFor(artifact, [
    rowInstruction("create", "/LEGACY-IMPORT-01", { milestone_id: null, id: "LEGACY-IMPORT-01" }, {
      milestone_id: null, id: "LEGACY-IMPORT-01", description: "Legacy import, no milestone",
    }, "create-legacy"),
  ]));

  const created = row("SELECT milestone_id, description FROM requirements WHERE id = 'LEGACY-IMPORT-01'");
  assert.equal(created["milestone_id"], null);
  assert.equal(created["description"], "Legacy import, no milestone");

  // A second create with the same id and the SAME (null) milestone must be
  // rejected as a duplicate, not silently coexist — upsertRequirement's
  // caller contract (INSERT, not INSERT OR REPLACE) via applyRow's plain
  // INSERT means a genuine duplicate create still fails loud.
  const duplicateArtifact = emptyPreview();
  expectAnyImportFailure(
    () => applyImport(duplicateArtifact, planFor(duplicateArtifact, [
      rowInstruction("create", "/LEGACY-IMPORT-01", { milestone_id: null, id: "LEGACY-IMPORT-01" }, {
        milestone_id: null, id: "LEGACY-IMPORT-01", description: "Duplicate legacy import",
      }, "create-legacy-duplicate"),
    ])),
    /UNIQUE constraint failed|idx_requirements_legacy_id/,
  );

  const survivor = row("SELECT description FROM requirements WHERE id = 'LEGACY-IMPORT-01'");
  assert.equal(survivor["description"], "Legacy import, no milestone", "the refused duplicate leaves the original row untouched");
});
