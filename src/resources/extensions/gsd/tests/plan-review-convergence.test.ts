// Project/App: gsd-pi
// File Purpose: Unit tests for the plan-review convergence port (Phase 20,
// CONV-01). Covers the pure CYCLE_SUMMARY parse/aggregate contract
// (plan-review-cycle-summary.ts) and the reactive decide-and-redispatch
// driver (plan-review-convergence.ts), including the free-text-override
// rejection (D-02) and that the driver behaves identically regardless of
// auto-mode state (RESEARCH.md Pitfall 1).

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
import {
  PLAN_REVIEW_DEFAULT_MAX_CYCLES,
  checkPlanReviewConvergenceAdvance,
} from "../plan-review-convergence.ts";
import { handlePlanReviewConvergence } from "../commands-gsd-core.ts";
import { withCommandCwd } from "../commands/context.ts";
import {
  _getAdapter,
  closeDatabase,
  countPlanReviewCyclesForTarget,
  getOpenPlanReviewCycle,
  insertMilestone,
  insertSlice,
  openDatabase,
  savePlanReviewCycle,
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

  it("marks the row cap-hit once the prior-cycle count reaches the persisted cap", async () => {
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
    assert.equal(pi.sent.length, 0, "this plan does not yet redispatch — Plan 02 wires reround/cap-hit dispatch");

    const rowAfter = _getAdapter()!.prepare("SELECT status FROM plan_review_cycles WHERE id = :id").get({ ":id": "PRC-M001-S01-c3" });
    assert.equal(rowAfter?.["status"], "cap-hit");
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
    assert.equal(row?.maxCycles, PLAN_REVIEW_DEFAULT_MAX_CYCLES);
  });
});
