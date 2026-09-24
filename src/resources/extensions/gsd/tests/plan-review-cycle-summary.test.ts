// Project/App: gsd-pi
// File Purpose: Unit tests for the CYCLE_SUMMARY structured-artifact contract
// (Phase 20, CONV-01) — plan-review-cycle-summary.ts. Covers the
// never-throwing parser (including malformed/truncated/adversarial input),
// the render/parse round trip, the renderer's caller-payload error guards,
// and the lane-health aggregation ladder. Mirrors
// tests/verify-agentic-log.test.ts's structure: one `describe` per exported
// function, node:test + node:assert/strict.

import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  PLAN_REVIEW_CYCLE_VERDICTS,
  PLAN_REVIEW_LANE_STATUSES,
  PlanReviewCycleSummaryRenderError,
  aggregatePlanReviewCycle,
  parsePlanReviewCycleSummary,
  planReviewCycleSummaryFileName,
  renderPlanReviewCycleSummary,
  type PlanReviewCycleSummary,
} from "../plan-review-cycle-summary.ts";

// Build patch-marker fixtures via explicit character construction rather
// than pasting raw markers inline, mirroring verify-agentic-log.test.ts's
// convention, so no fixture in this file reads as real diff content.
const BACKTICK = String.fromCharCode(96);
function fencedDiffBlock(): string {
  return `${BACKTICK}${BACKTICK}${BACKTICK}diff\nsome content\n${BACKTICK}${BACKTICK}${BACKTICK}`;
}
function hunkRangeMarker(): string {
  return "@@ -1,1 +1,1 @@";
}

