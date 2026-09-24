// Project/App: gsd-pi
// File Purpose: End-to-end contract for the Gate-2 human-UAT pending ledger's
// atomic write seam and the milestone close guard it feeds (LEDGER-01/02/03).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _setDomainOperationFaultForTest,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import { registerGate2HumanUatPendingRow } from "../db/writers/milestone-gate2-human-uat.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { registerGate2HumanUatPending } from "../milestone-gate2-human-uat-domain-operation.ts";
import {
  completeMilestone,
  MilestoneLifecycleValidationError,
} from "../milestone-lifecycle-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import { handleValidateMilestone, type ValidateMilestoneParams } from "../tools/validate-milestone.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

const tempDirs = new Set<string>();
let testedSourceRevision = "";

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

/**
 * Reads all three legs of a Gate-2 write together so a partial commit cannot
 * hide in the one count a caller forgot to check (D-03 requirement 1).
 */
function countGate2State(): { rows: number; events: number; outbox: number } {
  return {
    rows: Number(row(`SELECT COUNT(*) AS count FROM human_uat_pending`).count),
    events: Number(row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.gate2-human-uat-required'
    `).count),
    outbox: Number(row(`
      SELECT COUNT(*) AS count FROM workflow_outbox
      WHERE event_id IN (
        SELECT event_id FROM workflow_domain_events
        WHERE event_type = 'milestone.gate2-human-uat-required'
      )
    `).count),
  };
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "gate2-human-uat-test",
  };
}

function executeAtFence(
  operationType: string,
  idempotencyKey: string,
  write: (context: Readonly<DomainOperationContext>) => void,
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
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { idempotencyKey },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `test/${idempotencyKey}`.toLowerCase(),
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-gate2-human-uat-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'gate2';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) assert.fail(source.error);
  testedSourceRevision = source.snapshot.aggregateRevision;

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Gate-2 ledger", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

  executeAtFence("test.gate2.ready", "fixture/gate2/ready", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S01", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S01", taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  return basePath;
}

const validation: ValidateMilestoneParams = {
  milestoneId: "M001",
  verdict: "pass",
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "| S01 | delivered |",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: "| Class | Evidence | Verdict |\n| --- | --- | --- |\n| Contract | focused test | PASS |",
  verdictRationale: "All current database evidence passes.",
};

async function prepareValidatedFixture(): Promise<string> {
  const basePath = makeBase();
  const result = await handleValidateMilestone(validation, basePath, {
    invocation: invocation("fixture/gate2/validate"),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in result), `validation fixture failed: ${"error" in result ? result.error : ""}`);
  return basePath;
}

function completionInput(idempotencyKey: string) {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    sourceRevision: testedSourceRevision,
    closeout: {
      title: "Gate-2 ledger completion",
      oneLiner: "Completed with the Gate-2 close guard in place.",
      narrative: "Completed through one durable Domain Operation.",
      successCriteriaResults: "All success criteria passed.",
      definitionOfDoneResults: "All completion conditions passed.",
      requirementOutcomes: "All required outcomes are covered.",
      keyDecisions: ["The database is authoritative"],
      keyFiles: ["src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts"],
      lessonsLearned: ["Descendants are verified, not rewritten"],
      followUps: "None.",
      deviations: "None.",
    },
    audit: {
      actorName: "gate2-completion-test",
      triggerReason: "Current validation and terminal descendants",
    },
  };
}

afterEach(() => {
  _setDomainOperationFaultForTest(null);
  testedSourceRevision = "";
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("schema: human_uat_pending table exists at schema v52+ on a fresh install", () => {
  makeBase();
  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'human_uat_pending'
    `).count),
    1,
  );
  assert.equal(Number(row("PRAGMA user_version").user_version), SCHEMA_VERSION);
  assert.equal(SCHEMA_VERSION, 55);
});

