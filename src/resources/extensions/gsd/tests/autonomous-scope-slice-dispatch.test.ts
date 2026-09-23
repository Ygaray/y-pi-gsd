// Project/App: gsd-pi
// File Purpose: Mechanical `--from N` / `--to N` SLICE-level dispatch
// enforcement (ROADMAP SC2 fix spec, follow-up to 16-03's milestone-level
// `--only` gate). Proves the boundary is enforced IN CODE at the real
// per-slice dispatch point of the `/gsd auto` loop (`decideOrchestratorDispatch`
// in auto/orchestrator.ts) -- not merely described in the dispatched prompt's
// prose -- and that the durable `resume_from` pointer is still enforced
// mechanically after the in-process scope is gone (a simulated restart).
//
// `isUnitInAutonomousScope`'s own boundary behaviour (inclusive at from/to,
// --only precedence, unbounded-vs-zero) is already fully covered by Tests
// 9-12 in autonomous-scope-durable.test.ts and is NOT re-tested here --
// these tests only prove the dispatch path actually CONSULTS the predicate
// for a slice-scoped unit, and skips it for a milestone/project-level one
// (Test 8 of 16-03's own plan: --from/--to are not checked against the
// milestone's own ordinal).

import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, test } from "node:test";

import { decideOrchestratorDispatch } from "../auto/orchestrator.js";
import { RuleRegistry, setRegistry, resetRegistry } from "../rule-registry.js";
import type { UnifiedRule } from "../rule-types.js";
import type { GSDState } from "../types.js";
import type { AutonomousScope } from "../autonomous-scope.js";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.js";
import { recordMilestoneRunLifecycle } from "../milestone-run-log-domain-operation.js";
import { internalExecutionInvocation } from "../execution-invocation.js";

const tempDirs = new Set<string>();

