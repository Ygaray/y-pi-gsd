// Project/App: gsd-pi
// File Purpose: Round-trip coverage for the machine-readable pause-kind
// vocabulary (Phase 16, DRIVER-02, D-03 #2). Tests 1-5 are a pure
// format-then-parse suite (no database, no filesystem) proving
// `formatBlockedNoticeWithPauseKind`/`parsePauseKindFromNotice` stay in
// lockstep and compose safely with the existing blocked-stop vocabulary.
// Tests 6-8 prove the two real producers (`rule-registry.ts`'s gap-closure
// cap branch, `milestone-certify-domain-operation.ts`'s
// `escalateCertifyGapsToGate2`) actually tag their pause, and that tagging
// is opt-in per branch rather than blanket.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  formatBlockedNoticeWithPauseKind,
  formatStopNoticePrefix,
  isBlockedNoticeMessage,
  isBlockedStopReason,
  parsePauseKindFromNotice,
  stopNoticeDisplayReason,
} from "../stop-notice.ts";
import type { PauseKind } from "../types.ts";
import {
  RuleRegistry,
} from "../rule-registry.ts";
import {
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
  saveReworkBrief,
} from "../gsd-db.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { escalateCertifyGapsToGate2 } from "../milestone-certify-domain-operation.ts";
import type { CertifyGap } from "../milestone-certify-self-fix.ts";
import { clearParseCache } from "../files.ts";
import { clearPathCache } from "../paths.ts";
import { SELF_UAT_LOG_DIR_RELATIVE, selfUatLogFileName } from "../verify-agentic-log.ts";

const ALL_PAUSE_KINDS: PauseKind[] = ["gap-closure-cap", "certify-escalation", "human-decision"];

// ─── Tests 1-5: pure round-trip ────────────────────────────────────────────

test("Test 1: round trip — format then parse returns the same kind, for each of the three kinds", () => {
  for (const kind of ALL_PAUSE_KINDS) {
    const formatted = formatBlockedNoticeWithPauseKind("some reason text", kind);
    assert.equal(parsePauseKindFromNotice(formatted), kind, `round trip failed for ${kind}`);
  }
});

test("Test 2: no marker, unrecognised token, and a malformed marker all parse to null", () => {
  assert.equal(parsePauseKindFromNotice("Blocked: plain reason, no marker at all"), null);
  assert.equal(parsePauseKindFromNotice("Blocked: reason [pause-kind: not-a-real-kind]"), null);
  assert.equal(parsePauseKindFromNotice("Blocked: reason [pause-kind:]"), null);
  assert.equal(parsePauseKindFromNotice("Blocked: reason [pause-kind unclosed"), null);
  assert.equal(parsePauseKindFromNotice(""), null);
  assert.equal(parsePauseKindFromNotice(null), null);
  assert.equal(parsePauseKindFromNotice(undefined), null);
});

test("Test 3: a kind-tagged notice still classifies as a blocked stop reason and as a recognised blocked notification prefix", () => {
  const tagged = formatBlockedNoticeWithPauseKind("gap-closure cap reached", "gap-closure-cap");
  assert.ok(isBlockedStopReason(tagged), "tagged reason must still satisfy isBlockedStopReason");
  const notice = formatStopNoticePrefix(tagged).toLowerCase();
  assert.ok(isBlockedNoticeMessage(notice), `formatted notice must be recognised as blocked: ${notice}`);
});

test("Test 4: stopNoticeDisplayReason strips the blocked marker from a kind-tagged reason, same as today", () => {
  const tagged = formatBlockedNoticeWithPauseKind("gap-closure cap reached: 3 cycles", "gap-closure-cap");
  const displayed = stopNoticeDisplayReason(tagged);
  assert.equal(displayed.startsWith("Blocked:"), false, "the Blocked: prefix must be stripped");
  assert.ok(displayed.includes("gap-closure cap reached"), "the underlying reason text must survive display stripping");
});

