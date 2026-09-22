// Project/App: gsd-pi
// File Purpose: Contract for resolveGate2HumanUatPending — the sign-off/drain
// half of the Gate-2 write seam (LEDGER-01/03) and the close-guard clearance
// it feeds.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  _setDomainOperationFaultForTest,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
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
import { renderHumanUatPendingLedger } from "../human-uat-pending-projection.ts";
import {
  registerGate2HumanUatPending,
  resolveGate2HumanUatPending,
} from "../milestone-gate2-human-uat-domain-operation.ts";
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
 * hide in the one count a caller forgot to check (D-03 requirement 1),
 * mirroring the sibling register test file's own helper.
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
    actorId: "gate2-human-uat-drain-test",
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
  const basePath = mkdtempSync(join(tmpdir(), "gsd-gate2-drain-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");
  writeFileSync(join(basePath, "source.ts"), "export const source = 'gate2-drain';\n");
  execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
  execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
  execFileSync("git", ["add", "source.ts"], { cwd: basePath });
  execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  const source = captureVerificationSourceSnapshot([{ id: "project", cwd: basePath }]);
  if (!source.ok) assert.fail(source.error);
  testedSourceRevision = source.snapshot.aggregateRevision;

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Gate-2 drain", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", status: "complete" });

  executeAtFence("test.gate2.ready", "fixture/gate2-drain/ready", (context) => {
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

/** Registers a second slice (S02) on the same milestone, for partial-clearance tests. */
function addSecondSlice(): void {
  insertSlice({ id: "S02", milestoneId: "M001", status: "complete" });
  insertTask({ id: "T02", sliceId: "S02", milestoneId: "M001", status: "complete" });
  executeAtFence("test.gate2.ready-second-slice", "fixture/gate2-drain/ready-second-slice", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice", milestoneId: "M001", sliceId: "S02", lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task", milestoneId: "M001", sliceId: "S02", taskId: "T02",
      lifecycleStatus: "completed",
    });
  });
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
    invocation: invocation("fixture/gate2-drain/validate"),
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
      title: "Gate-2 drain completion",
      oneLiner: "Completed with the Gate-2 sign-off/drain path exercised.",
      narrative: "Completed through one durable Domain Operation.",
      successCriteriaResults: "All success criteria passed.",
      definitionOfDoneResults: "All completion conditions passed.",
      requirementOutcomes: "All required outcomes are covered.",
      keyDecisions: ["The database is authoritative"],
      keyFiles: ["src/resources/extensions/gsd/milestone-gate2-human-uat-domain-operation.ts"],
      lessonsLearned: ["The event head, not the ledger table, is the guard's authority"],
      followUps: "None.",
      deviations: "None.",
    },
    audit: {
      actorName: "gate2-drain-completion-test",
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

test("resolve: signed-off flips the row, links the resolution event, and drains the outbox row", () => {
  makeBase();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/register-for-resolve"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: needs human sign-off",
    partialCriteria: [{ criterion: "Offline sync", evidence: "Manual check needed" }],
  });

  const resolution = resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/resolve-signed-off"),
    entryId: registration.entryId,
    disposition: "signed-off",
  });
  assert.equal(resolution.entryId, registration.entryId);
  assert.equal(resolution.disposition, "signed-off");

  const pendingRow = rows(`SELECT * FROM human_uat_pending WHERE entry_id = '${registration.entryId}'`)[0]!;
  assert.equal(pendingRow["status"], "signed-off");
  assert.ok(pendingRow["signed_off_at"]);

  const resolvedEvents = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.gate2-human-uat-resolved'
  `);
  assert.equal(resolvedEvents.length, 1);
  const resolvedPayload = JSON.parse(String(resolvedEvents[0]!["payload_json"])) as Record<string, unknown>;
  assert.equal(resolvedPayload["entryId"], registration.entryId);

  const requiredEvent = row(`
    SELECT event_id FROM workflow_domain_events
    WHERE event_type = 'milestone.gate2-human-uat-required'
      AND json_extract(payload_json, '$.entryId') = '${registration.entryId}'
  `);
  const outboxRowsForEntry = rows(`
    SELECT * FROM workflow_outbox WHERE event_id = '${String(requiredEvent["event_id"])}'
  `);
  assert.equal(outboxRowsForEntry.length, 1);
  assert.ok(outboxRowsForEntry[0]!["delivered_at"]);
});

test("resolve: signed-off-with-gap stores the disposition and the supplied note", () => {
  makeBase();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/register-for-gap"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: needs human sign-off",
    partialCriteria: [{ criterion: "Offline sync", evidence: "Manual check needed" }],
  });

  const resolution = resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/resolve-gap"),
    entryId: registration.entryId,
    disposition: "signed-off-with-gap",
    note: "Accepted: offline sync unverifiable in CI",
  });
  assert.equal(resolution.disposition, "signed-off-with-gap");
  assert.equal(resolution.note, "Accepted: offline sync unverifiable in CI");

  const pendingRow = rows(`SELECT * FROM human_uat_pending WHERE entry_id = '${registration.entryId}'`)[0]!;
  assert.equal(pendingRow["status"], "signed-off-with-gap");
  assert.equal(pendingRow["signoff_note"], "Accepted: offline sync unverifiable in CI");
});

test("resolve: an unknown entryId throws and writes nothing", () => {
  makeBase();
  assert.throws(() => resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/resolve-unknown"),
    entryId: "does-not-exist",
    disposition: "signed-off",
  }));
  assert.deepEqual(countGate2State(), { rows: 0, events: 0, outbox: 0 });
  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.gate2-human-uat-resolved'
    `).count),
    0,
  );
});

