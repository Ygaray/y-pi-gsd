/**
 * Plan-review convergence reactive decide-and-redispatch driver
 * (Phase 20, CONV-01, D-01).
 *
 * Mirrors `rule-registry.ts`'s gap-closure cap branch and `auto.ts`'s own
 * reactive-driver shape: after a dispatched review/replan turn ends, this
 * module — never the LLM — reads the durable `plan_review_cycles` row plus
 * the on-disk CYCLE_SUMMARY artifact the turn wrote, decides
 * converged/reround/cap-hit, and (for reround, below the cap) redispatches
 * the next turn via the same fire-and-forget
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
 * Plan 20-01 wired the converged happy path end-to-end. Plan 20-02 (this
 * plan) wires the two remaining branches:
 *   - `reround`, below the persisted cap: mark the current row
 *     `reround-dispatched`, open the next cycle's row, and dispatch exactly
 *     one replan turn.
 *   - `reround` AT the cap, or `blocked` at ANY cycle (a failed/stubbed lane,
 *     or no lane at all): mark the row `cap-hit`, persist the residual
 *     counts and lane states (Phase 21 reads these for residual-HIGH
 *     promotion), dispatch nothing, and emit an escalation notice — never
 *     one that reads as a clean convergence.
 *
 * The cap comparison mirrors `_routeAgenticGateGapClosure`'s ordering
 * exactly: `countPlanReviewCyclesForTarget` is read into a local and compared
 * `>=` against the CURRENT ROW's persisted `max_cycles` BEFORE the next cycle
 * number is ever derived — the row is the per-run cap authority, never a
 * fresh resolve and never a second hardcoded literal (RESEARCH.md Pitfall 4).
 */

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { ExtensionAPI, ExtensionContext } from "@gsd/pi-coding-agent";

import type { AgentEndEvent } from "./auto/types.js";
import {
  countPlanReviewCyclesForTarget,
  getActiveMilestoneFromDb,
  getActiveSliceFromDb,
  getOpenPlanReviewCycle,
  savePlanReviewCycle,
  updatePlanReviewCycleOutcome,
} from "./gsd-db.js";
import {
  aggregatePlanReviewCycle,
  parsePlanReviewCycleSummary,
  planReviewCycleSummaryFileName,
  type PlanReviewCycleSummary,
} from "./plan-review-cycle-summary.js";
import { loadPrompt } from "./prompt-loader.js";

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
  // `event`/`basePath` are part of this branch's stable signature (mirroring
  // the other pre-gate checks in `handleAgentEnd`) but are not needed here:
  // the DB row is the sole detection and decision authority (see module
  // doc) — this module never reads `event.messages` or `basePath` to make
  // its decision. `pi` IS used below, for the reround branch's redispatch.
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

  // reround / blocked: decide cap-hit-vs-redispatch. `blocked` (a failed or
  // stubbed lane, or no lane at all) ALWAYS escalates to cap-hit regardless
  // of the cycle count — a lane-health failure is not something another
  // replan round can fix, unlike outstanding HIGH/actionable concerns.
  const priorCycles = countPlanReviewCyclesForTarget(milestone.id, sliceId);
  const capHit = aggregate.verdict === "blocked" || priorCycles >= openCycle.maxCycles;

  if (capHit) {
    updatePlanReviewCycleOutcome({
      cycleRowId: openCycle.cycleRowId,
      status: "cap-hit",
      highCount: aggregate.highCount,
      actionableCount: aggregate.actionableCount,
      laneStates: JSON.stringify(summary.lanes),
    });
    const reason =
      aggregate.verdict === "blocked"
        ? describeBlockedLaneHealth(summary)
        : `${aggregate.highCount} HIGH / ${aggregate.actionableCount} actionable concern(s) remain unresolved ` +
          `after ${priorCycles} cycle(s) (max ${openCycle.maxCycles})`;
    // Escalation wording only — never phrase this as convergence (T-20-07).
    ctx.ui.notify(
      `Plan-review cap-hit at cycle ${openCycle.cycle}: ${reason} — stopping with outstanding concerns, ` +
        "no further replan will be dispatched.",
      "error",
    );
    return true;
  }

  // reround, below the cap: mark the current row, open the next cycle's row
  // (cycle numbers embedded in the row id so the cap COUNT genuinely
  // advances — Phase 12 Plan 1 lesson), and dispatch exactly one replan turn
  // via the same fire-and-forget shape every other dispatch site uses (D-01).
  const nextCycle = openCycle.cycle + 1;
  const targetLabel = summary.target.trim() || `Milestone ${milestone.id}`;
  const nextArtifactPath = join(
    dirname(openCycle.artifactPath),
    planReviewCycleSummaryFileName(targetLabel, nextCycle),
  );

  updatePlanReviewCycleOutcome({
    cycleRowId: openCycle.cycleRowId,
    status: "reround-dispatched",
    highCount: aggregate.highCount,
    actionableCount: aggregate.actionableCount,
    laneStates: JSON.stringify(summary.lanes),
  });
  savePlanReviewCycle({
    milestoneId: milestone.id,
    sliceId,
    cycle: nextCycle,
    maxCycles: openCycle.maxCycles,
    artifactPath: nextArtifactPath,
  });

  pi.sendMessage(
    {
      customType: "gsd-plan-review-convergence-replan",
      content: loadPrompt("plan-review-convergence-replan", {
        target: targetLabel,
        priorSummaryPath: openCycle.artifactPath,
        summaryPath: nextArtifactPath,
        cycle: String(nextCycle),
        maxCycles: String(openCycle.maxCycles),
      }),
      display: false,
    },
    { triggerTurn: true },
  );

  ctx.ui.notify(
    `Plan-review cycle ${openCycle.cycle} found ${aggregate.highCount} HIGH / ` +
      `${aggregate.actionableCount} actionable concern(s) — dispatching a replan into cycle ${nextCycle} ` +
      `of ${openCycle.maxCycles}.`,
    "warning",
  );
  return true;
}

/**
 * Describe WHY a `blocked` verdict fired, for the cap-hit escalation notice
 * (T-20-07/T-20-08): names the unhealthy lane(s) — `stubbed` or `failed` — or
 * states plainly that no lane produced a review at all, rather than a
 * concern count that would misrepresent a lane-health failure as "N
 * concerns remain."
 */
function describeBlockedLaneHealth(summary: PlanReviewCycleSummary): string {
  if (summary.lanes.length === 0) return "no reviewer lane produced a review";
  const unhealthy = summary.lanes.filter((lane) => lane.status === "stubbed" || lane.status === "failed");
  if (unhealthy.length === 0) {
    // aggregatePlanReviewCycle only returns "blocked" for zero lanes or an
    // unhealthy lane, so this is unreachable in practice — a safe fallback
    // that still never fabricates a concern count.
    return "a reviewer lane reported an unrecognized health state";
  }
  return unhealthy.map((lane) => `"${lane.lane}" (${lane.status})`).join(", ");
}
