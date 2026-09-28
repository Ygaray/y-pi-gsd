// Project/App: gsd-pi
// File Purpose: Intent-level tests for deterministic legacy Preview change classification.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type {
  LegacyImportPreviewDiagnosis,
  LegacyImportPreviewResolution,
  LegacyImportPreviewSource,
  LegacyImportRawValue,
  LegacyImportTarget,
  LegacyImportValue,
} from "../legacy-import-contract.ts";
import {
  classifyLegacyImportChanges,
  LegacyImportClassificationError,
  type LegacyImportClassification,
} from "../legacy-import-preview-classifier.ts";
import type {
  LegacyImportBaseRow,
  LegacyImportBaseRowSet,
  LegacyImportBaseSnapshot,
} from "../legacy-import-preview-base.ts";
import type {
  LegacyImportCompleteRowSet,
  LegacyImportInterpretation,
  LegacyImportInterpretationCandidate,
} from "../legacy-import-preview-interpretation.ts";
import { hashLegacyImportValue } from "../legacy-import-preview.ts";
import {
  assertStableClassificationHashes,
  classificationBase as base,
  classificationBaseRow as row,
  classificationCandidate,
  classificationCompleteDecisions,
  classificationDecision as decision,
  classificationInterpretation,
  classificationRaw,
  classificationSource,
} from "./legacy-import-preview-classification-fixtures.ts";

function source(sourceId = "source-manifest"): LegacyImportPreviewSource {
  return classificationSource(sourceId, ".gsd/state-manifest.json");
}

function raw(
  value: LegacyImportValue,
  jsonPointer: string,
  sourceId = "source-manifest",
): LegacyImportRawValue {
  return classificationRaw(sourceId, value, jsonPointer);
}

function candidate(
  target: LegacyImportTarget,
  normalized: LegacyImportValue,
  options: {
    classification?: "compare" | "preserve";
    reason?: string;
    raw?: LegacyImportRawValue;
    ordinal?: number;
  } = {},
): LegacyImportInterpretationCandidate {
  const evidence = options.raw ?? raw(normalized, "/candidate");
  return classificationCandidate(
    source(evidence.source_id),
    target,
    normalized,
    {
      classification: options.classification,
      reasonCode: options.reason ?? "manifest-candidate",
      raw: evidence,
      ordinal: options.ordinal,
    },
  );
}

function interpretation(
  candidates: readonly LegacyImportInterpretationCandidate[] = [],
  options: {
    sources?: readonly LegacyImportPreviewSource[];
    completeRowSets?: readonly LegacyImportCompleteRowSet[];
    diagnoses?: readonly LegacyImportPreviewDiagnosis[];
    resolutions?: readonly LegacyImportPreviewResolution[];
  } = {},
): LegacyImportInterpretation {
  return classificationInterpretation(
    options.sources ?? [source()],
    candidates,
    options.completeRowSets,
    options.diagnoses,
    options.resolutions,
  );
}

function completeDecisions(
  values: readonly Readonly<Record<string, LegacyImportValue>>[],
  memberKeys = values.map((value) => String(value.id)),
): LegacyImportCompleteRowSet {
  return classificationCompleteDecisions(source(), values, memberKeys);
}

function completeRowSet(
  rowSet: LegacyImportBaseRowSet,
  targetKind: string,
  values: readonly Readonly<Record<string, LegacyImportValue>>[],
  memberKeys: readonly string[],
  evidenceSource = source(),
): LegacyImportCompleteRowSet {
  const pending = {
    row_set: rowSet,
    target_kind: targetKind,
    member_keys: memberKeys,
    raw: raw(values, `/${rowSet}`, evidenceSource.source_id),
    provenance: {
      source_id: evidenceSource.source_id,
      parser_id: evidenceSource.parser_id,
      parser_version: evidenceSource.parser_version,
    },
  };
  return { complete_set_id: hashLegacyImportValue(pending), ...pending };
}

function assertClassificationError(
  execute: () => unknown,
  code: LegacyImportClassificationError["code"],
): void {
  assert.throws(execute, (error: unknown) => {
    assert.ok(error instanceof LegacyImportClassificationError);
    assert.equal(error.code, code);
    return true;
  });
}

interface ProducerAdapterCase {
  name: string;
  target: LegacyImportTarget;
  normalized: Readonly<Record<string, LegacyImportValue>>;
  rowSet: LegacyImportBaseRowSet;
  identity: Readonly<Record<string, LegacyImportValue>>;
  canonicalField: string;
  canonicalValue: LegacyImportValue;
  driftValue: LegacyImportValue;
}

function assertProducerAdapterCase(adapterCase: ProducerAdapterCase): void {
  const canonicalRow = {
    ...adapterCase.identity,
    [adapterCase.canonicalField]: adapterCase.canonicalValue,
  };
  const noOp = classifyLegacyImportChanges(
    base([row(adapterCase.rowSet, adapterCase.identity, canonicalRow)]),
    interpretation([candidate(adapterCase.target, adapterCase.normalized)]),
  );
  assert.deepEqual(noOp.changes, [], `${adapterCase.name}: canonical alias is a no-op`);

  const changed = classifyLegacyImportChanges(
    base([row(adapterCase.rowSet, adapterCase.identity, {
      ...canonicalRow,
      [adapterCase.canonicalField]: adapterCase.driftValue,
    })]),
    interpretation([candidate(adapterCase.target, adapterCase.normalized)]),
  );
  assert.equal(changed.changes.length, 1, `${adapterCase.name}: canonical drift is repaired`);
  assert.equal(changed.changes[0]?.action, "update", adapterCase.name);
  assert.deepEqual(changed.changes[0]?.normalized, adapterCase.normalized, `${adapterCase.name}: normalized evidence`);
  assert.deepEqual(changed.changes[0]?.raw.value, adapterCase.normalized, `${adapterCase.name}: raw evidence`);
}

