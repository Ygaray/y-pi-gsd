// Project/App: gsd-pi
// File Purpose: Independent requirement-coverage and cross-slice-wiring
// derivation for the audit stage (CERT-02). Reads durable DB state directly
// (getActiveRequirements/getMilestoneSlices/getGateResults, the raw `slices`
// table, and `slice_dependencies`) and never reuses, wraps, or re-runs
// validate-milestone's MV03/MV04 or certify's CERT02 conclusion — RESEARCH
// Pitfall 3, D-01. Matching is always exact-token equality against this
// milestone's actual slice id set: no `LIKE`, no `.includes(` anywhere in
// the slice-id matching path, because a substring match would let a
// requirement naming "S1" claim slice "S10"'s coverage (T-14-17).

import { getDb } from "./db/engine.js";
import { getActiveRequirements, getGateResults, getMilestoneSlices } from "./db/queries.js";
import { getGateIdsForTurn } from "./gate-registry.js";
import { RAW_CLOSED_STATUSES } from "./status-guards.js";

export type RequirementCoverageFindingClass =
  | "unmapped"
  | "slice-not-in-milestone"
  | "slice-not-terminal"
  | "no-passing-gate";

export interface RequirementCoverageFinding {
  requirementId: string;
  sliceId: string;
  findingClass: RequirementCoverageFindingClass;
  detail: string;
}

export type CrossSliceWiringFindingClass =
  | "edge-missing-from-depends-column"
  | "edge-missing-from-dependencies-table"
  | "depends-target-not-in-milestone"
  | "depends-column-unparseable";

export interface CrossSliceWiringFinding {
  sliceId: string;
  dependsOnSliceId: string;
  findingClass: CrossSliceWiringFindingClass;
  detail: string;
}

export interface RequirementCoverageResult {
  findings: RequirementCoverageFinding[];
  /** Requirements with at least one token matching an actual slice of this milestone. */
  requirementsExamined: number;
  mappedRequirementCount: number;
}

const RAW_CLOSED_STATUS_SET: ReadonlySet<string> = new Set(RAW_CLOSED_STATUSES);

function isTerminalSliceStatus(status: string): boolean {
  return RAW_CLOSED_STATUS_SET.has(status);
}

/**
 * Tokenize a free-text `primary_owner`/`supporting_slices` value defensively:
 * split on commas, semicolons, and whitespace; strip markdown list markers,
 * backticks, and bracket/paren decoration from each surviving token; drop
 * empties; de-duplicate preserving first-seen order. Performs NO slice
 * lookup — matching against this milestone's actual slice ids is the
 * caller's job, and it is always exact-token equality (RESEARCH A3).
 */
