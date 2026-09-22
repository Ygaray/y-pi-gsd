// Project/App: gsd-pi
// File Purpose: Contract for resolveGate2HumanUatPending — the sign-off/drain
// half of the Gate-2 write seam (LEDGER-01/03) and the close-guard clearance
// it feeds.

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
import {
  registerGate2HumanUatPending,
  resolveGate2HumanUatPending,
} from "../milestone-gate2-human-uat-domain-operation.ts";
import { clearPathCache } from "../paths.ts";
import { captureVerificationSourceSnapshot } from "../verification-source-integrity.ts";

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

afterEach(() => {
  _setDomainOperationFaultForTest(null);
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