function actionMatrixInput(): {
  base: LegacyImportBaseSnapshot;
  interpretation: LegacyImportInterpretation;
  complete: LegacyImportCompleteRowSet;
} {
  const d001 = decision("D001", "guided recommendation", 1);
  const d002 = decision("D002", "database queue", 2);
  const d004 = decision("D004", "projection only", 4);
  const complete = completeDecisions([d001, d002, d004]);
  return {
    base: base([
      row("decisions", { id: "D002" }, decision("D002", "legacy queue")),
      row("decisions", { id: "D003" }, decision("D003", "dual authority")),
      row("decisions", { id: "D004" }, decision("D004", "projection only")),
    ]),
    interpretation: interpretation([
      candidate({ kind: "decision", key: "D001" }, d001, {
        raw: raw(d001, "/decisions/0"), ordinal: 1,
      }),
      candidate({ kind: "decision", key: "D002" }, d002, {
        raw: raw(d002, "/decisions/1"), ordinal: 2,
      }),
      candidate({ kind: "decision", key: "D004" }, d004, {
        raw: raw(d004, "/decisions/2"), ordinal: 3,
      }),
      candidate(
        { kind: "artifact", key: ".gsd/STATE.md" },
        { path: ".gsd/STATE.md", preservation: "verbatim" },
        {
          classification: "preserve",
          reason: "unmodeled-state-narrative-preserved",
          raw: raw("operator narrative", "", "source-state"),
          ordinal: 4,
        },
      ),
    ], {
      sources: [source(), { ...source("source-state"), path: ".gsd/STATE.md", kind: "markdown", outcome: "preserved" }],
      completeRowSets: [complete],
    }),
    complete,
  };
}

function assertCanonicalHashes(result: LegacyImportClassification): void {
  assertStableClassificationHashes(result);
  for (const change of result.changes) {
    assert.match(change.change_id, /^sha256:[0-9a-f]{64}$/u);
  }
}

