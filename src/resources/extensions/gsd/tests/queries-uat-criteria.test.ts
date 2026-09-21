// Project/App: gsd-pi
// File Purpose: Unit coverage for the reconciled slice-level UAT/acceptance-
// criteria accessors added in Phase 10 (DATA-01).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  closeDatabase,
  getSliceAcceptanceCriteria,
  insertMilestone,
  insertSlice,
  normalizeAcceptanceCriteriaText,
  openDatabase,
  setSliceUatMd,
} from "../gsd-db.ts";

describe("queries-uat-criteria", () => {
  test("returns normalized criteria and hasCriteria=true for a multi-line hyphen-bulleted slice", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "complete",
        planning: { successCriteria: "- must handle X\n- must handle Y" },
      });

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, ["must handle X", "must handle Y"]);
      assert.equal(result!.hasCriteria, true);
    } finally {
      closeDatabase();
    }
  });

  test("returns null when no slice row exists for (milestoneId, sliceId)", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

      const result = getSliceAcceptanceCriteria("M001", "does-not-exist");

      assert.equal(result, null);
    } finally {
      closeDatabase();
    }
  });

  test("completionEvidence carries full_uat_md verbatim and is never merged into criteria", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "complete",
        planning: { successCriteria: "- must handle X\n- must handle Y" },
      });
      setSliceUatMd("M001", "S01", "## Evidence\nran the app, X and Y both worked");

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.equal(result!.completionEvidence, "## Evidence\nran the app, X and Y both worked");
      assert.equal(result!.criteria.join("\n").includes("Evidence"), false);
      assert.equal(result!.criteria.join("\n").includes("ran the app"), false);
    } finally {
      closeDatabase();
    }
  });

  test("normalizeAcceptanceCriteriaText: single line with no marker returns one entry", () => {
    assert.deepEqual(
      normalizeAcceptanceCriteriaText("one criterion with no marker"),
      ["one criterion with no marker"],
    );
  });

  test("normalizeAcceptanceCriteriaText: only the hyphen-plus-whitespace marker form is stripped", () => {
    assert.deepEqual(normalizeAcceptanceCriteriaText("* starred"), ["* starred"]);
    assert.deepEqual(normalizeAcceptanceCriteriaText("-tight"), ["-tight"]);
  });
});
