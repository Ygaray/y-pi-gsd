/**
 * Metrics ledger resume-boundary regression suite (SIGNAL-04, Phase 23 Plan 03).
 *
 * Covers the verified defect behind the BlackJackTrainer M001 metrics-ledger
 * freeze (37 unit-end journal events, 1 metrics.json entry):
 *   snapshotUnitMetrics's two silent `return null` paths (Task 1) — now warn
 *   (via workflow-logger's real module-level buffer, captured with
 *   peekLogs()/_resetLogs() rather than a mock) instead of dropping a unit
 *   with zero observable trace.
 *
 * Task 2 extends this same file with the auto-resume base-path-aware guard
 * regression tests (shouldReinitMetricsForBase).
 *
 * Mechanism used to capture warnings: the REAL workflow-logger module-level
 * buffer (peekLogs() / _resetLogs()), not a substituted logWarning — no test
 * seam exists to inject a sink, and the buffer is the actual production
 * observability surface a future occurrence of this bug would be diagnosed
 * through.
 */

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  type UnitMetrics,
  initMetrics,
  resetMetrics,
  getLedger,
  getMetricsBasePath,
  snapshotUnitMetrics,
  shouldReinitMetricsForBase,
} from "../metrics.js";
import { peekLogs, _resetLogs } from "../workflow-logger.js";

// ── Helpers (mirrors metrics.test.ts's makeUnit/mockCtx shapes — not exported there) ──

function makeAssistantMessage(overrides: Record<string, unknown> = {}): any {
  return {
    role: "assistant",
    usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, totalTokens: 150 },
    content: [],
    ...overrides,
  };
}

function mockCtx(messages: any[] = []): any {
  const entries = messages.map((msg, i) => ({
    type: "message",
    id: `entry-${i}`,
    parentId: i > 0 ? `entry-${i - 1}` : null,
    timestamp: new Date().toISOString(),
    message: msg,
  }));
  return { sessionManager: { getEntries: () => entries }, model: { id: "claude-sonnet-4-20250514" } };
}

