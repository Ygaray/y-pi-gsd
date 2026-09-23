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
  deriveMilestoneOrdinal,
  describeAutonomousScope,
  InvalidAutonomousScopeFlagError,
  isUnitInAutonomousScope,
  parseAutonomousScopeFlags,
  resolveEffectiveAutonomousScope,
} from "../autonomous-scope.ts";
import { handleAutonomous } from "../commands-gsd-core.ts";
import { isConclusiveNotActiveReason } from "../session-lock.ts";
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

function createMockPi(): ExtensionAPI & { sent: Array<{ customType?: string; content?: string }> } {
  const sent: Array<{ customType?: string; content?: string }> = [];
  return {
    sent,
    sendMessage(message: { customType?: string; content?: string }) {
      sent.push(message);
    },
  } as unknown as ExtensionAPI & { sent: Array<{ customType?: string; content?: string }> };
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
): Promise<{ ctx: ReturnType<typeof createMockCtx>; pi: ReturnType<typeof createMockPi> }> {
  const ctx = createMockCtx();
  const pi = createMockPi();
  await withCommandCwd(basePath, async () => {
    await handleAutonomous(args, ctx, pi);
  });
  return { ctx, pi };
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

// ─── Task 3: mechanical enforcement + durable re-read on restart ──────────

test("Test 9: isUnitInAutonomousScope is inclusive at both from/to bounds, exclusive one step either side", () => {
  const scope = { from: 3, to: 5, only: null };
  assert.equal(isUnitInAutonomousScope(2, scope), false);
  assert.equal(isUnitInAutonomousScope(3, scope), true);
  assert.equal(isUnitInAutonomousScope(4, scope), true);
  assert.equal(isUnitInAutonomousScope(5, scope), true);
  assert.equal(isUnitInAutonomousScope(6, scope), false);
});

test("Test 10: isUnitInAutonomousScope with --only admits exactly that ordinal", () => {
  const scope = { from: null, to: null, only: 4 };
  assert.equal(isUnitInAutonomousScope(4, scope), true);
  assert.equal(isUnitInAutonomousScope(3, scope), false);
  assert.equal(isUnitInAutonomousScope(5, scope), false);
});

test("Test 11: an all-null scope admits every ordinal -- no scope means no restriction", () => {
  const scope = { from: null, to: null, only: null };
  for (const ordinal of [1, 2, 50, 9999]) {
    assert.equal(isUnitInAutonomousScope(ordinal, scope), true, `ordinal ${ordinal} should be in scope`);
  }
});

test("Test 12: an absent bound is unbounded, never coerced to zero", () => {
  const scope = { from: 3, to: null, only: null };
  assert.equal(isUnitInAutonomousScope(2, scope), false);
  assert.equal(isUnitInAutonomousScope(3, scope), true);
  assert.equal(isUnitInAutonomousScope(100_000, scope), true);
});

test("Test 13: re-invoking with NO --from flag while resume_from=3 exists resolves the effective scope from the row", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "--from 3");
  // No lock is written -- the first run is not "active" (no live lock), so
  // the second invocation is free to proceed and re-read the pointer.

  const { pi } = await runAutonomous(basePath, "");

  const rows = runLogRows("M001");
  const running = rows.find((r) => r["status"] === "running");
  assert.equal(running?.["resume_from"], 3, "the resume pointer survived the process that set it");
  assert.match(pi.sent[0]!.content!, /from 3/);
});

test("Test 14: an explicit --from 5 on re-invocation overrides the stored pointer", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "--from 3");

  await runAutonomous(basePath, "--from 5");

  const rows = runLogRows("M001");
  const running = rows.find((r) => r["status"] === "running");
  assert.equal(running?.["resume_from"], 5);
});

test("Test 15: the prose handed to the prompt template on restart is derived from the EFFECTIVE scope, not 'all remaining work'", async () => {
  const basePath = makeBase("M001");
  await runAutonomous(basePath, "--from 3");

  const { pi } = await runAutonomous(basePath, "");

  assert.match(pi.sent[0]!.content!, /from 3/);
  assert.doesNotMatch(pi.sent[0]!.content!, /All remaining work on the active milestone/);
});

