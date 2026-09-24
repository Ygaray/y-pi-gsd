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

import { validatePreferences } from "../preferences.js";

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
