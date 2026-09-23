// Project/App: gsd-pi
// File Purpose: Milestone-scoped active-run detection on the existing
// session-lock primitive (DRIVER-01, ROADMAP SC2, Task 1). Proves the
// two-signal agreement (`getActiveMilestoneRun` + `readSessionLockData` +
// `isSessionLockProcessAlive`) that distinguishes a genuinely active
// milestone run from a `running` row whose owner has crashed, and pins the
// generalised `effectiveLockFile`/`effectiveLockTarget` byte-identical to
// today's environment-only behavior for both existing call shapes.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { recordMilestoneRunLifecycle } from "../milestone-run-log-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { gsdRoot } from "../paths.ts";
import {
  detectActiveMilestoneRun,
  effectiveLockFile,
  effectiveLockTarget,
} from "../session-lock.ts";

// process.kill(pid, 0) → EPERM (treated as alive) for PID 1 (init/launchd)
// even as non-root; process.pid is explicitly rejected by isPidAlive's own
// self-PID guard, so the established codebase convention (see
// state-reconciliation-drift.test.ts) is to use PID 1 to represent "a live
// process" in fixtures, never the test runner's own pid.
const ALIVE_PID = 1;
// Far above any realistic system PID; process.kill(pid, 0) → ESRCH.
const DEAD_PID = 999_999_999;

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return { idempotencyKey, sourceTransport: "internal", actorType: "test" };
}

/** Fresh project directory with a `.gsd` DB carrying one active milestone. */
function makeBase(milestoneId = "M001"): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-session-lock-milestone-scoped-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Milestone-scoped lock test", status: "active" });
  return basePath;
}

/** Insert one `running` row for `milestoneId` through the real writer path. */
function insertRunningRow(milestoneId: string, runId: string, attempt = 1): string {
  const receipt = recordMilestoneRunLifecycle({
    invocation: invocation(`fixture/session-lock-milestone-scoped/${milestoneId}/${runId}/a${attempt}`),
    milestoneId,
    runId,
    attempt,
    status: "running",
  });
  return receipt.entryId;
}

/** Write a milestone-scoped session lock file directly, bypassing acquisition. */
function writeMilestoneLock(basePath: string, milestoneId: string, pid: number): string {
  const gsdDir = join(basePath, ".gsd");
  mkdirSync(gsdDir, { recursive: true });
  const lockFile = join(gsdDir, `auto-${milestoneId}.lock`);
  writeFileSync(
    lockFile,
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      unitType: "starting",
      unitId: "bootstrap",
      unitStartedAt: new Date().toISOString(),
    }),
  );
  return lockFile;
}

const savedEnv = {
  GSD_PARALLEL_WORKER: process.env.GSD_PARALLEL_WORKER,
  GSD_MILESTONE_LOCK: process.env.GSD_MILESTONE_LOCK,
};

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  // Restore both env vars so a leaked GSD_PARALLEL_WORKER cannot contaminate
  // other suites sharing this test process.
  if (savedEnv.GSD_PARALLEL_WORKER === undefined) delete process.env.GSD_PARALLEL_WORKER;
  else process.env.GSD_PARALLEL_WORKER = savedEnv.GSD_PARALLEL_WORKER;
  if (savedEnv.GSD_MILESTONE_LOCK === undefined) delete process.env.GSD_MILESTONE_LOCK;
  else process.env.GSD_MILESTONE_LOCK = savedEnv.GSD_MILESTONE_LOCK;
});

test("Test 1: a running row + a live lock reports active and names the owning PID", () => {
  const basePath = makeBase("M001");
  insertRunningRow("M001", "R001");
  writeMilestoneLock(basePath, "M001", ALIVE_PID);

  const result = detectActiveMilestoneRun(basePath, "M001");
  assert.equal(result.active, true);
  assert.equal(result.pid, ALIVE_PID);
});

test("Test 2: a running row + a lock whose PID belongs to no live process reports NOT active with a stale reason", () => {
  const basePath = makeBase("M001");
  insertRunningRow("M001", "R002");
  writeMilestoneLock(basePath, "M001", DEAD_PID);

  const result = detectActiveMilestoneRun(basePath, "M001");
  assert.equal(result.active, false);
  assert.equal(result.reason, "stale-lock-dead-owner");
  assert.equal(result.pid, DEAD_PID);
});

test("Test 3: a live lock but no running row reports NOT active for this milestone", () => {
  const basePath = makeBase("M001");
  // No running row inserted -- the milestone's only run-log activity (if
  // any) is not status='running'.
  writeMilestoneLock(basePath, "M001", ALIVE_PID);

  const result = detectActiveMilestoneRun(basePath, "M001");
  assert.equal(result.active, false);
  assert.equal(result.reason, "no-running-run-log-row");
});

