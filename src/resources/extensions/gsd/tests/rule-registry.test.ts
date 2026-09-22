// GSD Extension — Rule Registry Tests
//
// Tests the RuleRegistry class, UnifiedRule types, singleton accessors,
// and evaluation methods using mock rules.

import assert from 'node:assert/strict';
import { test, describe, beforeEach } from "node:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, realpathSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { emitJournalEvent } from "../journal.ts";
import {
  RuleRegistry,
  getRegistry,
  setRegistry,
  initRegistry,
  resetRegistry,
  convertDispatchRules,
  getOrCreateRegistry,
  resolveHookArtifactPath,
  GAP_CLOSURE_MAX_CYCLES,
} from "../rule-registry.ts";
import type { UnifiedRule } from "../rule-types.ts";
import type { DispatchAction, DispatchContext } from "../auto-dispatch.ts";
import { DISPATCH_RULES, getDispatchRuleNames } from "../auto-dispatch.ts";
import type { GSDState } from "../types.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  _getAdapter,
  saveReworkBrief,
  applyReworkResolutions,
  getBlockingReworkFindingsForTask,
  getUnresolvedBlockingReworkFindingsForTask,
} from "../gsd-db.ts";
import { resolvePostUnitHooks } from "../preferences.ts";
import {
  SELF_UAT_LOG_DIR_RELATIVE,
  selfUatLogFileName,
  renderSelfUat,
  type SelfUatCriterionResult,
} from "../verify-agentic-log.ts";
import { completeSlice, type SliceCompletionCloseout } from "../slice-lifecycle-domain-operation.ts";
import { internalExecutionInvocation } from "../execution-invocation.ts";
import { seedSliceCompletionAuthority } from "./slice-completion-fixture.ts";

// ─── Mock Rule Factories ──────────────────────────────────────────────────

function mockDispatchRule(name: string, matchPhase: string): UnifiedRule {
  return {
    name,
    when: "dispatch",
    evaluation: "first-match",
    where: async (ctx: DispatchContext): Promise<DispatchAction | null> => {
      if (ctx.state.phase === matchPhase) {
        return {
          action: "dispatch",
          unitType: `test-${matchPhase}`,
          unitId: "test-id",
          prompt: `Prompt for ${matchPhase}`,
        };
      }
      return null;
    },
    then: () => {},
    description: `Mock rule for ${matchPhase}`,
  };
}

function makeContext(phase: string): DispatchContext {
  return {
    basePath: "/tmp/test",
    mid: "M001",
    midTitle: "Test Milestone",
    state: {
      phase: phase as any,
      activeMilestone: { id: "M001", title: "Test" },
      activeSlice: null,
      activeTask: null,
      recentDecisions: [],
      blockers: [],
      nextAction: "",
      registry: [],
    },
    prefs: undefined,
  };
}

// ─── Tests ────────────────────────────────────────────────────────────────

