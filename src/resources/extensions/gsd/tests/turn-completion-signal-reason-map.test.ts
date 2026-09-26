import test from "node:test";
import assert from "node:assert/strict";

import { mapTurnEndToStopReason, type TurnEndClassificationInput, type TurnEndStopReason } from "../bootstrap/turn-completion-signal.ts";

const ABORT_ORIGINS: Array<TurnEndClassificationInput["abortOrigin"]> = [
  undefined,
  "user",
  "timeout",
  "error",
  "extension",
  "programmatic",
];
const TOOL_OUTCOMES: Array<boolean | null> = [true, false, null];
const BLOCKING_COMBOS: Array<{ approvalGateBlocking?: boolean; destructiveConfirmationBlocking?: boolean }> = [
  { approvalGateBlocking: false, destructiveConfirmationBlocking: false },
  { approvalGateBlocking: true, destructiveConfirmationBlocking: false },
  { approvalGateBlocking: false, destructiveConfirmationBlocking: true },
  { approvalGateBlocking: true, destructiveConfirmationBlocking: true },
];
const VALID_REASONS: TurnEndStopReason[] = ["completed", "cancelled", "error", "blocked"];

// ─── Behavior matrix ─────────────────────────────────────────────────────────

test("mapTurnEndToStopReason({}) is completed (absent abortOrigin = clean end)", () => {
  assert.equal(mapTurnEndToStopReason({}), "completed");
});

test("abortOrigin user maps to cancelled", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "user" }), "cancelled");
});

test("abortOrigin timeout maps to cancelled (mirrors existing transient treatment)", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "timeout" }), "cancelled");
});

test("abortOrigin error maps to error", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "error" }), "error");
});

test("abortOrigin extension + lastToolCallSucceeded true maps to completed", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "extension", lastToolCallSucceeded: true }), "completed");
});

test("abortOrigin extension + lastToolCallSucceeded false maps to cancelled", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "extension", lastToolCallSucceeded: false }), "cancelled");
});

test("abortOrigin extension + lastToolCallSucceeded null maps to cancelled (absence of affirmative success is not success)", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "extension", lastToolCallSucceeded: null }), "cancelled");
});

test("abortOrigin programmatic + lastToolCallSucceeded true maps to completed", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "programmatic", lastToolCallSucceeded: true }), "completed");
});

test("abortOrigin programmatic + lastToolCallSucceeded false maps to cancelled", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "programmatic", lastToolCallSucceeded: false }), "cancelled");
});

test("abortOrigin programmatic + lastToolCallSucceeded null maps to cancelled", () => {
  assert.equal(mapTurnEndToStopReason({ abortOrigin: "programmatic", lastToolCallSucceeded: null }), "cancelled");
});

test("approvalGateBlocking true wins over every abortOrigin state (blocked precedence)", () => {
  for (const abortOrigin of ABORT_ORIGINS) {
    assert.equal(
      mapTurnEndToStopReason({ abortOrigin, approvalGateBlocking: true }),
      "blocked",
      `expected blocked for abortOrigin=${String(abortOrigin)}`,
    );
  }
});

test("destructiveConfirmationBlocking true wins over every abortOrigin state (blocked precedence)", () => {
  for (const abortOrigin of ABORT_ORIGINS) {
    assert.equal(
      mapTurnEndToStopReason({ abortOrigin, destructiveConfirmationBlocking: true }),
      "blocked",
      `expected blocked for abortOrigin=${String(abortOrigin)}`,
    );
  }
});

test("unrecognized abortOrigin never silently reports completed: returns error and warns naming the value", () => {
  const warnings: string[] = [];
  const reason = mapTurnEndToStopReason(
    { abortOrigin: "totally-unknown-origin" as never },
    (message) => warnings.push(message),
  );
  assert.equal(reason, "error");
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /totally-unknown-origin/);
});

// ─── 72-case cross-product membership sweep ─────────────────────────────────

test("mapTurnEndToStopReason: every abortOrigin x lastToolCallSucceeded x blocking-flag combination returns a valid reason", () => {
  let caseCount = 0;
  for (const abortOrigin of ABORT_ORIGINS) {
    for (const lastToolCallSucceeded of TOOL_OUTCOMES) {
      for (const blocking of BLOCKING_COMBOS) {
        caseCount += 1;
        const reason = mapTurnEndToStopReason({
          abortOrigin,
          lastToolCallSucceeded,
          ...blocking,
        });
        assert.ok(
          VALID_REASONS.includes(reason),
          `invalid reason "${String(reason)}" for abortOrigin=${String(abortOrigin)}, ` +
            `lastToolCallSucceeded=${String(lastToolCallSucceeded)}, blocking=${JSON.stringify(blocking)}`,
        );
        assert.notEqual(reason, undefined);

        // Blocking always wins, regardless of anything else.
        if (blocking.approvalGateBlocking || blocking.destructiveConfirmationBlocking) {
          assert.equal(reason, "blocked");
        }
      }
    }
  }
  assert.equal(caseCount, 72, "expected the full 6x3x4 cross product");
});
