// Project/App: gsd-pi
// File Purpose: Unit coverage for the reconciled slice-level UAT/acceptance-
// criteria accessors added in Phase 10 (DATA-01).

import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  closeDatabase,
  getMilestone,
  getMilestoneSlices,
  getMilestoneUatCriteriaState,
  getSlice,
  getSliceAcceptanceCriteria,
  getTaskAcceptanceCriteria,
  insertMilestone,
  insertSlice,
  insertTask,
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

describe("queries-uat-criteria: task inheritance and cross-level shape coherence", () => {
  test("a task in a slice declaring two criteria returns those same criteria, hasCriteria:true, inheritedFromSliceId", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "complete",
        planning: { successCriteria: "- must handle X\n- must handle Y" },
      });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });

      const result = getTaskAcceptanceCriteria("M001", "S01", "T01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, ["must handle X", "must handle Y"]);
      assert.equal(result!.hasCriteria, true);
      assert.equal(result!.inheritedFromSliceId, "S01");
    } finally {
      closeDatabase();
    }
  });

  test("a task in a slice declaring no criteria returns a non-null object with criteria:[] and hasCriteria:false", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      const result = getTaskAcceptanceCriteria("M001", "S01", "T01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, []);
      assert.equal(result!.hasCriteria, false);
    } finally {
      closeDatabase();
    }
  });

  test("an unknown taskId in a real slice returns null", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });

      const result = getTaskAcceptanceCriteria("M001", "S01", "does-not-exist");

      assert.equal(result, null);
    } finally {
      closeDatabase();
    }
  });

  test("a real taskId paired with an unknown sliceId returns null", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "pending" });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });

      const result = getTaskAcceptanceCriteria("M001", "does-not-exist", "T01");

      assert.equal(result, null);
    } finally {
      closeDatabase();
    }
  });

  test("cross-level shape coherence: milestone, slice, and task all expose criteria/hasCriteria; task's criteria matches its slice, not the milestone", () => {
    openDatabase(":memory:");
    try {
      insertMilestone({ id: "M001", planning: { successCriteria: ["milestone-level vision criterion"] } });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "complete",
        sequence: 1,
        planning: { successCriteria: "- slice-level criterion one\n- slice-level criterion two" },
      });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });

      const milestoneResult = getMilestoneUatCriteriaState("M001");
      const sliceResult = getSliceAcceptanceCriteria("M001", "S01");
      const taskResult = getTaskAcceptanceCriteria("M001", "S01", "T01");

      assert.notEqual(milestoneResult, null);
      assert.notEqual(sliceResult, null);
      assert.notEqual(taskResult, null);

      // Positive: all three levels expose the shared shape with matching types.
      assert.equal(Array.isArray(milestoneResult!.criteria), true);
      assert.equal(typeof milestoneResult!.hasCriteria, "boolean");
      assert.equal(Array.isArray(sliceResult!.criteria), true);
      assert.equal(typeof sliceResult!.hasCriteria, "boolean");
      assert.equal(Array.isArray(taskResult!.criteria), true);
      assert.equal(typeof taskResult!.hasCriteria, "boolean");

      // The task's criteria equal its slice's criteria verbatim, and that same
      // slice entry appears in the milestone's roll-up.
      assert.deepEqual(taskResult!.criteria, sliceResult!.criteria);
      const milestoneSliceEntry = milestoneResult!.slices.find((slice) => slice.sliceId === "S01");
      assert.notEqual(milestoneSliceEntry, undefined);
      assert.deepEqual(milestoneSliceEntry!.criteria, sliceResult!.criteria);

      // Negative: the task must NOT be wired to the milestone's vision-level
      // criteria — a future regression that accidentally does this must fail here.
      assert.notDeepEqual(taskResult!.criteria, milestoneResult!.criteria);
    } finally {
      closeDatabase();
    }
  });
});

