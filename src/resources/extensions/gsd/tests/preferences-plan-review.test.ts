/**
 * Unit tests for `plan_review.max_cycles` (CONV-02): the config-plane cap for
 * plan-review convergence.
 *
 * Two halves, one per Plan 20-03 task:
 *   - "plan_review validation" (Task 1): round-trip, boundary (FA-02), and
 *     precision (FA-03) coverage through `validatePreferences`.
 *   - "resolvePlanReviewMaxCycles" (Task 2): the single config-side cap
 *     reader, exercised against real on-disk sandboxed preferences files
 *     (not a stub), mirroring `tests/preferences.test.ts`'s fixture pattern.
 */

import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { validatePreferences, resolvePlanReviewMaxCycles } from "../preferences.js";
import { PLAN_REVIEW_MAX_CYCLES_BOUNDS } from "../preferences-validation.js";

describe("plan_review validation", () => {
  it("round-trips a configured max_cycles with no errors", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 5 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 5);
  });

  it("accepts 1 verbatim (inclusive lower boundary)", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 1 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 1);
  });

  it("accepts 10 verbatim (inclusive upper boundary)", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 10 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 10);
  });

  it("clamps 0 up to 1", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 0 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 1);
  });

  it("clamps a negative value up to 1", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: -4 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 1);
  });

  it("clamps 11 down to 10", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 11 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 10);
  });

  it("clamps a very large value (9999) down to 10", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 9999 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 10);
  });

  it("rounds 0.4 to 0 then clamps up to 1 (FA-03)", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 0.4 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 1);
  });

  it("rounds 10.5 to 11 (half away from zero) then clamps down to 10 (FA-03)", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 10.5 },
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 10);
  });

  it("rejects a non-numeric string with a named error and drops the value", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: "seven" },
    } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review\.max_cycles must be a finite number between 1 and 10/);
    assert.equal(validated.plan_review, undefined);
  });

  it("rejects NaN with a named error and drops the value", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: Number.NaN },
    } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review\.max_cycles must be a finite number between 1 and 10/);
    assert.equal(validated.plan_review, undefined);
  });

  it("rejects Infinity with a named error and drops the value", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: Number.POSITIVE_INFINITY },
    } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review\.max_cycles must be a finite number between 1 and 10/);
    assert.equal(validated.plan_review, undefined);
  });

  it("rejects null with a named error and drops the value", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: null },
    } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review\.max_cycles must be a finite number between 1 and 10/);
    assert.equal(validated.plan_review, undefined);
  });

  it("rejects a non-object plan_review value ('must be an object')", () => {
    const { errors } = validatePreferences({ plan_review: "yes" } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review must be an object/);
  });

  it("rejects a null plan_review value ('must be an object')", () => {
    const { errors } = validatePreferences({ plan_review: null } as any);
    assert.equal(errors.length, 1);
    assert.match(errors[0]!, /plan_review must be an object/);
  });

  it("leaves plan_review absent from validated when given an empty object", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: {},
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review, undefined);
  });

  it("produces no unknown-preference-key warning when plan_review is set", () => {
    const { warnings } = validatePreferences({
      plan_review: { max_cycles: 5 },
    } as any);
    assert.ok(
      !warnings.some((w) => w.includes("plan_review")),
      `expected no plan_review warning, got: ${JSON.stringify(warnings)}`,
    );
  });

  it("does not interfere with an unrelated sibling key's own validation", () => {
    const { preferences: validated, errors } = validatePreferences({
      plan_review: { max_cycles: 5 },
      language: "Spanish",
    } as any);
    assert.deepEqual(errors, []);
    assert.equal(validated.plan_review?.max_cycles, 5);
    assert.equal(validated.language, "Spanish");
  });
});

describe("resolvePlanReviewMaxCycles", () => {
  function withSandbox(run: (basePath: string) => void): void {
    const originalCwd = process.cwd();
    const originalGsdHome = process.env.GSD_HOME;
    const tempProject = mkdtempSync(join(tmpdir(), "gsd-plan-review-cap-project-"));
    const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-plan-review-cap-home-"));
    try {
      mkdirSync(join(tempProject, ".gsd"), { recursive: true });
      process.env.GSD_HOME = tempGsdHome;
      process.chdir(tempProject);
      run(tempProject);
    } finally {
      process.chdir(originalCwd);
      if (originalGsdHome === undefined) delete process.env.GSD_HOME;
      else process.env.GSD_HOME = originalGsdHome;
      rmSync(tempProject, { recursive: true, force: true });
      rmSync(tempGsdHome, { recursive: true, force: true });
    }
  }

  it("returns the configured value when plan_review.max_cycles is set", () => {
    withSandbox((basePath) => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review:\n  max_cycles: 7\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), 7);
    });
  });

  it("returns the default (3) when plan_review is present but max_cycles is absent", () => {
    withSandbox((basePath) => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review: {}\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), PLAN_REVIEW_MAX_CYCLES_BOUNDS.default);
    });
  });

  it("returns the default (3) when the plan_review block is absent entirely", () => {
    withSandbox((basePath) => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nversion: 1\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), PLAN_REVIEW_MAX_CYCLES_BOUNDS.default);
    });
  });

  it("returns the default (3) and does not throw when no preferences file exists at all", () => {
    withSandbox((basePath) => {
      assert.doesNotThrow(() => resolvePlanReviewMaxCycles(basePath));
      assert.equal(resolvePlanReviewMaxCycles(basePath), PLAN_REVIEW_MAX_CYCLES_BOUNDS.default);
    });
  });

  it("clamps a hand-edited 0 up to 1 at the read site (defence-in-depth)", () => {
    withSandbox((basePath) => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review:\n  max_cycles: 0\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), 1);
    });
  });

  it("clamps a hand-edited 40 down to 10 at the read site (defence-in-depth)", () => {
    withSandbox((basePath) => {
      writeFileSync(
        join(basePath, ".gsd", "PREFERENCES.md"),
        "---\nplan_review:\n  max_cycles: 40\n---\n",
        "utf-8",
      );
      assert.equal(resolvePlanReviewMaxCycles(basePath), 10);
    });
  });

  it("always returns a finite integer of at least 1 across every exercised input", () => {
    const cases: Array<{ content: string | null; expectMin: number }> = [
      { content: "---\nplan_review:\n  max_cycles: 7\n---\n", expectMin: 1 },
      { content: "---\nplan_review: {}\n---\n", expectMin: 1 },
      { content: "---\nversion: 1\n---\n", expectMin: 1 },
      { content: null, expectMin: 1 },
      { content: "---\nplan_review:\n  max_cycles: 0\n---\n", expectMin: 1 },
      { content: "---\nplan_review:\n  max_cycles: 40\n---\n", expectMin: 1 },
    ];
    for (const { content, expectMin } of cases) {
      withSandbox((basePath) => {
        if (content !== null) {
          writeFileSync(join(basePath, ".gsd", "PREFERENCES.md"), content, "utf-8");
        }
        const result = resolvePlanReviewMaxCycles(basePath);
        assert.ok(Number.isInteger(result), `expected an integer, got ${result}`);
        assert.ok(result >= expectMin, `expected >= ${expectMin}, got ${result}`);
      });
    }
  });
});
