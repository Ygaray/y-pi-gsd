// Project/App: gsd-pi
// File Purpose: Single source of truth for the residual-HIGH disposition
// vocabulary (CONV-03/CONV-04) — the durable tag literals a plan-review
// cap-hit promotion writes and the two tracker read predicates that consume
// them. Both ends of the contract (the promotion writer in
// plan-review-convergence.ts and the execute-gate reader in auto-dispatch.ts)
// import from here so the tag literals and ref shape can never drift apart.

import { dirname } from "node:path";

import {
  createTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemRow,
} from "./db/writers/tracker-item.js";
import { immediateTransaction, getDbPath, isDbAvailable } from "./db/engine.js";
import { readTrackerItems } from "./tracker-projection.js";

/** Class marker tag: every residual-HIGH promotion carries this, independent
 * of milestone/disposition, so the set is queryable as a group (CONV-05). */
export const PLAN_REVIEW_RESIDUAL_HIGH_TAG = "plan-review-residual-high";

/** The one disposition tag CONV-04's execute gate actually filters on. */
export const MUST_FIX_IN_EXECUTE_DISPOSITION_TAG = "must-fix-in-execute";

/** A non-gating disposition: the residual HIGH is tracked but does not block
 * execute — the requirement itself needs to be rescoped instead. */
export const RESCOPE_REQUIREMENT_DISPOSITION_TAG = "rescope-requirement";

/** Prefix for the third non-gating disposition family: deferred to a named
 * future phase. Use `deferredToPhaseDispositionTag` to build the full tag. */
export const DEFERRED_TO_PHASE_DISPOSITION_TAG_PREFIX = "deferred-to-phase-";

/** Build the `deferred-to-phase-N` disposition tag for a given phase token. */
export function deferredToPhaseDispositionTag(phase: string): string {
  return `${DEFERRED_TO_PHASE_DISPOSITION_TAG_PREFIX}${phase.trim()}`;
}

/**
 * Mechanical vocabulary guard: is `tag` one of the three locked disposition
 * literals? Accepts the two exact literals, or any string starting with the
 * deferred-to-phase prefix and carrying at least one further character (a
 * bare prefix with nothing appended is not a valid phase reference). An
 * unrecognised tag is never treated as a disposition.
 */
export function isResidualHighDispositionTag(tag: string): boolean {
  if (tag === MUST_FIX_IN_EXECUTE_DISPOSITION_TAG) return true;
  if (tag === RESCOPE_REQUIREMENT_DISPOSITION_TAG) return true;
  return tag.startsWith(DEFERRED_TO_PHASE_DISPOSITION_TAG_PREFIX)
    && tag.length > DEFERRED_TO_PHASE_DISPOSITION_TAG_PREFIX.length;
}

/** The milestone-scope tag convention `milestone-closeout-residual-capture.ts`
 * already writes — reused verbatim here so both scoping mechanisms agree. */
export function milestoneScopeTag(milestoneId: string): string {
  return `milestone:${milestoneId}`;
}

export interface PlanReviewResidualPromotion {
  trackId: string | null;
  skipped: boolean;
  failure: string | null;
}

export interface PromotePlanReviewResidualHighInput {
  milestoneId: string;
  sliceId: string;
  cycle: number;
  highCount: number;
  actionableCount: number;
  laneStatesJson: string;
  artifactPath: string;
  disposition?: string;
  basePath?: string;
}

/** `.gsd/gsd.db` -> the project's basePath, mirroring
 * `milestone-lifecycle-domain-operation.ts`'s `residualCaptureBasePath()`
 * fallback exactly: the caller's own `basePath` wins when non-empty, else the
 * open DB's own path derives it, else `process.cwd()`. */
function residualPromotionBasePath(basePath: string | undefined): string {
  if (basePath) return basePath;
  const dbPath = getDbPath();
  if (dbPath) return dirname(dirname(dbPath));
  return process.cwd();
}

/**
 * A stable, order-independent identity over a normalised title plus its ref
 * set — mirrors `milestone-closeout-residual-capture.ts`'s `itemIdentity`
 * verbatim, so a repeated promotion against the same cap-hit cycle row and
 * artifact collapses to exactly one row instead of piling up.
 */
function itemIdentity(title: string, refs: readonly TrackerItemRefInput[]): string {
  const normalizedTitle = title.trim();
  const refKey = [...refs]
    .map((ref) => `${ref.refKind}:${ref.refValue}`)
    .sort()
    .join("|");
  return `${normalizedTitle}::${refKey}`;
}