test("resolve: an already-resolved entry throws and leaves the existing row and events unchanged", () => {
  makeBase();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/register-for-double-resolve"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: needs human sign-off",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  const first = resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/resolve-first"),
    entryId: registration.entryId,
    disposition: "signed-off",
  });

  assert.throws(() => resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/resolve-second"),
    entryId: registration.entryId,
    disposition: "signed-off-with-gap",
    note: "should never apply",
  }));

  const pendingRow = rows(`SELECT * FROM human_uat_pending WHERE entry_id = '${registration.entryId}'`)[0]!;
  assert.equal(pendingRow["status"], "signed-off");
  assert.equal(pendingRow["signed_off_at"], first.resolvedAt);
  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.gate2-human-uat-resolved'
    `).count),
    1,
  );
});

test("resolve: a fault at after-events leaves the row pending and the outbox row undelivered", () => {
  makeBase();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/register-for-fault"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: needs human sign-off",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });

  _setDomainOperationFaultForTest("after-events", "milestone.gate2-human-uat.resolve");
  assert.throws(
    () => resolveGate2HumanUatPending({
      invocation: invocation("fixture/gate2-drain/resolve-fault"),
      entryId: registration.entryId,
      disposition: "signed-off",
    }),
    /after-events/,
  );
  _setDomainOperationFaultForTest(null);

  const pendingRow = rows(`SELECT * FROM human_uat_pending WHERE entry_id = '${registration.entryId}'`)[0]!;
  assert.equal(pendingRow["status"], "pending");
  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM workflow_domain_events
      WHERE event_type = 'milestone.gate2-human-uat-resolved'
    `).count),
    0,
  );
  const requiredEvent = row(`
    SELECT event_id FROM workflow_domain_events
    WHERE event_type = 'milestone.gate2-human-uat-required'
      AND json_extract(payload_json, '$.entryId') = '${registration.entryId}'
  `);
  const outboxRowsForEntry = rows(`
    SELECT * FROM workflow_outbox WHERE event_id = '${String(requiredEvent["event_id"])}'
  `);
  assert.equal(outboxRowsForEntry.length, 1);
  assert.equal(outboxRowsForEntry[0]!["delivered_at"], null);
});

test("clearance: completeMilestone succeeds after resolveGate2HumanUatPending signs off the only entry", async () => {
  await prepareValidatedFixture();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/clearance-register"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: clearance test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });

  await assert.rejects(
    async () => completeMilestone(completionInput("fixture/gate2-drain/clearance-blocked")),
  );

  resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/clearance-resolve"),
    entryId: registration.entryId,
    disposition: "signed-off",
  });

  const result = await completeMilestone(completionInput("fixture/gate2-drain/clearance-complete"));
  assert.equal(result.canonicalStatus, "completed");
});

test("clearance: signing off one of two outstanding entries still blocks, naming only the remaining slice", async () => {
  // Second slice must exist BEFORE validation is recorded — validating
  // against a milestone state, then adding a slice afterward, makes the
  // recorded validation stale ("not current"), which would throw for an
  // unrelated reason before the Gate-2 guard is ever reached.
  const basePath = makeBase();
  addSecondSlice();
  const validated = await handleValidateMilestone(validation, basePath, {
    invocation: invocation("fixture/gate2-drain/partial-validate"),
    skipBrowserEvidenceGate: true,
  });
  assert.ok(!("error" in validated), `validation fixture failed: ${"error" in validated ? validated.error : ""}`);

  const first = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/partial-register-first"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: first slice",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/partial-register-second"),
    milestoneId: "M001",
    sliceId: "S02",
    reason: "PARTIAL: second slice",
    partialCriteria: [{ criterion: "B", evidence: "b" }],
  });

  resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/partial-resolve-first"),
    entryId: first.entryId,
    disposition: "signed-off",
  });

  await assert.rejects(
    async () => completeMilestone(completionInput("fixture/gate2-drain/partial-still-blocked")),
    (error: unknown) => {
      assert.ok(error instanceof MilestoneLifecycleValidationError);
      assert.match((error as Error).message, /S02/);
      assert.doesNotMatch((error as Error).message, /S01/);
      return true;
    },
  );
});

test("clearance: signed-off-with-gap unblocks the close exactly as signed-off does", async () => {
  await prepareValidatedFixture();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/gap-register"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: gap clearance test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });

  resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/gap-resolve"),
    entryId: registration.entryId,
    disposition: "signed-off-with-gap",
    note: "Accepted gap",
  });

  const result = await completeMilestone(completionInput("fixture/gate2-drain/gap-complete"));
  assert.equal(result.canonicalStatus, "completed");
});

test("projection: sign-off moves the entry from Outstanding to Signed off in HUMAN-UAT-PENDING.md", async () => {
  const basePath = await prepareValidatedFixture();
  const registration = registerGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/projection-register"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: projection test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });

  resolveGate2HumanUatPending({
    invocation: invocation("fixture/gate2-drain/projection-resolve"),
    entryId: registration.entryId,
    disposition: "signed-off",
  });
  assert.equal(renderHumanUatPendingLedger(basePath), true);

  const content = readFileSync(join(basePath, ".gsd", "HUMAN-UAT-PENDING.md"), "utf-8");
  const outstandingSection = content.split("## Signed off")[0]!;
  const signedOffSection = content.split("## Signed off")[1] ?? "";
  assert.doesNotMatch(outstandingSection, new RegExp(registration.entryId));
  assert.match(signedOffSection, new RegExp(registration.entryId));
});
