// Project/App: gsd-pi
// File Purpose: Proves `run-pause-resume.ts`'s default-deny, DB-re-derived,
// swappable resume condition (Phase 16, DRIVER-02, D-03). Uses the
// temp-project DB fixture style from `human-uat-pending-projection.test.ts`:
// real Domain Operation writes (`registerGate2HumanUatPending`,
// `resolveGate2HumanUatPending`, `saveReworkBrief`, `applyReworkResolutions`)
// seed the same rows production writes, never a synthetic shortcut.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  applyReworkResolutions,
  closeDatabase,
  getDbOrNull,
  insertMilestone,
  insertSlice,
  openDatabase,
  saveReworkBrief,
} from "../gsd-db.ts";
import {
  registerGate2HumanUatPending,
  resolveGate2HumanUatPending,
} from "../milestone-gate2-human-uat-domain-operation.ts";
import {
  AUTO_RESUMABLE_PAUSE_KINDS,
  defaultResumeCondition,
  resolveResumeCondition,
  setResumeCondition,
  type PauseContext,
} from "../run-pause-resume.ts";
import type { PauseKind } from "../types.ts";

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
  };
}

/** Creates a fresh temp project with an open workflow database — mirrors
 *  human-uat-pending-projection.test.ts's makeBase(). */
function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-pause-resume-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Pause-resume fixture", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
  closeDatabase();
  return basePath;
}

/** Seeds one gap-shaped rework brief with a single blocking, pending finding. */
function seedGapFinding(basePath: string, taskId: string, cycle: number, findingId: string): void {
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  saveReworkBrief({
    briefId: `RB-M001-S01-${taskId}-gap-${cycle}`,
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
    findings: [{
      findingId,
      severity: "blocking",
      description: `gap ${cycle}`,
      requiredFix: "close the gap",
      verificationCommands: [],
      evidence: "seeded by test",
    }],
  });
  closeDatabase();
}

/** Marks one finding resolved via the real resolution path. */
function resolveFinding(basePath: string, taskId: string, findingId: string): void {
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  applyReworkResolutions([{
    milestoneId: "M001",
    sliceId: "S01",
    taskId,
    findingId,
    status: "resolved",
    evidence: "resolved by test",
  }]);
  closeDatabase();
}

/** Registers a real Gate-2 human-UAT pending row, returning its entry id. */
function registerCertifyPause(basePath: string): string {
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const receipt = registerGate2HumanUatPending({
    invocation: invocation(`fixture/pause-resume/register-${Date.now()}-${Math.random()}`),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "certify escalation for M001/S01: 1 gap(s) requiring human review",
    partialCriteria: [{ criterion: "CERT01 gate is pending", evidence: "quality_gates row status=pending" }],
  });
  closeDatabase();
  return receipt.entryId;
}

function signOffCertifyPause(basePath: string, entryId: string, disposition: "signed-off" | "signed-off-with-gap"): void {
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  resolveGate2HumanUatPending({
    invocation: invocation(`fixture/pause-resume/resolve-${Date.now()}-${Math.random()}`),
    entryId,
    disposition,
  });
  closeDatabase();
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Tests 1-3: default-deny, before any allow branch ──────────────────────

test("Test 1: kind=human-decision returns no-resume and performs no database read at all", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-pause-resume-nodedb-"));
  tempDirs.add(basePath);
  // Deliberately no .gsd directory at all — if the deny branch touched the
  // database before returning, this would surface as a distinct
  // "database unavailable" reason rather than the allowlist reason below.
  const pause: PauseContext = { kind: "human-decision", milestoneId: "M001", sliceId: "S01" };
  const decision = defaultResumeCondition(basePath, pause);
  assert.equal(decision.resume, false);
  assert.match(decision.reason, /not on the auto-resume allowlist/);
});

test("Test 2: a null kind and an unrecognised kind take the same no-resume branch as the unlisted human-decision kind", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-pause-resume-nodedb2-"));
  tempDirs.add(basePath);
  const nullDecision = defaultResumeCondition(basePath, { kind: null, milestoneId: "M001", sliceId: "S01" });
  assert.equal(nullDecision.resume, false);
  assert.match(nullDecision.reason, /not on the auto-resume allowlist/);

  const unknownDecision = defaultResumeCondition(basePath, {
    kind: "totally-unknown" as unknown as PauseKind,
    milestoneId: "M001",
    sliceId: "S01",
  });
  assert.equal(unknownDecision.resume, false);
  assert.match(unknownDecision.reason, /not on the auto-resume allowlist/);
});

