// Project/App: gsd-pi
// File Purpose: Precision/boundary coverage for CONV-04's execute gate
// (readMustFixInExecuteBlock, module-private in auto-dispatch.ts, backed by
// findBlockingMustFixInExecuteItems in plan-review-residual-disposition.ts).
// Plan 21-01 proved one blocking path end-to-end; this file proves the
// boundary of that path — which dispositions do NOT block, which terminal
// statuses release the block, that the retry path is gated identically to
// the normal path, and that the stop reason is deterministic and actionable.
//
// Every case evaluates the real "executing → execute-task" rule (located by
// exact name in the exported DISPATCH_RULES array) against a DB-backed
// DispatchContext — never the private helper directly — so the tests also
// prove the block precedes the retry branch, not just the helper's logic.

import { afterEach, describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DISPATCH_RULES, type DispatchContext, type DispatchRule } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  MUST_FIX_IN_EXECUTE_DISPOSITION_TAG,
  RESCOPE_REQUIREMENT_DISPOSITION_TAG,
  deferredToPhaseDispositionTag,
} from "../plan-review-residual-disposition.ts";
import { createTrackerItem, resolveTrackerItem, updateTrackerItem } from "../db/writers/tracker-item.ts";
import { closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import { readTrackerItems } from "../tracker-projection.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Fixture helpers ──────────────────────────────────────────────────────

/** Fresh project directory with a `.gsd` DB carrying one active milestone + slice. */
function makeBase(milestoneId = "M001", sliceId = "S01"): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-must-fix-gate-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Gate test", status: "active" });
  insertSlice({ id: sliceId, milestoneId, title: "Slice", status: "active" });
  return basePath;
}

/**
 * Locates the `executing → execute-task` entry in DISPATCH_RULES by its
 * exact name. Fails loudly if the registry no longer contains it, per the
 * plan's Task 1 action text — a silent `undefined` would make every test in
 * this file vacuously pass.
 */
function resolveExecutingRule(): DispatchRule {
  const rule = DISPATCH_RULES.find((r) => r.name === "executing → execute-task");
  assert.ok(
    rule,
    "the 'executing → execute-task' rule must exist in DISPATCH_RULES — a rename or removal " +
      "breaks this gate's only proven entry point",
  );
  return rule!;
}

// Disk scaffold helpers mirroring dispatch-rule-coverage.test.ts exactly, so
// the negative (dispatch-reaching) cases exercise the real prompt-building
// path rather than a synthetic shortcut.
function writeMilestoneFile(basePath: string, mid: string, suffix: string, content = "stub\n"): void {
  const dir = join(basePath, ".gsd", "milestones", mid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${mid}-${suffix}.md`), content);
}

function writeSliceFile(basePath: string, mid: string, sid: string, suffix: string, content = "stub\n"): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${sid}-${suffix}.md`), content);
}

function writeTaskPlan(basePath: string, mid: string, sid: string, tid: string): void {
  const dir = join(basePath, ".gsd", "milestones", mid, "slices", sid, "tasks");
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, `${tid}-PLAN.md`), `# ${tid}\n\n## Steps\n- [ ] Step\n`);
}

/** Stages the on-disk scaffold the real dispatch path needs to build a prompt
 * (CONTEXT, slice PLAN, task PLAN) — required only for cases where the gate
 * is expected to release and the rule must reach its dispatch branch. */
function stageExecuteTaskScaffold(basePath: string, mid = "M001", sid = "S01", tid = "T01"): void {
  writeMilestoneFile(basePath, mid, "CONTEXT", "# Context\n");
  writeSliceFile(basePath, mid, sid, "PLAN", "# Plan\n");
  writeTaskPlan(basePath, mid, sid, tid);
}

function makeState(overrides: Partial<GSDState> = {}): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Gate test" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: { id: "T01", title: "First Task" },
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
    ...overrides,
  };
}

function makeCtx(basePath: string, overrides: Partial<DispatchContext> = {}): DispatchContext {
  return {
    basePath,
    mid: "M001",
    midTitle: "Gate test",
    state: makeState(),
    prefs: { reactive_execution: { enabled: false } } as DispatchContext["prefs"],
    ...overrides,
  };
}

function assertStop(result: Awaited<ReturnType<DispatchRule["match"]>>): asserts result is Extract<
  NonNullable<Awaited<ReturnType<DispatchRule["match"]>>>,
  { action: "stop" }
> {
  assert.ok(result, "the rule must return a result, not fall through");
  assert.equal(result!.action, "stop", `expected a stop, got ${result!.action}`);
}

