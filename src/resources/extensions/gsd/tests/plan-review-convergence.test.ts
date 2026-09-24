// Project/App: gsd-pi
// File Purpose: Unit tests for the plan-review convergence port (Phase 20,
// CONV-01). Covers the pure CYCLE_SUMMARY parse/aggregate contract
// (plan-review-cycle-summary.ts) and the reactive decide-and-redispatch
// driver (plan-review-convergence.ts), including the free-text-override
// rejection (D-02), that the driver behaves identically regardless of
// auto-mode state (RESEARCH.md Pitfall 1), and (Plan 20-02) the
// reround-dispatch branch (mechanical cap advance, replan redispatch) and
// the cap-hit escalation branch (reached from reround-at-cap and from any
// blocked lane-health failure).

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type { ExtensionAPI, ExtensionCommandContext, ExtensionContext } from "@gsd/pi-coding-agent";
import type { AgentEndEvent } from "../auto/types.ts";

import {
  PLAN_REVIEW_CYCLE_VERDICTS,
  aggregatePlanReviewCycle,
  parsePlanReviewCycleSummary,
  planReviewCycleSummaryFileName,
  type PlanReviewCycleSummary,
} from "../plan-review-cycle-summary.ts";
import { checkPlanReviewConvergenceAdvance } from "../plan-review-convergence.ts";
import { handlePlanReviewConvergence } from "../commands-gsd-core.ts";
import { withCommandCwd } from "../commands/context.ts";
import { resolvePlanReviewMaxCycles } from "../preferences.ts";
import { PLAN_REVIEW_MAX_CYCLES_BOUNDS } from "../preferences-validation.ts";
import {
  _getAdapter,
  closeDatabase,
  countPlanReviewCyclesForTarget,
  getOpenPlanReviewCycle,
  getOpenPlanReviewCycleForMilestone,
  insertMilestone,
  insertSlice,
  openDatabase,
  savePlanReviewCycle,
  updatePlanReviewCycleOutcome,
} from "../gsd-db.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

/** Fresh project directory with a `.gsd` DB carrying one active milestone + slice. */
function makeBase(milestoneId = "M001", sliceId = "S01"): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-plan-review-convergence-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Convergence test", status: "active" });
  insertSlice({ id: sliceId, milestoneId, title: "Slice", status: "active" });
  return basePath;
}

function createMockPi(): ExtensionAPI & { sent: Array<{ customType?: string; content?: string }> } {
  const sent: Array<{ customType?: string; content?: string }> = [];
  return {
    sent,
    sendMessage(message: { customType?: string; content?: string }) {
      sent.push(message);
    },
  } as unknown as ExtensionAPI & { sent: Array<{ customType?: string; content?: string }> };
}

function createMockCtx(): (ExtensionContext & ExtensionCommandContext) & {
  notifications: { message: string; level: string }[];
} {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  } as unknown as (ExtensionContext & ExtensionCommandContext) & {
    notifications: { message: string; level: string }[];
  };
}

function writeArtifact(path: string, body: string): void {
  writeFileSync(path, body);
}

/**
 * Sandbox `GSD_HOME` to an empty temp dir for the duration of `fn` — hermetic
 * to whatever global `~/.gsd/PREFERENCES.md` may exist on the host running
 * these tests, mirroring `tests/preferences-plan-review.test.ts`'s
 * `withSandbox` pattern. Needed only by the row-cap-vs-resolver tests below,
 * which write a real project-level PREFERENCES.md and must prove the
 * enforcement comparison ignores it.
 */
async function withSandboxedGsdHome(fn: () => void | Promise<void>): Promise<void> {
  const originalGsdHome = process.env.GSD_HOME;
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-plan-review-convergence-home-"));
  process.env.GSD_HOME = tempGsdHome;
  try {
    await fn();
  } finally {
    if (originalGsdHome === undefined) delete process.env.GSD_HOME;
    else process.env.GSD_HOME = originalGsdHome;
    rmSync(tempGsdHome, { recursive: true, force: true });
  }
}