test("Test 3: AUTO_RESUMABLE_PAUSE_KINDS has exactly two members", () => {
  assert.equal(AUTO_RESUMABLE_PAUSE_KINDS.size, 2);
  assert.ok(AUTO_RESUMABLE_PAUSE_KINDS.has("gap-closure-cap"));
  assert.ok(AUTO_RESUMABLE_PAUSE_KINDS.has("certify-escalation"));
});

// ─── Tests 4-8: gap-closure-cap readiness ──────────────────────────────────

describe("gap-closure-cap readiness", () => {
  test("Test 4: the exact-zero boundary, proven one step either side", () => {
    const basePath = makeBase();
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    seedGapFinding(basePath, "T01", 2, "GC2-01");

    const pause: PauseContext = {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 2 },
    };

    let decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, false, "2 unresolved must not resume");

    resolveFinding(basePath, "T01", "GC1-01");
    decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, false, "1 unresolved must not resume");

    resolveFinding(basePath, "T01", "GC2-01");
    decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, true, "0 unresolved, with a pause snapshot of 2, must resume");
    assert.match(decision.reason, /now resolved/);
  });

  test("Test 5: 0 unresolved with a pause snapshot ALSO recording 0 refuses the degenerate no-op resume", () => {
    const basePath = makeBase();
    const pause: PauseContext = {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 0 },
    };
    const decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, false);
    assert.match(decision.reason, /no change since pause/);
  });

  test("Test 6: readiness reflects a resolution applied AFTER the pause was recorded — the read is fresh, not cached", () => {
    const basePath = makeBase();
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    const pause: PauseContext = {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 1 },
    };
    assert.equal(defaultResumeCondition(basePath, pause).resume, false, "must not resume before the resolution lands");

    resolveFinding(basePath, "T01", "GC1-01");
    const decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, true, "must resume once the SAME pause context is re-evaluated after a fresh DB write");
  });

  test("Test 7: a contradictory .gsd/hook-state.json is ignored — the decision follows the DB in both directions", () => {
    const basePath = makeBase();
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    const pause: PauseContext = {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 1 },
    };

    // A hook-state.json claiming the gate is already clear (cycle: 0) —
    // if this module read it, it would optimistically resume despite the
    // real unresolved finding.
    writeFileSync(
      join(basePath, ".gsd", "hook-state.json"),
      JSON.stringify({ gateBlockPending: { cycle: 0 } }, null, 2),
      "utf-8",
    );
    let decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, false, "must follow the DB (still unresolved), not the optimistic hook-state file");

    // Resolve for real, but leave the (now stale, pessimistic) hook-state.json
    // untouched at cycle: 0 — a naive reader might treat "no change recorded"
    // as not-ready. The DB says otherwise.
    resolveFinding(basePath, "T01", "GC1-01");
    decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, true, "must follow the DB (now resolved), not the stale hook-state file");
  });

  test("Test 8: an unrelated non-gap-shaped rework brief does not affect readiness", () => {
    const basePath = makeBase();
    // Unrelated manual brief — no `-gap-` segment, exactly the
    // gsd_rework_brief_save shape (CR-01, 12-REVIEW.md).
    assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
    saveReworkBrief({
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T02",
      findings: [{
        findingId: "MANUAL-01",
        severity: "blocking",
        description: "unrelated manual rework brief",
        requiredFix: "n/a",
        verificationCommands: [],
        evidence: "pre-seeded, not gap-closure",
      }],
    });
    closeDatabase();

    const pause: PauseContext = {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 1 },
    };
    // No gap-shaped findings exist at all — readiness must be 0 unresolved
    // (ignoring the unrelated manual brief's still-pending finding).
    const decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, true, "the unrelated non-gap brief's pending finding must not block readiness");
  });
});

// ─── Tests 9-10: certify-escalation readiness ──────────────────────────────

