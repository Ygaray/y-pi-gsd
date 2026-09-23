// Project/App: gsd-pi
// File Purpose: Structured, validated, durable `--from N` autonomous-run
// scope (DRIVER-01, ROADMAP SC2, Tasks 2-3). Proves the parse/describe
// projection stays a faithful mirror of today's prose, that a malformed
// scope flag is rejected rather than coerced, that starting an autonomous
// run persists the scope to a durable `milestone_run_log` row rather than
// only a prompt-text sentence, and that an already-active run is refused by
// name. Assertions land on the DB row, never on the dispatched prompt
// string -- the string is no longer the contract (D-02).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import {
  describeAutonomousScope,
  InvalidAutonomousScopeFlagError,
  parseAutonomousScopeFlags,
} from "../autonomous-scope.ts";
import { handleAutonomous } from "../commands-gsd-core.ts";
import { withCommandCwd } from "../commands/context.ts";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase } from "../gsd-db.ts";

// process.kill(pid, 0) → EPERM (treated as alive) for PID 1 even as
// non-root; process.pid is rejected by isPidAlive's own self-PID guard, so
// the established codebase convention (session-lock-milestone-scoped.test.ts,
// state-reconciliation-drift.test.ts) is to use PID 1 for "a live process".
const ALIVE_PID = 1;
const DEAD_PID = 999_999_999;

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function createMockPi(): ExtensionAPI {
  return { sendMessage: () => {} } as unknown as ExtensionAPI;
}

function createMockCtx(): ExtensionCommandContext & { notifications: { message: string; level: string }[] } {
  const notifications: { message: string; level: string }[] = [];
  return {
    notifications,
    ui: {
      notify(message: string, level: string) {
        notifications.push({ message, level });
      },
      custom: async () => {},
    },
    shutdown: async () => {},
  } as unknown as ExtensionCommandContext & { notifications: { message: string; level: string }[] };
}

/** Fresh project directory with a `.gsd` DB carrying one active milestone. */
function makeBase(milestoneId = "M001"): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-autonomous-scope-durable-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Autonomous scope durability", status: "active" });
  return basePath;
}

function writeMilestoneLock(basePath: string, milestoneId: string, pid: number): void {
  writeFileSync(
    join(basePath, ".gsd", `auto-${milestoneId}.lock`),
    JSON.stringify({
      pid,
      startedAt: new Date().toISOString(),
      unitType: "starting",
      unitId: "bootstrap",
      unitStartedAt: new Date().toISOString(),
    }),
  );
}

function runLogRows(milestoneId: string): Array<Record<string, unknown>> {
  return db().prepare(`
    SELECT entry_id, status, resume_from FROM milestone_run_log
    WHERE milestone_id = :mid ORDER BY started_at ASC, entry_id ASC
  `).all({ ":mid": milestoneId });
}

async function runAutonomous(
  basePath: string,
  args: string,
): Promise<{ ctx: ReturnType<typeof createMockCtx> }> {
  const ctx = createMockCtx();
  const pi = createMockPi();
  await withCommandCwd(basePath, async () => {
    await handleAutonomous(args, ctx, pi);
  });
  return { ctx };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("Test 1: parseAutonomousScopeFlags returns integer fields for --from/--to", () => {
  const scope = parseAutonomousScopeFlags("--from 3 --to 5");
  assert.deepStrictEqual(scope, { from: 3, to: 5, only: null });
  assert.equal(typeof scope.from, "number");
  assert.equal(typeof scope.to, "number");
});

test("Test 2: --only takes precedence over --from/--to, matching today's precedence", () => {
  assert.deepStrictEqual(parseAutonomousScopeFlags("--only 4"), { from: null, to: null, only: 4 });
  assert.deepStrictEqual(parseAutonomousScopeFlags("--only 4 --from 2"), { from: null, to: null, only: 4 });
});

test("Test 3: a non-integer, zero, negative, or absurdly large --from throws a named parse error", () => {
  for (const bad of ["--from abc", "--from 0", "--from -1", "--from 1e9"]) {
    assert.throws(() => parseAutonomousScopeFlags(bad), InvalidAutonomousScopeFlagError);
  }
});

test("Test 4: describeAutonomousScope reproduces today's parseAutonomousScope prose for every valid input", () => {
  assert.match(describeAutonomousScope(parseAutonomousScopeFlags("")), /All remaining work on the active milestone/);
  assert.equal(describeAutonomousScope(parseAutonomousScopeFlags("--only 3")), "Only slice/milestone 3");
  assert.match(describeAutonomousScope(parseAutonomousScopeFlags("--from 1 --to 4")), /from 1/);
  assert.match(describeAutonomousScope(parseAutonomousScopeFlags("--from 1 --to 4")), /to 4/);
});

test("Test 5: starting with --from 3 when no run is active inserts a running row with resume_from 3", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "--from 3");

  const rows = runLogRows("M001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["status"], "running");
  assert.equal(rows[0]!["resume_from"], 3);
});

test("Test 6: starting with no scope flag inserts a row whose resume_from is NULL", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "");

  const rows = runLogRows("M001");
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!["status"], "running");
  assert.equal(rows[0]!["resume_from"], null);
});

test("Test 7: starting when a run is already active is refused, naming the holding PID and milestone", async () => {
  const basePath = makeBase("M001");
  // Seed an active run: a running row + a live lock (two-signal agreement).
  await runAutonomous(basePath, "");
  writeMilestoneLock(basePath, "M001", ALIVE_PID);

  const before = runLogRows("M001");
  assert.equal(before.length, 1);

  const { ctx } = await runAutonomous(basePath, "--from 2");

  const after = runLogRows("M001");
  assert.equal(after.length, 1, "no second row inserted");
  assert.ok(
    ctx.notifications.some((n) => n.message.includes("M001") && n.message.includes(String(ALIVE_PID))),
    "refusal names the milestone and the holding PID",
  );
});

test("Test 8: the refusal does not fire when the prior row's owner is dead; the new run starts and records its own row", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "");
  writeMilestoneLock(basePath, "M001", DEAD_PID);

  const before = runLogRows("M001");
  assert.equal(before.length, 1);
  assert.equal(before[0]!["status"], "running");

  const { ctx } = await runAutonomous(basePath, "--from 4");

  const after = runLogRows("M001");
  assert.equal(after.length, 2, "the stale row is failed out and a new row is inserted");
  const statuses = after.map((r) => r["status"]).sort();
  assert.deepStrictEqual(statuses, ["failed", "running"]);
  const runningRow = after.find((r) => r["status"] === "running");
  assert.equal(runningRow?.["resume_from"], 4);
  assert.ok(
    !ctx.notifications.some((n) => n.level === "warning" && n.message.includes("already has a live")),
    "no refusal is surfaced when the prior owner is dead",
  );
});