describe("plan-review-cycle-summary", () => {
  it("parses a converged CYCLE_SUMMARY with zero HIGH/actionable", () => {
    const content = [
      "target: Milestone M001",
      "cycle: 1",
      "",
      "### 1. claude",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.lanes.length, 1);
    assert.equal(summary.target, "Milestone M001");
    assert.equal(summary.cycle, 1);
    const aggregate = aggregatePlanReviewCycle(summary);
    assert.equal(aggregate.verdict, "converged");
    assert.equal(aggregate.highCount, 0);
    assert.equal(aggregate.actionableCount, 0);
  });

  it("reports reround when a lane has HIGH concerns", () => {
    const content = ["### 1. claude", "status: reviewed", "high: 2", "actionable: 0", ""].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    const aggregate = aggregatePlanReviewCycle(summary);
    assert.equal(aggregate.verdict, "reround");
    assert.equal(aggregate.highCount, 2);
  });

  it("returns zero lanes and never throws on an empty string", () => {
    assert.doesNotThrow(() => {
      const summary = parsePlanReviewCycleSummary("");
      assert.equal(summary.lanes.length, 0);
    });
  });

  it("returns zero lanes and never throws on a truncated document", () => {
    assert.doesNotThrow(() => {
      const summary = parsePlanReviewCycleSummary("### 1. claude\nstatus: rev");
      assert.equal(summary.lanes.length, 0);
    });
  });

  it("drops a lane record whose status is wrong-case or an unknown literal", () => {
    const wrongCase = ["### 1. claude", "status: Reviewed", "high: 0", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(wrongCase).lanes.length, 0);

    const unknown = ["### 1. claude", "status: partial", "high: 0", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(unknown).lanes.length, 0);
  });

  it("drops a lane record whose count fields are non-numeric", () => {
    const content = ["### 1. claude", "status: reviewed", "high: many", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("rejects a lane record whose lane name contains a patch/diff marker, never coercing it", () => {
    const content = [
      "### 1. claude",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "### 2. @@ -1,1 +1,1 @@",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.lanes.length, 1, "the patch-marker-tainted lane must be dropped, not the whole document");
    assert.equal(summary.lanes[0]?.lane, "claude");
  });

  it("aggregates zero lanes as blocked, never converged (Phase 09 no_criteria lesson)", () => {
    const summary: PlanReviewCycleSummary = { target: "x", cycle: 1, lanes: [] };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "blocked");
  });

  it("aggregates a stubbed or failed lane as blocked even with zero counts", () => {
    const stubbed: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [{ lane: "claude", status: "stubbed", high: 0, actionable: 0 }],
    };
    assert.equal(aggregatePlanReviewCycle(stubbed).verdict, "blocked");

    const failed: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [{ lane: "claude", status: "failed", high: 0, actionable: 0 }],
    };
    assert.equal(aggregatePlanReviewCycle(failed).verdict, "blocked");
  });

  it("computes the CYCLE_SUMMARY filename from the slugified target and cycle", () => {
    assert.equal(planReviewCycleSummaryFileName("Milestone M001", 2), "milestone-m001-c2-CYCLE-SUMMARY.md");
  });

  it("exposes the closed verdict set", () => {
    assert.deepEqual(PLAN_REVIEW_CYCLE_VERDICTS, ["converged", "reround", "blocked"]);
  });
});

