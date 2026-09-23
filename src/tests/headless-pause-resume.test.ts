// Project/App: gsd-pi
// File Purpose: Proves the headless pause classification, the bounded
// resume decision, and the two run-log lifecycle transitions (Phase 16,
// DRIVER-02, this phase's plumbing-into-the-host plan). Uses the temp-project
// DB fixture style from `human-uat-pending-projection.test.ts` /
// `run-pause-resume.test.ts`: real Domain Operation writes
// (`saveReworkBrief`, `applyReworkResolutions`, `registerGate2HumanUatPending`,
// `resolveGate2HumanUatPending`, `recordHeadlessRunLifecycle`) seed the same
// rows production writes, never a synthetic shortcut.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import {
  classifyHeadlessPause,
  decideHeadlessResume,
  MAX_CONSECUTIVE_RESUMES,
} from "../headless-pause-resume.ts";
import {
  recordHeadlessRunLifecycle,
  recordHeadlessRunPause,
  recordHeadlessRunResume,
} from "../headless-run-log.ts";
import { EXIT_BLOCKED, EXIT_SUCCESS } from "../headless-events.ts";
import {
  applyReworkResolutions,
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
  saveReworkBrief,
} from "../resources/extensions/gsd/gsd-db.ts";
import {
  registerGate2HumanUatPending,
  resolveGate2HumanUatPending,
} from "../resources/extensions/gsd/milestone-gate2-human-uat-domain-operation.ts";
import { formatBlockedNoticeWithPauseKind } from "../resources/extensions/gsd/stop-notice.ts";
import { setResumeCondition, type ResumeDecision } from "../resources/extensions/gsd/run-pause-resume.ts";
import { readMilestoneRunLog, RUN_LOG_PROJECTION_FILENAME } from "../resources/extensions/gsd/run-log-projection.ts";
import type { ExecutionInvocation } from "../resources/extensions/gsd/execution-invocation.ts";

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return { idempotencyKey, sourceTransport: "internal", actorType: "agent" };
}

/** Fresh temp project with an open workflow DB carrying one milestone/slice, mirrors run-pause-resume.test.ts's makeBase(). */
function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-headless-pause-resume-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Pause-resume fixture", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
  closeDatabase();
  return basePath;
}

/** Records the initial `running` attempt-1 row a real `gsd headless auto` start would write. */
function startRun(basePath: string, runId: string): void {
  const result = recordHeadlessRunLifecycle(basePath, { runId, attempt: 1, status: "running" });
  assert.equal(result.recorded, true, "fixture setup: the initial running row must be recorded");
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
    invocation: invocation(`fixture/headless-pause-resume/register-${Date.now()}-${Math.random()}`),
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
    invocation: invocation(`fixture/headless-pause-resume/resolve-${Date.now()}-${Math.random()}`),
    entryId,
    disposition,
  });
  closeDatabase();
}

/** Same technique as run-log-projection.test.ts: counts pipes NOT preceded by a backslash. */
function unescapedPipeCount(line: string): number {
  const matches = line.match(/(?<!\\)\|/g);
  return matches ? matches.length : 0;
}