test("Test 4: neither signal present reports NOT active", () => {
  const basePath = makeBase("M001");

  const result = detectActiveMilestoneRun(basePath, "M001");
  assert.equal(result.active, false);
  assert.equal(result.reason, "no-running-run-log-row");
});

test("Test 5: effectiveLockFile()/effectiveLockTarget() stay byte-identical to today for both existing call shapes", () => {
  const gsdDir = "/tmp/gsd-fixture-not-used";

  // Plain case: neither env var set.
  delete process.env.GSD_PARALLEL_WORKER;
  delete process.env.GSD_MILESTONE_LOCK;
  assert.equal(effectiveLockFile(), "auto.lock");
  assert.equal(effectiveLockTarget(gsdDir), gsdDir);

  // Parallel-worker case: both env vars set.
  process.env.GSD_PARALLEL_WORKER = "1";
  process.env.GSD_MILESTONE_LOCK = "M042";
  assert.equal(effectiveLockFile(), "auto-M042.lock");
  assert.equal(effectiveLockTarget(gsdDir), join(gsdDir, "parallel", "M042"));

  // GSD_MILESTONE_LOCK set without GSD_PARALLEL_WORKER: today's expression
  // still falls through to the plain case (worker flag gates the lookup).
  delete process.env.GSD_PARALLEL_WORKER;
  assert.equal(effectiveLockFile(), "auto.lock");
  assert.equal(effectiveLockTarget(gsdDir), gsdDir);
});

test("Test 6: the explicit milestone-scoped path produces auto-<id>.lock and .gsd/parallel/<id>, with no env var set", () => {
  delete process.env.GSD_PARALLEL_WORKER;
  delete process.env.GSD_MILESTONE_LOCK;
  const gsdDir = "/tmp/gsd-fixture-not-used";

  assert.equal(effectiveLockFile("M099"), "auto-M099.lock");
  assert.equal(effectiveLockTarget(gsdDir, "M099"), join(gsdDir, "parallel", "M099"));
});

test("Test 7: a milestone id with a path separator, a leading dot, or a null byte is rejected before it reaches a filesystem path", () => {
  const gsdDir = "/tmp/gsd-fixture-not-used";
  const badIds = ["../escape", "a/b", "a\\b", ".hidden", "\0null"];
  for (const badId of badIds) {
    assert.throws(() => effectiveLockFile(badId), `effectiveLockFile should reject ${JSON.stringify(badId)}`);
    assert.throws(
      () => effectiveLockTarget(gsdDir, badId),
      `effectiveLockTarget should reject ${JSON.stringify(badId)}`,
    );
  }
});

test("Test 8: detectActiveMilestoneRun never throws -- missing .gsd dir, unreadable lock file, malformed lock JSON each return a named not-active reason", () => {
  // Missing .gsd directory entirely, no DB open at all.
  const noGsdDirBase = mkdtempSync(join(tmpdir(), "gsd-session-lock-milestone-scoped-nogsd-"));
  tempDirs.add(noGsdDirBase);
  let result: ReturnType<typeof detectActiveMilestoneRun> | undefined;
  assert.doesNotThrow(() => { result = detectActiveMilestoneRun(noGsdDirBase, "M001"); });
  assert.equal(result!.active, false);
  assert.equal(result!.reason, "no-running-run-log-row");

  // Unreadable lock file (a directory sitting where the lock FILE is
  // expected -- readFileSync throws EISDIR) with a genuine running row.
  const unreadableBase = makeBase("M001");
  insertRunningRow("M001", "R-unreadable");
  const lockFile = join(unreadableBase, ".gsd", "auto-M001.lock");
  mkdirSync(lockFile, { recursive: true });
  assert.doesNotThrow(() => { result = detectActiveMilestoneRun(unreadableBase, "M001"); });
  assert.equal(result!.active, false);
  assert.equal(result!.reason, "no-session-lock");

  // Malformed lock JSON with a genuine running row.
  closeDatabase();
  const malformedBase = makeBase("M001");
  insertRunningRow("M001", "R-malformed");
  writeFileSync(join(malformedBase, ".gsd", "auto-M001.lock"), "{ this is not valid json");
  assert.doesNotThrow(() => { result = detectActiveMilestoneRun(malformedBase, "M001"); });
  assert.equal(result!.active, false);
  assert.equal(result!.reason, "no-session-lock");
});
