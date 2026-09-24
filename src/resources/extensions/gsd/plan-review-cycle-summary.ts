/**
 * CYCLE_SUMMARY structured-artifact contract for plan-review convergence
 * (Phase 20, CONV-01 / D-02).
 *
 * Mirrors `verify-agentic-log.ts`'s `parseSelfUatCriteria`/`aggregateSelfUat`
 * shape line-for-line: a `### N. <lane>` heading opens a per-lane record,
 * `status:`/`high:`/`actionable:` field lines fill it, the next `### `
 * heading closes it, and a record is accepted only when every field passes
 * its guard. This module performs NO filesystem, network, or
 * process-spawning I/O — `parsePlanReviewCycleSummary` and
 * `aggregatePlanReviewCycle` are pure functions: plain data in, plain data
 * out. `plan-review-convergence.ts` is the real caller: it reads the on-disk
 * artifact with `readFileSync` and hands the raw content to this module.
 * Never trust the review turn's free-text chat reply (D-02) — this module's
 * only input is the on-disk artifact content, nothing else.
 */

import { PATCH_MARKER_PATTERN, slugifyTarget } from "./verify-agentic-log.js";

/** Closed three-literal verdict set `aggregatePlanReviewCycle` can derive (D-02). */
export const PLAN_REVIEW_CYCLE_VERDICTS = ["converged", "reround", "blocked"] as const;
export type PlanReviewCycleVerdict = (typeof PLAN_REVIEW_CYCLE_VERDICTS)[number];

/** Closed per-lane status set a CYCLE_SUMMARY lane record may report. */
export const PLAN_REVIEW_LANE_STATUSES = ["reviewed", "stubbed", "failed"] as const;
export type PlanReviewLaneStatus = (typeof PLAN_REVIEW_LANE_STATUSES)[number];

/** One reviewer lane's reported outcome for a single cycle. */
export interface PlanReviewLaneState {
  lane: string;
  status: PlanReviewLaneStatus;
  high: number;
  actionable: number;
}

/** The parsed CYCLE_SUMMARY document for one cycle. */
export interface PlanReviewCycleSummary {
  target: string;
  cycle: number;
  lanes: PlanReviewLaneState[];
}

/** The verdict + rolled-up counts `aggregatePlanReviewCycle` derives. */
export interface PlanReviewCycleAggregate {
  verdict: PlanReviewCycleVerdict;
  highCount: number;
  actionableCount: number;
}

function isPlanReviewLaneStatus(value: string): value is PlanReviewLaneStatus {
  return (PLAN_REVIEW_LANE_STATUSES as readonly string[]).includes(value);
}

/** A finite, non-negative integer string, with no sign or decimal point. */
function isFiniteNonNegativeIntegerString(value: string): boolean {
  return /^\d+$/.test(value.trim());
}

/**
 * Parse a CYCLE_SUMMARY document's body into per-lane records, inverting the
 * review prompt's own required emission shape: a `### N. <lane>` heading
 * (ordinal-prefixed) opens a record; while a record is open, `status: `,
 * `high: `, and `actionable: ` prefixed lines fill the corresponding field;
 * the next `### ` heading (ordinal or not) closes the current record, but
 * only an ordinal-prefixed heading opens a new one. Before any lane record
 * opens, `target: ` and `cycle: ` header lines (mirroring
 * `verify-agentic-log.ts`'s `target:`/`surface:` header block) populate the
 * summary's own metadata.
 *
 * A lane record is accepted only when its lane name is non-empty after
 * trimming, its status is an EXACT-CASE member of
 * {@link PLAN_REVIEW_LANE_STATUSES}, both counts parse as finite,
 * non-negative integers, and no field matches {@link PATCH_MARKER_PATTERN}
 * (Security Domain V5/Tampering — a malformed or adversarial artifact is
 * dropped, never coerced). This function must never throw: the artifact is
 * written by a separate model turn, so malformed or truncated input yields
 * the records it can trust (possibly none), never an exception.
 */
