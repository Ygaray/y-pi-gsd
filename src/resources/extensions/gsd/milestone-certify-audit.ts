// Project/App: gsd-pi
// File Purpose: Derive every slice's certify gaps from durable DB state only
// (CERT-01). No filesystem access, no SELF-UAT re-parse — the four durable
// sources below (quality_gates, rework_briefs, human_uat_pending,
// slice_dependencies) are the sole inputs, so a certify replay is stable even
// if a Gate-1 artifact was later moved or archived (14-01-PLAN OQ1, RESEARCH
// Anti-pattern 3).

import { getDb } from "./db/engine.js";
import { getGateResults, getMilestoneSlices } from "./db/queries.js";
import { getOwnerTurn } from "./gate-registry.js";
import { countReworkBriefsForSlice } from "./gsd-db.js";
import { readOutstandingGate2HumanUat } from "./milestone-gate2-human-uat-domain-operation.js";
import type { CertifyGap, CertifyGapClass } from "./milestone-certify-self-fix.js";
import { RAW_CLOSED_STATUSES } from "./status-guards.js";

export type { CertifyGap, CertifyGapClass } from "./milestone-certify-self-fix.js";

const RAW_CLOSED_STATUS_SET: ReadonlySet<string> = new Set(RAW_CLOSED_STATUSES);

function isTerminalSliceStatus(status: string): boolean {
  return RAW_CLOSED_STATUS_SET.has(status);
}

interface SliceDependencyEdgeRow {
  slice_id: string;
  depends_on_slice_id: string;
}

/**
 * Deterministic identity for a certify gap — a pure function of
 * `(gapClass, sliceId, gateId)`. Determinism is load-bearing: the self-fix
 * cap in `milestone-certify-self-fix.ts` counts events by `gapId`, so a
 * non-deterministic id (a timestamp, a UUID, a row rowid) would reset the
 * budget on every certify pass and make D-02's cap unenforceable.
 */
export function certifyGapId(gapClass: CertifyGapClass, sliceId: string, gateId: string): string {
  return `${gapClass}:${sliceId}:${gateId}`;
}

function sliceHasAnyHumanUatEntry(projectId: string, milestoneId: string, sliceId: string): boolean {
  const outstanding = readOutstandingGate2HumanUat({ projectId, milestoneId })
    .some((entry) => entry.sliceId === sliceId);
  if (outstanding) return true;
  const resolvedRow = getDb().prepare(`
    SELECT COUNT(*) AS n FROM human_uat_pending
    WHERE project_id = :project_id AND milestone_id = :milestone_id AND slice_id = :slice_id
      AND status IN ('signed-off', 'signed-off-with-gap')
  `).get({
    ":project_id": projectId,
    ":milestone_id": milestoneId,
    ":slice_id": sliceId,
  }) as Record<string, unknown> | undefined;
  return Number(resolvedRow?.["n"] ?? 0) > 0;
}

/**
 * Derive every slice's certify gaps from durable DB state (CERT-01). Reads
 * FOUR sources and nothing else: `quality_gates` (via `getGateResults`),
 * `rework_briefs` (via `countReworkBriefsForSlice`), `human_uat_pending`
 * (open via `readOutstandingGate2HumanUat`, resolved via a direct read), and
 * `slice_dependencies`. Returns a stably-ordered array — deep-equal across
 * repeated calls against unchanged DB state.
 */
export function auditMilestoneSliceGates(input: {
  projectId: string;
  milestoneId: string;
}): CertifyGap[] {
  const { projectId, milestoneId } = input;
  const slices = getMilestoneSlices(milestoneId);
  if (slices.length === 0) return [];

  const sliceIds = new Set(slices.map((s) => s.id));
  const gaps: CertifyGap[] = [];

  const dependencyEdges = getDb().prepare(`
    SELECT slice_id, depends_on_slice_id FROM slice_dependencies WHERE milestone_id = :milestone_id
  `).all({ ":milestone_id": milestoneId }) as unknown as SliceDependencyEdgeRow[];

  for (const slice of slices) {
    const sliceId = slice.id;
    const gateRows = getGateResults(milestoneId, sliceId);

    for (const gateRow of gateRows) {
      if (gateRow.status === "pending") {
        gaps.push({
          gapId: certifyGapId("gate-pending", sliceId, gateRow.gate_id),
          gapClass: "gate-pending",
          milestoneId,
          sliceId,
          gateId: gateRow.gate_id,
          ownerTurn: getOwnerTurn(gateRow.gate_id),
          fixable: true,
          description: `Slice ${sliceId} has gate ${gateRow.gate_id} pending`,
          evidence: gateRow.rationale.trim() || `quality_gates row status=pending for ${gateRow.gate_id}`,
        });
      } else if (gateRow.status === "complete" && gateRow.verdict === "flag") {
        gaps.push({
          gapId: certifyGapId("gate-flagged", sliceId, gateRow.gate_id),
          gapClass: "gate-flagged",
          milestoneId,
          sliceId,
          gateId: gateRow.gate_id,
          ownerTurn: getOwnerTurn(gateRow.gate_id),
          fixable: true,
          description: `Slice ${sliceId} has gate ${gateRow.gate_id} flagged`,
          evidence: gateRow.findings.trim() || gateRow.rationale.trim()
            || `quality_gates row verdict=flag for ${gateRow.gate_id}`,
        });
      }
      // verdict === "omitted" is a recorded decision, not a gap — skip.
    }

    if (isTerminalSliceStatus(slice.status)) {
      const reworkCount = countReworkBriefsForSlice(milestoneId, sliceId);
      const hasHumanUatEntry = sliceHasAnyHumanUatEntry(projectId, milestoneId, sliceId);
      const cert01Row = gateRows.find((g) => g.gate_id === "CERT01" && g.evaluated_at !== null);
      if (reworkCount === 0 && !hasHumanUatEntry && !cert01Row) {
        gaps.push({
          gapId: certifyGapId("gate1-record-missing", sliceId, "CERT01"),
          gapClass: "gate1-record-missing",
          milestoneId,
          sliceId,
          gateId: "CERT01",
          ownerTurn: getOwnerTurn("CERT01"),
          fixable: false,
          description: `Slice ${sliceId} is terminal with no durable Gate-1 record`,
          evidence: `zero gap-closure rework briefs, zero human_uat_pending entries, `
            + `no evaluated CERT01 row for ${sliceId}`,
        });
      }

      const brokenEdges = dependencyEdges.filter((edge) => {
        if (edge.slice_id !== sliceId) return false;
        const target = edge.depends_on_slice_id;
        if (!sliceIds.has(target)) return true;
        const targetSlice = slices.find((s) => s.id === target);
        return targetSlice ? !isTerminalSliceStatus(targetSlice.status) : true;
      });
      if (brokenEdges.length > 0) {
        gaps.push({
          gapId: certifyGapId("integration-gap", sliceId, "CERT02"),
          gapClass: "integration-gap",
          milestoneId,
          sliceId,
          gateId: "CERT02",
          ownerTurn: getOwnerTurn("CERT02"),
          fixable: false,
          description: `Slice ${sliceId} depends on a slice that is missing or not terminal`,
          evidence: brokenEdges
            .map((edge) => `${sliceId} -> ${edge.depends_on_slice_id}`)
            .join("; "),
        });
      }
    }
  }

  return gaps.sort((a, b) => a.sliceId.localeCompare(b.sliceId) || a.gapId.localeCompare(b.gapId));
}
