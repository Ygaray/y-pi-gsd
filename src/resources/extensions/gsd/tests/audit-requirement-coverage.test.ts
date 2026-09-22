// Project/App: gsd-pi
// File Purpose: Proves the audit's requirement-coverage and cross-slice-wiring
// derivation is genuinely independent, exact-token, and stably ordered
// (14-03-PLAN.md Task 2) — never a substring match (T-14-17), never a
// silently-dropped foreign token (T-14-18), never a thrown exception on
// malformed `depends` JSON (T-14-21).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertRequirement,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { auditMilestone } from "../milestone-audit-domain-operation.ts";
import {
  auditCrossSliceWiring,
  auditRequirementCoverage,
  parseSupportingSliceIds,
} from "../milestone-audit-coverage.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function openFixture(milestoneId = "M001"): void {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-audit-coverage-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Audit coverage", status: "active" });
}

function insertReq(overrides: {
  id: string;
  primary_owner?: string;
  supporting_slices?: string;
}): void {
  insertRequirement({
    id: overrides.id,
    class: "functional",
    status: "active",
    description: `${overrides.id} description`,
    why: "test",
    source: "test",
    primary_owner: overrides.primary_owner ?? "",
    supporting_slices: overrides.supporting_slices ?? "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
  });
}

function insertPassingGate(milestoneId: string, sliceId: string, gateId: string): void {
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
    VALUES (:mid, :sid, :gid, 'slice', '', 'complete', 'pass', '2026-09-22T00:00:00.000Z')
  `).run({ ":mid": milestoneId, ":sid": sliceId, ":gid": gateId });
}

function insertDependencyEdge(milestoneId: string, sliceId: string, dependsOnSliceId: string): void {
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES (:mid, :sid, :dep)
  `).run({ ":mid": milestoneId, ":sid": sliceId, ":dep": dependsOnSliceId });
}

function setRawDependsColumn(milestoneId: string, sliceId: string, raw: string): void {
  db().prepare(`
    UPDATE slices SET depends = :raw WHERE milestone_id = :mid AND id = :sid
  `).run({ ":raw": raw, ":mid": milestoneId, ":sid": sliceId });
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "audit-requirement-coverage-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
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
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
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

/** Adopts M001's milestone lifecycle to "ready" — required only by the
 * auditMilestone() domain-operation tests (Test 7), not by the pure
 * auditRequirementCoverage/auditCrossSliceWiring read functions. */
function adoptMilestoneLifecycle(basePathHint = "M001"): void {
  mkdirSync(join(tmpdir()), { recursive: true });
  executeAtFence("test.audit-coverage.fixture", "fixture/audit-coverage/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: basePathHint, lifecycleStatus: "ready",
    });
  });
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Test 1: parseSupportingSliceIds tokenization ─────────────────────────

test("parseSupportingSliceIds tokenizes comma/semicolon/whitespace/markdown-decorated lists identically", () => {
  assert.deepEqual(parseSupportingSliceIds("S01, S02"), ["S01", "S02"]);
  assert.deepEqual(parseSupportingSliceIds("S01; S02"), ["S01", "S02"]);
  assert.deepEqual(parseSupportingSliceIds("S01 S02"), ["S01", "S02"]);
  assert.deepEqual(parseSupportingSliceIds("- `S01`\n- [S02]"), ["S01", "S02"]);
});

// ─── Test 2: adjacency edge — de-duplicated union ─────────────────────────

test("a slice named in both primary_owner and supporting_slices is checked once, not twice", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertReq({ id: "R001", primary_owner: "S01", supporting_slices: "S01, S02" });

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  const s01Findings = result.findings.filter((f) => f.requirementId === "R001" && f.sliceId === "S01");
  assert.equal(s01Findings.length, 1);
});

// ─── Test 3: exact-token matching — S1 never matches S10 ──────────────────

test("a requirement naming S1 against a milestone whose only slice is S10 produces slice-not-in-milestone for S1", () => {
  openFixture();
  insertSlice({ id: "S10", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "S1" });

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.findingClass, "slice-not-in-milestone");
  assert.equal(result.findings[0]!.sliceId, "S1");
});

// ─── Test 4: empty edge — blank owner and blank supporting_slices ─────────

test("a requirement with blank primary_owner and blank supporting_slices produces exactly one unmapped finding", () => {
  openFixture();
  insertReq({ id: "R001" });

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.findingClass, "unmapped");
  assert.equal(result.findings[0]!.sliceId, "");
  assert.equal(result.mappedRequirementCount, 0);
});

// ─── Test 5/6: terminal-slice gate evidence ────────────────────────────────

test("a requirement mapping to a terminal slice with zero complete+pass gates produces no-passing-gate", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "S01" });

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.findingClass, "no-passing-gate");
  assert.equal(result.mappedRequirementCount, 1);
});

test("a requirement mapping to a terminal slice carrying a complete+pass gate produces no finding", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "S01" });
  insertPassingGate("M001", "S01", "Q8");

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 0);
  assert.equal(result.mappedRequirementCount, 1);
});