describe("legacy preview change classification", () => {
  test("classifies the action matrix as create, update, delete, preserve, and an omitted no-op", () => {
    const input = actionMatrixInput();
    const result = classifyLegacyImportChanges(input.base, input.interpretation);

    assert.equal(result.applicable, true);
    assert.deepEqual(
      result.changes.map((change) => [change.action, change.target.kind, change.target.key]).sort(),
      [
        ["create", "decision", "D001"],
        ["delete", "decision", "D003"],
        ["preserve", "artifact", ".gsd/STATE.md"],
        ["update", "decision", "D002"],
      ].sort(),
    );
    assert.ok(!result.changes.some((change) => change.target.key === "D004"), "equal D004 is a no-op");
    const deletion = result.changes.find((change) => change.action === "delete");
    assert.ok(deletion);
    assert.equal(deletion.normalized, null);
    assert.deepEqual(deletion.raw, input.complete.raw, "delete is proven by the complete collection evidence");
    assert.equal(deletion.reason_code, "complete-snapshot-row-absent");
    assert.equal(
      result.changes.find((change) => change.target.key === "D001")?.reason_code,
      "candidate-row-absent-from-base",
    );
    assert.equal(
      result.changes.find((change) => change.target.key === "D002")?.reason_code,
      "candidate-row-differs-from-base",
    );
    assert.deepEqual(result.counts, {
      create: 1, update: 1, delete: 1, preserve: 1, unparsed: 0, unresolved: 0,
    });
    assertCanonicalHashes(result);
  });

  test("does not turn absence into deletion without an explicit complete row set", () => {
    const result = classifyLegacyImportChanges(
      base([row("decisions", { id: "D003" }, decision("D003", "dual authority"))]),
      interpretation([]),
    );

    assert.equal(result.applicable, true);
    assert.deepEqual(result.changes, []);
    assert.equal(result.counts.delete, 0);
  });

  test("compares the canonical decision projection and ignores manifest sequence metadata", () => {
    const d004 = decision("D004", "projection only", 400);
    const result = classifyLegacyImportChanges(
      base([row("decisions", { id: "D004" }, decision("D004", "projection only"))]),
      interpretation([candidate({ kind: "decision", key: "D004" }, d004)]),
    );

    assert.deepEqual(result.changes, []);
  });

  test("excludes unresolved ambiguous targets and marks the classification inapplicable", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-m007",
      code: "hybrid-conflicting-content",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 10, end_byte: 20, line: 2 },
      raw_value: "two routes",
      message: "M007 has two incompatible routes.",
    };
    const result = classifyLegacyImportChanges(
      base(),
      interpretation([
        candidate({ kind: "milestone", key: "M007" }, { id: "M007", title: "Alpha" }),
        candidate(
          { kind: "milestone", key: "M007", field: "status" },
          "active",
          { ordinal: 2 },
        ),
        candidate({ kind: "milestone", key: "M008" }, { id: "M008", title: "Unrelated" }, { ordinal: 3 }),
      ], {
        diagnoses: [diagnosis],
        resolutions: [{
          diagnosis_id: diagnosis.diagnosis_id,
          disposition: "requires-user",
          target: { kind: "milestone", key: "M007" },
        }],
      }),
    );

    assert.equal(result.applicable, false);
    assert.ok(!result.changes.some((change) => change.target.key === "M007"));
    assert.deepEqual(result.changes.map((change) => change.target.key), ["M008"]);
    assert.equal(result.counts.unresolved, 1);
  });

  test("matches canonical identity instead of treating an equal title as an existing row", () => {
    const result = classifyLegacyImportChanges(
      base([row("milestones", { id: "M701" }, { id: "M701", title: "Shared title", status: "pending" })]),
      interpretation([
        candidate(
          { kind: "milestone", key: "M702" },
          { id: "M702", title: "Shared title", status: "pending", layout: "nested" },
        ),
      ]),
    );

    assert.deepEqual(result.changes.map((change) => [change.action, change.target.key]), [["create", "M702"]]);
  });

  test("is invariant to candidate, base-row, source, and complete-member ordering", () => {
    const input = actionMatrixInput();
    const { complete_set_id: _completeSetId, ...completePending } = input.complete;
    const reversedPending = {
      ...completePending,
      member_keys: [...completePending.member_keys].reverse(),
    };
    const reversedComplete = {
      complete_set_id: hashLegacyImportValue(reversedPending),
      ...reversedPending,
    };
    const reversed = interpretation([...input.interpretation.candidates].reverse(), {
      sources: [...input.interpretation.sources].reverse(),
      completeRowSets: [reversedComplete],
    });

    const first = classifyLegacyImportChanges(input.base, input.interpretation);
    const second = classifyLegacyImportChanges(base([...input.base.rows].reverse()), reversed);
    assert.deepEqual(second, first);
  });

  test("preserves complete-set raw evidence verbatim while canonicalizing member keys", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const d002 = decision("D002", "database queue", 2);
    const complete = completeDecisions([d002, d001], ["D002", "D001"]);
    const result = classifyLegacyImportChanges(
      base([row("decisions", { id: "D003" }, decision("D003", "dual authority"))]),
      interpretation([
        candidate({ kind: "decision", key: "D001" }, d001, { raw: raw(d001, "/decisions/1") }),
        candidate({ kind: "decision", key: "D002" }, d002, { raw: raw(d002, "/decisions/0"), ordinal: 2 }),
      ], { completeRowSets: [complete] }),
    );

    const deletion = result.changes.find((change) => change.action === "delete");
    assert.ok(deletion);
    assert.deepEqual(deletion.raw, complete.raw);
    assert.deepEqual(deletion.raw.value, [d002, d001], "captured collection order is evidence, not a sort key");
  });

  test("rejects complete-set member keys that disagree with the retained raw collection", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const mismatched = completeDecisions([d001], ["D002"]);
    assert.throws(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate({ kind: "decision", key: "D002" }, decision("D002", "database queue", 2)),
        ], { completeRowSets: [mismatched] }),
      ),
      /complete row set (member keys.*raw|raw.*member keys)/iu,
    );
  });

  test("rejects a complete-set member candidate contributed by a different source", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const complete = completeDecisions([d001]);
    assert.throws(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate({ kind: "decision", key: "D001" }, d001, {
            raw: raw(d001, "/decisions/0", "source-other"),
          }),
        ], {
          sources: [source(), { ...source("source-other"), path: ".gsd/DECISIONS.md" }],
          completeRowSets: [complete],
        }),
      ),
      /complete row set member candidate.*source/iu,
    );
  });

  test("rejects a same-source candidate omitted from its authoritative complete set", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const d002 = decision("D002", "database queue", 2);
    const complete = completeDecisions([d001]);
    assert.throws(
      () => classifyLegacyImportChanges(
        base([row("decisions", { id: "D002" }, decision("D002", "legacy queue"))]),
        interpretation([
          candidate({ kind: "decision", key: "D001" }, d001, {
            raw: raw(d001, "/decisions/0"),
          }),
          candidate({ kind: "decision", key: "D002" }, d002, {
            raw: raw(d002, "/decisions/1"),
            ordinal: 2,
          }),
        ], { completeRowSets: [complete] }),
      ),
      /complete row set.*omits.*same-source candidate/iu,
    );
  });

  test("rejects a same-source field candidate omitted from its authoritative complete set", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const complete = completeDecisions([d001]);
    assert.throws(
      () => classifyLegacyImportChanges(
        base([row("decisions", { id: "D002" }, decision("D002", "legacy queue"))]),
        interpretation([
          candidate({ kind: "decision", key: "D001" }, d001, {
            raw: raw(d001, "/decisions/0"),
          }),
          candidate({ kind: "decision", key: "D002", field: "choice" }, "database queue", {
            raw: raw("database queue", "/decisions/1/choice"),
            ordinal: 2,
          }),
        ], { completeRowSets: [complete] }),
      ),
      /complete row set.*omits.*same-source candidate/iu,
    );
  });

  test("treats another source's row claim against authoritative absence as one ambiguity", () => {
    const d001 = decision("D001", "guided recommendation", 1);
    const d002 = decision("D002", "database queue", 2);
    const complete = completeDecisions([d001]);
    const classify = (includeExistingRow: boolean) => classifyLegacyImportChanges(
      base([
        row("decisions", { id: "D001" }, decision("D001", "guided recommendation")),
        ...(includeExistingRow
          ? [row("decisions", { id: "D002" }, decision("D002", "legacy queue"))]
          : []),
      ]),
      interpretation([
        candidate({ kind: "decision", key: "D001" }, d001, {
          raw: raw(d001, "/decisions/0"),
        }),
        candidate({ kind: "decision", key: "D002" }, d002, {
          raw: raw(d002, "/decisions/0", "source-other"),
          ordinal: 2,
        }),
      ], {
        sources: [source(), { ...source("source-other"), path: ".gsd/DECISIONS.md" }],
        completeRowSets: [complete],
      }),
    );

    for (const result of [classify(false), classify(true)]) {
      assert.equal(result.applicable, false);
      assert.equal(result.diagnoses.length, 1);
      assert.deepEqual(result.resolutions.map((resolution) => resolution.disposition), ["requires-user"]);
      assert.ok(!result.changes.some((change) => change.target.key === "D002"));
    }
  });

  test("treats overlapping row and field claims from different sources as one ambiguity", () => {
    const otherSource = { ...source("source-other"), path: ".gsd/ROADMAP.md" };
    const result = classifyLegacyImportChanges(
      base([row("milestones", { id: "M001" }, { id: "M001", title: "Old", status: "pending" })]),
      interpretation([
        candidate(
          { kind: "milestone", key: "M001" },
          { id: "M001", title: "Manifest", vision: "Manifest vision", status: "active" },
        ),
        candidate(
          { kind: "milestone", key: "M001", field: "title" },
          "Roadmap",
          { raw: raw("Roadmap", "/milestones/0/title", otherSource.source_id), ordinal: 2 },
        ),
        candidate(
          { kind: "milestone", key: "M001", field: "vision" },
          "Roadmap vision",
          { raw: raw("Roadmap vision", "/milestones/0/vision", otherSource.source_id), ordinal: 3 },
        ),
      ], { sources: [source(), otherSource] }),
    );

    assert.equal(result.applicable, false);
    assert.equal(result.diagnoses.length, 1);
    assert.equal(result.resolutions.length, 1);
    assert.ok(!result.changes.some((change) => change.target.key === "M001"));
  });

  test("coalesces equal same-source row and field claims", () => {
    const result = classifyLegacyImportChanges(
      base(),
      interpretation([
        candidate({ kind: "milestone", key: "M001" }, { id: "M001", title: "Foundation" }),
        candidate(
          { kind: "milestone", key: "M001", field: "title" },
          "Foundation",
          { ordinal: 2 },
        ),
      ]),
    );

    assert.equal(result.applicable, true);
    assert.deepEqual(result.diagnoses, []);
    assert.deepEqual(result.changes.map((change) => [change.action, change.target.key]), [["create", "M001"]]);
  });

  test("rejects contradictory same-source row and field claims", () => {
    assertClassificationError(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate({ kind: "milestone", key: "M001" }, { id: "M001", title: "Foundation" }),
          candidate(
            { kind: "milestone", key: "M001", field: "title" },
            "Different title",
            { ordinal: 2 },
          ),
        ]),
      ),
      "LEGACY_IMPORT_CLASSIFICATION_CANDIDATE_INCONSISTENT",
    );
  });

  test("treats a complete member's conflicting other-source claim as ambiguity", () => {
    const retained = decision("D001", "guided recommendation", 1);
    const conflicting = decision("D001", "different route", 1);
    const complete = completeDecisions([retained]);
    const result = classifyLegacyImportChanges(
      base([row("decisions", { id: "D001" }, decision("D001", "legacy route"))]),
      interpretation([
        candidate({ kind: "decision", key: "D001" }, retained, {
          raw: raw(retained, "/decisions/0"),
        }),
        candidate({ kind: "decision", key: "D001" }, conflicting, {
          raw: raw(conflicting, "/decisions/0", "source-other"),
          ordinal: 2,
        }),
      ], {
        sources: [source(), { ...source("source-other"), path: ".gsd/DECISIONS.md" }],
        completeRowSets: [complete],
      }),
    );

    assert.equal(result.applicable, false);
    assert.equal(result.diagnoses.length, 1);
    assert.equal(result.resolutions.length, 1);
    assert.ok(!result.changes.some((change) => change.target.key === "D001"));
  });

  test("allows target-keyed patches but requires identity for complete-set members", () => {
    const partialCandidates: readonly LegacyImportInterpretationCandidate[] = [
      candidate({ kind: "decision", key: "D001" }, { choice: "database queue" }),
      candidate(
        { kind: "task", key: "M001/S01/T01" },
        { slice_id: "S01", id: "T01", title: "Classify changes" },
      ),
    ];
    assert.deepEqual(
      classifyLegacyImportChanges(base(), interpretation(partialCandidates))
        .changes.map((change) => [change.action, change.target.key]).sort(),
      [["create", "D001"], ["create", "M001/S01/T01"]],
    );

    const retained = decision("D001", "database queue", 1);
    assertClassificationError(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate(
            { kind: "decision", key: "D001" },
            { choice: "database queue" },
            { raw: raw(retained, "/decisions/0") },
          ),
        ], { completeRowSets: [completeDecisions([retained])] }),
      ),
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
    );
  });

  test("maps sealed slice aliases while retaining metadata evidence", () => {
    const cases: readonly ProducerAdapterCase[] = [
      {
        name: "nested sketch placeholder",
        target: { kind: "slice", key: "M001/S01" },
        normalized: { sketch: true, tasks: [] },
        rowSet: "slices",
        identity: { milestone_id: "M001", id: "S01" },
        canonicalField: "is_sketch",
        canonicalValue: true,
        driftValue: false,
      },
      {
        name: "decimal phase alias",
        target: { kind: "slice", key: "M001/S01" },
        normalized: { canonical_sequence: 1, legacy_phase_number: "1.2" },
        rowSet: "slices",
        identity: { milestone_id: "M001", id: "S01" },
        canonicalField: "sequence",
        canonicalValue: 1,
        driftValue: 9,
      },
    ];

    for (const adapterCase of cases) assertProducerAdapterCase(adapterCase);
  });

  test("maps sealed task and requirement aliases while retaining metadata evidence", () => {
    const cases: readonly ProducerAdapterCase[] = [
      {
        name: "planning task objective",
        target: { kind: "task", key: "M001/S01/T01" },
        normalized: {
          objective: "Store a note and return it unchanged.",
          numbering_provenance: { legacy_phase: "1.2", legacy_plan: "03" },
        },
        rowSet: "tasks",
        identity: { milestone_id: "M001", slice_id: "S01", id: "T01" },
        canonicalField: "description",
        canonicalValue: "Store a note and return it unchanged.",
        driftValue: "Old objective.",
      },
      {
        name: "milestone requirement text",
        target: { kind: "requirement", key: "M001/CORE-01" },
        normalized: {
          text: "Foundation behavior is verified.",
          title: "Foundation behavior",
        },
        rowSet: "requirements",
        identity: { milestone_id: "M001", id: "CORE-01" },
        canonicalField: "description",
        canonicalValue: "Foundation behavior is verified.",
        driftValue: "Old requirement.",
      },
    ];

    for (const adapterCase of cases) assertProducerAdapterCase(adapterCase);
  });

  test("compares mapped SQLite booleans by meaning without hiding real changes", () => {
    const taskIdentity = { milestone_id: "M001", slice_id: "S01", id: "T01" };
    const classifyBlocker = (stored: 0 | 1, claimed: boolean) => classifyLegacyImportChanges(
      base([row("tasks", taskIdentity, { ...taskIdentity, blocker_discovered: stored })]),
      interpretation([
        candidate(
          { kind: "task", key: "M001/S01/T01" },
          { ...taskIdentity, blocker_discovered: claimed },
        ),
      ]),
    );
    const sliceIdentity = { milestone_id: "M001", id: "S01" };
    const classifySketch = (stored: 0 | 1, claimed: boolean) => classifyLegacyImportChanges(
      base([row("slices", sliceIdentity, { ...sliceIdentity, is_sketch: stored })]),
      interpretation([
        candidate({ kind: "slice", key: "M001/S01" }, { sketch: claimed }),
      ]),
    );

    assert.deepEqual(classifyBlocker(0, false).changes, []);
    assert.deepEqual(classifyBlocker(1, true).changes, []);
    assert.deepEqual(
      classifyBlocker(0, true).changes.map((change) => [change.action, change.target.key]),
      [["update", "M001/S01/T01"]],
    );
    assert.deepEqual(classifySketch(0, false).changes, []);
    assert.deepEqual(classifySketch(1, true).changes, []);
    assert.deepEqual(
      classifySketch(0, true).changes.map((change) => [change.action, change.target.key]),
      [["update", "M001/S01"]],
    );
  });

  test("retains milestone, slice, and task legacy provenance as comparison metadata", () => {
    const cases: readonly ProducerAdapterCase[] = [
      {
        name: "milestone provenance",
        target: { kind: "milestone", key: "M001" },
        normalized: { title: "Foundation", legacy_provenance: { milestone_id: "v1.0" } },
        rowSet: "milestones",
        identity: { id: "M001" },
        canonicalField: "title",
        canonicalValue: "Foundation",
        driftValue: "Old milestone",
      },
      {
        name: "slice provenance",
        target: { kind: "slice", key: "M001/S01" },
        normalized: {
          title: "Foundation slice",
          legacy_provenance: { milestone_id: "v1.0", phase_number: "01" },
        },
        rowSet: "slices",
        identity: { milestone_id: "M001", id: "S01" },
        canonicalField: "title",
        canonicalValue: "Foundation slice",
        driftValue: "Old slice",
      },
      {
        name: "task provenance",
        target: { kind: "task", key: "M001/S01/T01" },
        normalized: {
          title: "Foundation task",
          legacy_provenance: { milestone_id: "v1.0", phase_number: "01", plan_number: "01" },
        },
        rowSet: "tasks",
        identity: { milestone_id: "M001", slice_id: "S01", id: "T01" },
        canonicalField: "title",
        canonicalValue: "Foundation task",
        driftValue: "Old task",
      },
    ];

    for (const adapterCase of cases) assertProducerAdapterCase(adapterCase);
  });

  test("rejects missing, blank, and non-string complete-row identities", () => {
    const invalidRows: readonly {
      value: Readonly<Record<string, LegacyImportValue>>;
      memberKey: string;
      targetKey: string;
    }[] = [
      { value: {}, memberKey: "undefined", targetKey: "undefined" },
      { value: { id: "   " }, memberKey: "   ", targetKey: "   " },
      { value: { id: 42 }, memberKey: "42", targetKey: "42" },
    ];

    for (const invalid of invalidRows) {
      const complete = completeDecisions([invalid.value], [invalid.memberKey]);
      assertClassificationError(
        () => classifyLegacyImportChanges(
          base(),
          interpretation([
            candidate(
              { kind: "decision", key: invalid.targetKey },
              invalid.value,
              { raw: raw(invalid.value, "/decisions/0") },
            ),
          ], { completeRowSets: [complete] }),
        ),
        "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
      );
    }
  });

  test("rejects a target key that disagrees with normalized row identity", () => {
    assert.throws(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate({ kind: "decision", key: "D001" }, decision("D002", "database queue", 2)),
        ]),
      ),
      /normalized identity.*target|target.*normalized identity/iu,
    );
  });

  test("classifies a planning summary status object through its status field", () => {
    const normalized = {
      id: "T01",
      slice_id: "S01",
      status: "complete",
      summary: "The task passed its stated verification.",
    };
    const result = classifyLegacyImportChanges(
      base([
        row("tasks", { milestone_id: "M001", slice_id: "S01", id: "T01" }, {
          milestone_id: "M001", slice_id: "S01", id: "T01", status: "planned",
        }),
        row("item_lifecycles", {
          project_id: "project-test",
          item_kind: "task",
          milestone_id: "M001",
          slice_id: "S01",
          task_id: "T01",
        }, {
          project_id: "project-test",
          item_kind: "task",
          milestone_id: "M001",
          slice_id: "S01",
          task_id: "T01",
          lifecycle_status: "pending",
        }),
      ]),
      interpretation([
        candidate(
          { kind: "task", key: "M001/S01/T01", field: "status" },
          normalized,
          { reason: "planning-summary-completion" },
        ),
      ]),
    );

    assert.deepEqual(
      result.changes.map((change) => [change.action, change.target, change.normalized]),
      [["update", { kind: "task", key: "M001/S01/T01", field: "status" }, normalized]],
    );
  });

  test("omits an equal lifecycle with a semantic shadow and repairs shadow drift", () => {
    const lifecycleIdentity = {
      project_id: "project-test",
      item_kind: "task",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: "T01",
    };
    const taskIdentity = { milestone_id: "M001", slice_id: "S01", id: "T01" };
    const statusCandidate = (status: string) => candidate(
      { kind: "task", key: "M001/S01/T01", field: "status" },
      status,
    );

    const semanticMatch = classifyLegacyImportChanges(
      base([
        row("tasks", taskIdentity, { ...taskIdentity, status: "active" }),
        row("item_lifecycles", lifecycleIdentity, { ...lifecycleIdentity, lifecycle_status: "ready" }),
      ]),
      interpretation([statusCandidate("ready")]),
    );
    assert.deepEqual(semanticMatch.changes, []);

    const shadowDrift = classifyLegacyImportChanges(
      base([
        row("tasks", taskIdentity, { ...taskIdentity, status: "planned" }),
        row("item_lifecycles", lifecycleIdentity, { ...lifecycleIdentity, lifecycle_status: "completed" }),
      ]),
      interpretation([statusCandidate("complete")]),
    );
    assert.deepEqual(
      shadowDrift.changes.map((change) => [change.action, change.target.key]),
      [["update", "M001/S01/T01"]],
    );
  });

  test("reports missing hierarchy and invalid canonical lifecycle authority as typed errors", () => {
    const lifecycleIdentity = {
      project_id: "project-test",
      item_kind: "task",
      milestone_id: "M001",
      slice_id: "S01",
      task_id: "T01",
    };
    const statusCandidate = candidate(
      { kind: "task", key: "M001/S01/T01", field: "status" },
      "pending",
    );
    const cases = [
      base([
        row("item_lifecycles", lifecycleIdentity, { ...lifecycleIdentity, lifecycle_status: "pending" }),
      ]),
      base([
        row("tasks", { milestone_id: "M001", slice_id: "S01", id: "T01" }, {
          milestone_id: "M001", slice_id: "S01", id: "T01", status: "planned",
        }),
        row("item_lifecycles", lifecycleIdentity, { ...lifecycleIdentity, lifecycle_status: "mystery" }),
      ]),
    ];

    for (const invalidBase of cases) {
      assertClassificationError(
        () => classifyLegacyImportChanges(invalidBase, interpretation([statusCandidate])),
        "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID",
      );
    }
  });

  test("rejects an orphan lifecycle create when no hierarchy row was staged", () => {
    assertClassificationError(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate(
            { kind: "task-status", key: "M001/S01/T01" },
            "complete",
            { reason: "matching-task-summary-attestation" },
          ),
        ]),
      ),
      "LEGACY_IMPORT_CLASSIFICATION_LIFECYCLE_AUTHORITY_INVALID",
    );
  });

  test("keeps noncanonical legacy-phase keys outside canonical hierarchy adapters", () => {
    const legacyCandidates = [
      candidate(
        { kind: "slice", key: "legacy-phase-01", field: "title" },
        "Checked without summary",
        { reason: "planning-roadmap-phase-title" },
      ),
      candidate(
        { kind: "task", key: "legacy-phase-01-plan-01", field: "status" },
        "cancelled",
        { reason: "legacy-skipped-means-cancelled" },
      ),
    ];

    for (const legacyCandidate of legacyCandidates) {
      assertClassificationError(
        () => classifyLegacyImportChanges(base(), interpretation([legacyCandidate])),
        "LEGACY_IMPORT_CLASSIFICATION_NORMALIZED_VALUE_INVALID",
      );
    }
  });

  test("uses canonical decision memory source and lets tombstones suppress legacy fallback", () => {
    const d001 = { ...decision("D001", "SQLite"), source: "planning" };
    const legacy = { ...d001, source: "discussion" };
    const memory = (deleted: boolean) => row("decision_memories", { source_decision_id: "D001" }, {
      source_decision_id: "D001",
      structured_fields: JSON.stringify({
        sourceDecisionId: "D001",
        ...d001,
        deleted,
      }),
    });

    const preserved = classifyLegacyImportChanges(
      base([row("decisions", { id: "D001" }, legacy), memory(false)]),
      interpretation([candidate({ kind: "decision", key: "D001" }, d001)], {
        completeRowSets: [completeDecisions([d001])],
      }),
    );
    assert.deepEqual(preserved.changes, []);

    const recreated = classifyLegacyImportChanges(
      base([row("decisions", { id: "D001" }, legacy), memory(true)]),
      interpretation([candidate({ kind: "decision", key: "D001" }, d001)], {
        completeRowSets: [completeDecisions([d001])],
      }),
    );
    assert.equal(recreated.changes[0]?.action, "create");
  });

  test("only unresolved target resolutions block an otherwise classifiable candidate", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-route",
      code: "route-selection",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 12, end_byte: 96, line: 2 },
      raw_value: "choose a route",
      message: "The retained evidence needs an explicit route.",
    };
    const target = { kind: "milestone", key: "M009" } as const;
    const route = candidate(target, { id: "M009", title: "Selected route" });
    const cases = [
      { disposition: "unsupported" as const, applicable: false, changeCount: 0 },
      { disposition: "mapped" as const, applicable: true, changeCount: 1 },
      { disposition: "preserved" as const, applicable: true, changeCount: 1 },
    ];

    for (const resolutionCase of cases) {
      const result = classifyLegacyImportChanges(base(), interpretation([route], {
        diagnoses: [diagnosis],
        resolutions: [{
          diagnosis_id: diagnosis.diagnosis_id,
          disposition: resolutionCase.disposition,
          target,
        }],
      }));
      assert.equal(result.applicable, resolutionCase.applicable, resolutionCase.disposition);
      assert.equal(result.changes.length, resolutionCase.changeCount, resolutionCase.disposition);
    }
  });

  test("blocks an atomic row claim when one of its fields is unresolved", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-title-route",
      code: "title-route-selection",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 12, end_byte: 96, line: 2 },
      raw_value: "choose a title",
      message: "The retained title needs an explicit route.",
    };
    const result = classifyLegacyImportChanges(
      base(),
      interpretation([
        candidate(
          { kind: "milestone", key: "M010" },
          { id: "M010", title: "Unresolved", status: "pending" },
        ),
      ], {
        diagnoses: [diagnosis],
        resolutions: [{
          diagnosis_id: diagnosis.diagnosis_id,
          disposition: "requires-user",
          target: { kind: "milestone", key: "M010", field: "title" },
        }],
      }),
    );

    assert.equal(result.applicable, false);
    assert.ok(!result.changes.some((change) => change.target.key === "M010"));
  });

  test("blocks dependent lifecycle evidence when its hierarchy row is unresolved", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-task-route",
      code: "task-route-selection",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 12, end_byte: 96, line: 2 },
      raw_value: "choose a task route",
      message: "The retained task needs an explicit route.",
    };
    const result = classifyLegacyImportChanges(
      base(),
      interpretation([
        candidate(
          { kind: "task", key: "M001/S01/T01" },
          { milestone_id: "M001", slice_id: "S01", id: "T01", title: "Unresolved" },
        ),
        candidate(
          { kind: "task-status", key: "M001/S01/T01" },
          "active",
          { ordinal: 2 },
        ),
      ], {
        diagnoses: [diagnosis],
        resolutions: [{
          diagnosis_id: diagnosis.diagnosis_id,
          disposition: "requires-user",
          target: { kind: "task", key: "M001/S01/T01" },
        }],
      }),
    );

    assert.equal(result.applicable, false);
    assert.ok(!result.changes.some((change) => change.target.key === "M001/S01/T01"));
  });

  test("blocks a hierarchy field-status candidate when its status-kind spelling is unresolved", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-task-status-route",
      code: "task-status-route-selection",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 12, end_byte: 96, line: 2 },
      raw_value: "choose a task status route",
      message: "The retained task status needs an explicit route.",
    };
    const result = classifyLegacyImportChanges(
      base(),
      interpretation([
        candidate(
          { kind: "task", key: "M001/S01/T01", field: "status" },
          "active",
        ),
      ], {
        diagnoses: [diagnosis],
        resolutions: [{
          diagnosis_id: diagnosis.diagnosis_id,
          disposition: "requires-user",
          target: { kind: "task-status", key: "M001/S01/T01" },
        }],
      }),
    );

    assert.equal(result.applicable, false);
    assert.ok(!result.changes.some((change) => change.target.key === "M001/S01/T01"));
  });

  test("rejects an assessment delete identity it cannot encode injectively", () => {
    const identity = { milestone_id: "M001", slice_id: null, task_id: "T01", scope: "uat" };
    assertClassificationError(
      () => classifyLegacyImportChanges(
        base([row("assessments", identity, { ...identity, status: "pass" })]),
        interpretation([], {
          completeRowSets: [completeRowSet("assessments", "assessment", [], [])],
        }),
      ),
      "LEGACY_IMPORT_CLASSIFICATION_COMPLETE_SET_INVALID",
    );
  });

  test("derives exact task and assessment delete identities from complete snapshots", () => {
    const cases: readonly {
      rowSet: "tasks" | "assessments";
      targetKind: "task" | "assessment";
      identity: Readonly<Record<string, LegacyImportValue>>;
      value: Readonly<Record<string, LegacyImportValue>>;
      expectedKey: string;
    }[] = [
      {
        rowSet: "tasks",
        targetKind: "task",
        identity: { milestone_id: "M001", slice_id: "S01", id: "T99" },
        value: { milestone_id: "M001", slice_id: "S01", id: "T99", title: "Stale task" },
        expectedKey: "M001/S01/T99",
      },
      {
        rowSet: "assessments",
        targetKind: "assessment",
        identity: { milestone_id: "M001", slice_id: "S01", task_id: "T01", scope: "uat" },
        value: {
          milestone_id: "M001", slice_id: "S01", task_id: "T01", scope: "uat", status: "pass",
        },
        expectedKey: "M001/S01/T01/uat",
      },
      {
        rowSet: "assessments",
        targetKind: "assessment",
        identity: { milestone_id: "M002", slice_id: null, task_id: null, scope: "milestone" },
        value: {
          milestone_id: "M002", slice_id: null, task_id: null, scope: "milestone", status: "pass",
        },
        expectedKey: "M002/milestone",
      },
    ];

    for (const deleteCase of cases) {
      const result = classifyLegacyImportChanges(
        base([row(deleteCase.rowSet, deleteCase.identity, deleteCase.value)]),
        interpretation([], {
          completeRowSets: [completeRowSet(deleteCase.rowSet, deleteCase.targetKind, [], [])],
        }),
      );
      assert.deepEqual(
        result.changes.map((change) => [change.action, change.target.kind, change.target.key]),
        [["delete", deleteCase.targetKind, deleteCase.expectedKey]],
      );
    }
  });

  test("fails loud when a compare candidate has no canonical target adapter", () => {
    assert.throws(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([candidate({ kind: "mystery-authority", key: "X001" }, { id: "X001" })]),
      ),
      /unsupported legacy import comparison target/iu,
    );
  });

  test("rejects an unknown normalized field instead of silently ignoring parser drift", () => {
    assert.throws(
      () => classifyLegacyImportChanges(
        base(),
        interpretation([
          candidate(
            { kind: "milestone", key: "M001" },
            { id: "M001", title: "Foundation", future_field: "must not disappear" },
          ),
        ]),
      ),
      /milestone field future_field is not comparable/iu,
    );
  });

  test("rejects duplicate diagnosis resolutions instead of pairing by array position", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-duplicate",
      code: "ambiguous",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 0, end_byte: 1 },
      raw_value: "x",
      message: "Ambiguous.",
    };
    const resolution: LegacyImportPreviewResolution = {
      diagnosis_id: diagnosis.diagnosis_id,
      disposition: "requires-user",
    };
    assert.throws(
      () => classifyLegacyImportChanges(base(), interpretation([], {
        diagnoses: [diagnosis],
        resolutions: [resolution, resolution],
      })),
      /duplicate legacy import resolution/iu,
    );
  });

  test("requires a one-to-one diagnosis and resolution mapping", () => {
    const diagnosis: LegacyImportPreviewDiagnosis = {
      diagnosis_id: "diagnosis-bijection",
      code: "ambiguous",
      severity: "blocker",
      source_id: "source-manifest",
      locator: { start_byte: 0, end_byte: 1 },
      raw_value: "x",
      message: "Ambiguous.",
    };
    const resolution: LegacyImportPreviewResolution = {
      diagnosis_id: diagnosis.diagnosis_id,
      disposition: "requires-user",
    };
    const cases = [
      { diagnoses: [diagnosis, diagnosis], resolutions: [resolution], message: /duplicate legacy import diagnosis/iu },
      {
        diagnoses: [],
        resolutions: [{ ...resolution, diagnosis_id: "diagnosis-orphan" }],
        message: /orphan legacy import resolution/iu,
      },
      { diagnoses: [diagnosis], resolutions: [], message: /exactly one resolution/iu },
    ];

    for (const bijectionCase of cases) {
      assert.throws(
        () => classifyLegacyImportChanges(base(), interpretation([], bijectionCase)),
        bijectionCase.message,
      );
    }
  });

  test("uses stable canonical hash IDs across equivalent input orderings", () => {
    const input = actionMatrixInput();
    const first = classifyLegacyImportChanges(input.base, input.interpretation);
    const second = classifyLegacyImportChanges(
      base([...input.base.rows].reverse()),
      { ...input.interpretation, candidates: [...input.interpretation.candidates].reverse() },
    );

    assertCanonicalHashes(first);
    assert.deepEqual(
      second.changes.map((change) => change.change_id),
      first.changes.map((change) => change.change_id),
    );
  });
});