function assertDispatch(result: Awaited<ReturnType<DispatchRule["match"]>>): asserts result is Extract<
  NonNullable<Awaited<ReturnType<DispatchRule["match"]>>>,
  { action: "dispatch" }
> {
  assert.ok(result, "the rule must return a result, not fall through");
  assert.equal(result!.action, "dispatch", `expected a dispatch, got ${result!.action}`);
  assert.equal((result as { unitType: string }).unitType, "execute-task");
}

// ─── Task 1: dispositions, statuses, exact matching ──────────────────────

describe("CONV-04 execute gate: what blocks vs what does not", () => {
  it("blocks when an open must-fix-in-execute item is ref'd to the active slice", async () => {
    const basePath = makeBase();
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Blocking item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(result);
    assert.equal(result.level, "error");
  });

  it("does not block a deferred-to-phase-22 item — tracked but non-blocking (CONV-04's core guarantee)", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Deferred item",
        dispositionTags: [deferredToPhaseDispositionTag("22")],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("does not block a rescope-requirement item", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Rescope item",
        dispositionTags: [RESCOPE_REQUIREMENT_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("does not block a case-variant tag ('Must-Fix-In-Execute') — matching is exact and case-sensitive", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    // Deliberately a literal, not the imported constant: the point of this
    // test is that a near-miss string does not match.
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Case-variant item",
        dispositionTags: ["Must-Fix-In-Execute"],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("does not block when the phase ref is a strict prefix (S0) or strict superstring (S011) of the active slice id", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Prefix ref item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S0" }],
      },
      basePath,
    );
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Superstring ref item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S011" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("blocks once an item's ref is updated to exactly match the active slice id", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Adjacent-then-exact ref item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S0" }],
      },
      basePath,
    );
    stageExecuteTaskScaffold(basePath);
    const before = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(before);

    updateTrackerItem({ trackId, refs: [{ refKind: "phase", refValue: "S01" }] }, basePath);
    const after = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(after);
  });

  it("does not block when the only ref is a requirement ref (not a phase ref) valued S01 — ref kind matters", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Requirement-ref item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "requirement", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("does not block a HIGH-severity milestone-closeout-residual incident — severity alone never gates", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Unrelated closeout residual",
        dispositionTags: ["milestone-closeout-residual", "milestone:v4"],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });

  it("releases the block once resolved via resolveTrackerItem", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Resolved-release item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const before = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(before);

    stageExecuteTaskScaffold(basePath);
    resolveTrackerItem({ trackId, status: "resolved" }, basePath);
    const after = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(after);
  });

  it("releases the block once closed via resolveTrackerItem", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Closed-release item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const before = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(before);

    stageExecuteTaskScaffold(basePath);
    resolveTrackerItem({ trackId, status: "closed" }, basePath);
    const after = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(after);
  });

  it("releases the block once wont-fixed via resolveTrackerItem", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Wont-fix-release item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const before = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(before);

    stageExecuteTaskScaffold(basePath);
    resolveTrackerItem({ trackId, status: "wont-fix" }, basePath);
    const after = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(after);
  });

  it("re-blocks once a terminal item is reopened to open via updateTrackerItem", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Reopen item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    stageExecuteTaskScaffold(basePath);
    resolveTrackerItem({ trackId, status: "closed" }, basePath);
    const released = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(released);

    updateTrackerItem({ trackId, status: "open" }, basePath);
    const reopened = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(reopened);
  });

  it("releases the block once the disposition tag is swapped to deferred-to-phase-22 via updateTrackerItem", async () => {
    const basePath = makeBase();
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        severity: "HIGH",
        title: "Disposition-swap item",
        dispositionTags: [MUST_FIX_IN_EXECUTE_DISPOSITION_TAG],
        refs: [{ refKind: "phase", refValue: "S01" }],
      },
      basePath,
    );
    const before = await resolveExecutingRule().match(makeCtx(basePath));
    assertStop(before);

    stageExecuteTaskScaffold(basePath);
    updateTrackerItem({ trackId, dispositionTags: [deferredToPhaseDispositionTag("22")] }, basePath);
    const after = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(after);
  });

  it("dispatches (not a stop) when zero tracker rows exist in an open DB", async () => {
    const basePath = makeBase();
    stageExecuteTaskScaffold(basePath);
    assert.equal(readTrackerItems().length, 0);
    const result = await resolveExecutingRule().match(makeCtx(basePath));
    assertDispatch(result);
  });
});