test("atomic commit: one registration call commits the row, event, and outbox row together", () => {
  makeBase();
  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/register-atomic"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: could not verify offline sync",
    partialCriteria: [{ criterion: "Offline sync", evidence: "Manual check needed" }],
  });
  assert.equal(receipt.created, true);

  const pendingRows = rows(`SELECT * FROM human_uat_pending WHERE entry_id = '${receipt.entryId}'`);
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0]!["status"], "pending");
  assert.equal(pendingRows[0]!["created_operation_id"], receipt.operationId);

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.gate2-human-uat-required'
  `);
  assert.equal(eventRows.length, 1);
  const eventRow = eventRows[0]!;
  assert.equal(eventRow["operation_id"], receipt.operationId);

  const outboxRows = rows(`
    SELECT * FROM workflow_outbox WHERE event_id = '${String(eventRow["event_id"])}'
  `);
  assert.equal(outboxRows.length, 1);
  assert.equal(outboxRows[0]!["delivered_at"], null);
});

test("one row per slice: a second registration for the same slice does not create a second pending row", () => {
  makeBase();
  const first = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/register-first"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: first pass",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  const second = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/register-second"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: second pass",
    partialCriteria: [{ criterion: "B", evidence: "b" }],
  });
  assert.equal(second.created, false);
  assert.equal(second.entryId, first.entryId);

  const pendingRows = rows(`
    SELECT * FROM human_uat_pending WHERE milestone_id = 'M001' AND slice_id = 'S01' AND status = 'pending'
  `);
  assert.equal(pendingRows.length, 1);
  assert.equal(pendingRows[0]!["reason"], "PARTIAL: first pass");
});

test("atomicity: a fault at after-mutation leaves zero rows, events, and outbox rows", () => {
  makeBase();
  _setDomainOperationFaultForTest("after-mutation", "milestone.gate2-human-uat.require");
  assert.throws(
    () => registerGate2HumanUatPending({
      invocation: invocation("fixture/gate2/fault-after-mutation"),
      milestoneId: "M001",
      sliceId: "S01",
      reason: "PARTIAL: fault at after-mutation",
      partialCriteria: [{ criterion: "A", evidence: "a" }],
    }),
    /after-mutation/,
  );
  _setDomainOperationFaultForTest(null);
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
});

test("atomicity: a fault at after-events leaves zero rows, events, and outbox rows", () => {
  makeBase();
  _setDomainOperationFaultForTest("after-events", "milestone.gate2-human-uat.require");
  assert.throws(
    () => registerGate2HumanUatPending({
      invocation: invocation("fixture/gate2/fault-after-events"),
      milestoneId: "M001",
      sliceId: "S01",
      reason: "PARTIAL: fault at after-events",
      partialCriteria: [{ criterion: "A", evidence: "a" }],
    }),
    /after-events/,
  );
  _setDomainOperationFaultForTest(null);
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
});

test("atomicity: a fault at before-cas leaves zero rows, events, and outbox rows", () => {
  makeBase();
  _setDomainOperationFaultForTest("before-cas", "milestone.gate2-human-uat.require");
  assert.throws(
    () => registerGate2HumanUatPending({
      invocation: invocation("fixture/gate2/fault-before-cas"),
      milestoneId: "M001",
      sliceId: "S01",
      reason: "PARTIAL: fault at before-cas",
      partialCriteria: [{ criterion: "A", evidence: "a" }],
    }),
    /before-cas/,
  );
  _setDomainOperationFaultForTest(null);
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
});

test("clean run after a faulted run: a subsequent registration leaves no poison state", () => {
  makeBase();
  _setDomainOperationFaultForTest("after-mutation", "milestone.gate2-human-uat.require");
  assert.throws(() => registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/fault-then-clean-faulted"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: faulted attempt",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  }));
  _setDomainOperationFaultForTest(null);

  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/fault-then-clean-retry"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: clean attempt",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.equal(receipt.created, true);
  assert.deepEqual(countGate2State(), { rows: 1, events: 1, outbox: 1 });
});

test("idempotent replay: an identical idempotency key replays without duplicating anything", () => {
  makeBase();
  const key = "fixture/gate2/replay-key";
  const first = registerGate2HumanUatPending({
    invocation: invocation(key),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: replay test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.equal(first.created, true);

  const second = registerGate2HumanUatPending({
    invocation: invocation(key),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: replay test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.equal(second.status, "replayed");
  assert.equal(second.entryId, first.entryId);
  assert.deepEqual(countGate2State(), { rows: 1, events: 1, outbox: 1 });
});

test("second key, same slice: a distinct idempotency key does not open a second pending entry", () => {
  makeBase();
  const first = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/second-key-first"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: first pass",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.equal(first.created, true);

  const second = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/second-key-second"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: second pass",
    partialCriteria: [{ criterion: "B", evidence: "b" }],
  });
  assert.equal(second.created, false);
  assert.equal(second.entryId, first.entryId);

  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM human_uat_pending WHERE status = 'pending'
    `).count),
    1,
  );
});

test("close guard blocks: completeMilestone refuses while a Gate-2 entry is outstanding", async () => {
  await prepareValidatedFixture();
  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/register-guard"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: guard test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.ok(receipt.entryId);

  await assert.rejects(
    async () => completeMilestone(completionInput("fixture/gate2/complete-blocked")),
    (error: unknown) => {
      assert.ok(error instanceof MilestoneLifecycleValidationError);
      assert.match((error as Error).message, /M001/);
      assert.match((error as Error).message, /S01/);
      return true;
    },
  );
});

