// Project/App: gsd-pi
// File Purpose: Unit coverage for the reconciled slice-level UAT/acceptance-
// criteria accessors added in Phase 10 (DATA-01).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  closeDatabase,
  getMilestoneSlices,
  getMilestoneUatCriteriaState,
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

describe("queries-uat-criteria: no-criteria and placeholder cases", () => {
  test("a slice with no planning.successCriteria (schema default '') yields criteria:[], hasCriteria:false, non-null", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, []);
      assert.equal(result!.hasCriteria, false);
    } finally {
      closeDatabase();
    }
  });

  for (const placeholder of ["Not provided", "none.", "N/A", "{{success_criteria}}"]) {
    test(`placeholder value "${placeholder}" yields criteria:[] and hasCriteria:false`, () => {
      openDatabase(":memory:");
      try {
        insertMilestone({ id: "M001" });
        insertSlice({
          id: "S01",
          milestoneId: "M001",
          status: "pending",
          planning: { successCriteria: placeholder },
        });

        const result = getSliceAcceptanceCriteria("M001", "S01");

        assert.notEqual(result, null);
        assert.deepEqual(result!.criteria, []);
        assert.equal(result!.hasCriteria, false);
      } finally {
        closeDatabase();
      }
    });
  }

  test("blank lines between declared criteria are collapsed, not emitted as empty criteria", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "pending",
        planning: { successCriteria: "- real one\n\n\n- real two" },
      });

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.equal(result!.criteria.length, 2);
      assert.deepEqual(result!.criteria, ["real one", "real two"]);
    } finally {
      closeDatabase();
    }
  });

  test("populated full_uat_md with default success_criteria still yields hasCriteria:false — evidence never manufactures a criterion", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      setSliceUatMd("M001", "S01", "<sentinel-completion-evidence>");

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.equal(result!.hasCriteria, false);
      assert.deepEqual(result!.criteria, []);
      assert.equal(result!.completionEvidence, "<sentinel-completion-evidence>");
    } finally {
      closeDatabase();
    }
  });

  test("a five-declared-line value returns an array of length exactly 5, with each line's text at its stored index", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      const lines = ["- alpha line", "- bravo line", "- charlie line", "- delta line", "- echo line"];
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "pending",
        planning: { successCriteria: lines.join("\n") },
      });

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.equal(result!.criteria.length, 5);
      assert.deepEqual(result!.criteria, ["alpha line", "bravo line", "charlie line", "delta line", "echo line"]);
    } finally {
      closeDatabase();
    }
  });
});

describe("queries-uat-criteria: milestone-level state", () => {
  test("returns the milestone's own criteria, hasCriteria, and sliceCount from three seeded slices", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({
        id: "M002",
        planning: { successCriteria: ["vision criterion A", "vision criterion B"] },
      });
      insertSlice({ id: "S01", milestoneId: "M002", status: "complete", sequence: 1 });
      insertSlice({ id: "S02", milestoneId: "M002", status: "pending", sequence: 2 });
      insertSlice({ id: "S03", milestoneId: "M002", status: "pending", sequence: 3 });

      const result = getMilestoneUatCriteriaState("M002");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, ["vision criterion A", "vision criterion B"]);
      assert.equal(result!.hasCriteria, true);
      assert.equal(result!.sliceCount, 3);
    } finally {
      closeDatabase();
    }
  });

  test("slices roll-up is ordered exactly as getMilestoneSlices orders it, and each entry matches getSliceAcceptanceCriteria", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M002", planning: { successCriteria: ["vision criterion A"] } });
      insertSlice({
        id: "S03",
        milestoneId: "M002",
        status: "pending",
        sequence: 3,
        planning: { successCriteria: "- third slice criterion" },
      });
      insertSlice({ id: "S01", milestoneId: "M002", status: "complete", sequence: 1 });
      insertSlice({
        id: "S02",
        milestoneId: "M002",
        status: "pending",
        sequence: 2,
        planning: { successCriteria: "- second slice criterion" },
      });

      const result = getMilestoneUatCriteriaState("M002");
      const expectedOrder = getMilestoneSlices("M002").map((slice) => slice.id);

      assert.notEqual(result, null);
      assert.deepEqual(result!.slices.map((slice) => slice.sliceId), expectedOrder);
      for (const entry of result!.slices) {
        const direct = getSliceAcceptanceCriteria("M002", entry.sliceId);
        assert.deepEqual(entry.criteria, direct!.criteria);
        assert.equal(entry.status, direct!.status);
        assert.equal(entry.hasCriteria, direct!.hasCriteria);
      }
    } finally {
      closeDatabase();
    }
  });

  test("slicesWithCriteria counts exactly the slices that declared criteria", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M002" });
      insertSlice({
        id: "S01",
        milestoneId: "M002",
        status: "complete",
        sequence: 1,
        planning: { successCriteria: "- one" },
      });
      insertSlice({
        id: "S02",
        milestoneId: "M002",
        status: "pending",
        sequence: 2,
        planning: { successCriteria: "- two" },
      });
      insertSlice({ id: "S03", milestoneId: "M002", status: "pending", sequence: 3 });

      const result = getMilestoneUatCriteriaState("M002");

      assert.notEqual(result, null);
      assert.equal(result!.slicesWithCriteria, 2);
    } finally {
      closeDatabase();
    }
  });

  test("a milestone with zero declared criteria and zero slices returns a non-null all-empty state", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M002" });

      const result = getMilestoneUatCriteriaState("M002");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, []);
      assert.equal(result!.hasCriteria, false);
      assert.equal(result!.sliceCount, 0);
      assert.equal(result!.slicesWithCriteria, 0);
    } finally {
      closeDatabase();
    }
  });

  test("returns null for an unknown milestoneId", () => {
    openDatabase(":memory:");
    try {
      const result = getMilestoneUatCriteriaState("no-such-milestone");

      assert.equal(result, null);
    } finally {
      closeDatabase();
    }
  });
});