afterEach(() => {
  resetRegistry();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-autonomous-scope-slice-dispatch-"));
  tempDirs.add(base);
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  return base;
}

function makeState(): GSDState {
  return {
    activeMilestone: { id: "M010", title: "Milestone" },
    activeSlice: null,
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "Execute task",
    registry: [],
    requirements: { active: 0, validated: 0, deferred: 0, outOfScope: 0, blocked: 0, total: 0 },
    progress: { milestones: { done: 0, total: 1 } },
  };
}

/** Installs a rule that always proposes dispatching the given unit. */
function installFixedDispatchRule(unitType: string, unitId: string): void {
  const rule: UnifiedRule = {
    name: "test-fixed-dispatch",
    when: "dispatch",
    evaluation: "first-match",
    where: async () => ({
      action: "dispatch" as const,
      unitType,
      unitId,
      prompt: `fixture prompt for ${unitId}`,
    }),
    then: (r: unknown) => r,
  };
  setRegistry(new RuleRegistry([rule]));
}

const ctx = { model: {}, modelRegistry: { getAll: () => [], getAvailable: () => [] } } as never;
const pi = { getActiveTools: () => [] } as never;

function sessionWithScope(base: string, scope: AutonomousScope | null): unknown {
  return {
    basePath: base,
    originalBasePath: base,
    currentMilestoneId: "M010",
    autonomousScope: scope,
  };
}

test("--from N mechanically blocks dispatch of a slice below N (in-process scope)", async () => {
  const base = makeBase();
  insertMilestone({ id: "M010", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M010", title: "Slice 1", status: "active", depends: [], sequence: 1 });
  insertTask({ milestoneId: "M010", sliceId: "S01", id: "T01", title: "Task", status: "active" });
  installFixedDispatchRule("execute-task", "M010/S01/T01");

  const session = sessionWithScope(base, { from: 3, to: null, only: null });
  const result = await decideOrchestratorDispatch(ctx, pi, base, session as never, { stateSnapshot: makeState() });

  assert.deepEqual(result, {
    kind: "blocked",
    reason:
      "Slice S01 (unit 1) of M010 is outside the requested autonomous scope " +
      "(All remaining work from 3) -- stopping dispatch.",
    action: "stop",
    guardId: "autonomous-scope-slice",
  });
});

test("--to N mechanically blocks dispatch of a slice above N (in-process scope)", async () => {
  const base = makeBase();
  insertMilestone({ id: "M010", title: "Milestone", status: "active" });
  insertSlice({ id: "S05", milestoneId: "M010", title: "Slice 5", status: "active", depends: [], sequence: 5 });
  insertTask({ milestoneId: "M010", sliceId: "S05", id: "T01", title: "Task", status: "active" });
  installFixedDispatchRule("execute-task", "M010/S05/T01");

  const session = sessionWithScope(base, { from: null, to: 2, only: null });
  const result = await decideOrchestratorDispatch(ctx, pi, base, session as never, { stateSnapshot: makeState() });

  assert.deepEqual(result, {
    kind: "blocked",
    reason:
      "Slice S05 (unit 5) of M010 is outside the requested autonomous scope " +
      "(All remaining work to 2) -- stopping dispatch.",
    action: "stop",
    guardId: "autonomous-scope-slice",
  });
});

test("a combined --from/--to range blocks below and above the range and dispatches normally inside it", async () => {
  const base = makeBase();
  insertMilestone({ id: "M010", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M010", title: "Slice 2", status: "active", depends: [], sequence: 2 });
  insertSlice({ id: "S04", milestoneId: "M010", title: "Slice 4", status: "active", depends: [], sequence: 4 });
  insertSlice({ id: "S06", milestoneId: "M010", title: "Slice 6", status: "active", depends: [], sequence: 6 });
  insertTask({ milestoneId: "M010", sliceId: "S02", id: "T01", title: "Task", status: "active" });
  insertTask({ milestoneId: "M010", sliceId: "S04", id: "T01", title: "Task", status: "active" });
  insertTask({ milestoneId: "M010", sliceId: "S06", id: "T01", title: "Task", status: "active" });
  const scope: AutonomousScope = { from: 3, to: 5, only: null };

  installFixedDispatchRule("execute-task", "M010/S02/T01");
  const belowResult = await decideOrchestratorDispatch(
    ctx, pi, base, sessionWithScope(base, scope) as never, { stateSnapshot: makeState() },
  );
  assert.ok(belowResult && "kind" in belowResult && belowResult.kind === "blocked", "below-range slice must be blocked");

  installFixedDispatchRule("execute-task", "M010/S06/T01");
  const aboveResult = await decideOrchestratorDispatch(
    ctx, pi, base, sessionWithScope(base, scope) as never, { stateSnapshot: makeState() },
  );
  assert.ok(aboveResult && "kind" in aboveResult && aboveResult.kind === "blocked", "above-range slice must be blocked");

  installFixedDispatchRule("execute-task", "M010/S04/T01");
  const inRangeResult = await decideOrchestratorDispatch(
    ctx, pi, base, sessionWithScope(base, scope) as never, { stateSnapshot: makeState() },
  );
  assert.ok(inRangeResult && "unitType" in inRangeResult, "in-range slice must dispatch");
  if (!inRangeResult || !("unitType" in inRangeResult)) return;
  assert.equal(inRangeResult.unitId, "M010/S04/T01");
});

test("a milestone/project-level unit (no slice component) is never scope-checked, matching --only's own milestone-ordinal-only behaviour", async () => {
  const base = makeBase();
  insertMilestone({ id: "M010", title: "Milestone", status: "active" });
  // Scope excludes every slice ordinal -- if the gate mistakenly applied to
  // a bare "mid" unitId it would block this dispatch too.
  const scope: AutonomousScope = { from: 999, to: null, only: null };
  installFixedDispatchRule("complete-milestone", "M010");

  const result = await decideOrchestratorDispatch(
    ctx, pi, base, sessionWithScope(base, scope) as never, { stateSnapshot: makeState() },
  );

  assert.ok(result && "unitType" in result, `milestone-level dispatch must not be scope-gated, got ${JSON.stringify(result)}`);
  if (!result || !("unitType" in result)) return;
  assert.equal(result.unitId, "M010");
});

test("restart-safety: a durably-persisted resume_from is enforced mechanically after the in-process scope is gone", async () => {
  const base = makeBase();
  insertMilestone({ id: "M010", title: "Milestone", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M010", title: "Slice 2", status: "active", depends: [], sequence: 2 });
  insertSlice({ id: "S05", milestoneId: "M010", title: "Slice 5", status: "active", depends: [], sequence: 5 });
  insertTask({ milestoneId: "M010", sliceId: "S02", id: "T01", title: "Task", status: "active" });
  insertTask({ milestoneId: "M010", sliceId: "S05", id: "T01", title: "Task", status: "active" });

  // Mirrors production's startMilestoneRunLogEntry (commands-gsd-core.ts): a
  // prior `/gsd autonomous --from 4` call durably persisted resume_from=4
  // BEFORE the process that set it exited/restarted.
  recordMilestoneRunLifecycle({
    invocation: internalExecutionInvocation("test:restart-safety:M010"),
    milestoneId: "M010",
    runId: randomUUID(),
    attempt: 1,
    status: "running",
    resumeFrom: 4,
  });

  // Simulate the restart: a FRESH session with no in-process autonomousScope
  // at all (a brand-new AutoSession never touched by handleAutonomous in
  // this process) -- the gate must fall back to the durable row, not
  // silently admit everything.
  const restartedSession = {
    basePath: base,
    originalBasePath: base,
    currentMilestoneId: "M010",
    autonomousScope: null,
  };

  installFixedDispatchRule("execute-task", "M010/S02/T01");
  const belowResult = await decideOrchestratorDispatch(
    ctx, pi, base, restartedSession as never, { stateSnapshot: makeState() },
  );
  assert.deepEqual(belowResult, {
    kind: "blocked",
    reason:
      "Slice S02 (unit 2) of M010 is outside the requested autonomous scope " +
      "(All remaining work from 4) -- stopping dispatch.",
    action: "stop",
    guardId: "autonomous-scope-slice",
  });

  installFixedDispatchRule("execute-task", "M010/S05/T01");
  const atOrAboveResult = await decideOrchestratorDispatch(
    ctx, pi, base, restartedSession as never, { stateSnapshot: makeState() },
  );
  assert.ok(
    atOrAboveResult && "unitType" in atOrAboveResult,
    `a slice at/above the durable resume_from must still dispatch, got ${JSON.stringify(atOrAboveResult)}`,
  );
  if (!atOrAboveResult || !("unitType" in atOrAboveResult)) return;
  assert.equal(atOrAboveResult.unitId, "M010/S05/T01");
});