describe("queries-uat-criteria: no data loss across the reconciliation", () => {
  test("a five-entry stored milestone success_criteria array reads back through getMilestoneUatCriteriaState in order, identical text", () => {
    openDatabase(":memory:");
    try {
      const fiveEntries = [
        "milestone criterion one",
        "milestone criterion two",
        "milestone criterion three",
        "milestone criterion four",
        "milestone criterion five",
      ];
      insertMilestone({ id: "M001", planning: { successCriteria: fiveEntries } });

      const result = getMilestoneUatCriteriaState("M001");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, fiveEntries);
    } finally {
      closeDatabase();
    }
  });

  test("a five-line stored slice success_criteria string reads back through getSliceAcceptanceCriteria in order, identical text after marker stripping", () => {
    openDatabase(":memory:");
    try {
      const fiveLines = [
        "- slice line one",
        "- slice line two",
        "- slice line three",
        "- slice line four",
        "- slice line five",
      ];
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "pending",
        planning: { successCriteria: fiveLines.join("\n") },
      });

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, [
        "slice line one",
        "slice line two",
        "slice line three",
        "slice line four",
        "slice line five",
      ]);
    } finally {
      closeDatabase();
    }
  });

  test("a JSON-looking slice success_criteria value reads back as literal text lines, never parsed, never throws", () => {
    openDatabase(":memory:");
    try {
      const jsonLookingValue = '["not", "actually", "parsed"]';
      insertMilestone({ id: "M001" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "pending",
        planning: { successCriteria: jsonLookingValue },
      });

      assert.doesNotThrow(() => getSliceAcceptanceCriteria("M001", "S01"));
      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.deepEqual(result!.criteria, [jsonLookingValue]);
    } finally {
      closeDatabase();
    }
  });

  test("a full_uat_md value with headings, a fenced block, and a trailing newline reads back byte-identical through completionEvidence", () => {
    openDatabase(":memory:");
    try {
      const evidenceBlob = "## Evidence\n\nRan the app end to end.\n\n```\ncode block contents\n```\n";
      insertMilestone({ id: "M001" });
      insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
      setSliceUatMd("M001", "S01", evidenceBlob);

      const result = getSliceAcceptanceCriteria("M001", "S01");

      assert.notEqual(result, null);
      assert.equal(result!.completionEvidence, evidenceBlob);
    } finally {
      closeDatabase();
    }
  });

  test("reading through all three new accessors alters no stored byte — raw rows re-read identically afterward", () => {
    openDatabase(":memory:");
    try {
      const evidenceBlob = "## Evidence\n\nRan the app.\n";
      insertMilestone({ id: "M001", planning: { successCriteria: ["a", "b", "c"] } });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "complete",
        planning: { successCriteria: "- one\n- two" },
      });
      insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "complete" });
      setSliceUatMd("M001", "S01", evidenceBlob);

      const sliceBefore = getSlice("M001", "S01");
      const milestoneBefore = getMilestone("M001");
      const sliceSuccessCriteriaBefore = sliceBefore!.success_criteria;
      const sliceFullUatMdBefore = sliceBefore!.full_uat_md;
      const milestoneSuccessCriteriaBefore = milestoneBefore!.success_criteria;

      // Exercise all three new accessors.
      getMilestoneUatCriteriaState("M001");
      getSliceAcceptanceCriteria("M001", "S01");
      getTaskAcceptanceCriteria("M001", "S01", "T01");

      const sliceAfter = getSlice("M001", "S01");
      const milestoneAfter = getMilestone("M001");

      assert.equal(sliceAfter!.success_criteria, sliceSuccessCriteriaBefore);
      assert.equal(sliceAfter!.full_uat_md, sliceFullUatMdBefore);
      assert.deepEqual(milestoneAfter!.success_criteria, milestoneSuccessCriteriaBefore);
    } finally {
      closeDatabase();
    }
  });
});

describe("queries-uat-criteria: renderer output parity", () => {
  // Reproduces markdown-renderer.ts's Must-Haves bullet-prefix rule exactly:
  // an entry that already begins with a hyphen renders unchanged; anything
  // else gets a hyphen-space prefix. This pins today's rendered output as a
  // contract BEFORE the renderer is retrofitted to source its lines from
  // normalizeAcceptanceCriteriaText instead of its own inline parse.
  function toRenderedLines(input: string): string[] {
    return normalizeAcceptanceCriteriaText(input).map((entry) =>
      entry.startsWith("-") ? entry : `- ${entry}`,
    );
  }

  test("an already-hyphen-marked line renders unchanged", () => {
    assert.deepEqual(toRenderedLines("- already marked"), ["- already marked"]);
  });

  test("an unmarked line gets a hyphen-space prefix", () => {
    assert.deepEqual(toRenderedLines("unmarked line"), ["- unmarked line"]);
  });

  test("a hyphen-with-no-space line is left unchanged (not a recognized marker)", () => {
    assert.deepEqual(toRenderedLines("-tight"), ["-tight"]);
  });

  test("an asterisk-marker line is prefixed, not treated as already marked", () => {
    assert.deepEqual(toRenderedLines("* starred"), ["- * starred"]);
  });

  test("a multi-line value renders one prefixed line per declared entry", () => {
    assert.deepEqual(toRenderedLines("- one\n\n- two"), ["- one", "- two"]);
  });

  test("an empty value and a placeholder value both render zero criteria lines", () => {
    assert.deepEqual(toRenderedLines(""), []);
    assert.deepEqual(toRenderedLines("Not provided"), []);
  });
});