function readRunLog(basePath: string) {
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const rows = readMilestoneRunLog();
  closeDatabase();
  return rows;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Tests 1-2: classifyHeadlessPause ───────────────────────────────────────

describe("classifyHeadlessPause", () => {
  test("Test 1: a gap-closure-cap notice returns that kind plus the display reason with the marker stripped", () => {
    const notice = formatBlockedNoticeWithPauseKind(
      "gap-closure cap reached: 3 rework cycle(s) already recorded for M001/S01 (max 3)",
      "gap-closure-cap",
    );
    const classified = classifyHeadlessPause(notice);
    assert.equal(classified.kind, "gap-closure-cap");
    assert.equal(classified.reason, "gap-closure cap reached: 3 rework cycle(s) already recorded for M001/S01 (max 3)");
    assert.ok(!classified.reason.includes("[pause-kind:"), "the machine marker must not leak into the stored reason");
    assert.equal(classified.milestoneId, "M001");
    assert.equal(classified.sliceId, "S01");
  });

  test("Test 2: no marker and an unrecognised marker both classify as human-decision", () => {
    const noMarker = classifyHeadlessPause("Blocked: some other pause with no marker at all");
    assert.equal(noMarker.kind, "human-decision");

    const badMarker = classifyHeadlessPause("Blocked: reason text [pause-kind: not-a-real-kind]");
    assert.equal(badMarker.kind, "human-decision");
  });
});

// ─── Tests 3-6: decideHeadlessResume's cheap refusals + delegation ─────────

describe("decideHeadlessResume", () => {
  test("Test 3: returns no-resume when the run was not blocked, regardless of kind", () => {
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("certify escalation for M001/S01: 1 gap(s) requiring human review (gate2-entry: G1)", "certify-escalation"),
    );
    const decision = decideHeadlessResume({
      blocked: false,
      exitCode: EXIT_SUCCESS,
      pause,
      unresolvedAtPause: null,
      resumeCount: 0,
      max: MAX_CONSECUTIVE_RESUMES,
      basePath: "/nonexistent",
    });
    assert.equal(decision.resume, false);
  });

  test("Test 4: returns no-resume when resumeCount has reached the maximum, naming the bound, even when the condition would have resumed", () => {
    const restore = setResumeCondition(() => ({ resume: true, reason: "would have resumed" }));
    try {
      const pause = classifyHeadlessPause(
        formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
      );
      const decision = decideHeadlessResume({
        blocked: true,
        exitCode: EXIT_BLOCKED,
        pause,
        unresolvedAtPause: 0,
        resumeCount: MAX_CONSECUTIVE_RESUMES,
        max: MAX_CONSECUTIVE_RESUMES,
        basePath: "/nonexistent",
      });
      assert.equal(decision.resume, false);
      assert.match(decision.reason, new RegExp(String(MAX_CONSECUTIVE_RESUMES)));
    } finally {
      restore();
    }
  });

  test("Test 5: delegates to resolveResumeCondition rather than calling the default directly", () => {
    const restore = setResumeCondition(() => ({ resume: true, reason: "stubbed" }));
    try {
      const pause = classifyHeadlessPause(
        formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
      );
      const decision = decideHeadlessResume({
        blocked: true,
        exitCode: EXIT_BLOCKED,
        pause,
        unresolvedAtPause: 0,
        resumeCount: 0,
        max: MAX_CONSECUTIVE_RESUMES,
        basePath: "/nonexistent",
      });
      assert.equal(decision.resume, true);
      assert.equal(decision.reason, "stubbed");
    } finally {
      restore();
    }
  });

  test("Test 6: the decision's reason string is non-empty on both the resume and the no-resume branch", () => {
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const noResume = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: 5,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath: "/nonexistent",
    });
    assert.ok(noResume.reason.length > 0);

    const restore = setResumeCondition(() => ({ resume: true, reason: "ok" }));
    try {
      const resumed = decideHeadlessResume({
        blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: 0,
        resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath: "/nonexistent",
      });
      assert.ok(resumed.reason.length > 0);
    } finally {
      restore();
    }
  });
});

// ─── Tests 7-10: the two run-log transitions ────────────────────────────────

describe("recordHeadlessRunPause / recordHeadlessRunResume", () => {
  test("Test 7: recordHeadlessRunPause transitions running -> paused and stores the pause kind and reason", () => {
    const basePath = makeBase();
    startRun(basePath, "R001");
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 2 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const result = recordHeadlessRunPause(basePath, "R001", pause);
    assert.equal(result.recorded, true);
    assert.ok(result.entryId);

    const row = readRunLog(basePath).find((r) => r.entryId === result.entryId);
    assert.ok(row);
    assert.equal(row!.status, "paused");
    assert.equal(row!.pauseKind, "gap-closure-cap");
    assert.equal(row!.reason, pause.reason);

    const content = readFileSync(join(basePath, ".gsd", RUN_LOG_PROJECTION_FILENAME), "utf-8");
    assert.match(content, /gap-closure-cap/);
  });

  test("Test 8: recordHeadlessRunResume transitions to resumed and inserts a new attempt row at running, leaving the paused row intact", () => {
    const basePath = makeBase();
    startRun(basePath, "R002");
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("certify escalation for M001/S01: 1 gap(s) requiring human review (gate2-entry: G1)", "certify-escalation"),
    );
    const pauseResult = recordHeadlessRunPause(basePath, "R002", pause);
    assert.equal(pauseResult.recorded, true);

    const resumeResult = recordHeadlessRunResume(basePath, "R002");
    assert.equal(resumeResult.recorded, true);
    assert.notEqual(resumeResult.entryId, pauseResult.entryId);

    const rows = readRunLog(basePath);
    const pausedRow = rows.find((r) => r.entryId === pauseResult.entryId);
    const runningRow = rows.find((r) => r.entryId === resumeResult.entryId);
    assert.ok(pausedRow, "the paused row must remain intact");
    assert.equal(pausedRow!.status, "resumed");
    assert.ok(runningRow);
    assert.equal(runningRow!.status, "running");
    assert.equal(runningRow!.attempt, pausedRow!.attempt + 1);
  });

  test("Test 9: both recorders never throw and no-op with no database, no .gsd directory, or no active run row", () => {
    const noGsdDir = mkdtempSync(join(tmpdir(), "gsd-headless-pause-resume-nogsd-"));
    tempDirs.add(noGsdDir);
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    assert.doesNotThrow(() => {
      assert.equal(recordHeadlessRunPause(noGsdDir, "RX", pause).recorded, false);
    });
    assert.doesNotThrow(() => {
      assert.equal(recordHeadlessRunResume(noGsdDir, "RX").recorded, false);
    });

    const basePath = makeBase();
    // No run started at all -- no active 'running' row for runId "RY".
    assert.doesNotThrow(() => {
      assert.equal(recordHeadlessRunPause(basePath, "RY", pause).recorded, false);
    });
    assert.doesNotThrow(() => {
      assert.equal(recordHeadlessRunResume(basePath, "RY").recorded, false);
    });
  });

  test("Test 10: the pause snapshot is captured at pause time from a fresh DB read, so a later resolution is visible as a decrease", () => {
    const basePath = makeBase();
    startRun(basePath, "R003");
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    seedGapFinding(basePath, "T01", 2, "GC2-01");

    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 2 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const pauseResult = recordHeadlessRunPause(basePath, "R003", pause);
    assert.equal(pauseResult.recorded, true);
    assert.equal(pauseResult.unresolvedAtPause, 2, "must capture the count observed AT pause time");

    // Right after pausing, nothing has changed yet -- must not resume.
    let decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: pauseResult.unresolvedAtPause,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);

    // Resolve both findings -- a decision built from the SAME captured
    // snapshot must now see the decrease.
    resolveFinding(basePath, "T01", "GC1-01");
    resolveFinding(basePath, "T01", "GC2-01");
    decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: pauseResult.unresolvedAtPause,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, true);
  });
});

