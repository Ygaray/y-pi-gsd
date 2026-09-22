// Project/App: gsd-pi
// File Purpose: End-to-end contract for the Gate-2 human-UAT pending ledger's
// atomic write seam and the milestone close guard it feeds (LEDGER-01/02/03).

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { SCHEMA_VERSION } from "../db/engine.ts";
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
  testedSourceRevision = "";
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("schema: human_uat_pending table exists at schema v52 on a fresh install", () => {
  makeBase();
  assert.equal(
    Number(row(`
      SELECT COUNT(*) AS count FROM sqlite_master WHERE type = 'table' AND name = 'human_uat_pending'
    `).count),
    1,
  );
  assert.equal(Number(row("PRAGMA user_version").user_version), 52);
  assert.equal(SCHEMA_VERSION, 52);
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