describe("RuleRegistry", () => {
    beforeEach(() => {
    resetRegistry();
  });

  test("construct with dispatch rules, listRules returns them", () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("rule-a", "planning"),
      mockDispatchRule("rule-b", "executing"),
      mockDispatchRule("rule-c", "complete"),
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();

    // At minimum, dispatch rules are returned (hook rules depend on prefs)
    const dispatchRules = listed.filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 3, "listRules returns 3 dispatch rules");
    assert.deepStrictEqual(dispatchRules[0].name, "rule-a", "first rule name is rule-a");
    assert.deepStrictEqual(dispatchRules[1].name, "rule-b", "second rule name is rule-b");
    assert.deepStrictEqual(dispatchRules[2].name, "rule-c", "third rule name is rule-c");
  });

  test("listRules returns correct fields on each rule", () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("check-fields", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const listed = registry.listRules();
    const rule = listed.find(r => r.name === "check-fields")!;

    assert.ok(rule !== undefined, "rule found by name");
    assert.deepStrictEqual(rule.when, "dispatch", "when field is dispatch");
    assert.deepStrictEqual(rule.evaluation, "first-match", "evaluation is first-match");
    assert.ok(typeof rule.where === "function", "where is a function");
    assert.ok(typeof rule.then === "function", "then is a function");
    assert.deepStrictEqual(rule.description, "Mock rule for planning", "description is set");
  });

  test("evaluateDispatch returns first matching rule", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("rule-planning", "planning"),
      mockDispatchRule("rule-executing", "executing"),
      mockDispatchRule("rule-complete", "complete"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("executing");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "test-executing", "matched the executing rule");
      assert.deepStrictEqual(result.prompt, "Prompt for executing", "prompt from matched rule");
    }
  });

  test("evaluateDispatch returns stop when no rule matches", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("only-planning", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("blocked");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    if (result.action === "stop") {
      assert.ok(result.reason.includes("blocked"), "stop reason mentions phase");
    }
  });

  test("evaluateDispatch works with async where predicate", async () => {
    const asyncRule: UnifiedRule = {
      name: "async-rule",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext): Promise<DispatchAction | null> => {
        // Simulate async work
        await new Promise(resolve => setTimeout(resolve, 1));
        if (ctx.state.phase === "planning") {
          return {
            action: "dispatch",
            unitType: "async-test",
            unitId: "async-id",
            prompt: "Async prompt",
          };
        }
        return null;
      },
      then: () => {},
    };

    const registry = new RuleRegistry([asyncRule]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "async dispatch resolved");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "async-test", "async rule matched");
    }
  });

  test("resetState clears all mutable state", () => {
    const registry = new RuleRegistry([]);

    // Set up some state
    registry.activeHook = {
      hookName: "test-hook",
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T01",
      cycle: 2,
      pendingRetry: false,
    };
    registry.hookQueue.push({
      config: { name: "q", after: [], prompt: "p" },
      triggerUnitType: "execute-task",
      triggerUnitId: "M001/S01/T02",
    });
    registry.cycleCounts.set("test/key", 3);
    registry.retryPending = true;
    registry.retryTrigger = { unitType: "execute-task", unitId: "M001/S01/T01", retryArtifact: "RETRY" };

    // Reset
    registry.resetState();

    assert.deepStrictEqual(registry.getActiveHook(), null, "activeHook cleared");
    assert.deepStrictEqual(registry.hookQueue.length, 0, "hookQueue cleared");
    assert.deepStrictEqual(registry.cycleCounts.size, 0, "cycleCounts cleared");
    assert.deepStrictEqual(registry.isRetryPending(), false, "retryPending cleared");
    assert.deepStrictEqual(registry.consumeRetryTrigger(), null, "retryTrigger cleared");
  });

  test("peekRetryTrigger observes a pending retry without consuming it", () => {
    const registry = new RuleRegistry([]);
    const expected = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };
    registry.retryPending = true;
    registry.retryTrigger = expected;

    const peeked = registry.peekRetryTrigger();

    assert.deepStrictEqual(peeked, expected);
    assert.notStrictEqual(peeked, registry.retryTrigger, "peek returns a defensive copy");
    assert.equal(registry.isRetryPending(), true, "peek leaves the retry pending");
    assert.deepStrictEqual(registry.consumeRetryTrigger(), expected, "consume still acknowledges the trigger");
    assert.equal(registry.isRetryPending(), false);
  });

  test("pending hook retry survives registry persistence until acknowledged", () => {
    const basePath = mkdtempSync(join(tmpdir(), "gsd-hook-retry-state-"));
    const expected = {
      unitType: "execute-task",
      unitId: "M001/S01/T01",
      retryArtifact: "NEEDS-REWORK.md",
    };
    try {
      const beforeRestart = new RuleRegistry([]);
      beforeRestart.retryPending = true;
      beforeRestart.retryTrigger = expected;
      beforeRestart.persistState(basePath);

      const afterRestart = new RuleRegistry([]);
      afterRestart.restoreState(basePath);

      assert.equal(afterRestart.isRetryPending(), true);
      assert.deepEqual(afterRestart.peekRetryTrigger(), expected);
      assert.deepEqual(afterRestart.consumeRetryTrigger(), expected);
      assert.equal(afterRestart.isRetryPending(), false);
    } finally {
      rmSync(basePath, { recursive: true, force: true });
    }
  });

  test("singleton getRegistry throws when not initialized", () => {
    let threw = false;
    try {
      getRegistry();
    } catch (e: any) {
      threw = true;
      assert.ok(e.message.includes("not initialized"), "error mentions not initialized");
    }
    assert.ok(threw, "getRegistry threw");
  });

  test("setRegistry / getRegistry round-trips", () => {
    const registry = new RuleRegistry([mockDispatchRule("singleton-test", "planning")]);
    setRegistry(registry);

    const retrieved = getRegistry();
    assert.deepStrictEqual(retrieved, registry, "getRegistry returns the same instance");

    const listed = retrieved.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has 1 dispatch rule");
    assert.deepStrictEqual(listed[0].name, "singleton-test", "rule name matches");
  });

  test("initRegistry creates and sets singleton", () => {
    const rules = [mockDispatchRule("init-test", "executing")];
    const registry = initRegistry(rules);

    assert.deepStrictEqual(getRegistry(), registry, "initRegistry sets the singleton");
    const listed = getRegistry().listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, 1, "singleton has the rule");
  });

  test("evaluateDispatch respects rule order (first match wins)", async () => {
    // Both rules match "planning" but rule-first should win
    const ruleFirst: UnifiedRule = {
      name: "rule-first",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext) => {
        if (ctx.state.phase === "planning") {
          return { action: "dispatch" as const, unitType: "first-wins", unitId: "id", prompt: "first" };
        }
        return null;
      },
      then: () => {},
    };
    const ruleSecond: UnifiedRule = {
      name: "rule-second",
      when: "dispatch",
      evaluation: "first-match",
      where: async (ctx: DispatchContext) => {
        if (ctx.state.phase === "planning") {
          return { action: "dispatch" as const, unitType: "second-loses", unitId: "id", prompt: "second" };
        }
        return null;
      },
      then: () => {},
    };

    const registry = new RuleRegistry([ruleFirst, ruleSecond]);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "dispatch action returned");
    if (result.action === "dispatch") {
      assert.deepStrictEqual(result.unitType, "first-wins", "first rule won over second");
    }
  });

  // ── Dispatch rule conversion tests ─────────────────────────────────

  test("convertDispatchRules produces correct count of UnifiedRule objects", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    assert.deepStrictEqual(converted.length, DISPATCH_RULES.length, `convertDispatchRules produces ${DISPATCH_RULES.length} rules`);
  });

  test("each converted rule has correct when, evaluation, and original name", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    for (let i = 0; i < converted.length; i++) {
      const rule = converted[i];
      assert.deepStrictEqual(rule.when, "dispatch", `rule ${i} has when:"dispatch"`);
      assert.deepStrictEqual(rule.evaluation, "first-match", `rule ${i} has evaluation:"first-match"`);
      assert.deepStrictEqual(rule.name, DISPATCH_RULES[i].name, `rule ${i} preserves name "${DISPATCH_RULES[i].name}"`);
      assert.ok(typeof rule.where === "function", `rule ${i} has a where function`);
      assert.ok(typeof rule.then === "function", `rule ${i} has a then function`);
    }
  });

  test("listRules after construction with real dispatch rules returns correct count", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listed = registry.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(listed.length, DISPATCH_RULES.length, `listRules returns ${DISPATCH_RULES.length} dispatch rules`);
  });

  test("rule names from listRules match getDispatchRuleNames in exact order", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const listedNames = registry.listRules()
      .filter(r => r.when === "dispatch")
      .map(r => r.name);
    const originalNames = getDispatchRuleNames();

    assert.deepStrictEqual(listedNames.length, originalNames.length, "same number of names");
    for (let i = 0; i < originalNames.length; i++) {
      assert.deepStrictEqual(listedNames[i], originalNames[i], `name at index ${i} matches: "${originalNames[i]}"`);
    }
  });

  // ── getOrCreateRegistry (lazy init for facades) ────────────────────

  test("getOrCreateRegistry lazily creates a registry with empty dispatch rules", () => {
    // After resetRegistry(), getRegistry() would throw. getOrCreateRegistry() should not.
    const registry = getOrCreateRegistry();
    assert.ok(registry instanceof RuleRegistry, "returns a RuleRegistry instance");
    const dispatchRules = registry.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 0, "lazily-created registry has 0 dispatch rules");
  });

  test("getOrCreateRegistry returns existing registry when initialized", () => {
    const rules = [mockDispatchRule("explicit-init", "planning")];
    const explicit = initRegistry(rules);
    const lazy = getOrCreateRegistry();
    assert.deepStrictEqual(lazy, explicit, "getOrCreateRegistry returns the same singleton as initRegistry");
    const dispatchRules = lazy.listRules().filter(r => r.when === "dispatch");
    assert.deepStrictEqual(dispatchRules.length, 1, "singleton has the explicitly initialized dispatch rule");
  });

  // ── Hook-derived rules in listRules ────────────────────────────────

  test("listRules returns only dispatch rules when no hooks are configured", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();
    const postUnitRules = allRules.filter(r => r.when === "post-unit");
    const preDispatchRules = allRules.filter(r => r.when === "pre-dispatch");

    // No preferences file = no hooks
    assert.deepStrictEqual(postUnitRules.length, 0, "no post-unit rules when no hooks configured");
    assert.deepStrictEqual(preDispatchRules.length, 0, "no pre-dispatch rules when no hooks configured");
    assert.deepStrictEqual(allRules.length, DISPATCH_RULES.length, "total rules equals dispatch rules only");
  });

  test("listRules dispatch rules appear first, hooks after", () => {
    const converted = convertDispatchRules(DISPATCH_RULES);
    const registry = new RuleRegistry(converted);
    const allRules = registry.listRules();

    // Verify dispatch rules come first (indices 0..N-1)
    for (let i = 0; i < converted.length; i++) {
      assert.deepStrictEqual(allRules[i].when, "dispatch", `rule at index ${i} is a dispatch rule`);
      assert.deepStrictEqual(allRules[i].name, converted[i].name, `dispatch rule at index ${i} has correct name`);
    }
  });

  // ── Facade delegation (post-unit-hooks.ts imports work through registry) ──

  test("evaluatePostUnit returns null for hook-on-hook prevention", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("hook/code-review", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "hook units don't trigger other hooks");
  });

  test("evaluatePostUnit returns null for triage-captures", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("triage-captures", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "triage-captures skipped");
  });

  test("evaluatePostUnit returns null for quick-task", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePostUnit("quick-task", "M001/S01/T01", "/tmp/test");
    assert.deepStrictEqual(result, null, "quick-task skipped");
  });

  test("evaluatePostUnit does not dispatch execute-task hooks before canonical completion", (t) => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-staged-task-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));

    t.after(() => {
      closeDatabase();
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    });

    mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
    writeFileSync(
      join(projectRoot, ".gsd", "PREFERENCES.md"),
      [
        "---",
        "version: 1",
        "post_unit_hooks:",
        "  - name: review-after-task",
        "    after: [execute-task]",
        "    prompt: Review {taskId}",
        "---",
      ].join("\n"),
      "utf-8",
    );
    process.env.GSD_HOME = tempGsdHome;
    openDatabase(join(projectRoot, ".gsd", "gsd.db"));
    insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
    insertSlice({ id: "S01", milestoneId: "M001", title: "Test Slice", status: "active" });
    insertTask({
      id: "T01",
      milestoneId: "M001",
      sliceId: "S01",
      title: "Staged Task",
      status: "pending",
    });

    const registry = new RuleRegistry([]);
    assert.equal(
      registry.evaluatePostUnit("execute-task", "M001/S01/T01", projectRoot),
      null,
      "verify-staged Tasks must fail closed without dispatching hooks",
    );
  });

  test("evaluatePreDispatch bypasses hook units", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("hook/review", "M001/S01/T01", "prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "hook units always proceed");
    assert.deepStrictEqual(result.prompt, "prompt", "prompt unchanged");
    assert.deepStrictEqual(result.firedHooks.length, 0, "no hooks fired");
  });

  test("evaluatePreDispatch proceeds with empty hooks", () => {
    const registry = new RuleRegistry([]);
    const result = registry.evaluatePreDispatch("execute-task", "M001/S01/T01", "original prompt", "/tmp/test");
    assert.deepStrictEqual(result.action, "proceed", "proceeds when no hooks");
    assert.deepStrictEqual(result.prompt, "original prompt", "prompt unchanged");
  });

  test("hook evaluation loads preferences from explicit basePath when cwd is an isolated worktree", () => {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-base-"));
    const worktreeRoot = mkdtempSync(join(tmpdir(), "gsd-hook-worktree-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));

    try {
      mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".gsd", "PREFERENCES.md"),
        [
          "---",
          "version: 1",
          "pre_dispatch_hooks:",
          "  - name: policy-prepend",
          "    before: [complete-slice]",
          "    action: modify",
          "    prepend: POLICY TEXT HERE",
          "post_unit_hooks:",
          "  - name: review-after-task",
          "    after: [plan-slice]",
          "    prompt: Review {taskId}",
          "---",
        ].join("\n"),
        "utf-8",
      );

      process.env.GSD_HOME = tempGsdHome;
      process.chdir(worktreeRoot);

      const registry = new RuleRegistry([]);
      const preResult = registry.evaluatePreDispatch(
        "complete-slice",
        "M001/S01",
        "original prompt",
        projectRoot,
      );

      assert.deepStrictEqual(preResult.action, "proceed");
      assert.ok(preResult.prompt?.startsWith("POLICY TEXT HERE"), "pre-dispatch hook prepends policy text");
      assert.deepStrictEqual(preResult.firedHooks, ["policy-prepend"]);

      const postResult = registry.evaluatePostUnit("plan-slice", "M001/S01/T01", projectRoot);
      assert.notEqual(postResult, null, "post-unit hook dispatches from basePath preferences");
      assert.deepStrictEqual(postResult!.hookName, "review-after-task");
      assert.equal(postResult!.prompt.includes("Review T01"), true);
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(worktreeRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("failed hook completion with an artifact does not dequeue the next hook", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-failed-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    const unitId = "M001/S01/T01";

    try {
      mkdirSync(join(projectRoot, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
      writeFileSync(
        join(projectRoot, ".gsd", "PREFERENCES.md"),
        [
          "---",
          "version: 1",
          "post_unit_hooks:",
          "  - name: review-arbiter",
          "    after: [plan-slice]",
          "    prompt: Review {taskId}",
          "    artifact: REVIEW.md",
          "    max_cycles: 1",
          "  - name: follow-up-review",
          "    after: [plan-slice]",
          "    prompt: Follow-up review {taskId}",
          "---",
        ].join("\n"),
        "utf-8",
      );
      process.env.GSD_HOME = tempGsdHome;

      const registry = new RuleRegistry([]);
      const firstHook = registry.evaluatePostUnit("plan-slice", unitId, projectRoot);
      assert.equal(firstHook?.hookName, "review-arbiter");

      writeFileSync(
        resolveHookArtifactPath(projectRoot, unitId, "REVIEW.md"),
        "partial review output",
        "utf-8",
      );
      emitJournalEvent(projectRoot, {
        ts: "2026-06-03T12:00:00.000Z",
        flowId: "flow-hook-failed",
        seq: 3,
        eventType: "unit-end",
        data: {
          unitType: "hook/review-arbiter",
          unitId,
          status: "cancelled",
          artifactVerified: false,
          errorContext: {
            message: "Provider error: Stream ended without finish_reason",
            category: "provider",
          },
        },
      });

      const nextHook = registry.evaluatePostUnit("hook/review-arbiter", unitId, projectRoot);
      assert.equal(nextHook, null, "failed hook must not allow follow-up hook dispatch");
      const failure = registry.consumeHookFailure();
      assert.equal(failure?.hookName, "review-arbiter");
      assert.match(failure?.reason ?? "", /status cancelled/);

      const resumedRegistry = new RuleRegistry([]);
      resumedRegistry.restoreState(projectRoot);
      const resumedHook = resumedRegistry.evaluatePostUnit("plan-slice", unitId, projectRoot);
      assert.equal(resumedHook, null, "resumed hook evaluation must not skip failed hook artifact");
      assert.equal(resumedRegistry.consumeHookFailure()?.hookName, "review-arbiter");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  // ── matchedRule provenance (S02 journal support) ───────────────────

  test("evaluateDispatch result includes matchedRule on dispatch match", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("my-planning-rule", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("planning");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "dispatch", "result is a dispatch action");
    assert.deepStrictEqual(result.matchedRule, "my-planning-rule", "matchedRule is the rule name");
  });

  test("evaluateDispatch result includes matchedRule '<no-match>' on fallback stop", async () => {
    const rules: UnifiedRule[] = [
      mockDispatchRule("only-planning", "planning"),
    ];
    const registry = new RuleRegistry(rules);
    const ctx = makeContext("some-unknown-phase");
    const result = await registry.evaluateDispatch(ctx);

    assert.deepStrictEqual(result.action, "stop", "result is a stop action");
    assert.deepStrictEqual(result.matchedRule, "<no-match>", "matchedRule is '<no-match>' on fallback");
  });
});

// ─── Phase 11: agentic-gate1 blocking dispatch ─────────────────────────────

/** Shared fixture setup for the agentic-gate1 describe block below. */
function setupGate1Fixture(prefsLines: string[]): { projectRoot: string; cleanup: () => void } {
  const originalGsdHome = process.env.GSD_HOME;
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-gate1-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-gate1-home-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  writeFileSync(join(projectRoot, ".gsd", "PREFERENCES.md"), prefsLines.join("\n"), "utf-8");
  process.env.GSD_HOME = tempGsdHome;
  openDatabase(join(projectRoot, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test Milestone", status: "active" });
  return {
    projectRoot,
    cleanup: () => {
      closeDatabase();
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    },
  };
}

describe("agentic-gate1 blocking dispatch (Phase 11)", () => {
  test("toggle OFF: resolvePostUnitHooks has no agentic-gate1 entry even with unrelated post_unit_hooks configured", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "post_unit_hooks:",
      "  - name: review-after-task",
      "    after: [execute-task]",
      "    prompt: Review {taskId}",
      "---",
    ]);
    try {
      insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
      const hooks = resolvePostUnitHooks(projectRoot);
      assert.equal(hooks.some(h => h.name === "agentic-gate1"), false, "toggle off must never synthesize the gate hook");
    } finally {
      cleanup();
    }
  });

  test("toggle ON + android surface + criteria: dispatch prompt uses the android driver, never cli", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });
      _getAdapter()!.prepare("UPDATE slices SET surface = ? WHERE milestone_id = ? AND id = ?")
        .run("android", "M001", "S01");

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);

      assert.notEqual(dispatch, null, "criteria-bearing slice with toggle on must dispatch");
      assert.equal(dispatch!.unitType, "hook/agentic-gate1");
      assert.ok(dispatch!.prompt.includes("S01"), "prompt must reference the target slice ID");
      assert.ok(
        dispatch!.prompt.includes("src/resources/skills/agentic-tester/drivers/android.md"),
        "prompt must reference the android driver path",
      );
      assert.equal(
        dispatch!.prompt.includes("src/resources/skills/agentic-tester/drivers/cli.md"),
        false,
        "prompt must NEVER reference the cli driver path for an android-surfaced slice",
      );
    } finally {
      cleanup();
    }
  });

  test("an unrecognized slices.surface value throws loudly rather than silently defaulting to cli (D-02, Pitfall 4)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });
      _getAdapter()!.prepare("UPDATE slices SET surface = ? WHERE milestone_id = ? AND id = ?")
        .run("bogus-surface", "M001", "S01");

      const registry = new RuleRegistry([]);
      assert.throws(
        () => registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot),
        /slices\.surface value "bogus-surface" is not one of/,
        "an unrecognized surface value must throw, never silently route through the cli driver",
      );
    } finally {
      cleanup();
    }
  });

  test("a real passing timestamped SELF-UAT artifact clears the block and evaluatePostUnit returns null", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);
      assert.equal(dispatch!.unitType, "hook/agentic-gate1");

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });
      // CR-01: artifact is keyed by the full "{milestone}/{slice}" unit id,
      // not the bare slice id, so it must match what `_readGateOutcome` now
      // looks up.
      const fileName = selfUatLogFileName("M001/S01", new Date().toISOString());
      writeFileSync(join(selfUatDir, fileName), "---\nresult: all_pass\nverdict: pass\n---\n", "utf-8");

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null, "a pass verdict clears the block");
      assert.equal(registry.consumeGateBlock(), null, "no gate block should be pending after a pass verdict");
    } finally {
      cleanup();
    }
  });

  test("a criteria-less slice self-skips: evaluatePostUnit returns null, never queuing the gate hook", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({ id: "S01", milestoneId: "M001", status: "active" });

      const registry = new RuleRegistry([]);
      const result = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.equal(result, null, "a slice with no declared success_criteria must never dispatch the gate hook");
    } finally {
      cleanup();
    }
  });

  test("two different criteria-bearing slices dispatch independently with correct per-slice targets, no cross-slice bleed", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });
      insertSlice({
        id: "S02",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle Y" },
      });

      const registry1 = new RuleRegistry([]);
      const dispatch1 = registry1.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      const registry2 = new RuleRegistry([]);
      const dispatch2 = registry2.evaluatePostUnit("complete-slice", "M001/S02", projectRoot);

      assert.notEqual(dispatch1, null);
      assert.notEqual(dispatch2, null);
      assert.equal(dispatch1!.unitId, "M001/S01");
      assert.equal(dispatch2!.unitId, "M001/S02");
      assert.ok(dispatch1!.prompt.includes("S01"));
      assert.ok(dispatch2!.prompt.includes("S02"));
      assert.equal(dispatch1!.prompt.includes("S02"), false, "S01's dispatch must not bleed S02's target");
    } finally {
      cleanup();
    }
  });

  test("CR-01 regression: two different milestones' same-numbered slice each read back their own SELF-UAT artifact, no cross-milestone bleed", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      // Slice IDs conventionally restart per milestone (every milestone's
      // first slice is "S01" in this codebase's own fixtures) -- this is
      // exactly the collision CR-01 describes.
      insertMilestone({ id: "M002", title: "Second Milestone", status: "active" });
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });
      insertSlice({
        id: "S01",
        milestoneId: "M002",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registryM001 = new RuleRegistry([]);
      assert.notEqual(registryM001.evaluatePostUnit("complete-slice", "M001/S01", projectRoot), null);
      const registryM002 = new RuleRegistry([]);
      assert.notEqual(registryM002.evaluatePostUnit("complete-slice", "M002/S01", projectRoot), null);

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });

      // M001/S01's own run genuinely found a defect and wrote needs-rework...
      const m001File = selfUatLogFileName("M001/S01", "2026-09-21T10:00:00.000Z");
      writeFileSync(join(selfUatDir, m001File), "---\nresult: has_fail\nverdict: needs-rework\n---\n", "utf-8");

      // ...then, independently and LATER (newer mtime), M002/S01's own run
      // genuinely passed. Before CR-01's fix, resolveAgenticGateArtifactPath
      // was keyed by the bare slice id "S01" and would return whichever
      // artifact was most-recently modified -- M002's newer `pass` -- even
      // when evaluating M001's gate.
      const m002File = selfUatLogFileName("M002/S01", "2026-09-21T11:00:00.000Z");
      writeFileSync(join(selfUatDir, m002File), "---\nresult: all_pass\nverdict: pass\n---\n", "utf-8");

      const m001Result = registryM001.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(m001Result, null, "M001/S01's needs-rework must not auto-dispatch/retry");
      const m001Block = registryM001.consumeGateBlock();
      assert.notEqual(m001Block, null, "M001/S01 must still be blocked by its OWN needs-rework verdict, not cleared by M002's newer pass");

      const m002Result = registryM002.evaluatePostUnit("hook/agentic-gate1", "M002/S01", projectRoot);
      assert.equal(m002Result, null, "M002/S01's own pass verdict clears its block");
      assert.equal(registryM002.consumeGateBlock(), null, "M002/S01 must clear based on its OWN pass artifact");
    } finally {
      cleanup();
    }
  });

  test("toggle genuinely unset (not written at all): behaves identically to explicit false — zero dispatch", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const result = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.equal(result, null, "an unset toggle must behave exactly like an explicit false");
    } finally {
      cleanup();
    }
  });

  test("a duplicate complete-slice trigger for the same already-dispatched slice does not double-dispatch", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      // The existing, unmodified one-shot lost-dispatch refund
      // (#1246/#2194 — a repeated "complete-slice" trigger with no
      // intervening hook/agentic-gate1 completion looks identical to a
      // lost/interrupted dispatch) means a repeated trigger is re-dispatched
      // at least once before ever blocking. Phase 12 (RESEARCH gap 1) raised
      // AGENTIC_GATE1_HOOK_CONFIG.max_cycles from its 1-cycle default to 8
      // (dispatch headroom for the gap-closure loop), so the SAME repeated
      // trigger now re-dispatches up to that larger budget before blocking
      // — still bounded, never unbounded, just at a bigger bound. Drive
      // repeated triggers until the budget is genuinely exhausted, proving
      // the loop terminates rather than hard-coding the old cycle count.
      const registry = new RuleRegistry([]);
      const first = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(first, null, "first complete-slice trigger must dispatch");
      assert.equal(first!.unitType, "hook/agentic-gate1");

      let sawBlock = false;
      for (let i = 0; i < 20; i++) {
        const next = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
        if (next === null) {
          sawBlock = true;
          break;
        }
        assert.equal(next!.unitType, "hook/agentic-gate1", "every re-dispatch before the budget exhausts must still be the same gate hook");
      }
      assert.ok(sawBlock, "repeated triggers must eventually block — never loop unboundedly");
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "the blocked state must be observable, not a silent unbounded loop");
      assert.equal(block?.action, "pause");
    } finally {
      cleanup();
    }
  });

  test("a needs-rework verdict pauses via the engine's existing block mechanism, never auto-retrying (D-01)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });
      // CR-01: artifact is keyed by the full "{milestone}/{slice}" unit id.
      const fileName = selfUatLogFileName("M001/S01", new Date().toISOString());
      writeFileSync(join(selfUatDir, fileName), "---\nresult: has_fail\nverdict: needs-rework\n---\n", "utf-8");

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null, "a needs-rework verdict must not auto-retry/dispatch again");
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "needs-rework must produce an observable gate block");
      assert.equal(block?.action, "pause", "on_block.action must be pause, never retry-unit/retry-task (D-01)");
    } finally {
      cleanup();
    }
  });

  test("WR-02 (resolved): a needs-attention verdict (all-PARTIAL SELF-UAT run) pauses the blocking gate, never clears and never auto-reworks", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });
      // CR-01: artifact is keyed by the full "{milestone}/{slice}" unit id.
      const fileName = selfUatLogFileName("M001/S01", new Date().toISOString());
      // Represents an all-PARTIAL SELF-UAT run: aggregateSelfUat now derives
      // verdict "needs-attention" (not "advisory") for result "has_partial".
      writeFileSync(join(selfUatDir, fileName), "---\nresult: has_partial\nverdict: needs-attention\n---\n", "utf-8");

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null, "a needs-attention verdict must not clear the gate or auto-dispatch again");
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "needs-attention must produce an observable gate block, not a silent clear");
      assert.equal(block?.action, "pause", "on_block.action must be pause, never retry-unit/retry-task");
      assert.equal(
        block?.reason,
        "SELF-UAT partial -- no criterion fully verified",
        "the pause reason must name the SELF-UAT-partial cause for the agentic-gate1 hook specifically",
      );
    } finally {
      cleanup();
    }
  });

  test("WR-02-followup: reconcileRestoredGateBlock on a resumed needs-attention block does not dequeue past the gate, and re-dispatches the same hook rather than clearing it", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });
      const fileName = selfUatLogFileName("M001/S01", new Date().toISOString());
      // Represents an all-PARTIAL SELF-UAT run: aggregateSelfUat derives
      // verdict "needs-attention" (not "advisory") for result "has_partial".
      writeFileSync(join(selfUatDir, fileName), "---\nresult: has_partial\nverdict: needs-attention\n---\n", "utf-8");

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null, "a needs-attention verdict must not clear the gate or auto-dispatch again");

      // Do NOT consume the block here -- persist it outstanding, exactly as
      // it would be across a real pause/resume, and reconcile it against a
      // fresh registry instance restored from that persisted state.
      registry.persistState(projectRoot);

      const resumed = new RuleRegistry([]);
      resumed.restoreState(projectRoot);
      assert.notEqual(
        resumed.gateBlockPending,
        null,
        "the restored registry must still carry the outstanding needs-attention block",
      );

      const reconciled = resumed.reconcileRestoredGateBlock(projectRoot);
      assert.notEqual(
        reconciled,
        null,
        "reconcileRestoredGateBlock must return a fresh dispatch on resume, not silently dequeue past the block as pass/advisory would",
      );
      assert.equal(
        reconciled?.unitType,
        "hook/agentic-gate1",
        "the fresh dispatch must re-run the SAME gate hook, not the next unit behind it in the queue",
      );
      assert.equal(reconciled?.unitId, "M001/S01");
      assert.equal(
        resumed.activeHook?.hookName,
        "agentic-gate1",
        "activeHook must be re-armed so the re-run's completion is assessed against the gate",
      );
      assert.equal(
        resumed.consumeGateBlock(),
        null,
        "reconcile must not leave behind a pass/advisory-style cleared block -- the outstanding needs-attention block was replaced by a live re-dispatch, not treated as a clean pass",
      );
    } finally {
      cleanup();
    }
  });

  test("a halted run with no SELF-UAT artifact still produces an observable block, never a silent hang", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      // No SELF-UAT artifact written at all — simulates a halted run. Phase
      // 12 (RESEARCH gap 1) raised AGENTIC_GATE1_HOOK_CONFIG.max_cycles from
      // its 1-cycle default to 8 (dispatch headroom for the gap-closure
      // loop), so a missing-artifact completion now re-dispatches itself up
      // to that larger budget before finally blocking — still bounded,
      // never hanging, just at a bigger bound.
      let result: ReturnType<typeof registry.evaluatePostUnit> = dispatch;
      for (let i = 0; i < 20 && result !== null; i++) {
        result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      }
      assert.equal(result, null, "a halted run with no artifact must eventually block — never hang unboundedly");
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "the blocked state must be observable");
      assert.equal(typeof block?.reason, "string");
      assert.ok((block?.reason ?? "").length > 0, "the block must carry a non-empty, actionable reason");
    } finally {
      cleanup();
    }
  });
});

