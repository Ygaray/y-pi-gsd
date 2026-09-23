// Project/App: gsd-pi
// File Purpose: D-02 regression net — a shipped/archived milestone cannot be
// reopened through the canonical `reopenMilestoneHierarchy` path or the
// legacy unadopted `reopenMilestoneCascade`, while an ordinary completed or
// cancelled milestone still reopens exactly as before (15-03 Task 1).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getMilestone,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
  reopenMilestoneCascade,
  updateMilestoneStatus,
} from "../gsd-db.ts";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import { handleReopenMilestone } from "../tools/reopen-milestone.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function row(sql: string): Record<string, unknown> {
  return db().prepare(sql).get() ?? {};
}

function rows(sql: string): Array<Record<string, unknown>> {
  return db().prepare(sql).all();
}

function count(sql: string): number {
  return Number(row(sql)["count"] ?? 0);
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "ship-reopen-guard-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
  event?: () => {
    eventType: string;
    entityType: string;
    entityId: string;
    payload: Record<string, string>;
  },
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType, idempotencyKey },
  }, (context) => {
    write(context);
    const emitted = event?.() ?? {
      eventType: operationType,
      entityType: "milestone",
      entityId: "M001",
      payload: { idempotencyKey },
    };
    return {
      events: [{ ...emitted, destinations: ["test"] }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function recordVerdict(
  eventType: string,
  operationType: string,
  idempotencyKey: string,
  overallVerdict: string,
): void {
  executeAtFence(operationType, idempotencyKey, () => {}, () => ({
    eventType,
    entityType: "milestone",
    entityId: "M001",
    payload: { overallVerdict },
  }));
}

function recordPassingCertify(idempotencyKey = "fixture/reopen-guard/certify"): void {
  recordVerdict("milestone.certify.recorded", "milestone.certify", idempotencyKey, "pass");
}

function recordPassingAudit(idempotencyKey = "fixture/reopen-guard/audit"): void {
  recordVerdict("milestone.audit.recorded", "milestone.audit", idempotencyKey, "pass");
}

/**
 * Single-slice, already-completed fixture — mirrors 15-01/15-02's
 * `milestone-ship-domain-operation.test.ts` / `milestone-ship-gate-refusals
 * .test.ts` `makeBase()` exactly, including the slice/task lifecycle
 * adoption `reopenMilestoneHierarchy`'s `requireTerminalState` needs on every
 * descendant (not just the milestone).
 */
function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-reopen-guard-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Ship reopen guard", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice one", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertRequirement({
    id: "REQ-01",
    class: "must",
    status: "active",
    description: "Ship works end to end.",
    why: "Proves the gate.",
    source: "test",
    primary_owner: "S01",
    supporting_slices: "S01",
    validation: "test",
    notes: "",
    full_content: "REQ-01",
    superseded_by: null,
  });

  executeAtFence("test.ship.fixture", "fixture/reopen-guard/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
  });

  executeAtFence("milestone.complete", "fixture/reopen-guard/complete", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });

  return basePath;
}

function shipInput(idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId: "M001" };
}

/** Ships M001 through the real three-way gate, exactly as a real operator
 * would — never hand-writes the shipped status directly (Task 1 action). */
function shipTheMilestone(idempotencyKey = "reopen-guard/ship"): void {
  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput(idempotencyKey));
}

/** Two-slice ordinary-completion fixture matching the slices-reset=2 /
 * tasks-reset=2 counts the pre-existing `milestone-reopen-domain-operation
 * .test.ts` reopen contract asserts (Test 5's narrowness proof). */
function makeTwoSliceCompletedBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-reopen-guard-two-slice-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Two-slice ordinary reopen", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice one", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", title: "Slice two", status: "skipped" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", status: "skipped" });

  executeAtFence("test.ship.fixture", "fixture/reopen-guard/two-slice-ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T02", lifecycleStatus: "cancelled",
    });
  });

  executeAtFence("milestone.complete", "fixture/reopen-guard/two-slice-complete", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });

  return basePath;
}

/** A single-slice, cancelled/skipped terminal milestone — the OTHER terminal
 * bucket `requireTerminalState` accepts, to prove Test 5's guard narrowness
 * from the opposite direction (Test 6). Milestone lifecycle is adopted
 * directly at "cancelled" (state_version 0, no prior "ready" row needed —
 * the milestone-completion INSERT trigger only restricts `lifecycle_status =
 * 'completed'`). */
function makeCancelledMilestoneBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-reopen-guard-cancelled-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Cancelled milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice one", status: "skipped" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "skipped" });

  executeAtFence("test.ship.fixture", "fixture/reopen-guard/cancelled-adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "cancelled",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01", lifecycleStatus: "cancelled",
    });
    db().prepare(`
      UPDATE milestones SET status = 'skipped', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });

  return basePath;
}

function snapshotM001(): Record<string, unknown> {
  return {
    milestone: row(`SELECT * FROM milestones WHERE id = 'M001'`),
    slices: rows(`SELECT * FROM slices WHERE milestone_id = 'M001' ORDER BY id`),
    tasks: rows(`SELECT * FROM tasks WHERE milestone_id = 'M001' ORDER BY slice_id, id`),
    lifecycles: rows(`
      SELECT * FROM workflow_item_lifecycles WHERE milestone_id = 'M001'
      ORDER BY item_kind, slice_id, task_id
    `),
  };
}

function operationTablesSnapshot(): Record<string, number> {
  return {
    operations: count(`SELECT COUNT(*) AS count FROM workflow_operations`),
    events: count(`SELECT COUNT(*) AS count FROM workflow_domain_events`),
    outbox: count(`SELECT COUNT(*) AS count FROM workflow_outbox`),
    projections: count(`SELECT COUNT(*) AS count FROM workflow_projection_work`),
  };
}

function reopenedEventCount(): number {
  return count(`
    SELECT COUNT(*) AS count FROM workflow_domain_events
    WHERE event_type = 'milestone.reopened' AND entity_type = 'milestone' AND entity_id = 'M001'
  `);
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a shipped milestone refuses reopen, naming the milestone id and the status found, with zero milestone.reopened events", () => {
  makeBase();
  shipTheMilestone();
  assert.equal(getMilestone("M001")!.status, "shipped");

  assert.throws(
    () => reopenMilestone({
      invocation: invocation("reopen-guard/basic-reopen"),
      milestoneId: "M001",
      reason: "Attempting to reopen a shipped milestone.",
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /M001/);
      assert.match(error.message, /shipped/i);
      return true;
    },
  );
  assert.equal(reopenedEventCount(), 0);
  assert.equal(getMilestone("M001")!.status, "shipped");
});

test("a shipped milestone refuses reopen with keepCompleted: true, proving the guard sits ahead of the keep-completed branch", () => {
  makeBase();
  shipTheMilestone();

  assert.throws(
    () => reopenMilestone({
      invocation: invocation("reopen-guard/keep-completed"),
      milestoneId: "M001",
      reason: "Attempting to reopen a shipped milestone without resetting descendants.",
      keepCompleted: true,
    }),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /M001/);
      assert.match(error.message, /shipped/i);
      return true;
    },
  );
  assert.equal(reopenedEventCount(), 0);
  assert.equal(getMilestone("M001")!.status, "shipped");
});

test("both shipped-reopen refusals leave every slice, task, and lifecycle row byte-identical to their pre-attempt values", () => {
  makeBase();
  shipTheMilestone();
  const before = snapshotM001();

  assert.throws(() => reopenMilestone({
    invocation: invocation("reopen-guard/no-mutation-default"),
    milestoneId: "M001",
    reason: "First refused attempt.",
  }));
  assert.throws(() => reopenMilestone({
    invocation: invocation("reopen-guard/no-mutation-keep-completed"),
    milestoneId: "M001",
    reason: "Second refused attempt.",
    keepCompleted: true,
  }));

  assert.deepEqual(snapshotM001(), before, "a refused ship-reopen must leave exact zero residue");
});

test("the legacy unadopted reopen cascade refuses an archived milestone naming the shipped outcome, and handleReopenMilestone reports it with no side door", async () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-reopen-guard-legacy-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  // Genuinely unadopted: no workflow_item_lifecycles row at all, so the
  // canonical path is never reached — this reaches reopenMilestoneCascade.
  insertMilestone({ id: "M001", title: "Unadopted archived import", status: "archived" });

  const outcome = reopenMilestoneCascade("M001", false);
  assert.deepEqual(outcome, { ok: false, reason: "milestone-shipped", status: "archived" });

  const handled = await handleReopenMilestone({ milestoneId: "M001" }, basePath);
  assert.ok("error" in handled, "the legacy cascade must not silently succeed on an archived milestone");
  assert.match((handled as { error: string }).error, /M001/);
  assert.match((handled as { error: string }).error, /archived/i);

  const milestone = getMilestone("M001");
  assert.ok(milestone);
  assert.equal(milestone!.status, "archived");
});

test("an ordinary completed milestone still reopens successfully, with the same slices-reset and tasks-reset counts the pre-existing reopen contract expects", () => {
  makeTwoSliceCompletedBase();

  const result = reopenMilestone({
    invocation: invocation("reopen-guard/ordinary-complete"),
    milestoneId: "M001",
    reason: "Ordinary reopen must still work — the guard is narrow, not a blanket ban.",
  });

  assert.equal(result.status, "committed");
  assert.equal(result.slicesReset, 2);
  assert.equal(result.tasksReset, 2);
  assert.equal(getMilestone("M001")!.status, "active");
});

test("a skipped/cancelled terminal milestone still reopens as before", () => {
  makeCancelledMilestoneBase();

  const result = reopenMilestone({
    invocation: invocation("reopen-guard/cancelled"),
    milestoneId: "M001",
    reason: "A cancelled milestone must remain reopenable.",
  });

  assert.equal(result.status, "committed");
  assert.equal(getMilestone("M001")!.status, "active");
});

test("the refusal aborts the whole Domain Operation — no operation row, no event, and no projection work is committed for the attempt", () => {
  makeBase();
  shipTheMilestone();
  const before = operationTablesSnapshot();
  const idempotencyKey = "reopen-guard/atomicity";

  assert.throws(() => reopenMilestone({
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    reason: "This whole operation must abort, not partially commit.",
  }));

  assert.equal(
    count(`SELECT COUNT(*) AS count FROM workflow_operations WHERE idempotency_key = '${idempotencyKey}'`),
    0,
  );
  assert.deepEqual(
    operationTablesSnapshot(),
    before,
    "a refused ship-reopen must add zero operations, events, outbox rows, or projection work",
  );
});

test("the shipped/archived guard in reopenMilestoneHierarchy sits textually between loadMilestone and requireTerminalState, not merely behaviorally ahead of it", () => {
  // D-02 / RESEARCH Pitfall 2: requireTerminalState normalizes through the
  // canonical bucket, which after 15-01 can no longer distinguish "shipped"
  // from "completed". The guard is only load-bearing if it is positioned
  // textually before requireTerminalState runs on the milestone row (both
  // for the vanilla path AND the keepCompleted branch) — a guard that is
  // merely "usually" reached first (e.g. inside a conditional that can be
  // skipped) would silently stop mattering. This asserts the real source
  // text ordering rather than trusting the 15-01/15-03 SUMMARY prose.
  const source = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), "..", "db", "writers", "milestone-lifecycle.ts"),
    "utf8",
  );

  const reopenHierarchyStart = source.indexOf("function reopenMilestoneHierarchy");
  assert.notEqual(reopenHierarchyStart, -1, "reopenMilestoneHierarchy must exist in milestone-lifecycle.ts");

  // Scope the search window to the reopenMilestoneHierarchy function body
  // (up to the next top-level function declaration) so a shipped-status
  // guard elsewhere in the file (e.g. in shipMilestoneHierarchy) cannot be
  // mistaken for this one.
  const nextFunctionStart = source.indexOf("\nfunction ", reopenHierarchyStart + 1);
  const body = source.slice(reopenHierarchyStart, nextFunctionStart === -1 ? source.length : nextFunctionStart);

  const loadMilestoneIndex = body.indexOf("loadMilestone(context, milestoneId)");
  const shippedGuardIndex = body.indexOf("isShippedStatus(milestone.legacyStatus)");
  const requireTerminalStateIndex = body.indexOf("requireTerminalState(milestone,");

  assert.notEqual(loadMilestoneIndex, -1, "reopenMilestoneHierarchy must load the milestone row");
  assert.notEqual(shippedGuardIndex, -1, "reopenMilestoneHierarchy must guard on isShippedStatus");
  assert.notEqual(requireTerminalStateIndex, -1, "reopenMilestoneHierarchy must still call requireTerminalState");

  assert.ok(
    loadMilestoneIndex < shippedGuardIndex,
    "the shipped/archived guard must read the milestone before checking its raw legacy status",
  );
  assert.ok(
    shippedGuardIndex < requireTerminalStateIndex,
    "the shipped/archived guard must run BEFORE requireTerminalState, which can no longer tell shipped apart from completed once the canonical bucket collapses them",
  );
});

test("SEC-01: the generic status writer refuses a closed->different-closed write on a shipped milestone (e.g. shipped -> complete), leaving the shipped status untouched", () => {
  makeBase();
  shipTheMilestone();
  assert.equal(getMilestone("M001")!.status, "shipped");

  assert.throws(
    () => updateMilestoneStatus("M001", "complete"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /M001/);
      assert.match(error.message, /shipped/i);
      return true;
    },
  );

  // Status must be byte-identical to before the refused write — no silent
  // shipped -> complete erosion via the generic closed->closed path.
  assert.equal(getMilestone("M001")!.status, "shipped");
});