export function parseSupportingSliceIds(value: string): string[] {
  if (!value) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of value.split(/[,;\s]+/)) {
    let token = raw.trim();
    if (!token) continue;
    // Strip leading markdown list markers (-, *, +).
    token = token.replace(/^[-*+]+/, "");
    // Strip backticks and bracket/paren decoration anywhere in the token.
    token = token.replace(/[`[\]()]/g, "");
    token = token.trim();
    if (!token) continue;
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

function dedupePreserveOrder(tokens: string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const token of tokens) {
    if (seen.has(token)) continue;
    seen.add(token);
    result.push(token);
  }
  return result;
}

/**
 * Self-attestation gate ids from BOTH the certify and audit stages
 * themselves — never valid evidence that a requirement's slice is
 * "genuinely satisfied" for AUD02's own independent check (D-01: audit
 * must never be a function of the signal it independently checks).
 */
const SELF_ATTESTATION_GATE_IDS: ReadonlySet<string> = new Set([
  ...getGateIdsForTurn("certify-milestone"),
  ...getGateIdsForTurn("audit-milestone"),
]);

function sliceHasPassingGate(milestoneId: string, sliceId: string): boolean {
  return getGateResults(milestoneId, sliceId).some(
    (gate) =>
      gate.status === "complete" &&
      gate.verdict === "pass" &&
      !SELF_ATTESTATION_GATE_IDS.has(gate.gate_id),
  );
}

/**
 * Independently re-derive requirement coverage (AUD02): for every active
 * requirement, take the exact-token union of `parseSupportingSliceIds`
 * applied to `primary_owner` and `supporting_slices`, then match each token
 * by exact equality against this milestone's actual slice ids. A
 * requirement's tokens are de-duplicated BEFORE matching so a slice named in
 * both `primary_owner` and `supporting_slices` is checked once, not twice
 * (CERT-02 adjacency edge). Returns findings ordered by `requirementId` then
 * `sliceId` ascending — stable across repeated calls on unchanged state.
 */
export function auditRequirementCoverage(input: { milestoneId: string }): RequirementCoverageResult {
  const { milestoneId } = input;
  const slices = getMilestoneSlices(milestoneId);
  const sliceById = new Map(slices.map((slice) => [slice.id, slice]));

  const findings: RequirementCoverageFinding[] = [];
  let requirementsExamined = 0;
  let mappedRequirementCount = 0;

  for (const requirement of getActiveRequirements()) {
    requirementsExamined += 1;
    const tokens = dedupePreserveOrder([
      ...parseSupportingSliceIds(requirement.primary_owner),
      ...parseSupportingSliceIds(requirement.supporting_slices),
    ]);

    if (tokens.length === 0) {
      findings.push({
        requirementId: requirement.id,
        sliceId: "",
        findingClass: "unmapped",
        detail: `requirement ${requirement.id} has a blank primary_owner and blank supporting_slices`,
      });
      continue;
    }

    let mappedToThisMilestone = false;
    for (const token of tokens) {
      const slice = sliceById.get(token);
      if (!slice) {
        // Out of scope for THIS milestone (a foreign or stale slice id) —
        // still reported so nothing silently vanishes, but not counted as
        // "mapped" and not itself an "unmapped" finding (T-14-18).
        findings.push({
          requirementId: requirement.id,
          sliceId: token,
          findingClass: "slice-not-in-milestone",
          detail: `requirement ${requirement.id} names slice "${token}", which is not a slice of milestone ${milestoneId}`,
        });
        continue;
      }
      mappedToThisMilestone = true;
      if (!isTerminalSliceStatus(slice.status)) {
        findings.push({
          requirementId: requirement.id,
          sliceId: token,
          findingClass: "slice-not-terminal",
          detail: `requirement ${requirement.id} maps to slice ${token}, which is not terminal (status=${slice.status})`,
        });
        continue;
      }
      if (!sliceHasPassingGate(milestoneId, token)) {
        findings.push({
          requirementId: requirement.id,
          sliceId: token,
          findingClass: "no-passing-gate",
          detail: `requirement ${requirement.id} maps to terminal slice ${token}, which carries no complete+pass quality_gates row`,
        });
      }
    }
    if (mappedToThisMilestone) mappedRequirementCount += 1;
  }

  findings.sort((a, b) =>
    a.requirementId.localeCompare(b.requirementId) || a.sliceId.localeCompare(b.sliceId)
  );

  return { findings, requirementsExamined, mappedRequirementCount };
}

interface RawSliceDependsRow {
  id: string;
  depends: string;
}

interface SliceDependencyEdgeRow {
  slice_id: string;
  depends_on_slice_id: string;
}

function edgeKey(sliceId: string, dependsOnSliceId: string): string {
  return `${sliceId}\u0000${dependsOnSliceId}`;
}

/**
 * Independently cross-check TWO stored representations of the same
 * dependency graph — the `slices.depends` JSON column and the
 * `slice_dependencies` junction table — and report every disagreement
 * between them (AUD01). Never reads `getMilestoneSlices()`'s already-parsed
 * `depends` array: a slice's raw `depends` column is read here directly so a
 * malformed value becomes a `depends-column-unparseable` finding instead of
 * throwing (T-14-21).
 */
export function auditCrossSliceWiring(input: { milestoneId: string }): CrossSliceWiringFinding[] {
  const { milestoneId } = input;
  const rawSlices = getDb().prepare(`
    SELECT id, depends FROM slices WHERE milestone_id = :milestone_id
  `).all({ ":milestone_id": milestoneId }) as unknown as RawSliceDependsRow[];
  if (rawSlices.length === 0) return [];

  const sliceIds = new Set(rawSlices.map((slice) => slice.id));
  const findings: CrossSliceWiringFinding[] = [];

  const aEdges = getDb().prepare(`
    SELECT slice_id, depends_on_slice_id FROM slice_dependencies WHERE milestone_id = :milestone_id
  `).all({ ":milestone_id": milestoneId }) as unknown as SliceDependencyEdgeRow[];
  const aEdgeSet = new Set(aEdges.map((edge) => edgeKey(edge.slice_id, edge.depends_on_slice_id)));

  const bEdgesBySlice = new Map<string, string[]>();
  const unparseableSliceIds = new Set<string>();

  for (const slice of rawSlices) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(slice.depends || "[]");
    } catch {
      unparseableSliceIds.add(slice.id);
      findings.push({
        sliceId: slice.id,
        dependsOnSliceId: "",
        findingClass: "depends-column-unparseable",
        detail: `slice ${slice.id}'s depends column is not valid JSON: ${slice.depends}`,
      });
      continue;
    }
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      unparseableSliceIds.add(slice.id);
      findings.push({
        sliceId: slice.id,
        dependsOnSliceId: "",
        findingClass: "depends-column-unparseable",
        detail: `slice ${slice.id}'s depends column did not parse to a JSON array of strings: ${slice.depends}`,
      });
      continue;
    }
    bEdgesBySlice.set(slice.id, parsed);
  }

  const bEdgeSet = new Set<string>();
  for (const [sliceId, targets] of bEdgesBySlice) {
    for (const target of targets) {
      bEdgeSet.add(edgeKey(sliceId, target));
      if (!sliceIds.has(target)) {
        findings.push({
          sliceId,
          dependsOnSliceId: target,
          findingClass: "depends-target-not-in-milestone",
          detail: `slice ${sliceId} depends on "${target}", which is not a slice of milestone ${milestoneId}`,
        });
      }
    }
  }

  for (const edge of aEdges) {
    if (unparseableSliceIds.has(edge.slice_id)) continue;
    if (!bEdgeSet.has(edgeKey(edge.slice_id, edge.depends_on_slice_id))) {
      findings.push({
        sliceId: edge.slice_id,
        dependsOnSliceId: edge.depends_on_slice_id,
        findingClass: "edge-missing-from-depends-column",
        detail: `slice_dependencies has ${edge.slice_id} -> ${edge.depends_on_slice_id}, but slices.depends does not`,
      });
    }
  }
  for (const [sliceId, targets] of bEdgesBySlice) {
    for (const target of targets) {
      if (!aEdgeSet.has(edgeKey(sliceId, target))) {
        findings.push({
          sliceId,
          dependsOnSliceId: target,
          findingClass: "edge-missing-from-dependencies-table",
          detail: `slices.depends has ${sliceId} -> ${target}, but slice_dependencies does not`,
        });
      }
    }
  }

  findings.sort((a, b) =>
    a.sliceId.localeCompare(b.sliceId) || a.dependsOnSliceId.localeCompare(b.dependsOnSliceId)
  );
  return findings;
}