test("Test 5: formatting is idempotent — applying the formatter twice produces exactly one marker", () => {
  const once = formatBlockedNoticeWithPauseKind("gap-closure cap reached", "gap-closure-cap");
  const twice = formatBlockedNoticeWithPauseKind(once, "gap-closure-cap");
  const markerCount = (twice.match(/\[pause-kind:/g) ?? []).length;
  assert.equal(markerCount, 1, `expected exactly one marker, got: ${twice}`);
  assert.equal(parsePauseKindFromNotice(twice), "gap-closure-cap");
});

// ─── Tests 6-7: rule-registry.ts's gap-closure producer ────────────────────

function setupGate1Fixture(prefsLines: string[]): { projectRoot: string; cleanup: () => void } {
  const originalGsdHome = process.env.GSD_HOME;
  const projectRoot = mkdtempSync(join(tmpdir(), "gsd-pause-kind-gate1-"));
  const tempGsdHome = mkdtempSync(join(tmpdir(), "gsd-pause-kind-gate1-home-"));
  mkdirSync(join(projectRoot, ".gsd"), { recursive: true });
  writeFileSync(join(projectRoot, ".gsd", "PREFERENCES.md"), prefsLines.join("\n"), "utf-8");
  process.env.GSD_HOME = tempGsdHome;
  openDatabase(join(projectRoot, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Pause-kind fixture", status: "active" });
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

/** Writes a minimal frontmatter-only artifact reporting needs-rework, with no
 *  parsable criterion body — the "no parsable criterion" pause branch. */
function writeBareNeedsReworkArtifact(projectRoot: string, unitId: string): void {
  const selfUatDir = join(projectRoot, SELF_UAT_LOG_DIR_RELATIVE);
  mkdirSync(selfUatDir, { recursive: true });
  const fileName = selfUatLogFileName(unitId, new Date().toISOString());
  writeFileSync(join(selfUatDir, fileName), "---\nresult: has_fail\nverdict: needs-rework\n---\n", "utf-8");
}

test("Test 6: the gap-closure-cap pause carries the gap-closure-cap kind in its reason", () => {
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
    // Pre-seed the cap: 3 gap-shaped rework briefs already recorded for this
    // slice, so the very next needs-rework verdict must hit the cap branch
    // without needing three real gap-closure cycles.
    for (const n of [1, 2, 3]) {
      saveReworkBrief({
        briefId: `RB-M001-S01-T99-gap-${n}`,
        milestoneId: "M001",
        sliceId: "S01",
        taskId: "T99",
        findings: [],
      });
    }

    const registry = new RuleRegistry([]);
    const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
    assert.notEqual(dispatch, null, "the gate must dispatch before it can be completed");

    writeBareNeedsReworkArtifact(projectRoot, "M001/S01");
    const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
    assert.equal(result, null, "a capped needs-rework verdict must not dispatch again");

    const block = registry.consumeGateBlock();
    assert.notEqual(block, null, "the cap must produce an observable pause");
    assert.equal(block?.pauseKind, "gap-closure-cap", "the block's in-process pauseKind field must be set");
    assert.equal(
      parsePauseKindFromNotice(block?.reason ?? ""),
      "gap-closure-cap",
      `the reason string itself must carry the marker, got: ${block?.reason}`,
    );
  } finally {
    cleanup();
  }
});

test("Test 7: a pause from a DIFFERENT _pauseForGate branch (no parsable criterion, cap NOT reached) carries no kind marker", () => {
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
    // No pre-seeded rework briefs — the cap branch must NOT fire here. This
    // exercises a sibling branch of the SAME gap-closure routing method
    // (no parsable FAIL/PARTIAL criterion in the artifact), proving the
    // pause-kind tag is opt-in per branch rather than blanket.

    const registry = new RuleRegistry([]);
    const dispatch = registry.evaluatePostUnit("complete-slice", "M001/S01", projectRoot);
    assert.notEqual(dispatch, null);

    writeBareNeedsReworkArtifact(projectRoot, "M001/S01");
    const result = registry.evaluatePostUnit("hook/agentic-gate1", "M001/S01", projectRoot);
    assert.equal(result, null);

    const block = registry.consumeGateBlock();
    assert.notEqual(block, null, "an unparsable artifact must still produce an observable pause");
    assert.equal(block?.pauseKind, undefined, "a non-cap gap-closure pause must carry no in-process pauseKind");
    assert.equal(
      parsePauseKindFromNotice(block?.reason ?? ""),
      null,
      `an untagged reason must parse to null (human-decision), got: ${block?.reason}`,
    );
  } finally {
    cleanup();
  }
});

// ─── Test 8: milestone-certify-domain-operation.ts's escalation producer ──

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "stop-notice-pause-kind-test",
  };
}

function makeGap(overrides: Partial<CertifyGap> = {}): CertifyGap {
  return {
    gapId: "gate-pending:S01:CERT01",
    gapClass: "gate-pending",
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "CERT01",
    ownerTurn: "certify-milestone",
    fixable: false,
    description: "CERT01 gate is pending for slice S01",
    evidence: "quality_gates row status=pending",
    ...overrides,
  };
}

const certifyTempDirs = new Set<string>();

function makeCertifyBase(): void {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-pause-kind-certify-"));
  certifyTempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Pause-kind certify fixture", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: "fixture/pause-kind-certify/adopt-lifecycle",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/adopt-lifecycle",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of certifyTempDirs) rmSync(dir, { recursive: true, force: true });
  certifyTempDirs.clear();
});

test("Test 8: the certify escalation's reason carries the certify-escalation kind and the Gate-2 entry id it registered", () => {
  makeCertifyBase();
  const gap = makeGap();

  const result = escalateCertifyGapsToGate2({
    invocation: invocation("pause-kind-test/certify/escalate/S01"),
    milestoneId: "M001",
    sliceId: "S01",
    gaps: [gap],
  });

  assert.equal(result.disposition, "escalated");
  assert.equal(
    parsePauseKindFromNotice(result.reason),
    "certify-escalation",
    `expected the certify-escalation kind, got: ${result.reason}`,
  );
  assert.ok(
    result.reason.includes(result.entryId),
    `expected the Gate-2 entry id ${result.entryId} to appear in the reason: ${result.reason}`,
  );
});