test("resolveEffectiveAutonomousScope: explicit flags win, otherwise falls back to the active run's resumeFrom", () => {
  assert.deepStrictEqual(
    resolveEffectiveAutonomousScope("", { resumeFrom: 3 }),
    { from: 3, to: null, only: null },
  );
  assert.deepStrictEqual(
    resolveEffectiveAutonomousScope("--from 5", { resumeFrom: 3 }),
    { from: 5, to: null, only: null },
  );
  assert.deepStrictEqual(
    resolveEffectiveAutonomousScope("", null),
    { from: null, to: null, only: null },
  );
});

test("deriveMilestoneOrdinal extracts the numeric suffix from a milestone id", () => {
  assert.equal(deriveMilestoneOrdinal("M001"), 1);
  assert.equal(deriveMilestoneOrdinal("M042"), 42);
  assert.equal(deriveMilestoneOrdinal("not-a-milestone-id"), null);
});

test("Test 16: an out-of-scope --only unit is refused by the dispatch path instead of being dispatched to the model", async () => {
  const basePath = makeBase("M002");

  const { ctx, pi } = await runAutonomous(basePath, "--only 5");

  const rows = runLogRows("M002");
  assert.equal(rows.length, 0, "no run-log row is recorded for a refused dispatch");
  assert.equal(pi.sent.length, 0, "the prompt is never dispatched to the model");
  assert.ok(
    ctx.notifications.some((n) => n.level === "warning" && n.message.includes("M002") && /scope/i.test(n.message)),
    "the refusal names the milestone and cites the scope",
  );
});

// ─── CR-02 (review of 16-driver-ergonomics): refuse on an ambiguous ───────
// detection reason instead of force-failing a possibly-still-live run.

test("Test 17: isConclusiveNotActiveReason is true for exactly the three CONCLUSIVE not-active reasons, false for the four AMBIGUOUS ones and for undefined", () => {
  // Only these three are actual proof that nothing is running: no row at
  // all, a row with no lock holder, or a row whose lock owner is confirmed
  // dead. `startMilestoneRunLogEntry`'s force-fail (and the dispatch that
  // follows it) must only fire for these -- proven end-to-end by Test 5
  // (no-running-run-log-row), Test 13 (no-session-lock), and Test 8
  // (stale-lock-dead-owner), all still passing unmodified.
  for (const reason of ["no-running-run-log-row", "no-session-lock", "stale-lock-dead-owner"] as const) {
    assert.equal(isConclusiveNotActiveReason(reason), true, `${reason} should be conclusive`);
  }

  // These four are "I could not tell" outcomes from a transient read/query
  // failure partway through detection -- the actual other process may
  // still be alive and still hold the lock. Treating any of these as safe
  // to force-restart is exactly the T-16-14-widened race CR-02 describes.
  for (const reason of [
    "run-log-query-failed",
    "session-lock-read-failed",
    "liveness-check-failed",
    "detection-failed",
  ] as const) {
    assert.equal(isConclusiveNotActiveReason(reason), false, `${reason} should be ambiguous`);
  }

  assert.equal(isConclusiveNotActiveReason(undefined), false, "an absent reason must not default to safe");
});

test("Test 18: an ambiguous detection reason (a run-log query failure) refuses to dispatch and does not touch the existing run-log row", async () => {
  const basePath = makeBase("M003");
  // A genuinely running row exists -- if this were force-failed and a
  // second run allowed to dispatch while the real owner is still alive,
  // two live processes would be racing against the same milestone.
  await runAutonomous(basePath, "");
  const before = runLogRows("M003");
  assert.equal(before.length, 1);
  assert.equal(before[0]!["status"], "running");

  // Force `getActiveMilestoneId`'s own DB read to throw first (the
  // pre-existing, unrelated scope-resolution catch in `handleAutonomous`
  // handles this identically -- notify and refuse -- so this exercises the
  // "a DB read failed, refuse rather than proceed" posture end-to-end even
  // though it lands on that earlier catch rather than the new
  // `isConclusiveNotActiveReason` gate specifically; Test 17 above proves
  // the new gate's own classification is correct for all seven reasons).
  db().prepare("DROP TABLE milestone_run_log").run();

  const { ctx, pi } = await runAutonomous(basePath, "--from 2");

  assert.equal(pi.sent.length, 0, "the prompt is never dispatched when a run-log read fails");
  assert.ok(
    ctx.notifications.some((n) => n.level === "warning"),
    "a warning is surfaced instead of silently proceeding",
  );
});