export function parsePlanReviewCycleSummary(content: string): PlanReviewCycleSummary {
  let target = "";
  let cycle = 0;
  const lanes: PlanReviewLaneState[] = [];
  let current: {
    lane: string;
    status?: string;
    high?: string;
    actionable?: string;
  } | null = null;

  const flush = (): void => {
    if (!current) return;
    const record = current;
    current = null;
    const lane = record.lane.trim();
    const status = record.status?.trim();
    const high = record.high?.trim();
    const actionable = record.actionable?.trim();
    if (
      lane.length === 0 ||
      typeof status !== "string" ||
      !isPlanReviewLaneStatus(status) ||
      typeof high !== "string" ||
      !isFiniteNonNegativeIntegerString(high) ||
      typeof actionable !== "string" ||
      !isFiniteNonNegativeIntegerString(actionable) ||
      PATCH_MARKER_PATTERN.test(lane) ||
      PATCH_MARKER_PATTERN.test(status) ||
      PATCH_MARKER_PATTERN.test(high) ||
      PATCH_MARKER_PATTERN.test(actionable)
    ) {
      return;
    }
    lanes.push({
      lane,
      status,
      high: Number(high),
      actionable: Number(actionable),
    });
  };

  for (const line of content.split("\n")) {
    if (!current) {
      if (line.startsWith("target: ")) {
        target = line.slice("target: ".length).trim();
        continue;
      }
      if (line.startsWith("cycle: ")) {
        const raw = line.slice("cycle: ".length).trim();
        if (isFiniteNonNegativeIntegerString(raw)) cycle = Number(raw);
        continue;
      }
    }

    const orderedHeading = line.match(/^### (\d+)\. (.*)$/);
    if (orderedHeading) {
      flush();
      current = { lane: orderedHeading[2] ?? "" };
      continue;
    }
    if (line.startsWith("### ")) {
      // A `### ` heading with no ordinal prefix never opens a record; it
      // only closes whatever record (if any) was already open.
      flush();
      continue;
    }
    if (!current) continue;
    if (line.startsWith("status: ")) {
      current.status = line.slice("status: ".length).trim();
    } else if (line.startsWith("high: ")) {
      current.high = line.slice("high: ".length).trim();
    } else if (line.startsWith("actionable: ")) {
      current.actionable = line.slice("actionable: ".length).trim();
    }
  }
  flush();

  return { target, cycle, lanes };
}

/**
 * Derive the verdict and rolled-up HIGH/actionable counts from a parsed
 * CYCLE_SUMMARY (D-02). Precedence ladder mirroring `aggregateSelfUat`:
 * zero lanes is its own distinct non-pass outcome first (nothing reviewed
 * can never read as converged — the Phase 09 `no_criteria` lesson); any lane
 * `failed` or `stubbed` takes precedence over the counts and forces
 * `blocked`; else any lane reporting `high > 0` or `actionable > 0` forces
 * `reround`; only when every lane was fully `reviewed` with zero HIGH and
 * zero actionable concerns does the cycle read as `converged`.
 */
export function aggregatePlanReviewCycle(summary: PlanReviewCycleSummary): PlanReviewCycleAggregate {
  const { lanes } = summary;
  const highCount = lanes.reduce((sum, lane) => sum + lane.high, 0);
  const actionableCount = lanes.reduce((sum, lane) => sum + lane.actionable, 0);

  if (lanes.length === 0) {
    return { verdict: "blocked", highCount, actionableCount };
  }
  if (lanes.some((lane) => lane.status === "failed" || lane.status === "stubbed")) {
    return { verdict: "blocked", highCount, actionableCount };
  }
  if (highCount > 0 || actionableCount > 0) {
    return { verdict: "reround", highCount, actionableCount };
  }
  return { verdict: "converged", highCount, actionableCount };
}

/**
 * Compute the CYCLE_SUMMARY artifact filename for a given target and cycle
 * number: `{slugifyTarget(target)}-c{cycle}-CYCLE-SUMMARY.md`, reusing the
 * exported `slugifyTarget` rather than a second slug implementation.
 */
export function planReviewCycleSummaryFileName(target: string, cycle: number): string {
  return `${slugifyTarget(target)}-c${cycle}-CYCLE-SUMMARY.md`;
}
