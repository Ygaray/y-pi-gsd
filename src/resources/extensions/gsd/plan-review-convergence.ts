/**
 * Plan-review convergence reactive decide-and-redispatch driver
 * (Phase 20, CONV-01, D-01).
 *
 * Mirrors `rule-registry.ts`'s gap-closure cap branch and `auto.ts`'s own
 * reactive-driver shape: after a dispatched review turn ends, this module —
 * never the LLM — reads the durable `plan_review_cycles` row plus the
 * on-disk CYCLE_SUMMARY artifact the turn wrote, decides
 * converged/reround/cap-hit, and (for reround, Plan 02's expansion) would
 * redispatch the next turn via the same fire-and-forget
 * `pi.sendMessage(..., {triggerTurn: true})` shape every other dispatch site
 * in this codebase uses — no spawn-and-await primitive exists here.
 *
 * `checkPlanReviewConvergenceAdvance` is called from
 * `bootstrap/agent-end-recovery.ts`'s `handleAgentEnd`, inserted as a
 * pre-gate branch BEFORE the `isAutoActive()` early return — the
 * `/gsd plan-review-convergence` command is standalone (works outside full
 * auto-mode), so its own decide step must fire regardless of auto-mode state
 * (RESEARCH.md Pitfall 1).
 *
 * Detection authority: `AgentEndEvent` carries no `customType` field of its
 * own (confirmed by reading `auto/types.ts` this session — the grounded
 * correction to RESEARCH.md Open Question 2), so the DB row IS the detection
 * authority — an open `plan_review_cycles` row for the resolved active
 * milestone/slice target. Never the ended turn's free-text chat reply (D-02):
 * this module never reads `event.messages` content to make its decision.
 *
 * This plan (20-01) wires the converged happy path end-to-end. The
 * reround/blocked branches record the real outcome and cap count — so
 * Plan 02 has durable history to read — and notify that the redispatch path
 * is not yet wired, but do not yet dispatch another turn.
 */

import { readFileSync } from "node:fs";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AgentEndEvent } from "./auto/types.js";
import {
  countPlanReviewCyclesForTarget,
  getActiveMilestoneFromDb,
  getActiveSliceFromDb,
  getOpenPlanReviewCycle,
  updatePlanReviewCycleOutcome,
} from "./gsd-db.js";
import { aggregatePlanReviewCycle, parsePlanReviewCycleSummary } from "./plan-review-cycle-summary.js";

/**
 * The single literal `3` this feature owns (RESEARCH.md Pitfall 4). Plan
 * 20-03/20-04 thread a `plan_review.max_cycles` config value and a
 * `--max-cycles N` flag in FRONT of this default — nowhere else in the
 * feature re-hardcodes `3`.
 */
export const PLAN_REVIEW_DEFAULT_MAX_CYCLES = 3;

/**
 * Decide-and-redispatch branch for the plan-review-convergence loop. Returns
 * `true` when this turn's end was handled (an open cycle row existed for the
 * resolved target and a decision was recorded), signalling
 * `handleAgentEnd` to short-circuit the rest of its own logic for this turn.
 * Returns `false` when there is nothing to do — no open row for the
 * resolved target — so unrelated turns fall through untouched.
 */
export async function checkPlanReviewConvergenceAdvance(
  pi: ExtensionAPI,
  event: AgentEndEvent,
  ctx: ExtensionContext,
  basePath: string | undefined,
): Promise<boolean> {
  // `pi`/`event`/`basePath` are part of this branch's stable signature
  // (mirroring the other pre-gate checks in `handleAgentEnd`) but are not
  // needed by this plan's happy path: the DB row is the sole detection and
  // decision authority (see module doc), and Plan 02 is where a genuine
  // redispatch via `pi.sendMessage` is wired.
  void pi;
  void event;
  void basePath;

  const milestone = getActiveMilestoneFromDb();
  if (!milestone) return false;
  const slice = getActiveSliceFromDb(milestone.id);
  const sliceId = slice?.id ?? "";

  const openCycle = getOpenPlanReviewCycle(milestone.id, sliceId);
  if (!openCycle) return false;

  let artifactContent: string;
  try {
    artifactContent = readFileSync(openCycle.artifactPath, "utf8");
  } catch {
    // Artifact not written yet — the turn that just ended may not be the
    // review turn, or the review turn ended before writing it. Leave the
    // row open; the next agent_end for this target re-checks. Still report
    // "handled" so unrelated auto-mode logic below the insertion point does
    // not also try to act on this turn.
    return true;
  }

  const summary = parsePlanReviewCycleSummary(artifactContent);
  const aggregate = aggregatePlanReviewCycle(summary);

  if (aggregate.verdict === "converged") {
    updatePlanReviewCycleOutcome({
      cycleRowId: openCycle.cycleRowId,
      status: "converged",
      highCount: aggregate.highCount,
      actionableCount: aggregate.actionableCount,
      laneStates: JSON.stringify(summary.lanes),
    });
    ctx.ui.notify(
      `Plan-review converged at cycle ${openCycle.cycle} — 0 HIGH, 0 actionable concerns.`,
      "info",
    );
    return true;
  }

  // reround / blocked: Plan 02 wires the redispatch, the lane-health ladder,
  // and cap-hit escalation. This plan records the real outcome (including
  // whether the cap is already exhausted) so that history is durable, and
  // notifies rather than silently dropping the result — but does not yet
  // dispatch another turn.
  const priorCycles = countPlanReviewCyclesForTarget(milestone.id, sliceId);
  const capHit = priorCycles >= openCycle.maxCycles;
  updatePlanReviewCycleOutcome({
    cycleRowId: openCycle.cycleRowId,
    status: capHit ? "cap-hit" : openCycle.status,
    highCount: aggregate.highCount,
    actionableCount: aggregate.actionableCount,
    laneStates: JSON.stringify(summary.lanes),
  });
  ctx.ui.notify(
    `Plan-review cycle ${openCycle.cycle} reports ${aggregate.highCount} HIGH / ` +
      `${aggregate.actionableCount} actionable concern(s) (verdict: ${aggregate.verdict}` +
      `${capHit ? ", cap reached" : ""}) — reround/replan dispatch is not yet wired (Phase 20 Plan 02).`,
    "warning",
  );
  return true;
}