// ─── Tests 11-17: both directions, real fixtures, and the bound ────────────

describe("both directions on real fixtures", () => {
  test("Test 11: a resolved gap-closure-cap pause produces resume, a resumed row, and a new running row", () => {
    const basePath = makeBase();
    startRun(basePath, "R010");
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const pauseResult = recordHeadlessRunPause(basePath, "R010", pause);
    assert.equal(pauseResult.recorded, true);

    resolveFinding(basePath, "T01", "GC1-01");

    const decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: pauseResult.unresolvedAtPause,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, true);

    const resumeResult = recordHeadlessRunResume(basePath, "R010");
    assert.equal(resumeResult.recorded, true);

    const rows = readRunLog(basePath);
    assert.equal(rows.find((r) => r.entryId === pauseResult.entryId)?.status, "resumed");
    assert.equal(rows.find((r) => r.entryId === resumeResult.entryId)?.status, "running");
  });

  test("Test 12: one remaining unresolved finding produces no-resume and no new attempt row", () => {
    const basePath = makeBase();
    startRun(basePath, "R011");
    seedGapFinding(basePath, "T01", 1, "GC1-01");
    seedGapFinding(basePath, "T01", 2, "GC2-01");
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 2 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const pauseResult = recordHeadlessRunPause(basePath, "R011", pause);

    resolveFinding(basePath, "T01", "GC1-01"); // one still unresolved

    const decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: pauseResult.unresolvedAtPause,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);

    const rows = readRunLog(basePath);
    assert.equal(rows.length, 1, "no new attempt row must be created");
    assert.equal(rows[0]!.status, "paused");
  });

  test("Test 13: a certify-escalation pause stays paused while pending and resumes once signed off", () => {
    const basePath = makeBase();
    startRun(basePath, "R012");
    const entryId = registerCertifyPause(basePath);
    const pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind(
        `certify escalation for M001/S01: 1 gap(s) requiring human review (gate2-entry: ${entryId})`,
        "certify-escalation",
      ),
    );
    assert.equal(pause.gate2EntryId, entryId);
    const pauseResult = recordHeadlessRunPause(basePath, "R012", pause);
    assert.equal(pauseResult.recorded, true);

    let decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: null,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);

    signOffCertifyPause(basePath, entryId, "signed-off");
    decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: null,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, true);
  });

  test("Test 14: a Gate-2 human-UAT sign-off pause (no certify-escalation kind on the notice) stays paused without ever consulting the table", () => {
    const basePath = makeBase();
    startRun(basePath, "R013");
    // A REAL pending Gate-2 row exists -- sharing the exact table
    // certify-escalation also writes to -- but the notice carries NO
    // certify-escalation kind marker. A generic "is this resolved?" check
    // would clear it; the kind must stop the decision before the table is
    // ever consulted (RESEARCH Pitfall 5 / T-16-03).
    registerCertifyPause(basePath);
    const pause = classifyHeadlessPause("Blocked: a human-uat sign-off is still pending for M001/S01");
    assert.equal(pause.kind, "human-decision");

    const decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: null,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);
    assert.match(decision.reason, /not on the auto-resume allowlist/);
    assert.doesNotMatch(decision.reason, /pending sign-off/, "the reason must name the allowlist, not the row's status");
  });

  test("Test 15: a pause with no kind marker at all produces no-resume", () => {
    const basePath = makeBase();
    startRun(basePath, "R014");
    const pause = classifyHeadlessPause("Blocked: no parsable criterion found for M001/S01");
    assert.equal(pause.kind, "human-decision");
    const decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: null,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);
  });

  test("Test 16: a sequence of consecutive resumes stops at the maximum, with that many attempt rows in the run-log", () => {
    const basePath = makeBase();
    startRun(basePath, "R015");
    const restore = setResumeCondition(() => ({ resume: true, reason: "always ready (test stub)" }));
    try {
      let resumeCount = 0;
      let decision: ResumeDecision = { resume: false, reason: "" };
      while (resumeCount < MAX_CONSECUTIVE_RESUMES + 2) {
        const pause = classifyHeadlessPause(
          formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
        );
        recordHeadlessRunPause(basePath, "R015", pause);
        decision = decideHeadlessResume({
          blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: 0,
          resumeCount, max: MAX_CONSECUTIVE_RESUMES, basePath,
        });
        if (!decision.resume) break;
        recordHeadlessRunResume(basePath, "R015");
        resumeCount += 1;
      }

      assert.equal(resumeCount, MAX_CONSECUTIVE_RESUMES);
      assert.match(decision.reason, new RegExp(String(MAX_CONSECUTIVE_RESUMES)));

      const rows = readRunLog(basePath);
      // One initial running row (attempt 1) plus one new row per resume.
      assert.equal(rows.length, MAX_CONSECUTIVE_RESUMES + 1);
    } finally {
      restore();
    }
  });

  test("Test 17: a full pause/resume/pause/stop sequence renders one row per attempt, each escaped to one cell", () => {
    const basePath = makeBase();
    startRun(basePath, "R016");

    seedGapFinding(basePath, "T01", 1, "GC1-01");
    let pause = classifyHeadlessPause(
      formatBlockedNoticeWithPauseKind("gap-closure cap reached: 1 rework cycle(s) already recorded for M001/S01 (max 3)", "gap-closure-cap"),
    );
    const pauseResult1 = recordHeadlessRunPause(basePath, "R016", pause);
    resolveFinding(basePath, "T01", "GC1-01");
    let decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: pauseResult1.unresolvedAtPause,
      resumeCount: 0, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, true);
    recordHeadlessRunResume(basePath, "R016");

    // A second pause -- untagged (human-decision), with a reason carrying a
    // pipe and a newline -- never resolved, so the run stops here.
    const injected = "blocked | with a\nnewline and | more pipes";
    pause = classifyHeadlessPause(`Blocked: ${injected}`);
    assert.equal(pause.kind, "human-decision");
    const pauseResult2 = recordHeadlessRunPause(basePath, "R016", pause);
    decision = decideHeadlessResume({
      blocked: true, exitCode: EXIT_BLOCKED, pause, unresolvedAtPause: null,
      resumeCount: 1, max: MAX_CONSECUTIVE_RESUMES, basePath,
    });
    assert.equal(decision.resume, false);

    const rows = readRunLog(basePath);
    assert.equal(rows.length, 2, "one row per attempt");
    assert.equal(rows[0]!.status, "resumed");
    assert.equal(rows[1]!.status, "paused");
    assert.ok(rows[0]!.pauseKind);
    assert.ok(rows[0]!.reason);
    assert.ok(rows[1]!.pauseKind);
    assert.ok(rows[1]!.reason);

    const content = readFileSync(join(basePath, ".gsd", RUN_LOG_PROJECTION_FILENAME), "utf-8");
    const lines = content.split("\n");
    const headerLine = lines.find((l) => l.startsWith("| Entry | Milestone | Run | Attempt | Status"))!;
    assert.ok(headerLine, "the Run history header row must exist");
    const headerPipes = unescapedPipeCount(headerLine);
    const dataLines = lines.filter((l) => l.includes(pauseResult2.entryId!));
    assert.equal(dataLines.length, 1, "the injected pipe/newline must render as exactly one row");
    assert.equal(unescapedPipeCount(dataLines[0]!), headerPipes, "every reason cell must occupy exactly one cell");
    assert.doesNotMatch(content, /\nnewline and/, "the embedded newline must not survive as a raw line break");
  });
});