// ─── CR-01 regression: certify/audit self-attestation rows never satisfy
// audit's own independent coverage check (D-01) ──────────────────────────

test("a terminal slice carrying ONLY a complete+pass CERT01 row (certify's own self-attestation, no real Gate-1 evidence) still produces no-passing-gate", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "S01" });
  insertPassingGate("M001", "S01", "CERT01");

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.findingClass, "no-passing-gate");
  assert.equal(result.mappedRequirementCount, 1);
});

test("a terminal slice carrying ONLY a complete+pass AUD02 row (a prior audit run's own self-attestation) still produces no-passing-gate", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "S01" });
  insertPassingGate("M001", "S01", "AUD02");

  const result = auditRequirementCoverage({ milestoneId: "M001" });
  assert.equal(result.findings.length, 1);
  assert.equal(result.findings[0]!.findingClass, "no-passing-gate");
  assert.equal(result.mappedRequirementCount, 1);
});

// ─── Test 7: empty edge — nothing mapped -> inconclusive, never pass ──────

test("auditMilestone records inconclusive, never pass, when no requirement maps to any slice of the milestone", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-audit-coverage-e2e-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Audit coverage e2e", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertReq({ id: "R001", primary_owner: "" });
  adoptMilestoneLifecycle("M001");

  const receipt = auditMilestone({
    invocation: invocation("audit/coverage/empty-mapping"),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });
  assert.equal(receipt.verdict, "inconclusive");

  const rationaleRow = db().prepare(`
    SELECT verdict.rationale AS rationale
    FROM workflow_technical_verdicts verdict
    JOIN workflow_acceptance_criteria criterion ON criterion.criterion_id = verdict.criterion_id
    WHERE criterion.criterion_key = 'milestone-audit:requirement-coverage'
  `).get() as Record<string, unknown>;
  assert.match(String(rationaleRow["rationale"]), /0 mapped|zero.*mapped/i);
});

// ─── Test 8: ordering edge — stable, deep-equal across calls ──────────────

test("findings are ordered by requirementId then sliceId, and two consecutive calls are deep-equal", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertReq({ id: "R002", primary_owner: "S02" });
  insertReq({ id: "R001", primary_owner: "S01" });

  const first = auditRequirementCoverage({ milestoneId: "M001" });
  const expected = [
    { requirementId: "R001", sliceId: "S01", findingClass: "slice-not-terminal", detail: first.findings[0]!.detail },
    { requirementId: "R002", sliceId: "S02", findingClass: "slice-not-terminal", detail: first.findings[1]!.detail },
  ];
  assert.deepEqual(first.findings, expected);

  const second = auditRequirementCoverage({ milestoneId: "M001" });
  assert.deepEqual(second.findings, first.findings);
});

// ─── Test 9: cross-slice wiring disagreement, both directions ────────────

test("an edge in slice_dependencies absent from slices.depends produces edge-missing-from-depends-column", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertDependencyEdge("M001", "S01", "S02");

  const findings = auditCrossSliceWiring({ milestoneId: "M001" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.findingClass, "edge-missing-from-depends-column");
  assert.equal(findings[0]!.sliceId, "S01");
  assert.equal(findings[0]!.dependsOnSliceId, "S02");
});

test("an edge in slices.depends absent from slice_dependencies produces edge-missing-from-dependencies-table", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress", depends: ["S02"] });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });

  const findings = auditCrossSliceWiring({ milestoneId: "M001" });
  assert.equal(findings.length, 1);
  assert.equal(findings[0]!.findingClass, "edge-missing-from-dependencies-table");
  assert.equal(findings[0]!.sliceId, "S01");
  assert.equal(findings[0]!.dependsOnSliceId, "S02");
});

// ─── Test 10: foreign target + unparseable JSON, never throws ────────────

test("a depends entry naming a slice absent from the milestone produces depends-target-not-in-milestone", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress", depends: ["S99"] });

  const findings = auditCrossSliceWiring({ milestoneId: "M001" });
  const foreignTarget = findings.filter((f) => f.findingClass === "depends-target-not-in-milestone");
  assert.equal(foreignTarget.length, 1);
  assert.equal(foreignTarget[0]!.sliceId, "S01");
  assert.equal(foreignTarget[0]!.dependsOnSliceId, "S99");
});

test("a slices.depends value that is not valid JSON produces depends-column-unparseable rather than throwing", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  setRawDependsColumn("M001", "S01", "{not valid json");

  assert.doesNotThrow(() => {
    const findings = auditCrossSliceWiring({ milestoneId: "M001" });
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.findingClass, "depends-column-unparseable");
    assert.equal(findings[0]!.sliceId, "S01");
  });
});

// ─── Test 11: agreeing representations -> empty array ─────────────────────

test("auditCrossSliceWiring returns an empty array when both representations agree exactly", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress", depends: ["S02"] });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  insertDependencyEdge("M001", "S01", "S02");

  const findings = auditCrossSliceWiring({ milestoneId: "M001" });
  assert.deepEqual(findings, []);
});