describe("parsePlanReviewCycleSummary", () => {
  it("parses target/cycle header and one lane record", () => {
    const content = [
      "target: Milestone M001",
      "cycle: 2",
      "",
      "### 1. claude",
      "status: reviewed",
      "high: 1",
      "actionable: 3",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.target, "Milestone M001");
    assert.equal(summary.cycle, 2);
    assert.deepEqual(summary.lanes, [{ lane: "claude", status: "reviewed", high: 1, actionable: 3 }]);
  });

  it("parses multiple lane records in order", () => {
    const content = [
      "### 1. claude",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "### 2. gemini",
      "status: stubbed",
      "high: 0",
      "actionable: 0",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.lanes.length, 2);
    assert.equal(summary.lanes[0]?.lane, "claude");
    assert.equal(summary.lanes[1]?.lane, "gemini");
    assert.equal(summary.lanes[1]?.status, "stubbed");
  });

  it("never throws on an empty string", () => {
    assert.doesNotThrow(() => parsePlanReviewCycleSummary(""));
    assert.equal(parsePlanReviewCycleSummary("").lanes.length, 0);
  });

  it("never throws on a document truncated mid-record", () => {
    assert.doesNotThrow(() => parsePlanReviewCycleSummary("### 1. claude\nstatus: rev"));
    assert.equal(parsePlanReviewCycleSummary("### 1. claude\nstatus: rev").lanes.length, 0);
  });

  it("never throws on a `### ` heading carrying no ordinal", () => {
    assert.doesNotThrow(() => parsePlanReviewCycleSummary("### not-ordinal\nstatus: reviewed\n"));
  });

  it("never throws on a multi-megabyte input", () => {
    const huge = `${"x".repeat(2 * 1024 * 1024)}\n### 1. claude\nstatus: reviewed\nhigh: 0\nactionable: 0\n`;
    assert.doesNotThrow(() => parsePlanReviewCycleSummary(huge));
  });

  it("drops a lane record whose status differs in case from the closed set", () => {
    const content = ["### 1. claude", "status: Reviewed", "high: 0", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops a lane record whose status is not a member of the closed set", () => {
    const content = ["### 1. claude", "status: partial", "high: 0", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops a lane record whose high field is a float", () => {
    const content = ["### 1. claude", "status: reviewed", "high: 1.5", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops a lane record whose high field is negative", () => {
    const content = ["### 1. claude", "status: reviewed", "high: -1", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops a lane record whose high field is NaN-shaped text", () => {
    const content = ["### 1. claude", "status: reviewed", "high: NaN", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops a lane record whose high field is an empty string", () => {
    const content = ["### 1. claude", "status: reviewed", "high: ", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("drops only the patch-marker-tainted lane, not the whole document", () => {
    const content = [
      "### 1. claude",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      `### 2. ${hunkRangeMarker()}`,
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.lanes.length, 1);
    assert.equal(summary.lanes[0]?.lane, "claude");
  });

  it("drops a lane record whose status field contains a fenced diff block", () => {
    const content = ["### 1. claude", `status: ${fencedDiffBlock()}`, "high: 0", "actionable: 0", ""].join("\n");
    assert.equal(parsePlanReviewCycleSummary(content).lanes.length, 0);
  });

  it("closes a record on a `### ` heading with no ordinal, opening nothing new", () => {
    const content = [
      "### 1. claude",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "### not-ordinal",
      "status: reviewed",
      "high: 0",
      "actionable: 0",
      "",
    ].join("\n");
    const summary = parsePlanReviewCycleSummary(content);
    assert.equal(summary.lanes.length, 1);
  });
});

describe("renderPlanReviewCycleSummary", () => {
  const validSummary: PlanReviewCycleSummary = {
    target: "Milestone M001",
    cycle: 2,
    lanes: [
      { lane: "claude", status: "reviewed", high: 1, actionable: 3 },
      { lane: "gemini", status: "stubbed", high: 0, actionable: 0 },
    ],
  };

  it("round-trips through the parser to a deep-equal summary", () => {
    const rendered = renderPlanReviewCycleSummary(validSummary);
    const parsed = parsePlanReviewCycleSummary(rendered);
    assert.deepEqual(parsed, validSummary);
  });

  it("collapses an embedded newline in a lane name/target to one physical line, round-tripping correctly", () => {
    const summary: PlanReviewCycleSummary = {
      target: "Milestone\nM001",
      cycle: 1,
      lanes: [{ lane: "claude\nreview", status: "reviewed", high: 0, actionable: 0 }],
    };
    const rendered = renderPlanReviewCycleSummary(summary);
    const parsed = parsePlanReviewCycleSummary(rendered);
    assert.equal(parsed.target, "Milestone M001");
    assert.equal(parsed.lanes.length, 1, "the collapsed line must not read as a second, unprefixed record");
    assert.equal(parsed.lanes[0]?.lane, "claude review");
  });

  it("throws PlanReviewCycleSummaryRenderError on a negative count", () => {
    assert.throws(
      () =>
        renderPlanReviewCycleSummary({
          target: "x",
          cycle: 1,
          lanes: [{ lane: "claude", status: "reviewed", high: -1, actionable: 0 }],
        }),
      PlanReviewCycleSummaryRenderError,
    );
  });

  it("throws PlanReviewCycleSummaryRenderError on a non-integer count", () => {
    assert.throws(
      () =>
        renderPlanReviewCycleSummary({
          target: "x",
          cycle: 1,
          lanes: [{ lane: "claude", status: "reviewed", high: 1.5, actionable: 0 }],
        }),
      PlanReviewCycleSummaryRenderError,
    );
  });

  it("throws PlanReviewCycleSummaryRenderError on a lane status outside the closed set", () => {
    assert.throws(
      () =>
        renderPlanReviewCycleSummary({
          target: "x",
          cycle: 1,
          lanes: [{ lane: "claude", status: "partial" as never, high: 0, actionable: 0 }],
        }),
      PlanReviewCycleSummaryRenderError,
    );
  });

  it("throws PlanReviewCycleSummaryRenderError on a lane name carrying a patch/diff marker", () => {
    assert.throws(
      () =>
        renderPlanReviewCycleSummary({
          target: "x",
          cycle: 1,
          lanes: [{ lane: hunkRangeMarker(), status: "reviewed", high: 0, actionable: 0 }],
        }),
      PlanReviewCycleSummaryRenderError,
    );
  });

  it("throws PlanReviewCycleSummaryRenderError on a target carrying a patch/diff marker", () => {
    assert.throws(
      () => renderPlanReviewCycleSummary({ target: fencedDiffBlock(), cycle: 1, lanes: [] }),
      PlanReviewCycleSummaryRenderError,
    );
  });

  it("throws PlanReviewCycleSummaryRenderError on a non-integer cycle", () => {
    assert.throws(
      () => renderPlanReviewCycleSummary({ target: "x", cycle: 1.5, lanes: [] }),
      PlanReviewCycleSummaryRenderError,
    );
  });
});

describe("aggregatePlanReviewCycle", () => {
  it("aggregates zero lanes as blocked, never converged (Phase 09 no_criteria lesson)", () => {
    const summary: PlanReviewCycleSummary = { target: "x", cycle: 1, lanes: [] };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "blocked");
  });

  it("aggregates a stubbed lane as blocked even when every lane reports zero concerns", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [
        { lane: "claude", status: "reviewed", high: 0, actionable: 0 },
        { lane: "gemini", status: "stubbed", high: 0, actionable: 0 },
      ],
    };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "blocked");
  });

  it("aggregates a failed lane as blocked, whatever the counts", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [{ lane: "claude", status: "failed", high: 0, actionable: 0 }],
    };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "blocked");
  });

  it("resolves to blocked from a failed lane appearing after a stubbed lane (scans every lane, no short-circuit)", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [
        { lane: "gemini", status: "stubbed", high: 0, actionable: 0 },
        { lane: "claude", status: "failed", high: 0, actionable: 0 },
      ],
    };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "blocked");
  });

  it("aggregates any HIGH > 0 across reviewed lanes as reround", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [{ lane: "claude", status: "reviewed", high: 2, actionable: 0 }],
    };
    const aggregate = aggregatePlanReviewCycle(summary);
    assert.equal(aggregate.verdict, "reround");
    assert.equal(aggregate.highCount, 2);
  });

  it("aggregates zero HIGH but actionable > 0 across reviewed lanes as reround", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [{ lane: "claude", status: "reviewed", high: 0, actionable: 4 }],
    };
    const aggregate = aggregatePlanReviewCycle(summary);
    assert.equal(aggregate.verdict, "reround");
    assert.equal(aggregate.actionableCount, 4);
  });

  it("aggregates every lane reviewed with zero counts as converged", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [
        { lane: "claude", status: "reviewed", high: 0, actionable: 0 },
        { lane: "gemini", status: "reviewed", high: 0, actionable: 0 },
      ],
    };
    assert.equal(aggregatePlanReviewCycle(summary).verdict, "converged");
  });

  it("sums HIGH and actionable counts across accepted lanes", () => {
    const summary: PlanReviewCycleSummary = {
      target: "x",
      cycle: 1,
      lanes: [
        { lane: "claude", status: "reviewed", high: 2, actionable: 1 },
        { lane: "gemini", status: "reviewed", high: 3, actionable: 5 },
      ],
    };
    const aggregate = aggregatePlanReviewCycle(summary);
    assert.equal(aggregate.highCount, 5);
    assert.equal(aggregate.actionableCount, 6);
  });
});

describe("planReviewCycleSummaryFileName", () => {
  it("computes the filename from the slugified target and cycle", () => {
    assert.equal(planReviewCycleSummaryFileName("Milestone M001", 2), "milestone-m001-c2-CYCLE-SUMMARY.md");
  });
});

describe("closed sets", () => {
  it("exposes the closed verdict set", () => {
    assert.deepEqual(PLAN_REVIEW_CYCLE_VERDICTS, ["converged", "reround", "blocked"]);
  });

  it("exposes the closed lane-status set", () => {
    assert.deepEqual(PLAN_REVIEW_LANE_STATUSES, ["reviewed", "stubbed", "failed"]);
  });
});