describe("checkPlanReviewConvergenceAdvance", () => {
  it("returns false when no open cycle row exists for the resolved target", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, false);
  });

  it("marks the row converged, notifies, and dispatches nothing when the artifact reports zero HIGH/actionable", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "milestone-m001-c1-CYCLE-SUMMARY.md");
    writeArtifact(
      artifactPath,
      ["target: Milestone M001", "cycle: 1", "", "### 1. claude", "status: reviewed", "high: 0", "actionable: 0", ""].join("\n"),
    );
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 0, "converged path must dispatch nothing");
    assert.ok(ctx.notifications.some((n) => n.message.includes("converged")));

    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null, "the converged row is no longer 'open'");
  });

  it("does not mark the row converged when the artifact reports outstanding HIGH concerns, even if the last chat message claims convergence", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "milestone-m001-c1-CYCLE-SUMMARY.md");
    writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 3", "actionable: 0", ""].join("\n"));
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    // The last message's text CLAIMS convergence — the driver must ignore
    // chat content entirely and read only the on-disk artifact (D-02 / SC-1).
    const event: AgentEndEvent = {
      messages: [{ content: "All reviewers agree: CONVERGED, no outstanding concerns." }],
    };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);

    const row = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(row, "the row must remain open — it was never marked converged");
    assert.notEqual(row?.status, "converged");
  });

  it("marks the row cap-hit (with residual counts + lane states persisted) once the prior-cycle count reaches the persisted cap, dispatching nothing", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });

    // Two prior cycle rows plus this cycle's open row == 3 total rows for a
    // maxCycles of 3 — countPlanReviewCyclesForTarget's COUNT(*) reaches the
    // cap on THIS decision.
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath: join(artifactDir, "c1.md") });
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 2, maxCycles: 3, artifactPath: join(artifactDir, "c2.md") });
    const artifactPath = join(artifactDir, "c3.md");
    writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 1", "actionable: 0", ""].join("\n"));
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 3, maxCycles: 3, artifactPath });

    assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 3);

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 0, "reaching the cap must dispatch zero further messages");

    const rowAfter = _getAdapter()!.prepare(
      "SELECT status, high_count, actionable_count, lane_states FROM plan_review_cycles WHERE id = :id",
    ).get({ ":id": "PRC-M001-S01-c3" }) as Record<string, unknown>;
    assert.equal(rowAfter?.["status"], "cap-hit");
    assert.equal(rowAfter?.["high_count"], 1, "the residual HIGH count must be persisted, not left at its default");
    assert.notEqual(rowAfter?.["lane_states"], "[]", "the lane states must be persisted, not left at their default");

    // T-20-07: the notice must escalate — name the residual HIGH count and
    // never read as a clean convergence.
    const notice = ctx.notifications.find((n) => n.message.includes("cap-hit"));
    assert.ok(notice, "a cap-hit notice must be emitted");
    assert.ok(notice!.message.includes("1 HIGH"), "the notice must name the residual HIGH count");
    assert.ok(!/\bconverg/i.test(notice!.message), "a cap-hit notice must never contain convergence wording");
  });

  it("the row's cap wins over the resolver: a row cap of 2 stops the run even though preferences configure 9", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });

    await withSandboxedGsdHome(async () => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review:\n  max_cycles: 9\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), 9, "sanity: the sandboxed config really is 9");

      // One prior cycle row plus this cycle's open row == 2 total rows for a
      // ROW cap of 2 — the comparison must read the row, not re-resolve.
      savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 2, artifactPath: join(artifactDir, "c1.md") });
      const artifactPath = join(artifactDir, "c2.md");
      writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 1", "actionable: 0", ""].join("\n"));
      savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 2, maxCycles: 2, artifactPath });

      assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 2);

      const pi = createMockPi();
      const ctx = createMockCtx();
      const handled = await checkPlanReviewConvergenceAdvance(pi, { messages: [] }, ctx, basePath);
      assert.equal(handled, true);
      assert.equal(pi.sent.length, 0, "the row's cap of 2 must stop the run even though config configures 9");

      const row = _getAdapter()!.prepare(
        "SELECT status FROM plan_review_cycles WHERE id = :id",
      ).get({ ":id": "PRC-M001-S01-c2" }) as Record<string, unknown>;
      assert.equal(row?.["status"], "cap-hit");
    });
  });

  it("the converse also holds: a row cap of 9 keeps the run going even though preferences configure 2", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });

    await withSandboxedGsdHome(async () => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review:\n  max_cycles: 2\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), 2, "sanity: the sandboxed config really is 2");

      // Two prior rows plus this cycle's open row == 3 total for a ROW cap
      // of 9 — far under the row's own cap, even though config (2) would
      // already have stopped this run had the comparison re-resolved it.
      savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 9, artifactPath: join(artifactDir, "c1.md") });
      savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 2, maxCycles: 9, artifactPath: join(artifactDir, "c2.md") });
      const artifactPath = join(artifactDir, "c3.md");
      writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 1", "actionable: 0", ""].join("\n"));
      savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 3, maxCycles: 9, artifactPath });

      assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 3);

      const pi = createMockPi();
      const ctx = createMockCtx();
      const handled = await checkPlanReviewConvergenceAdvance(pi, { messages: [] }, ctx, basePath);
      assert.equal(handled, true);
      assert.equal(pi.sent.length, 1, "the row's cap of 9 must keep the run going even though config configures 2");
      assert.equal(pi.sent[0]?.customType, "gsd-plan-review-convergence-replan");
    });
  });

  it("hits the cap immediately when max_cycles is 1 and the very first cycle is not converged", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 1", "actionable: 0", ""].join("\n"));
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 1, artifactPath });

    assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 1);

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 0, "a max_cycles of 1 means the first non-converged outcome is already at the cap");

    const row = _getAdapter()!.prepare("SELECT status FROM plan_review_cycles WHERE id = :id").get({ ":id": "PRC-M001-S01-c1" });
    assert.equal(row?.["status"], "cap-hit");
  });

  it("dispatches exactly one replan turn and opens the next cycle's row when reround is below the cap", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "milestone-m001-c1-CYCLE-SUMMARY.md");
    writeArtifact(
      artifactPath,
      ["target: Milestone M001", "cycle: 1", "", "### 1. claude", "status: reviewed", "high: 2", "actionable: 0", ""].join("\n"),
    );
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 1, "a reround below the cap must dispatch exactly one message");
    assert.equal(pi.sent[0]?.customType, "gsd-plan-review-convergence-replan");

    // The current (cycle 1) row is reround-dispatched, not converged/cap-hit.
    const c1Row = _getAdapter()!.prepare(
      "SELECT status, high_count FROM plan_review_cycles WHERE id = :id",
    ).get({ ":id": "PRC-M001-S01-c1" }) as Record<string, unknown>;
    assert.equal(c1Row?.["status"], "reround-dispatched");
    assert.equal(c1Row?.["high_count"], 2);

    // A new row opened at cycle 2, carrying the same cap, with a genuinely
    // different row id — the COUNT advances, it never upserts onto one row.
    const openRow = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(openRow, "the newly-opened cycle-2 row must now be the 'open' row");
    assert.equal(openRow?.cycle, 2);
    assert.equal(openRow?.maxCycles, 3, "the cap carries forward onto the new row");
    assert.notEqual(openRow?.cycleRowId, "PRC-M001-S01-c1");
    assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 2, "the COUNT genuinely advances, proving the cap is reachable");

    const notice = ctx.notifications.find((n) => n.message.includes("cycle 2"));
    assert.ok(notice, "the operator notice must name the cycle being entered");
    assert.ok(notice!.message.includes("2 HIGH"), "the operator notice must name the outstanding counts");
  });

  it("escalates a blocked verdict (a stubbed lane) to cap-hit immediately, naming the lane rather than a concern count", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    // maxCycles is 3 (far from the cap) — a blocked verdict must escalate
    // regardless of how much cap headroom remains.
    writeArtifact(artifactPath, ["### 1. gemini", "status: stubbed", "high: 0", "actionable: 0", ""].join("\n"));
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 0, "a lane-health failure must never dispatch a replan turn");

    const row = _getAdapter()!.prepare("SELECT status FROM plan_review_cycles WHERE id = :id").get({ ":id": "PRC-M001-S01-c1" });
    assert.equal(row?.["status"], "cap-hit");

    const notice = ctx.notifications.find((n) => n.message.includes("cap-hit"));
    assert.ok(notice);
    assert.ok(notice!.message.includes('"gemini"'), "the notice must name the unhealthy lane");
    assert.ok(notice!.message.includes("stubbed"), "the notice must name the lane's health status");
    assert.ok(!/\d+ HIGH/.test(notice!.message), "a lane-health notice must never be phrased as a concern count");
  });

  it("escalates a blocked verdict (zero lanes) to cap-hit, naming that no lane produced a review", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    writeArtifact(artifactPath, "");
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(pi.sent.length, 0);

    const notice = ctx.notifications.find((n) => n.message.includes("cap-hit"));
    assert.ok(notice?.message.includes("no reviewer lane produced a review"));
  });

  it("drives a full multi-cycle sequence: cycle 1 rerounds once, cycle 2 hits the cap and dispatches nothing", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });

    const c1Path = join(artifactDir, "c1.md");
    writeArtifact(
      c1Path,
      ["target: Milestone M001", "cycle: 1", "", "### 1. claude", "status: reviewed", "high: 2", "actionable: 0", ""].join("\n"),
    );
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 2, artifactPath: c1Path });

    const pi1 = createMockPi();
    const ctx1 = createMockCtx();
    const handled1 = await checkPlanReviewConvergenceAdvance(pi1, { messages: [] }, ctx1, basePath);
    assert.equal(handled1, true);
    assert.equal(pi1.sent.length, 1, "cycle 1 (below the cap of 2) must dispatch exactly one replan turn");
    assert.equal(countPlanReviewCyclesForTarget("M001", "S01"), 2, "the COUNT genuinely advances after the reround");

    const openAfterC1 = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(openAfterC1);
    assert.equal(openAfterC1?.cycle, 2);
    assert.equal(openAfterC1?.maxCycles, 2, "the cap carries forward onto the new row, never re-resolved");

    // The replan turn (simulated here) writes cycle 2's CYCLE_SUMMARY, still
    // reporting an outstanding concern — but the COUNT is now AT the cap.
    writeArtifact(openAfterC1!.artifactPath, ["### 1. claude", "status: reviewed", "high: 1", "actionable: 0", ""].join("\n"));

    const pi2 = createMockPi();
    const ctx2 = createMockCtx();
    const handled2 = await checkPlanReviewConvergenceAdvance(pi2, { messages: [] }, ctx2, basePath);
    assert.equal(handled2, true);
    assert.equal(pi2.sent.length, 0, "cycle 2 is at the cap — no further replan may be dispatched");

    const finalRow = _getAdapter()!.prepare(
      "SELECT status FROM plan_review_cycles WHERE id = :id",
    ).get({ ":id": openAfterC1!.cycleRowId }) as Record<string, unknown>;
    assert.equal(finalRow?.["status"], "cap-hit");
  });

  it("CR-02: does not swallow a turn that ended in error before writing its CYCLE_SUMMARY — marks the row cap-hit and lets the error fall through", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    // Never write the artifact — this simulates the review turn crashing or
    // erroring before it could produce CYCLE_SUMMARY.
    const artifactPath = join(artifactDir, "c1.md");
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [{ stopReason: "error" }] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(
      handled,
      false,
      "an errored turn must NOT be reported as handled — it must fall through to ordinary error recovery",
    );
    assert.equal(pi.sent.length, 0, "no replan/review turn may be dispatched for an errored turn");

    const row = _getAdapter()!.prepare("SELECT status FROM plan_review_cycles WHERE id = :id").get({ ":id": "PRC-M001-S01-c1" }) as Record<string, unknown>;
    assert.equal(row?.["status"], "cap-hit", "the row must be closed so it stops swallowing future unrelated agent_end events");
    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null, "the row is no longer 'open'");

    const notice = ctx.notifications.find((n) => n.message.includes("without producing its CYCLE_SUMMARY"));
    assert.ok(notice, "an explanatory notice must be emitted");
  });

  it("CR-02: also closes the row for an aborted turn (abortOrigin set) with no artifact", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [], abortOrigin: "timeout" };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, false);
    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null);
  });

  it("still leaves the row open (reporting handled) when the artifact is simply not yet written and the turn did not error", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [{ stopReason: "end_turn" }] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true, "a non-erroring turn with no artifact yet must still be absorbed as handled");
    assert.ok(getOpenPlanReviewCycle("M001", "S01"), "the row must remain open for a subsequent agent_end to re-check");
  });

  it("WR-02: finds the open row by milestone alone, even when the resolved active slice would otherwise differ from the row's own sliceId", async () => {
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 0", "actionable: 0", ""].join("\n"));
    // Open the row under a DIFFERENT sliceId than whatever getActiveSliceFromDb
    // would resolve today (a stale/rotated slice pointer) — simulating the
    // race where the active-slice pointer changed between dispatch and decide.
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "STALE-SLICE", cycle: 1, maxCycles: 3, artifactPath });
    assert.equal(
      getOpenPlanReviewCycleForMilestone("M001")?.sliceId,
      "STALE-SLICE",
      "sanity: the row really is opened under a slice id the active-slice resolver would not currently return",
    );

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true, "the row must still be found and decided, scoped by milestone alone");
    assert.ok(ctx.notifications.some((n) => n.message.includes("converged")));
  });

  it("behaves identically whether or not full auto-mode is active", async () => {
    // checkPlanReviewConvergenceAdvance never reads auto-mode state itself —
    // its insertion point in handleAgentEnd (strictly before the
    // isAutoActive() gate) is what makes it fire regardless of mode. Proven
    // here by calling it directly with no auto-mode signal involved at all.
    const basePath = makeBase();
    const artifactDir = join(basePath, ".gsd", "plan-review");
    mkdirSync(artifactDir, { recursive: true });
    const artifactPath = join(artifactDir, "c1.md");
    writeArtifact(artifactPath, ["### 1. claude", "status: reviewed", "high: 0", "actionable: 0", ""].join("\n"));
    savePlanReviewCycle({ milestoneId: "M001", sliceId: "S01", cycle: 1, maxCycles: 3, artifactPath });

    const pi = createMockPi();
    const ctx = createMockCtx();
    const event: AgentEndEvent = { messages: [] };
    const handled = await checkPlanReviewConvergenceAdvance(pi, event, ctx, basePath);
    assert.equal(handled, true);
    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null);
  });
});

