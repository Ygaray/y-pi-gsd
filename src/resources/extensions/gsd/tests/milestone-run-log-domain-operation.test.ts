// Project/App: gsd-pi
// File Purpose: End-to-end contract for the milestone run-log's first
// lifecycle transition (DRIVER-01, this phase's tracer) -- the
// Domain-Operation-bound write, the `.gsd/RUN-LOG.md` projection, and the
// host-side never-throws wrapper that is the first write-path from `src/`
// into a Domain Operation in this repository.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _getAdapter,
  closeDatabase,
  getDbOrNull,
  insertMilestone,
  openDatabase,
  SCHEMA_VERSION,
} from "../gsd-db.ts";
import { RUN_LOG_PROJECTION_FILENAME } from "../run-log-projection.ts";
import { recordHeadlessRunComplete, recordHeadlessRunLifecycle, recordHeadlessRunPause } from "../../../../headless-run-log.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

/** Fresh project directory with a `.gsd` DB carrying one active milestone. */
function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-domain-op-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Run log", status: "active" });
  closeDatabase();
  return basePath;
}

/** Fresh project directory with a `.gsd` directory but no database file. */
function makeGsdDirOnly(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-nodb-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  return basePath;
}

/** Fresh project directory with no `.gsd` directory at all. */
function makeNoGsdDir(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-no-gsd-dir-"));
  tempDirs.add(basePath);
  return basePath;
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("schema: milestone_run_log table exists at schema v54+ on a fresh install", () => {
  const basePath = makeBase();
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  assert.equal(
    Number(db().prepare(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'milestone_run_log'
    `).get()?.["count"] ?? 0),
    1,
  );
  assert.ok(SCHEMA_VERSION >= 54, "milestone_run_log requires schema v54+");
});

test("recording a running transition inserts one row with attempt-numbered identity and matching provenance", () => {
  const basePath = makeBase();
  const result = recordHeadlessRunLifecycle(basePath, { runId: "R001", attempt: 1, status: "running" });
  assert.equal(result.recorded, true);
  assert.equal(result.milestoneId, "M001");
  assert.equal(result.entryId, "RUN-M001-R001-a1");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const row = db().prepare(`
    SELECT * FROM milestone_run_log WHERE entry_id = :entry_id
  `).get({ ":entry_id": result.entryId });
  assert.ok(row);
  assert.equal(row!["status"], "running");
  assert.equal(row!["milestone_id"], "M001");
  assert.equal(row!["run_id"], "R001");
  assert.equal(row!["attempt"], 1);
  assert.ok(row!["created_operation_id"]);
  assert.equal(row!["created_operation_id"], row!["last_operation_id"]);
});

test("the registration call regenerates .gsd/RUN-LOG.md naming the milestone, run, attempt and status", () => {
  const basePath = makeBase();
  const result = recordHeadlessRunLifecycle(basePath, { runId: "R002", attempt: 1, status: "running" });
  assert.equal(result.recorded, true);

  const content = readFileSync(join(basePath, ".gsd", RUN_LOG_PROJECTION_FILENAME), "utf-8");
  assert.match(content, /M001/);
  assert.match(content, new RegExp(result.entryId!));
  assert.match(content, /running/);
});

test("recordHeadlessRunLifecycle against a project with no .gsd database returns its no-op result and does not throw", () => {
  const basePath = makeNoGsdDir();
  let result: ReturnType<typeof recordHeadlessRunLifecycle> | undefined;
  assert.doesNotThrow(() => {
    result = recordHeadlessRunLifecycle(basePath, { runId: "R003", attempt: 1, status: "running" });
  });
  assert.equal(result!.recorded, false);
  assert.equal(result!.milestoneId, null);
  assert.equal(result!.entryId, null);

  // Also confirm the "gsd dir exists, database does not" no-op path.
  const basePath2 = makeGsdDirOnly();
  const result2 = recordHeadlessRunLifecycle(basePath2, { runId: "R003b", attempt: 1, status: "running" });
  assert.equal(result2.recorded, false);
  assert.equal(result2.milestoneId, null);
  assert.equal(result2.entryId, null);
});

test("recordHeadlessRunLifecycle against a project whose DB has no active milestone returns its no-op result and writes no row", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-run-log-no-milestone-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  closeDatabase();

  const result = recordHeadlessRunLifecycle(basePath, { runId: "R004", attempt: 1, status: "running" });
  assert.equal(result.recorded, false);
  assert.equal(result.milestoneId, null);
  assert.equal(result.entryId, null);

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  assert.equal(
    Number(db().prepare(`SELECT COUNT(*) AS count FROM milestone_run_log`).get()?.["count"] ?? -1),
    0,
  );
});

test("after the host wrapper returns, the workflow database is closed (no leaked handle)", () => {
  const basePath = makeBase();
  const result = recordHeadlessRunLifecycle(basePath, { runId: "R005", attempt: 1, status: "running" });
  assert.equal(result.recorded, true);
  assert.equal(getDbOrNull(), null);
});

// ─── CR-01 (review of 16-driver-ergonomics): the terminal transition ──────
// recordHeadlessRunLifecycle never had, and its own stale-row cleanup.

test("CR-01: recordHeadlessRunComplete transitions a running row to completed, and a subsequent recordHeadlessRunLifecycle call for the SAME milestone succeeds -- the exact 'run 1 completes, run 2 starts' scenario the bug broke", () => {
  const basePath = makeBase();
  const run1 = recordHeadlessRunLifecycle(basePath, { runId: "R-run1", attempt: 1, status: "running" });
  assert.equal(run1.recorded, true);

  const completeResult = recordHeadlessRunComplete(basePath, "R-run1", "completed");
  assert.equal(completeResult.recorded, true);
  assert.equal(completeResult.status, "completed");
  assert.equal(completeResult.entryId, run1.entryId);

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const run1Row = db().prepare(`SELECT status FROM milestone_run_log WHERE entry_id = :id`)
    .get({ ":id": run1.entryId });
  assert.equal(run1Row?.["status"], "completed");
  closeDatabase();

  // Before this fix, this second call would silently collide with
  // idx_milestone_run_log_one_active (run 1's row still 'running') and
  // return the swallowed no-op result -- exactly CR-01's headline bug.
  const run2 = recordHeadlessRunLifecycle(basePath, { runId: "R-run2", attempt: 1, status: "running" });
  assert.equal(run2.recorded, true, "the second run for the same milestone must succeed");
  assert.notEqual(run2.entryId, run1.entryId, "the second run gets its own row, not an upsert onto run 1's");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  assert.equal(
    Number(db().prepare(`SELECT COUNT(*) AS count FROM milestone_run_log WHERE status = 'running'`).get()?.["count"] ?? -1),
    1,
    "exactly one running row exists -- run 1's row is terminal, run 2's is the sole active row",
  );
});

test("CR-01: recordHeadlessRunComplete on a paused row always writes 'failed', never 'completed' -- the schema's whitelist only permits paused -> failed", () => {
  const basePath = makeBase();
  const run1 = recordHeadlessRunLifecycle(basePath, { runId: "R-paused", attempt: 1, status: "running" });
  assert.equal(run1.recorded, true);

  const pauseResult = recordHeadlessRunPause(basePath, "R-paused", {
    kind: "human-decision",
    reason: "waiting on a human decision",
    milestoneId: "M001",
    sliceId: null,
  });
  assert.equal(pauseResult.recorded, true);

  // Ask for 'completed' -- the ONLY legal transition out of 'paused' is to
  // 'failed', so the function must not attempt (and fail) 'completed'.
  const completeResult = recordHeadlessRunComplete(basePath, "R-paused", "completed");
  assert.equal(completeResult.recorded, true);
  assert.equal(completeResult.status, "failed", "a paused row resolves to failed, never completed");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const row = db().prepare(`SELECT status FROM milestone_run_log WHERE entry_id = :id`)
    .get({ ":id": pauseResult.entryId });
  assert.equal(row?.["status"], "failed");
});

test("CR-01: recordHeadlessRunComplete never throws and no-ops on no DB, no active milestone, or no matching running/paused row", () => {
  const noDbBase = makeNoGsdDir();
  assert.doesNotThrow(() => {
    const result = recordHeadlessRunComplete(noDbBase, "R-nodb", "completed");
    assert.equal(result.recorded, false);
    assert.equal(result.entryId, null);
    assert.equal(result.status, null);
  });

  const basePath = makeBase();
  // No run was ever recorded for "R-nonexistent" -- nothing to transition.
  const result = recordHeadlessRunComplete(basePath, "R-nonexistent", "completed");
  assert.equal(result.recorded, false);
  assert.equal(result.entryId, null);
  assert.equal(result.status, null);
});

test("CR-01: recordHeadlessRunComplete closes the workflow database, leaking no handle", () => {
  const basePath = makeBase();
  const run1 = recordHeadlessRunLifecycle(basePath, { runId: "R-close", attempt: 1, status: "running" });
  assert.equal(run1.recorded, true);
  recordHeadlessRunComplete(basePath, "R-close", "completed");
  assert.equal(getDbOrNull(), null);
});

test("CR-01: recordHeadlessRunLifecycle's stale-row cleanup only fires for a CONCLUSIVE not-active reason -- a leftover running row with no session lock (no-session-lock, conclusive) is failed out and the fresh insert succeeds", () => {
  const basePath = makeBase();
  const run1 = recordHeadlessRunLifecycle(basePath, { runId: "R-stale", attempt: 1, status: "running" });
  assert.equal(run1.recorded, true);
  // No session lock file is ever written in this test -- detectActiveMilestoneRun
  // reports { active: false, reason: "no-session-lock" }, a CONCLUSIVE reason,
  // so the stale-row cleanup fires and the second insert below succeeds.

  const run2 = recordHeadlessRunLifecycle(basePath, { runId: "R-fresh", attempt: 1, status: "running" });
  assert.equal(run2.recorded, true);

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  const run1Row = db().prepare(`SELECT status FROM milestone_run_log WHERE entry_id = :id`)
    .get({ ":id": run1.entryId });
  assert.equal(run1Row?.["status"], "failed", "the stale leftover row was force-failed by the cleanup");
  const run2Row = db().prepare(`SELECT status FROM milestone_run_log WHERE entry_id = :id`)
    .get({ ":id": run2.entryId });
  assert.equal(run2Row?.["status"], "running");
});
