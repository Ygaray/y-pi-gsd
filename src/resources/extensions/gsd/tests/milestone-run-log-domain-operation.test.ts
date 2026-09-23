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
import { recordHeadlessRunLifecycle } from "../../../../headless-run-log.ts";

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
  assert.equal(SCHEMA_VERSION, 54);
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