describe("certify-escalation readiness", () => {
  test("Test 9: pending refuses, signed-off resumes, signed-off-with-gap also resumes", () => {
    const basePath = makeBase();
    const entryId = registerCertifyPause(basePath);
    const pause: PauseContext = {
      kind: "certify-escalation",
      milestoneId: "M001",
      sliceId: "S01",
      gate2EntryId: entryId,
    };

    let decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, false, "a still-pending entry must not resume");
    assert.match(decision.reason, /pending sign-off/);

    signOffCertifyPause(basePath, entryId, "signed-off");
    decision = defaultResumeCondition(basePath, pause);
    assert.equal(decision.resume, true, "signed-off must resume");

    const secondEntryId = registerCertifyPause(basePath);
    signOffCertifyPause(basePath, secondEntryId, "signed-off-with-gap");
    const secondDecision = defaultResumeCondition(basePath, {
      kind: "certify-escalation",
      milestoneId: "M001",
      sliceId: "S01",
      gate2EntryId: secondEntryId,
    });
    assert.equal(secondDecision.resume, true, "signed-off-with-gap must also resume");
  });

  test("Test 10: an entry id that does not exist returns no-resume with a named reason, never an optimistic pass", () => {
    const basePath = makeBase();
    const decision = defaultResumeCondition(basePath, {
      kind: "certify-escalation",
      milestoneId: "M001",
      sliceId: "S01",
      gate2EntryId: "does-not-exist",
    });
    assert.equal(decision.resume, false);
    assert.match(decision.reason, /not found/);
  });
});

// ─── Test 11: the swap is real and reversible ──────────────────────────────

test("Test 11: setResumeCondition installs a replacement, resolveResumeCondition returns it, and restoring puts the default back", () => {
  assert.equal(resolveResumeCondition(), defaultResumeCondition, "the default must be installed at module load");

  const replacement = (_basePath: string, _pause: PauseContext) => ({ resume: true, reason: "test override" });
  const restore = setResumeCondition(replacement);
  assert.equal(resolveResumeCondition(), replacement);

  restore();
  assert.equal(resolveResumeCondition(), defaultResumeCondition, "restoring must put the default back exactly");
});

// ─── Tests 12-13: never throws, never leaks a handle ───────────────────────

describe("failure modes never throw", () => {
  test("Test 12: no database, no .gsd directory, and a database that throws on query all return no-resume without throwing", () => {
    const missingDbPath = mkdtempSync(join(tmpdir(), "gsd-run-pause-resume-missingdb-"));
    tempDirs.add(missingDbPath);
    mkdirSync(join(missingDbPath, ".gsd"), { recursive: true });
    assert.doesNotThrow(() => {
      const decision = defaultResumeCondition(missingDbPath, {
        kind: "certify-escalation",
        milestoneId: "M001",
        sliceId: "S01",
        gate2EntryId: "any",
      });
      assert.equal(decision.resume, false);
      assert.match(decision.reason, /unavailable/);
    });

    const noGsdDirPath = mkdtempSync(join(tmpdir(), "gsd-run-pause-resume-nogsddir-"));
    tempDirs.add(noGsdDirPath);
    assert.doesNotThrow(() => {
      const decision = defaultResumeCondition(noGsdDirPath, {
        kind: "gap-closure-cap",
        milestoneId: "M001",
        sliceId: "S01",
        snapshot: { unresolvedAtPause: 1 },
      });
      assert.equal(decision.resume, false);
      assert.match(decision.reason, /unavailable/);
    });

    const throwsPath = makeBase();
    assert.equal(openDatabase(join(throwsPath, ".gsd", "gsd.db")), true);
    getDbOrNull()!.exec("DROP TABLE human_uat_pending");
    closeDatabase();
    assert.doesNotThrow(() => {
      const decision = defaultResumeCondition(throwsPath, {
        kind: "certify-escalation",
        milestoneId: "M001",
        sliceId: "S01",
        gate2EntryId: "any",
      });
      assert.equal(decision.resume, false);
      assert.match(decision.reason, /readiness check failed/);
    });
  });

  test("Test 13: after every call, the workflow database is closed — no handle leaks into the host process", () => {
    const basePath = makeBase();
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    defaultResumeCondition(basePath, {
      kind: "gap-closure-cap",
      milestoneId: "M001",
      sliceId: "S01",
      snapshot: { unresolvedAtPause: 1 },
    });
    assert.equal(getDbOrNull(), null, "gap-closure-cap evaluation must close the database it opened");

    const entryId = registerCertifyPause(basePath);
    defaultResumeCondition(basePath, {
      kind: "certify-escalation",
      milestoneId: "M001",
      sliceId: "S01",
      gate2EntryId: entryId,
    });
    assert.equal(getDbOrNull(), null, "certify-escalation evaluation must close the database it opened");

    defaultResumeCondition(basePath, { kind: "human-decision", milestoneId: "M001", sliceId: "S01" });
    assert.equal(getDbOrNull(), null, "the deny branch never opens a database in the first place");
  });
});