/**
 * Promote one cap-hit cycle's residual HIGH into a durable tracker row.
 * Never throws — a promotion failure (validation error, closed DB, write
 * error) must never abort the cap-hit escalation notice the caller already
 * depends on. Returns `{trackId:null, skipped:true, failure:null}` when
 * `highCount` is not a positive integer (no promotion attempted) or when an
 * identical promotion (same normalized title + sorted ref set) already
 * exists. The existence-check and insert run inside a single
 * `immediateTransaction` so a concurrent close or a concurrent promotion
 * cannot produce two rows for one identity.
 */
export function promotePlanReviewResidualHigh(
  input: PromotePlanReviewResidualHighInput,
): PlanReviewResidualPromotion {
  if (!Number.isInteger(input.highCount) || input.highCount <= 0) {
    return { trackId: null, skipped: true, failure: null };
  }

  const effectiveBasePath = residualPromotionBasePath(input.basePath);
  const disposition = input.disposition ?? MUST_FIX_IN_EXECUTE_DISPOSITION_TAG;

  try {
    return immediateTransaction((): PlanReviewResidualPromotion => {
      const title =
        `Plan-review residual HIGH (cycle ${input.cycle}): ${input.highCount} HIGH / ` +
        `${input.actionableCount} actionable concern(s) unresolved at cap`;
      const refs: TrackerItemRefInput[] = [
        { refKind: "phase", refValue: input.sliceId },
        { refKind: "reviews_md", refValue: input.artifactPath },
      ];
      const identity = itemIdentity(title, refs);

      const existing = readTrackerItems();
      const alreadyExists = existing.some((row) => itemIdentity(row.title, row.refs) === identity);
      if (alreadyExists) {
        return { trackId: null, skipped: true, failure: null };
      }

      try {
        const { trackId } = createTrackerItem(
          {
            type: "incident",
            severity: "HIGH",
            title,
            detail: input.laneStatesJson,
            dispositionTags: [PLAN_REVIEW_RESIDUAL_HIGH_TAG, milestoneScopeTag(input.milestoneId), disposition],
            refs,
          },
          effectiveBasePath,
        );
        return { trackId, skipped: false, failure: null };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { trackId: null, skipped: false, failure: message };
      }
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return { trackId: null, skipped: false, failure: message };
  }
}

/**
 * CONV-04's read predicate: open `must-fix-in-execute` tracker items ref'd to
 * `sliceId`. Returns `[]` when the DB is unavailable, `sliceId` is blank, or a
 * read fails — never throws into the dispatch resolver. Order is inherited
 * from `readTrackerItems()` (`ORDER BY created_at ASC, id ASC`) — not re-sorted.
 */
export function findBlockingMustFixInExecuteItems(sliceId: string): TrackerItemRow[] {
  if (!isDbAvailable() || !sliceId || sliceId.trim().length === 0) return [];
  try {
    return readTrackerItems().filter(
      (item) =>
        item.status !== "resolved"
        && item.status !== "closed"
        && item.status !== "wont-fix"
        && item.dispositionTags.includes(MUST_FIX_IN_EXECUTE_DISPOSITION_TAG)
        && item.refs.some((ref) => ref.refKind === "phase" && ref.refValue === sliceId),
    );
  } catch {
    return [];
  }
}

/**
 * CONV-05's aggregation predicate: every tracker row carrying BOTH the class
 * marker and the milestone scope tag, reduced to a count plus the
 * de-duplicated, first-seen-order list of `phase` ref values across those
 * rows. Returns `{count:0, phases:[]}` when the DB is unavailable.
 */
export function summarizeResidualHighForMilestone(
  milestoneId: string,
): { count: number; phases: string[] } {
  if (!isDbAvailable()) return { count: 0, phases: [] };
  const scopeTag = milestoneScopeTag(milestoneId);
  return readTrackerItems()
    .filter(
      (item) =>
        item.dispositionTags.includes(PLAN_REVIEW_RESIDUAL_HIGH_TAG)
        && item.dispositionTags.includes(scopeTag),
    )
    .reduce(
      (acc, item) => {
        acc.count += 1;
        const phaseRef = item.refs.find((ref) => ref.refKind === "phase");
        if (phaseRef && !acc.phases.includes(phaseRef.refValue)) acc.phases.push(phaseRef.refValue);
        return acc;
      },
      { count: 0, phases: [] as string[] },
    );
}