describe("handlePlanReviewConvergence", () => {
  it("inserts a cycle-1 row carrying the resolved cap and dispatches exactly one review-turn message", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();

    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 5", ctx, pi);
    });

    assert.equal(pi.sent.length, 1);
    assert.equal(pi.sent[0]?.customType, "gsd-plan-review-convergence-review");

    const row = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(row);
    assert.equal(row?.cycle, 1);
    assert.equal(row?.maxCycles, 5);
    assert.ok((row?.artifactPath.length ?? 0) > 0);
  });

  it("clamps an out-of-range --max-cycles to the 1..10 bound", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();

    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 999", ctx, pi);
    });

    const row = getOpenPlanReviewCycle("M001", "S01");
    assert.equal(row?.maxCycles, 10);
  });

  it("falls back to the default cap when no --max-cycles flag is given", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();

    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("", ctx, pi);
    });

    const row = getOpenPlanReviewCycle("M001", "S01");
    assert.equal(row?.maxCycles, PLAN_REVIEW_MAX_CYCLES_BOUNDS.default);
  });

  it("CR-01: re-invoking on a target already decided to 'converged' re-arms the cycle-1 row instead of leaving it stale", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();

    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 3", ctx, pi);
    });
    const firstRow = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(firstRow, "the first run must open a cycle-1 row");

    // Decide the first run to a terminal state, exactly as
    // checkPlanReviewConvergenceAdvance would on convergence.
    updatePlanReviewCycleOutcome({
      cycleRowId: firstRow!.cycleRowId,
      status: "converged",
      highCount: 3,
      actionableCount: 2,
      laneStates: JSON.stringify([{ lane: "claude", status: "reviewed", high: 3, actionable: 2 }]),
    });
    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null, "the terminal row must no longer be 'open'");

    // Re-invoke the same command against the same milestone/slice — a normal,
    // expected re-review after further edits. The deterministic row id
    // means this upserts onto the SAME row (PRC-M001-S01-c1).
    const pi2 = createMockPi();
    const ctx2 = createMockCtx();
    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 3", ctx2, pi2);
    });

    const reopened = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(reopened, "the re-invoked run's cycle-1 row must be detected as open again");
    assert.equal(reopened?.cycleRowId, firstRow!.cycleRowId, "it is genuinely the same row id, re-armed in place");
    assert.equal(reopened?.status, "review-pending");
    assert.equal(reopened?.highCount, 0, "stale residual high_count from the prior run must be reset");
    assert.equal(reopened?.actionableCount, 0, "stale residual actionable_count from the prior run must be reset");
    assert.equal(reopened?.laneStates, "[]", "stale lane_states from the prior run must be reset");
  });

  it("CR-01: re-invoking on a target already decided to 'cap-hit' also re-arms the row", async () => {
    const basePath = makeBase();
    const pi = createMockPi();
    const ctx = createMockCtx();

    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 1", ctx, pi);
    });
    const firstRow = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(firstRow);

    updatePlanReviewCycleOutcome({
      cycleRowId: firstRow!.cycleRowId,
      status: "cap-hit",
      highCount: 5,
      actionableCount: 1,
      laneStates: JSON.stringify([{ lane: "claude", status: "reviewed", high: 5, actionable: 1 }]),
    });
    assert.equal(getOpenPlanReviewCycle("M001", "S01"), null);

    const pi2 = createMockPi();
    const ctx2 = createMockCtx();
    await withCommandCwd(basePath, async () => {
      await handlePlanReviewConvergence("--max-cycles 1", ctx2, pi2);
    });

    const reopened = getOpenPlanReviewCycle("M001", "S01");
    assert.ok(reopened, "a cap-hit terminal row must also be re-armed on re-invocation");
    assert.equal(reopened?.status, "review-pending");
    assert.equal(reopened?.highCount, 0);
    assert.equal(reopened?.actionableCount, 0);
  });
});