test("additive no-op: completeMilestone succeeds exactly as before with no Gate-2 entries", async () => {
  await prepareValidatedFixture();
  const result = await completeMilestone(completionInput("fixture/gate2/complete-clean"));
  assert.equal(result.canonicalStatus, "completed");
});

test("input validation: blank milestoneId, sliceId, or reason is rejected before any write", () => {
  makeBase();
  assert.throws(() => registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/blank-milestone"),
    milestoneId: "   ",
    sliceId: "S01",
    reason: "PARTIAL: blank milestone",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  }));
  assert.throws(() => registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/blank-slice"),
    milestoneId: "M001",
    sliceId: "",
    reason: "PARTIAL: blank slice",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  }));
  assert.throws(() => registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/blank-reason"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "   ",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  }));
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
});

test("context guard: registerGate2HumanUatPendingRow rejects a wrong Domain Operation context", () => {
  makeBase();
  assert.throws(
    () => executeAtFence("test.fixture.wrong-op", "fixture/gate2/wrong-op", (context) => {
      registerGate2HumanUatPendingRow(context, {
        milestoneId: "M001",
        sliceId: "S01",
        taskId: null,
        artifactPath: null,
        reason: "PARTIAL: wrong operation context",
        partialCriteria: [{ criterion: "A", evidence: "a" }],
      });
    }),
    /requires its Domain Operation/,
  );
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
});

test("Pitfall-1 probe: flipping human_uat_pending.status alone does not clear the close guard", async () => {
  // Deliberate false-clearance probe (Pitfall 1, RESEARCH.md): this bypasses
  // the real resolve path (13-04) and must NOT unblock the close guard. If
  // this test ever goes green for the wrong reason, the guard has been
  // silently rewired to read human_uat_pending instead of the event head.
  await prepareValidatedFixture();
  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/pitfall-1-flip"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: pitfall probe",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.ok(receipt.entryId);

  db().prepare(`
    UPDATE human_uat_pending SET status = 'signed-off', updated_at = :now
    WHERE entry_id = :entry_id
  `).run({ ":now": new Date().toISOString(), ":entry_id": receipt.entryId });

  await assert.rejects(
    async () => completeMilestone(completionInput("fixture/gate2/pitfall-1-complete")),
    (error: unknown) => {
      assert.ok(error instanceof MilestoneLifecycleValidationError);
      assert.match((error as Error).message, /S01/);
      return true;
    },
  );
});

test("Pitfall-1 probe: draining the outbox row alone (no resolution event) does not clear the close guard", async () => {
  // Same deliberate false-clearance probe as the status-flip test above, but
  // for the OTHER independent trip-wire: draining the outbox row with no
  // resolution event must still leave the close guard blocked. If this test
  // ever goes green for the wrong reason, the guard is treating the outbox
  // drain as sufficient settlement on its own.
  await prepareValidatedFixture();
  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/pitfall-1-drain"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: pitfall probe",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.ok(receipt.entryId);

  db().prepare(`
    UPDATE human_uat_pending SET status = 'signed-off', updated_at = :now
    WHERE entry_id = :entry_id
  `).run({ ":now": new Date().toISOString(), ":entry_id": receipt.entryId });
  const eventRow = row(`
    SELECT event_id FROM workflow_domain_events
    WHERE event_type = 'milestone.gate2-human-uat-required'
      AND json_extract(payload_json, '$.entryId') = '${receipt.entryId}'
  `);
  db().prepare(`
    UPDATE workflow_outbox SET delivered_at = :now WHERE event_id = :event_id
  `).run({ ":now": new Date().toISOString(), ":event_id": String(eventRow["event_id"]) });

  await assert.rejects(
    async () => completeMilestone(completionInput("fixture/gate2/pitfall-1-drain-complete")),
    (error: unknown) => {
      assert.ok(error instanceof MilestoneLifecycleValidationError);
      assert.match((error as Error).message, /S01/);
      return true;
    },
  );
});

test("outbox rows cannot be deleted: DELETE FROM workflow_outbox is rejected by the schema trigger", () => {
  makeBase();
  const receipt = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2/delete-outbox"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: delete probe",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  const eventRow = row(`
    SELECT event_id FROM workflow_domain_events
    WHERE event_type = 'milestone.gate2-human-uat-required'
      AND json_extract(payload_json, '$.entryId') = '${receipt.entryId}'
  `);
  assert.throws(
    () => db().prepare(`
      DELETE FROM workflow_outbox WHERE event_id = :event_id
    `).run({ ":event_id": String(eventRow["event_id"]) }),
    /outbox rows are durable history/,
  );
});