describe("resolveHookArtifactPath", () => {
  test("resolves a phase-level artifact from the .gsd/phases layout", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-phase-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });
      const artifactPath = join(phaseDir, "BROWSER-RUNTIME-EVIDENCE.md");
      writeFileSync(artifactPath, "---\nverdict: advisory\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "BROWSER-RUNTIME-EVIDENCE.md");
      assert.equal(resolved, artifactPath, "resolves the canonical phase-level artifact");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("resolves canonical flat-phase scoped artifact names", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-flat-scope-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });
      const milestoneArtifactPath = join(phaseDir, "50-PLAN-REVIEW.md");
      const sliceArtifactPath = join(phaseDir, "50-02-PLAN-REVIEW.md");
      const taskArtifactPath = join(phaseDir, "S02-T01-REVIEW.md");
      writeFileSync(milestoneArtifactPath, "---\nverdict: pass\n---\n", "utf-8");
      writeFileSync(sliceArtifactPath, "---\nverdict: needs-attention\n---\n", "utf-8");
      writeFileSync(taskArtifactPath, "---\nverdict: advisory\n---\n", "utf-8");

      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050", "PLAN-REVIEW.md"),
        milestoneArtifactPath,
        "resolves the canonical milestone-prefixed flat artifact",
      );
      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050/S02", "PLAN-REVIEW.md"),
        sliceArtifactPath,
        "resolves the canonical slice-prefixed flat artifact",
      );
      assert.equal(
        resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md"),
        taskArtifactPath,
        "resolves the canonical slice/task-prefixed flat artifact",
      );
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("flat-phase missing slice artifact fallback points at the canonical slice path", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-flat-slice-miss-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const phaseDir = join(realpathSync(projectRoot), ".gsd", "phases", "50-some-phase");
      mkdirSync(phaseDir, { recursive: true });

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02", "PLAN-REVIEW.md");
      assert.equal(
        resolved,
        join(phaseDir, "50-02-PLAN-REVIEW.md"),
        "diagnostic fallback uses the collision-free slice-prefixed path",
      );
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("falls back to the legacy milestones/slices/tasks layout", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const tasksDir = join(projectRoot, ".gsd", "milestones", "M050", "slices", "S02", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      const artifactPath = join(tasksDir, "T01-REVIEW.md");
      writeFileSync(artifactPath, "---\nverdict: pass\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      assert.equal(resolved, artifactPath, "resolves the task-prefixed legacy artifact");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("legacy: nested task artifact wins over a milestone-root file of the same name", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-root-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const milestoneDir = join(projectRoot, ".gsd", "milestones", "M050");
      const tasksDir = join(milestoneDir, "slices", "S02", "tasks");
      mkdirSync(tasksDir, { recursive: true });
      // The correct task-scoped artifact lives in the nested slices/tasks tree.
      const nestedPath = join(tasksDir, "T01-REVIEW.md");
      writeFileSync(nestedPath, "---\nverdict: pass\n---\n", "utf-8");
      // A same-named decoy at the legacy milestone root must NOT win — before the
      // fix, resolveMilestonePath returned the milestone root and it was probed
      // ahead of the nested task path (#1264 Bugbot follow-up).
      writeFileSync(join(milestoneDir, "REVIEW.md"), "---\nverdict: failed\n---\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      assert.equal(resolved, nestedPath, "task-scoped legacy path wins over the milestone-root file");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });

  test("legacy: missing-artifact fallback points at the nested task path, not the milestone root", () => {
    const originalGsdHome = process.env.GSD_HOME;
    const projectRoot = mkdtempSync(join(tmpdir(), "gsd-hook-legacy-miss-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-hook-home-"));
    try {
      process.env.GSD_HOME = tempGsdHome;
      const milestoneDir = join(projectRoot, ".gsd", "milestones", "M050");
      mkdirSync(milestoneDir, { recursive: true });
      // Content-bearing legacy milestone dir (a non-META file) so resolveMilestonePath
      // returns it, but the requested gate artifact does not exist anywhere.
      writeFileSync(join(milestoneDir, "M050-ROADMAP.md"), "# roadmap\n", "utf-8");

      const resolved = resolveHookArtifactPath(projectRoot, "M050/S02/T01", "REVIEW.md");
      const expected = join(milestoneDir, "slices", "S02", "tasks", "T01-REVIEW.md");
      assert.equal(resolved, expected, "diagnostic fallback uses the nested task path for a legacy task-scoped unit");
    } finally {
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(projectRoot, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  });
});

// ─── Phase 12: agentic-gate1 gap-closure loop ──────────────────────────────

function gapClosureCloseout(): SliceCompletionCloseout {
  return {
    sliceTitle: "Gap-closure fixture",
    oneLiner: "A genuinely completed slice, ready to prove the gap-closure loop.",
    narrative: "Seeded via seedSliceCompletionAuthority, then completed for real via completeSlice.",
    verification: "Phase 12 gap-closure loop test harness.",
    uatContent: "## UAT Type\n\n- UAT mode: runtime-executable\n\nPASS",
    operationalReadiness: "N/A — test fixture.",
    deviations: "None.",
    knownLimitations: "None.",
    followUps: "None.",
    provides: [],
    requires: [],
    affects: [],
    keyFiles: [],
    keyDecisions: [],
    patternsEstablished: [],
    observabilitySurfaces: [],
    drillDownPaths: [],
    requirementsAdvanced: [],
    requirementsValidated: [],
    requirementsSurfaced: [],
    requirementsInvalidated: [],
    filesModified: [],
  };
}

/**
 * Genuinely completes M001/S01 (T01+T02) via the real domain operations,
 * mirroring slice-lifecycle-convergence.test.ts's prepareOperation("complete")
 * ordering exactly. reopenSlice refuses a non-terminal slice, so nothing
 * weaker proves the gap-closure path.
 */
function completeGate1Slice(runId: string): void {
  seedSliceCompletionAuthority({
    milestoneId: "M001",
    sliceId: "S01",
    completedTaskIds: ["T01", "T02"],
    runId,
  });
  completeSlice({
    invocation: internalExecutionInvocation(`gap-closure-test:${runId}`),
    slice: { milestoneId: "M001", sliceId: "S01" },
    closeout: gapClosureCloseout(),
  });
}

function reworkBriefRow(briefId: string): Record<string, unknown> | undefined {
  return _getAdapter()!.prepare("SELECT * FROM rework_briefs WHERE id = :id").get({ ":id": briefId }) as
    | Record<string, unknown>
    | undefined;
}

function reworkBriefCountForSlice(milestoneId: string, sliceId: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS n FROM rework_briefs WHERE milestone_id = :mid AND slice_id = :sid",
  ).get({ ":mid": milestoneId, ":sid": sliceId }) as { n: number };
  return row.n;
}

function findingsForBrief(briefId: string): Array<Record<string, unknown>> {
  return _getAdapter()!.prepare(
    "SELECT * FROM rework_brief_findings WHERE brief_id = :id ORDER BY finding_id",
  ).all({ ":id": briefId }) as Array<Record<string, unknown>>;
}

function gate1TaskStatus(taskId: string): string {
  const row = _getAdapter()!.prepare(
    "SELECT status FROM tasks WHERE milestone_id = 'M001' AND slice_id = 'S01' AND id = :tid",
  ).get({ ":tid": taskId }) as { status: string };
  return row.status;
}

function gate1SliceStatus(): string {
  const row = _getAdapter()!.prepare(
    "SELECT status FROM slices WHERE milestone_id = 'M001' AND id = 'S01'",
  ).get() as { status: string };
  return row.status;
}

const GAP_CLOSURE_PASS_RESULT: SelfUatCriterionResult = {
  criterion: "the first criterion holds",
  verdict: "PASS",
  evidence: "exit 0, stdout matched the expected shape",
};

const GAP_CLOSURE_FAIL_RESULT: SelfUatCriterionResult = {
  criterion: "the second criterion holds",
  verdict: "FAIL",
  evidence: "exit 1, stderr: TypeError: Cannot read properties of undefined (reading 'foo')",
  rootCause: "the handler never checked for a null payload before dereferencing its foo field",
  gapClosureRoute: "Add a null guard in src/handler.ts before the .foo access and re-run this criterion",
};

/** The second criterion re-graded PASS — pairs with GAP_CLOSURE_PASS_RESULT to
 *  produce an all-PASS artifact (aggregateSelfUat -> verdict: pass) once a
 *  gap-closure cycle's rework has (notionally) landed. */
const GAP_CLOSURE_FAIL_RESULT_NOW_PASSING: SelfUatCriterionResult = {
  criterion: "the second criterion holds",
  verdict: "PASS",
  evidence: "exit 0, stderr empty after the null-guard fix",
};

/** Writes a real needs-rework (or, with an all-PASS `results` override, a
 *  clean-pass) SELF-UAT artifact via the real renderer for M001/S01 and
 *  returns its basename. */
function writeNeedsReworkArtifact(
  projectRoot: string,
  timestampIso: string,
  results: SelfUatCriterionResult[] = [GAP_CLOSURE_PASS_RESULT, GAP_CLOSURE_FAIL_RESULT],
): string {
  const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
  mkdirSync(selfUatDir, { recursive: true });
  const fileName = selfUatLogFileName("M001/S01", timestampIso);
  const doc = renderSelfUat(results, {
    target: "M001/S01",
    surface: "cli",
    timestampIso,
  });
  writeFileSync(join(selfUatDir, fileName), doc, "utf-8");
  return fileName;
}

/**
 * Drives one full gap-closure cycle against a genuinely completed slice: a
 * fresh runId re-seeds slice-completion authority and re-completes M001/S01
 * for real (mirroring the "Pitfall 1 regression" test's re-complete step),
 * dispatches the gate, writes a needs-rework SELF-UAT artifact at a fresh
 * timestamp (so resolveAgenticGateArtifactPath's newest-mtime resolution
 * picks THIS cycle's file), then runs the hook completion. Every cycle uses
 * a distinct runId/timestamp — reusing either is what makes a multi-cycle
 * test pass for the wrong reason (12-02-PLAN Task 1).
 */
function runGapClosureCycle(
  registry: RuleRegistry,
  projectRoot: string,
  cycleLabel: string,
  timestampIso: string,
  results: SelfUatCriterionResult[] = [GAP_CLOSURE_PASS_RESULT, GAP_CLOSURE_FAIL_RESULT],
): ReturnType<typeof registry.evaluatePostUnit> {
  completeGate1Slice(`gap-closure-multi-${cycleLabel}`);
  const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
  assert.notEqual(dispatch, null, `cycle ${cycleLabel} dispatch must fire`);
  assert.equal(dispatch!.unitType, "hook/agentic-gate1");
  writeNeedsReworkArtifact(projectRoot, timestampIso, results);
  return registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
}

/** Durable count of `slice.reopened` domain events for an entity — the
 *  ground truth for "how many real reopen operations actually ran",
 *  independent of how many gate evaluations were made (RESEARCH Pitfall 5). */
function reopenedEventCount(entityId: string): number {
  const row = _getAdapter()!.prepare(
    "SELECT COUNT(*) AS n FROM workflow_domain_events WHERE event_type = 'slice.reopened' AND entity_id = :entity_id",
  ).get({ ":entity_id": entityId }) as { n: number };
  return row.n;
}

describe("agentic-gate1 gap-closure loop (Phase 12)", () => {
  test("a needs-rework verdict on a genuinely completed slice reopens it and authors exactly one cycle-1 rework brief (D-01, D-02, D-03)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
      insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

      completeGate1Slice("gap-closure-cycle1");

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null, "a genuinely completed, criteria-bearing slice must dispatch the gate");
      assert.equal(dispatch!.unitType, "hook/agentic-gate1");

      const timestampIso = "2026-09-21T12:00:00.000Z";
      const artifactFileName = writeNeedsReworkArtifact(projectRoot, timestampIso);

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null, "a successful gap-closure exit must not return a dispatch");
      assert.equal(registry.consumeGateBlock(), null, "a successful gap-closure exit must leave no gate block");

      assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "exactly one rework_briefs row for the slice");
      const briefId = "RB-M001-S01-T02-gap-1";
      const brief = reworkBriefRow(briefId);
      assert.ok(brief, `expected a rework_briefs row with id ${briefId}`);
      assert.ok(String(brief!["id"]).endsWith("-gap-1"), "brief id must end with -gap-1 for the first cycle");

      const findings = findingsForBrief(briefId);
      assert.equal(findings.length, 1, "exactly one finding — the FAIL criterion only, not the PASS one");
      const finding = findings[0]!;
      assert.ok(String(finding["finding_id"]).startsWith("GC1-"), "finding id must be cycle-scoped (GC1-...)");
      assert.equal(finding["severity"], "blocking");
      assert.equal(finding["status"], "pending");
      assert.match(
        String(finding["description"]),
        /the second criterion holds/,
        "description must name the failed criterion text",
      );
      assert.match(
        String(finding["evidence"]),
        /Cannot read properties of undefined/,
        "evidence must carry the criterion's evidence line",
      );
      assert.equal(finding["decision_ref"], artifactFileName, "decision_ref must trace to the SELF-UAT artifact's basename");

      assert.notEqual(gate1SliceStatus(), "complete", "the slice must no longer be terminal after gap-closure");
      assert.equal(gate1TaskStatus("T01"), "pending", "every task in the slice must be back to pending");
      assert.equal(gate1TaskStatus("T02"), "pending", "every task in the slice must be back to pending");
    } finally {
      cleanup();
    }
  });

  test("reaching a pre-seeded cap of 3 rework_briefs rows pauses via _pauseForGate and writes no 4th row", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });

      for (let cycle = 1; cycle <= GAP_CLOSURE_MAX_CYCLES; cycle++) {
        saveReworkBrief({
          briefId: `RB-M001-S01-T01-gap-${cycle}`,
          milestoneId: "M001",
          sliceId: "S01",
          taskId: "T01",
          findings: [{
            findingId: `GC${cycle}-01`,
            severity: "blocking",
            description: `pre-seeded finding for cycle ${cycle}`,
            requiredFix: "n/a",
            verificationCommands: [],
            evidence: "pre-seeded",
            decisionRef: "pre-seeded",
          }],
        });
      }
      assert.equal(reworkBriefCountForSlice("M001", "S01"), GAP_CLOSURE_MAX_CYCLES);

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      const timestampIso = "2026-09-21T13:00:00.000Z";
      writeNeedsReworkArtifact(projectRoot, timestampIso);

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null);
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "reaching the cap must produce an observable pause, not another gap-closure attempt");
      assert.equal(block?.action, "pause");

      assert.equal(
        reworkBriefCountForSlice("M001", "S01"),
        GAP_CLOSURE_MAX_CYCLES,
        "no 4th rework_briefs row must be written once the cap is reached",
      );
    } finally {
      cleanup();
    }
  });

  test("a needs-rework artifact with no parsable FAIL/PARTIAL-with-root-cause criterion pauses and writes no brief", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- must handle X" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });

      const registry = new RuleRegistry([]);
      const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(dispatch, null);

      const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
      mkdirSync(selfUatDir, { recursive: true });
      const fileName = selfUatLogFileName("M001/S01", new Date().toISOString());
      // Frontmatter alone reports needs-rework, but the body carries no
      // per-criterion block at all -- nothing for parseSelfUatCriteria to
      // find, so gap-closure must pause rather than author an empty brief.
      writeFileSync(join(selfUatDir, fileName), "---\nresult: has_fail\nverdict: needs-rework\n---\n", "utf-8");

      const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(result, null);
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "a needs-rework verdict with no parsable failing criterion must pause");
      assert.equal(block?.action, "pause");

      assert.equal(reworkBriefCountForSlice("M001", "S01"), 0, "no brief may be written when no failing criterion parses");
    } finally {
      cleanup();
    }
  });

  test("Pitfall 1 regression: the gate can dispatch a second time for the same slice after a gap-closure cycle completes", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
      insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

      completeGate1Slice("gap-closure-pitfall1-cycle1");

      const registry = new RuleRegistry([]);
      const firstDispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(firstDispatch, null);

      writeNeedsReworkArtifact(projectRoot, "2026-09-21T14:00:00.000Z");

      const gapClosureResult = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
      assert.equal(gapClosureResult, null, "cycle 1 gap-closure must complete without a dispatch");
      assert.equal(registry.consumeGateBlock(), null, "cycle 1 gap-closure must leave no gate block");
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "cycle 1 must author exactly one rework_briefs row");

      // Re-complete the slice — as the untouched auto-loop would, once the
      // reopened task's rework is addressed and the slice re-completes —
      // and run a SECOND complete-slice evaluation on the SAME registry
      // instance. Before the max_cycles bump this hard-pauses on the
      // pre-existing, unrelated hook-level cycle budget (Pitfall 1) before
      // any of Phase 12's gap-closure logic is ever consulted.
      completeGate1Slice("gap-closure-pitfall1-cycle1-recomplete");
      const secondDispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
      assert.notEqual(
        secondDispatch,
        null,
        "the engine must not refuse the second dispatch and hard-pause with a budget-exhausted reason (Pitfall 1)",
      );
      assert.equal(secondDispatch!.unitType, "hook/agentic-gate1");
      assert.equal(registry.consumeGateBlock(), null, "the second dispatch must not itself be a gate block");
    } finally {
      cleanup();
    }
  });

  test("AGENTIC_GATE1_HOOK_CONFIG.max_cycles carries headroom above GAP_CLOSURE_MAX_CYCLES (Pitfall 1)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      const hooks = resolvePostUnitHooks(projectRoot);
      const gateConfig = hooks.find((h) => h.name === "agentic-gate1");
      assert.ok(gateConfig, "resolvePostUnitHooks must synthesize the gate config when the toggle is on");
      const maxCycles = gateConfig!.max_cycles;
      assert.equal(typeof maxCycles, "number");
      assert.ok(
        (maxCycles as number) >= GAP_CLOSURE_MAX_CYCLES + 1,
        `max_cycles (${maxCycles}) must be at least GAP_CLOSURE_MAX_CYCLES + 1 (${GAP_CLOSURE_MAX_CYCLES + 1})`,
      );
      assert.ok((maxCycles as number) <= 10, `max_cycles (${maxCycles}) must not exceed the documented ceiling of 10`);
    } finally {
      cleanup();
    }
  });

  test("three cycles author three distinct rework briefs and finding sets, then a 4th needs-rework attempt escalates via the cap (D-03, ROADMAP SC3/SC4)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
      insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

      const registry = new RuleRegistry([]);

      let result = runGapClosureCycle(registry, projectRoot, "1", "2026-09-22T01:00:00.000Z");
      assert.equal(result, null, "cycle 1 gap-closure must complete without a dispatch");
      assert.equal(registry.consumeGateBlock(), null, "cycle 1 must leave no gate block");
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "cycle 1 COUNT must be 1");

      result = runGapClosureCycle(registry, projectRoot, "2", "2026-09-22T02:00:00.000Z");
      assert.equal(result, null, "cycle 2 gap-closure must complete without a dispatch");
      assert.equal(registry.consumeGateBlock(), null, "cycle 2 must leave no gate block");
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 2, "cycle 2 COUNT must be 2");

      result = runGapClosureCycle(registry, projectRoot, "3", "2026-09-22T03:00:00.000Z");
      assert.equal(result, null, "cycle 3 gap-closure must complete without a dispatch");
      assert.equal(registry.consumeGateBlock(), null, "cycle 3 must leave no gate block");
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 3, "cycle 3 COUNT must be 3");

      const briefIds = [1, 2, 3].map((n) => `RB-M001-S01-T02-gap-${n}`);
      for (const [index, briefId] of briefIds.entries()) {
        const brief = reworkBriefRow(briefId);
        assert.ok(brief, `expected a rework_briefs row with id ${briefId}`);
        assert.ok(String(brief!["id"]).endsWith(`-gap-${index + 1}`), `brief id must end with -gap-${index + 1}`);
      }
      assert.equal(new Set(briefIds).size, 3, "the three brief ids must be pairwise distinct");

      const allFindingIds = briefIds.flatMap((id) => findingsForBrief(id).map((f) => String(f["finding_id"])));
      assert.equal(
        new Set(allFindingIds).size,
        allFindingIds.length,
        "finding ids must be pairwise distinct across all three cycles — no id reused",
      );
      assert.ok(allFindingIds.some((id) => id.startsWith("GC1-")), "cycle 1 findings must carry the GC1- prefix");
      assert.ok(allFindingIds.some((id) => id.startsWith("GC2-")), "cycle 2 findings must carry the GC2- prefix");
      assert.ok(allFindingIds.some((id) => id.startsWith("GC3-")), "cycle 3 findings must carry the GC3- prefix");

      // 4th attempt: the cap (GAP_CLOSURE_MAX_CYCLES=3) has already been
      // reached by three real cycles — this must escalate via _pauseForGate
      // rather than author a 4th row.
      result = runGapClosureCycle(registry, projectRoot, "4", "2026-09-22T04:00:00.000Z");
      assert.equal(result, null);
      const block = registry.consumeGateBlock();
      assert.notEqual(block, null, "the 4th needs-rework verdict must produce an observable pause, not a 4th cycle");
      assert.equal(block?.action, "pause");
      assert.match(String(block?.reason ?? ""), /3/, "the pause reason must name the cap count");
      assert.equal(
        reworkBriefCountForSlice("M001", "S01"),
        3,
        "no 4th rework_briefs row may be written once the cap is reached",
      );
    } finally {
      cleanup();
    }
  });

  test("a pass verdict after a gap-closure cycle clears the block and authors no additional rework brief (ROADMAP SC2)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
      insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

      const registry = new RuleRegistry([]);
      const cycle1 = runGapClosureCycle(registry, projectRoot, "pass-fixture-1", "2026-09-22T05:00:00.000Z");
      assert.equal(cycle1, null);
      assert.equal(registry.consumeGateBlock(), null);
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "cycle 1 must author exactly one brief");

      // Re-complete the slice — as the untouched auto-loop would once the
      // reopened task's rework is addressed — and re-run the gate with an
      // ALL-PASS artifact so aggregateSelfUat yields verdict: pass.
      const result = runGapClosureCycle(
        registry,
        projectRoot,
        "pass-fixture-2",
        "2026-09-22T06:00:00.000Z",
        [GAP_CLOSURE_PASS_RESULT, GAP_CLOSURE_FAIL_RESULT_NOW_PASSING],
      );
      assert.equal(result, null, "a pass verdict must clear cleanly with no dispatch");
      assert.equal(registry.consumeGateBlock(), null, "no gate block may remain outstanding after a pass verdict");
      assert.equal(
        reworkBriefCountForSlice("M001", "S01"),
        1,
        "a pass verdict must not author an additional rework brief",
      );
    } finally {
      cleanup();
    }
  });

  describe("resume safety (Phase 12, D-03 restart invariant — RESEARCH Pitfall 5)", () => {
    test("repeated same-cycle evaluation: a second evaluation against the same needs-rework artifact double-reopens neither the slice nor authors a second brief", () => {
      const { projectRoot, cleanup } = setupGate1Fixture([
        "---",
        "version: 1",
        "agentic_gate1_enabled: true",
        "---",
      ]);
      try {
        insertSlice({
          id: "S01",
          milestoneId: "M001",
          status: "active",
          planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
        });
        insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
        insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

        completeGate1Slice("resume-repeat-cycle1");
        const registry = new RuleRegistry([]);
        const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
        assert.notEqual(dispatch, null);
        writeNeedsReworkArtifact(projectRoot, "2026-09-22T07:00:00.000Z");

        const first = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
        assert.equal(first, null, "the first, real evaluation must complete cycle 1");
        assert.equal(registry.consumeGateBlock(), null);
        assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "cycle 1 authors exactly one brief");
        assert.equal(reopenedEventCount("M001/S01"), 1, "cycle 1 reopens the slice exactly once");

        // Invariant (RESEARCH Pitfall 5): once a cycle's success exit clears
        // activeHook/hookQueue, evaluatePostUnit's own hook-on-hook guard
        // (completedUnitType.startsWith("hook/")) makes a second, unpaired
        // evaluation of the SAME hook unit id a pure no-op — it can never
        // re-enter gap-closure routing without a genuine new dispatch. This
        // is what keeps a re-evaluation from double-reopening: the reopen
        // count tracks cycles genuinely run, never evaluations made.
        const second = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
        assert.equal(second, null, "a repeated hook-unit evaluation with no active hook must be a no-op");
        assert.equal(reworkBriefCountForSlice("M001", "S01"), 1, "no second brief from the repeated evaluation");
        assert.equal(
          reopenedEventCount("M001/S01"),
          1,
          "no second reopen from the repeated evaluation — the count matches cycles run, not evaluations made",
        );
      } finally {
        cleanup();
      }
    });

    test("a persisted cap block survives persist/restore/reconcile without resetting or bypassing the cap", () => {
      const { projectRoot, cleanup } = setupGate1Fixture([
        "---",
        "version: 1",
        "agentic_gate1_enabled: true",
        "---",
      ]);
      try {
        insertSlice({
          id: "S01",
          milestoneId: "M001",
          status: "active",
          planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
        });
        insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
        insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

        const registry = new RuleRegistry([]);
        for (const [label, ts] of [
          ["resume-cap-1", "2026-09-22T08:00:00.000Z"],
          ["resume-cap-2", "2026-09-22T09:00:00.000Z"],
          ["resume-cap-3", "2026-09-22T10:00:00.000Z"],
        ] as const) {
          const cycleResult = runGapClosureCycle(registry, projectRoot, label, ts);
          assert.equal(cycleResult, null);
          assert.equal(registry.consumeGateBlock(), null);
        }
        const briefCountBeforePersist = reworkBriefCountForSlice("M001", "S01");
        assert.equal(briefCountBeforePersist, GAP_CLOSURE_MAX_CYCLES, "three real cycles must reach the cap");

        // A 4th attempt now hits the cap and pauses. Do NOT consume the
        // block — persist it outstanding, exactly as a real pause/resume
        // would leave it.
        completeGate1Slice("resume-cap-4th-attempt");
        const fourthDispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
        assert.notEqual(fourthDispatch, null);
        writeNeedsReworkArtifact(projectRoot, "2026-09-22T11:00:00.000Z");
        const fourthResult = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
        assert.equal(fourthResult, null);
        assert.notEqual(registry.gateBlockPending, null, "the cap pause must leave an outstanding gate block");
        assert.equal(registry.gateBlockPending?.action, "pause");

        registry.persistState(projectRoot);

        const resumed = new RuleRegistry([]);
        resumed.restoreState(projectRoot);
        assert.notEqual(
          resumed.gateBlockPending,
          null,
          "the restored registry must still carry the outstanding cap-pause block",
        );

        const reconciled = resumed.reconcileRestoredGateBlock(projectRoot);
        assert.notEqual(
          reconciled,
          null,
          "reconcileRestoredGateBlock must re-dispatch the same gate hook rather than silently clearing the cap block",
        );
        assert.equal(reconciled?.unitType, "hook/agentic-gate1");
        assert.equal(reconciled?.unitId, "M001/S01");
        assert.equal(
          resumed.activeHook?.hookName,
          "agentic-gate1",
          "activeHook must be re-armed so the re-run's completion is assessed against the gate",
        );
        assert.equal(
          resumed.consumeGateBlock(),
          null,
          "reconcile replaces the outstanding block with a live re-dispatch rather than a cleared pass",
        );

        // The re-dispatched hook completes against the SAME (still
        // needs-rework, still cap-reached) artifact — the cap must still
        // hold: pause again, no 4th brief.
        const afterReconcileResult = resumed.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
        assert.equal(afterReconcileResult, null);
        const blockAfterReconcile = resumed.consumeGateBlock();
        assert.notEqual(blockAfterReconcile, null, "the cap must still pause the resumed session, not admit a 4th cycle");
        assert.equal(blockAfterReconcile?.action, "pause");

        assert.equal(
          reworkBriefCountForSlice("M001", "S01"),
          briefCountBeforePersist,
          "a restart must never reset or advance the cap-authority COUNT (D-03)",
        );
      } finally {
        cleanup();
      }
    });

    test("a fresh RuleRegistry that never observed cycle 1/2 still derives the next cycle from the DB COUNT, not from any local/restored state", () => {
      const { projectRoot, cleanup } = setupGate1Fixture([
        "---",
        "version: 1",
        "agentic_gate1_enabled: true",
        "---",
      ]);
      try {
        insertSlice({
          id: "S01",
          milestoneId: "M001",
          status: "active",
          planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
        });
        insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
        insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

        // Pre-seed cycles 1 and 2 directly in the DB — no registry instance
        // has ever run evaluatePostUnit for this slice.
        for (const cycle of [1, 2]) {
          saveReworkBrief({
            briefId: `RB-M001-S01-T02-gap-${cycle}`,
            milestoneId: "M001",
            sliceId: "S01",
            taskId: "T02",
            findings: [{
              findingId: `GC${cycle}-01`,
              severity: "blocking",
              description: `pre-seeded finding for cycle ${cycle}`,
              requiredFix: "n/a",
              verificationCommands: [],
              evidence: "pre-seeded",
              decisionRef: "pre-seeded",
            }],
          });
        }
        assert.equal(reworkBriefCountForSlice("M001", "S01"), 2);

        completeGate1Slice("resume-fresh-registry-cycle3");
        const registry = new RuleRegistry([]);
        const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
        assert.notEqual(dispatch, null);
        writeNeedsReworkArtifact(projectRoot, "2026-09-22T12:00:00.000Z");

        const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
        assert.equal(result, null);
        assert.equal(registry.consumeGateBlock(), null);
        assert.equal(
          reworkBriefCountForSlice("M001", "S01"),
          3,
          "a fresh registry must compute cycle 3 from the DB COUNT, landing exactly at the cap",
        );
        const brief = reworkBriefRow("RB-M001-S01-T02-gap-3");
        assert.ok(
          brief,
          "the fresh registry's own first gap-closure evaluation must carry the DB-derived -gap-3 suffix, not -gap-1",
        );
      } finally {
        cleanup();
      }
    });
  });

  test("cross-cycle resolution isolation: resolving only the cycle-2 finding leaves the cycle-1 finding pending (T-12-08)", () => {
    const { projectRoot, cleanup } = setupGate1Fixture([
      "---",
      "version: 1",
      "agentic_gate1_enabled: true",
      "---",
    ]);
    try {
      insertSlice({
        id: "S01",
        milestoneId: "M001",
        status: "active",
        planning: { successCriteria: "- the first criterion holds\n- the second criterion holds" },
      });
      insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 1 });
      insertTask({ id: "T02", milestoneId: "M001", sliceId: "S01", status: "pending", sequence: 2 });

      const registry = new RuleRegistry([]);
      const cycle1 = runGapClosureCycle(registry, projectRoot, "isolation-1", "2026-09-22T13:00:00.000Z");
      assert.equal(cycle1, null);
      assert.equal(registry.consumeGateBlock(), null);
      const cycle2 = runGapClosureCycle(registry, projectRoot, "isolation-2", "2026-09-22T14:00:00.000Z");
      assert.equal(cycle2, null);
      assert.equal(registry.consumeGateBlock(), null);
      assert.equal(reworkBriefCountForSlice("M001", "S01"), 2, "two briefs must exist for the same task (T02)");

      // Documents the plural-identity union behaviour BEFORE any resolution:
      // getBlockingReworkFindingsForTask returns findings sourced from BOTH
      // brief ids for the shared task.
      const beforeResolution = getBlockingReworkFindingsForTask("M001", "S01", "T02");
      const briefIdsSeen = new Set(
        beforeResolution.map((f) => f.brief_id),
      );
      assert.ok(briefIdsSeen.has("RB-M001-S01-T02-gap-1"), "must include the cycle-1 brief's findings");
      assert.ok(briefIdsSeen.has("RB-M001-S01-T02-gap-2"), "must include the cycle-2 brief's findings");

      // Resolve ONLY the cycle-2 finding.
      applyReworkResolutions([{
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T02",
        findingId: "GC2-01",
        status: "resolved",
        evidence: "Added the null guard in src/handler.ts and re-ran the criterion — exit 0.",
      }]);

      const cycle2Finding = findingsForBrief("RB-M001-S01-T02-gap-2").find((f) => f["finding_id"] === "GC2-01");
      assert.ok(cycle2Finding, "the cycle-2 finding row must exist");
      assert.equal(cycle2Finding!["status"], "resolved");

      const cycle1Finding = findingsForBrief("RB-M001-S01-T02-gap-1").find((f) => f["finding_id"] === "GC1-01");
      assert.ok(cycle1Finding, "the cycle-1 finding row must exist");
      assert.equal(
        cycle1Finding!["status"],
        "pending",
        "resolving only the cycle-2 id must NOT flip the cycle-1 finding — this is what makes GC{cycle}-{NN} ids load-bearing",
      );

      const unresolved = getUnresolvedBlockingReworkFindingsForTask("M001", "S01", "T02");
      assert.ok(
        unresolved.some((f) => f.finding_id === "GC1-01"),
        "getUnresolvedBlockingReworkFindingsForTask must still return the still-pending cycle-1 finding",
      );
      assert.ok(
        !unresolved.some((f) => f.finding_id === "GC2-01"),
        "the now-resolved cycle-2 finding must no longer appear as unresolved",
      );
    } finally {
      cleanup();
    }
  });
});
