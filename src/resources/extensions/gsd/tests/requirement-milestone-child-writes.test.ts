// Project/App: gsd-pi
// File Purpose: Executable contract for Plan 33-02 Task 1 — the single
// `resolveRequirementMilestoneId` decision point every remaining production
// write site (Task 2, added in a following commit) binds to. See
// 33-02-PLAN.md's write-site inventory.

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { resolveRequirementMilestoneId } from "../db/requirement-milestone-resolution.ts";
import { closeDatabase, insertRequirement, openDatabase } from "../gsd-db.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function freshDbPath(prefix = "gsd-requirement-milestone-child-writes-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.add(dir);
  return join(dir, "gsd.db");
}

function seedRequirement(id: string, milestoneId?: string): void {
  insertRequirement({
    id,
    class: "must",
    status: "active",
    description: `Requirement ${id}`,
    why: "",
    source: "test",
    primary_owner: "",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
    ...(milestoneId !== undefined ? { milestone_id: milestoneId } : {}),
  });
}

// ---------------------------------------------------------------------------
// Task 1: resolveRequirementMilestoneId
// ---------------------------------------------------------------------------

test("Test 1: resolves to the caller's own milestone when a matching row exists", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-1", "M-A");
  assert.equal(resolveRequirementMilestoneId("REQ-1", "M-A"), "M-A");
});

test("Test 2: returns null for a legacy NULL-milestone row rather than the caller's context", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-2");
  assert.equal(resolveRequirementMilestoneId("REQ-2", "M-A"), null);
});

test("Test 3: the same id under both the caller's milestone and another milestone resolves to the caller's, deterministically", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-3", "M-A");
  seedRequirement("REQ-3", "M-B");
  for (let i = 0; i < 3; i += 1) {
    assert.equal(resolveRequirementMilestoneId("REQ-3", "M-A"), "M-A");
  }
  assert.equal(resolveRequirementMilestoneId("REQ-3", "M-B"), "M-B");
});

test("Test 4: an id that exists only under some other milestone resolves to null", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  seedRequirement("REQ-4", "M-OTHER");
  assert.equal(resolveRequirementMilestoneId("REQ-4", "M-A"), null);
});

test("Test 5: an id with no matching requirement row at all resolves to null", () => {
  assert.equal(openDatabase(freshDbPath()), true);
  assert.equal(resolveRequirementMilestoneId("REQ-MISSING", "M-A"), null);
});

test("Test 6: a null or empty requirement id resolves to null without querying (no database open)", () => {
  // Deliberately no openDatabase() call — if the resolver queried the DB
  // before short-circuiting, getDb() would throw "No database open" here.
  assert.equal(resolveRequirementMilestoneId(null, "M-A"), null);
  assert.equal(resolveRequirementMilestoneId(undefined, "M-A"), null);
  assert.equal(resolveRequirementMilestoneId("", "M-A"), null);
  assert.equal(resolveRequirementMilestoneId("   ", "M-A"), null);
});
