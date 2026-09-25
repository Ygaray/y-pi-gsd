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
  getOpenPlanReviewCycleForMilestone,
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
import {
  MUST_FIX_IN_EXECUTE_DISPOSITION_TAG,
  promotePlanReviewResidualHigh,
} from "./plan-review-residual-disposition.js";

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
  // `basePath` is part of this branch's stable signature (mirroring the
  // other pre-gate checks in `handleAgentEnd`) and is now consumed by the
  // CONV-03 promotion below (the `createTrackerItem` writer's markdown-pane
  // regeneration needs a project root). The DB row remains the sole
  // detection and decision authority (see module doc). `event` IS read below
  // (CR-02), but only its turn-completion metadata (`abortOrigin`/
  // `stopReason`) to detect a genuinely-erroring/aborted turn — never its
  // message content, which stays off-limits for deciding the convergence
  // verdict itself (D-02). `pi` IS used below too, for the reround branch's
  // redispatch.

  const milestone = getActiveMilestoneFromDb();
  if (!milestone) return false;

  // WR-02: look up the open row scoped ONLY by milestone — never also
  // filtered by an independently-resolved "active slice." The row itself
  // already carries the sliceId it was opened under (persisted at dispatch
  // time in `handlePlanReviewConvergence`); read that back below instead of
  // re-deriving "active slice" here, which can drift from what was active
  // at dispatch time and silently miss the row.
  const openCycle = getOpenPlanReviewCycleForMilestone(milestone.id);
  if (!openCycle) return false;
  const sliceId = openCycle.sliceId;

  let artifactContent: string;
  try {
    artifactContent = readFileSync(openCycle.artifactPath, "utf8");
  } catch {
    // Artifact not written yet. Two distinct cases (CR-02):
    //
    // 1. The turn that just ended genuinely errored or was aborted (crash,
    //    provider error, abort) — it will never write the artifact now. Do
    //    NOT swallow this as "handled": close the row as cap-hit (so it
    //    stops silently absorbing every later agent_end for this
    //    milestone/slice, and so a future re-invocation of the standalone
    //    command can open a fresh row instead of finding this one stuck
    //    "open" forever) and report `false` so the turn's own error/abort
    //    falls through to `handleAgentEnd`'s ordinary
    //    retry/model-fallback/pause pipeline, exactly as it would have if no
    //    plan-review row were open at all.
    if (isErroredOrAbortedTurn(event)) {
      updatePlanReviewCycleOutcome({
        cycleRowId: openCycle.cycleRowId,
        status: "cap-hit",
        highCount: openCycle.highCount,
        actionableCount: openCycle.actionableCount,
        laneStates: openCycle.laneStates,
      });
      ctx.ui.notify(
        `Plan-review cycle ${openCycle.cycle} ended without producing its CYCLE_SUMMARY artifact ` +
          "(the turn errored or was aborted) — marking cap-hit and handing the turn's own error back " +
          "to the normal error-recovery pipeline.",
        "error",
      );
      return false;
    }
    // 2. The turn that just ended may simply not be the review turn, or the
    //    review turn ended cleanly but hasn't written the artifact yet.
    //    Leave the row open; the next agent_end for this target re-checks.
    //    Still report "handled" so unrelated auto-mode logic below the
    //    insertion point does not also try to act on this turn.
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
  // WR-03: `countPlanReviewCyclesForTarget` counts ALL cycle rows for this
  // target, including the currently-open one being decided right now — i.e.
  // this is "total cycles so far, including this one", not "cycles prior to
  // this one". Named accordingly (a previous `priorCycles` name undersold
  // this by one and invited a future maintainer to "fix" a non-existent
  // off-by-one, or introduce a real one while refactoring under the wrong
  // mental model).
  const totalCyclesSoFar = countPlanReviewCyclesForTarget(milestone.id, sliceId);
  // Compared against the row's own persisted cap, never a fresh config-layer
  // lookup: a run must finish under the cap it began with, so an operator
  // editing preferences — or a concurrent run using a different override —
  // mid-flight cannot extend or truncate a run already in progress (CONV-02).
  const capHit = aggregate.verdict === "blocked" || totalCyclesSoFar >= openCycle.maxCycles;

  if (capHit) {
    updatePlanReviewCycleOutcome({
      cycleRowId: openCycle.cycleRowId,
      status: "cap-hit",
      highCount: aggregate.highCount,
      actionableCount: aggregate.actionableCount,
      laneStates: JSON.stringify(summary.lanes),
    });

    // CONV-03: unconditional, non-throwing promotion of the residual HIGH
    // into the durable tracker — never delayed, never conditional on
    // anything the LLM says. Consumes only the already-parsed `summary`/
    // `aggregate` objects (ASVS V5) — the raw artifact string is not
    // re-read or re-parsed here.
    //
    // WR-01: the dedup identity inside promotePlanReviewResidualHigh is
    // `title::sortedRefs`, and the title embeds this exact cycle number and
    // counts. That means a slice that cap-hits more than once across its
    // lifetime (e.g. a deferred-to-phase-N residual gets addressed, execute
    // proceeds, a later plan-review on the same slice cap-hits again at a
    // new cycle) always promotes a NEW tracker row rather than updating an
    // existing one — this is intentional (an append-only audit trail of
    // every cap-hit), not a bug. findBlockingMustFixInExecuteItems and
    // summarizeResidualHighForMilestone will therefore accumulate one row
    // per cap-hit cycle for a repeatedly-cap-hitting slice, not one row per
    // slice.
    const promotion = promotePlanReviewResidualHigh({
      milestoneId: milestone.id,
      sliceId,
      cycle: openCycle.cycle,
      highCount: aggregate.highCount,
      actionableCount: aggregate.actionableCount,
      laneStatesJson: JSON.stringify(summary.lanes),
      artifactPath: openCycle.artifactPath,
      disposition: MUST_FIX_IN_EXECUTE_DISPOSITION_TAG,
      basePath,
    });

    const reason =
      aggregate.verdict === "blocked"
        ? describeBlockedLaneHealth(summary)
        : `${aggregate.highCount} HIGH / ${aggregate.actionableCount} actionable concern(s) remain unresolved ` +
          `after ${totalCyclesSoFar} cycle(s) (max ${openCycle.maxCycles})`;
    // Escalation wording only — never phrase this as convergence (T-20-07).
    ctx.ui.notify(
      `Plan-review cap-hit at cycle ${openCycle.cycle}: ${reason} — stopping with outstanding concerns, ` +
        "no further replan will be dispatched.",
      "error",
    );

    if (promotion.failure) {
      ctx.ui.notify(
        `Warning: residual-HIGH tracker promotion did not land (${promotion.failure}) — ` +
          "the cap-hit escalation above still stands.",
        "warning",
      );
    }

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
 * Whether the turn that just ended is known to have errored or been aborted
 * (CR-02), read from `AgentEndEvent`'s own turn-completion metadata —
 * `abortOrigin`, or the last message's `stopReason` — never its message
 * content/text. This is a distinct concern from D-02 (which forbids trusting
 * the chat's free-text CLAIMS about convergence): here we are only asking
 * "did the turn itself end abnormally," not "what does the turn say about
 * the review outcome."
 */
function isErroredOrAbortedTurn(event: AgentEndEvent): boolean {
  if (event.abortOrigin) return true;
  // WR-02: `.at(-1)` rather than `messages[messages.length - 1]` — functionally
  // identical (both are `undefined` on an empty array, which the guard below
  // already handles), but removes the off-by-one arithmetic that a future
  // edit could break if copied elsewhere with a different offset.
  const lastMsg = event.messages.at(-1);
  if (lastMsg && typeof lastMsg === "object" && "stopReason" in lastMsg) {
    const stopReason = (lastMsg as { stopReason?: unknown }).stopReason;
    return stopReason === "error" || stopReason === "aborted";
  }
  return false;
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
    /* c8 ignore next */
    return "a reviewer lane reported an unrecognized health state";
  }
  return unhealthy.map((lane) => `"${lane.lane}" (${lane.status})`).join(", ");
}