function makeTmpBase(): string {
  const base = mkdtempSync(join(tmpdir(), "metrics-resume-boundary-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function readLedgerFromDisk(base: string): { units: UnitMetrics[] } {
  return JSON.parse(readFileSync(join(base, ".gsd", "metrics.json"), "utf-8"));
}

// ── Task 1: silent-drop warnings + getMetricsBasePath ──────────────────────

test("snapshotUnitMetrics with a null ledger returns null AND warns naming unitType/unitId", () => {
  resetMetrics();
  _resetLogs();
  const result = snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
  assert.equal(result, null);
  const warnings = peekLogs().filter((e) => e.severity === "warn");
  assert.equal(warnings.length, 1, "expected exactly one warning");
  assert.match(warnings[0]!.message, /execute-task/);
  assert.match(warnings[0]!.message, /M001\/S01\/T01/);
  _resetLogs();
});

test("snapshotUnitMetrics with an initialized ledger but empty session entries returns null AND warns naming unitType/unitId", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    _resetLogs();
    const result = snapshotUnitMetrics(mockCtx([]), "research-slice", "M001/S01", 1000, "m");
    assert.equal(result, null);
    const warnings = peekLogs().filter((e) => e.severity === "warn");
    assert.equal(warnings.length, 1, "expected exactly one warning");
    assert.match(warnings[0]!.message, /research-slice/);
    assert.match(warnings[0]!.message, /M001\/S01(?!\/)/);
    _resetLogs();
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

test("snapshotUnitMetrics happy path returns a UnitMetrics and produces ZERO warnings", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    _resetLogs();
    const result = snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
    assert.ok(result);
    assert.equal(result!.type, "execute-task");
    const warnings = peekLogs().filter((e) => e.severity === "warn");
    assert.equal(warnings.length, 0, "happy path must stay silent");
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
    _resetLogs();
  }
});

test("neither null-returning path throws under any combination of null ledger / empty entries", () => {
  resetMetrics();
  _resetLogs();
  assert.doesNotThrow(() => snapshotUnitMetrics(mockCtx([]), "execute-task", "M001/S01/T01", 1000, "m"));
  assert.doesNotThrow(() => snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m"));
  const base = makeTmpBase();
  try {
    initMetrics(base);
    assert.doesNotThrow(() => snapshotUnitMetrics(mockCtx([]), "execute-task", "M001/S01/T02", 1000, "m"));
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
    _resetLogs();
  }
});

test("getMetricsBasePath returns empty string on a fresh module / after resetMetrics()", () => {
  resetMetrics();
  assert.equal(getMetricsBasePath(), "");
});

test("getMetricsBasePath tracks the base most recently passed to initMetrics", () => {
  const baseA = makeTmpBase();
  const baseB = makeTmpBase();
  try {
    initMetrics(baseA);
    assert.equal(getMetricsBasePath(), baseA);
    initMetrics(baseB);
    assert.equal(getMetricsBasePath(), baseB);
  } finally {
    resetMetrics();
    rmSync(baseA, { recursive: true, force: true });
    rmSync(baseB, { recursive: true, force: true });
  }
});

test("two snapshots, same type, different id, sequential startedAt: append two entries in call order", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T02", 2000, "m");
    const units = getLedger()!.units;
    assert.equal(units.length, 2);
    assert.equal(units[0]!.id, "M001/S01/T01");
    assert.equal(units[1]!.id, "M001/S01/T02");
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

test("two snapshots with identical type/id/startedAt still collapse to one entry (pre-existing idempotency guard unchanged)", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
    const units = getLedger()!.units;
    assert.equal(units.length, 1);
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

// ── Task 2: shouldReinitMetricsForBase + resume-boundary round trips ───────

test("shouldReinitMetricsForBase: base unchanged, ledger present -> false (no re-init)", () => {
  assert.equal(shouldReinitMetricsForBase("/base/a", true, "/base/a"), false);
});

test("shouldReinitMetricsForBase: ledger absent -> true (re-init), regardless of base match", () => {
  assert.equal(shouldReinitMetricsForBase("/base/a", false, "/base/a"), true);
  assert.equal(shouldReinitMetricsForBase("/base/a", false, ""), true);
});

test("shouldReinitMetricsForBase: ledger present but base differs -> true (re-init)", () => {
  assert.equal(shouldReinitMetricsForBase("/base/b", true, "/base/a"), true);
});

test("guard decision: base UNCHANGED, ledger populated -> no re-init, in-memory units and base preserved", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01", 1000, "m");
    const before = getLedger()!.units.length;
    const beforeBase = getMetricsBasePath();
    const shouldReinit = shouldReinitMetricsForBase(base, Boolean(getLedger()), getMetricsBasePath());
    assert.equal(shouldReinit, false);
    if (shouldReinit) initMetrics(base);
    assert.equal(getLedger()!.units.length, before);
    assert.equal(getMetricsBasePath(), beforeBase);
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

test("guard decision: ledger null -> re-init (pre-existing behavior preserved)", () => {
  const base = makeTmpBase();
  try {
    resetMetrics();
    const shouldReinit = shouldReinitMetricsForBase(base, Boolean(getLedger()), getMetricsBasePath());
    assert.equal(shouldReinit, true);
    if (shouldReinit) initMetrics(base);
    assert.ok(getLedger());
    assert.equal(getMetricsBasePath(), base);
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

test("guard decision: ledger populated but base differs from getMetricsBasePath() -> re-init, basePath repointed", () => {
  const baseA = makeTmpBase();
  const baseB = makeTmpBase();
  try {
    initMetrics(baseA);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01", 1000, "m");
    // No resetMetrics() — ledger is still truthy, simulating a live-ledger-with-stale-base resume.
    const shouldReinit = shouldReinitMetricsForBase(baseB, Boolean(getLedger()), getMetricsBasePath());
    assert.equal(shouldReinit, true);
    if (shouldReinit) initMetrics(baseB);
    assert.equal(getMetricsBasePath(), baseB);
  } finally {
    resetMetrics();
    rmSync(baseA, { recursive: true, force: true });
    rmSync(baseB, { recursive: true, force: true });
  }
});

test("resume-boundary round trip: post-resume entries append to their own ledger, pre-resume entries never replaced or misrouted", () => {
  const baseA = makeTmpBase();
  const baseB = makeTmpBase();
  try {
    initMetrics(baseA);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "research-slice", "M001/S01", 1000, "m");
    resetMetrics();
    initMetrics(baseB);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "research-slice", "M001/S02", 2000, "m");

    const diskB = readLedgerFromDisk(baseB);
    assert.equal(diskB.units.length, 1);
    assert.equal(diskB.units[0]!.id, "M001/S02");

    const diskA = readLedgerFromDisk(baseA);
    assert.equal(diskA.units.length, 1);
    assert.equal(diskA.units[0]!.id, "M001/S01");
  } finally {
    resetMetrics();
    rmSync(baseA, { recursive: true, force: true });
    rmSync(baseB, { recursive: true, force: true });
  }
});

test("same-base multi-unit append: does NOT re-init and preserves in-memory units when guard is checked between each snapshot", () => {
  const base = makeTmpBase();
  try {
    initMetrics(base);
    for (const [id, startedAt] of [
      ["M001/S01/T01", 1000],
      ["M001/S01/T02", 2000],
      ["M001/S01/T03", 3000],
    ] as const) {
      const shouldReinit = shouldReinitMetricsForBase(base, Boolean(getLedger()), getMetricsBasePath());
      assert.equal(shouldReinit, false, `must not re-init for unchanged base at ${id}`);
      snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", id, startedAt, "m");
    }

    const memUnits = getLedger()!.units;
    assert.equal(memUnits.length, 3);
    assert.deepEqual(memUnits.map((u) => u.id), ["M001/S01/T01", "M001/S01/T02", "M001/S01/T03"]);

    const diskUnits = readLedgerFromDisk(base).units;
    assert.equal(diskUnits.length, 3);
    assert.deepEqual(diskUnits.map((u) => u.id), ["M001/S01/T01", "M001/S01/T02", "M001/S01/T03"]);
  } finally {
    resetMetrics();
    rmSync(base, { recursive: true, force: true });
  }
});

test("stale-basePath regression: guard-driven re-init to baseB routes unit 2 to baseB, not baseA (fails against the old truthiness-only guard)", () => {
  const baseA = makeTmpBase();
  const baseB = makeTmpBase();
  try {
    initMetrics(baseA);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T01", 1000, "m");
    // WITHOUT resetMetrics(): ledger stays truthy, exactly the stale-basePath shape.
    // The OLD guard `if (!getLedger()) initMetrics(base)` would skip re-init here
    // (ledger is truthy) and unit 2 would land in baseA's metrics.json instead.
    const shouldReinit = shouldReinitMetricsForBase(baseB, Boolean(getLedger()), getMetricsBasePath());
    assert.equal(shouldReinit, true, "new guard must re-init on a changed base even with a live ledger");
    if (shouldReinit) initMetrics(baseB);
    snapshotUnitMetrics(mockCtx([makeAssistantMessage()]), "execute-task", "M001/S01/T02", 2000, "m");

    const diskB = readLedgerFromDisk(baseB);
    assert.equal(diskB.units.length, 1);
    assert.equal(diskB.units[0]!.id, "M001/S01/T02");

    const diskA = readLedgerFromDisk(baseA);
    assert.equal(diskA.units.length, 1);
    assert.equal(diskA.units[0]!.id, "M001/S01/T01");
  } finally {
    resetMetrics();
    rmSync(baseA, { recursive: true, force: true });
    rmSync(baseB, { recursive: true, force: true });
  }
});

test.after(() => {
  resetMetrics();
  _resetLogs();
});
