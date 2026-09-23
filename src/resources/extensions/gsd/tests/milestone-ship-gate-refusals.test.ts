// Project/App: gsd-pi
// File Purpose: ROADMAP SC2 regression net — every way of failing the
// milestone.ship gate is reached in isolation, names itself in the refusal
// message via describeMilestoneShipBlockers, and leaves zero partial state
// behind (15-02 Task 1's staleness/read-failure blockers, Task 2's exhaustive
// refusal-surface coverage).

import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  describeMilestoneShipBlockers,
  readMilestoneShipAuthorization,
  type MilestoneShipBlocker,
} from "../db/milestone-ship-readiness.ts";
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
} from "../gsd-db.ts";
import {
  registerGate2HumanUatPending,
  resolveGate2HumanUatPending,
} from "../milestone-gate2-human-uat-domain-operation.ts";
import { reopenMilestone } from "../milestone-lifecycle-domain-operation.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import { clearPathCache } from "../paths.ts";

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

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "ship-gate-refusals-test",
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
      events: [{
        ...emitted,
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

function recordPassingCertify(idempotencyKey = "fixture/refusal/certify"): void {
  recordVerdict("milestone.certify.recorded", "milestone.certify", idempotencyKey, "pass");
}

function recordPassingAudit(idempotencyKey = "fixture/refusal/audit"): void {
  recordVerdict("milestone.audit.recorded", "milestone.audit", idempotencyKey, "pass");
}

/**
 * `workflow_domain_events` is immutable (UPDATE/DELETE both raise ABORT via
 * `trg_workflow_domain_events_immutable_update`/`_delete`), so a malformed
 * event can only be produced at INSERT time. This inserts a fresh
 * `workflow_operations` + `workflow_domain_events` row pair directly (bypassing
 * `executeDomainOperation`'s normal JSON.stringify'd payload) with a
 * deliberately invalid `payload_json`, then advances `project_authority` so
 * later real Domain Operations in the same test still fence correctly. This
 * models a genuinely malformed historical event without ever violating the
 * immutability trigger (INSERT is unrestricted; only UPDATE/DELETE are
 * blocked) — isolating exactly one evidence read's failure.
 */
function insertMalformedEvent(eventType: string, operationType: string): void {
  const authority = row(`
    SELECT project_id, revision, authority_epoch FROM project_authority WHERE singleton = 1
  `);
  const projectIdValue = String(authority["project_id"]);
  const revision = Number(authority["revision"]);
  const authorityEpoch = Number(authority["authority_epoch"]);
  const newRevision = revision + 1;
  const operationId = randomUUID();
  const eventId = randomUUID();
  const now = new Date().toISOString();

  db().prepare(`
    INSERT INTO workflow_operations (
      operation_id, project_id, operation_type, idempotency_key,
      expected_revision, resulting_revision, expected_authority_epoch, resulting_authority_epoch,
      actor_type, source_transport, request_hash, created_at
    ) VALUES (
      :operation_id, :project_id, :operation_type, :idempotency_key,
      :expected_revision, :resulting_revision, :expected_authority_epoch, :resulting_authority_epoch,
      'test', 'test', 'test-hash', :created_at
    )
  `).run({
    ":operation_id": operationId,
    ":project_id": projectIdValue,
    ":operation_type": operationType,
    ":idempotency_key": `fixture/refusal/malformed/${eventType}/${operationId}`,
    ":expected_revision": revision,
    ":resulting_revision": newRevision,
    ":expected_authority_epoch": authorityEpoch,
    ":resulting_authority_epoch": authorityEpoch,
    ":created_at": now,
  });

  db().prepare(`
    INSERT INTO workflow_domain_events (
      event_id, operation_id, event_index, project_id, project_revision, authority_epoch,
      event_type, entity_type, entity_id, payload_json, created_at
    ) VALUES (
      :event_id, :operation_id, 0, :project_id, :project_revision, :authority_epoch,
      :event_type, 'milestone', 'M001', 'not-json{', :created_at
    )
  `).run({
    ":event_id": eventId,
    ":operation_id": operationId,
    ":project_id": projectIdValue,
    ":project_revision": newRevision,
    ":authority_epoch": authorityEpoch,
    ":event_type": eventType,
    ":created_at": now,
  });

  db().prepare(`UPDATE project_authority SET revision = :revision WHERE singleton = 1`).run({
    ":revision": newRevision,
  });
}

function makeActiveBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-refusals-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Ship stage", status: "active" });
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

  // Adopt the milestone lifecycle to "ready" first, under its own fence — the
  // causal-provenance trigger (trg_workflow_lifecycle_causal_provenance)
  // requires last_project_revision to strictly advance across an UPDATE, so
  // the ready->completed transition below must be a SEPARATE operation.
  // Slice/task lifecycles are adopted directly at "completed" (from === to,
  // state_version 0) — reopenMilestoneHierarchy's requireTerminalState needs
  // a canonical lifecycle row on every slice/task, not just the milestone.
  executeAtFence("test.ship.fixture", "fixture/refusal/ready", (context) => {
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

  return basePath;
}

function completeMilestoneFixture(idempotencyKey = "fixture/refusal/complete"): void {
  // Bring the milestone to canonical+legacy "completed" the same way a real
  // completeMilestone would: trg_workflow_lifecycle_milestone_completion_insert
  // and trg_workflow_lifecycle_transition both require operation_type
  // 'milestone.complete' for any milestone row reaching 'completed'.
  executeAtFence("milestone.complete", idempotencyKey, (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": "2026-09-22T00:00:00.000Z" });
  });
}

function makeBase(): string {
  const basePath = makeActiveBase();
  completeMilestoneFixture();
  return basePath;
}

/** Reopens the milestone (real Domain Operation, so a genuine
 * milestone.reopened event lands at a higher project_revision) then restores
 * it to completed, mirroring a real reopen -> re-complete cycle. */
function reopenThenRecomplete(): void {
  reopenMilestone({
    invocation: invocation("fixture/refusal/reopen"),
    milestoneId: "M001",
    reason: "re-verify before ship",
    keepCompleted: true,
  });
  completeMilestoneFixture("fixture/refusal/re-complete");
}

function registerOutstandingGate2(idempotencyKey = "fixture/refusal/gate2-register"): string {
  const receipt = registerGate2HumanUatPending({
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "manual verification needed",
    partialCriteria: [],
  });
  return receipt.entryId;
}

function resolveGate2(entryId: string, idempotencyKey = "fixture/refusal/gate2-resolve"): void {
  resolveGate2HumanUatPending({
    invocation: invocation(idempotencyKey),
    entryId,
    disposition: "signed-off",
  });
}

function shipInput(idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId: "M001" };
}

function projectId(): string {
  return String(row(`SELECT project_id FROM project_authority WHERE singleton = 1`)["project_id"]);
}

function shippedEventCount(): number {
  return rows(`SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.shipped'`).length;
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("ship refuses a legacy-active milestone, naming not-completed and the found status, with zero shipped events and status unchanged", () => {
  makeActiveBase();

  assert.throws(() => shipMilestone(shipInput("refusal/not-completed")), /not-completed/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "active");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses when certify has never been recorded, naming certify-missing", () => {
  makeBase();
  recordPassingAudit();

  assert.throws(() => shipMilestone(shipInput("refusal/certify-missing")), /certify-missing/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses a non-passing certify verdict, naming certify-not-passing with the observed verdict", () => {
  makeBase();
  recordVerdict("milestone.certify.recorded", "milestone.certify", "fixture/refusal/certify-fail", "fail");
  recordPassingAudit();

  assert.throws(() => shipMilestone(shipInput("refusal/certify-not-passing")), /certify-not-passing \(fail\)/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses when audit has never been recorded (certify passing), naming audit-missing", () => {
  makeBase();
  recordPassingCertify();

  assert.throws(() => shipMilestone(shipInput("refusal/audit-missing")), /audit-missing/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses a non-passing audit verdict, naming audit-not-passing with the observed verdict", () => {
  makeBase();
  recordPassingCertify();
  recordVerdict("milestone.audit.recorded", "milestone.audit", "fixture/refusal/audit-fail", "fail");

  assert.throws(() => shipMilestone(shipInput("refusal/audit-not-passing")), /audit-not-passing \(fail\)/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses with an outstanding Gate-2 entry naming gate2-outstanding with the milestone/slice pair, and ships successfully once resolved", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  const entryId = registerOutstandingGate2();

  assert.throws(() => shipMilestone(shipInput("refusal/gate2-outstanding")), /gate2-outstanding \(M001\/S01\)/);

  const beforeResolve = getMilestone("M001");
  assert.equal(beforeResolve!.status, "complete");
  assert.equal(shippedEventCount(), 0);

  resolveGate2(entryId);

  shipMilestone(shipInput("refusal/gate2-outstanding-then-ship"));
  const shipped = getMilestone("M001");
  assert.equal(shipped!.status, "shipped");
  assert.equal(shippedEventCount(), 1);
});

test("ship refuses stale certify/audit evidence recorded before a later reopen, naming certify-stale and audit-stale with both revisions", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  reopenThenRecomplete();

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  const staleBlockers = authorization.blockers.filter(
    (blocker): blocker is Extract<MilestoneShipBlocker, { kind: "certify-stale" | "audit-stale" }> =>
      blocker.kind === "certify-stale" || blocker.kind === "audit-stale",
  );
  assert.equal(staleBlockers.length, 2);
  for (const blocker of staleBlockers) {
    assert.ok(blocker.reopenRevision > blocker.verdictRevision);
  }

  assert.throws(() => shipMilestone(shipInput("refusal/stale")), /certify-stale.*audit-stale|audit-stale.*certify-stale/);

  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("certify/audit evidence recorded with no reopen event at all is not stale", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, true);
});

test("certify/audit evidence recorded at or after the latest reopen revision is not stale", () => {
  makeBase();
  reopenThenRecomplete();
  recordPassingCertify("fixture/refusal/certify-post-reopen");
  recordPassingAudit("fixture/refusal/audit-post-reopen");

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, true);

  shipMilestone(shipInput("refusal/not-stale-ships"));
  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "shipped");
});

test("ship refuses when the certify verdict read throws, naming certify-read-failed, while still reporting the audit and gate2 blockers it can determine", () => {
  makeBase();
  insertMalformedEvent("milestone.certify.recorded", "milestone.certify");
  recordPassingAudit();

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  assert.equal(authorization.blockers.length, 1);
  const blocker = authorization.blockers[0]!;
  assert.equal(blocker.kind, "certify-read-failed");
  if (blocker.kind === "certify-read-failed") {
    assert.ok(blocker.message.length > 0);
  }

  assert.throws(() => shipMilestone(shipInput("refusal/certify-read-failed")), /certify-read-failed/);
  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses when the audit verdict read throws, naming audit-read-failed", () => {
  makeBase();
  recordPassingCertify();
  insertMalformedEvent("milestone.audit.recorded", "milestone.audit");

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  assert.equal(authorization.blockers.length, 1);
  assert.equal(authorization.blockers[0]!.kind, "audit-read-failed");

  assert.throws(() => shipMilestone(shipInput("refusal/audit-read-failed")), /audit-read-failed/);
  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("ship refuses when the Gate-2 outstanding read throws, naming gate2-read-failed", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  insertMalformedEvent("milestone.gate2-human-uat-required", "milestone.gate2-human-uat.require");

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  assert.equal(authorization.blockers.length, 1);
  assert.equal(authorization.blockers[0]!.kind, "gate2-read-failed");

  assert.throws(() => shipMilestone(shipInput("refusal/gate2-read-failed")), /gate2-read-failed/);
  const milestone = getMilestone("M001");
  assert.equal(milestone!.status, "complete");
  assert.equal(shippedEventCount(), 0);
});

test("describeMilestoneShipBlockers renders a single-line reason naming every blocker's kind and distinguishing data", () => {
  const blockers: MilestoneShipBlocker[] = [
    { kind: "not-completed", legacyStatus: "active" },
    { kind: "already-shipped", legacyStatus: "shipped" },
    { kind: "certify-missing" },
    { kind: "certify-not-passing", overallVerdict: "fail" },
    { kind: "certify-stale", verdictRevision: 3, reopenRevision: 7 },
    { kind: "certify-read-failed", message: "boom-certify" },
    { kind: "audit-missing" },
    { kind: "audit-not-passing", overallVerdict: "inconclusive" },
    { kind: "audit-stale", verdictRevision: 4, reopenRevision: 8 },
    { kind: "audit-read-failed", message: "boom-audit" },
    { kind: "gate2-outstanding", entries: [{ entryId: "E1", milestoneId: "M001", sliceId: "S01", eventId: "EV1" }] },
    { kind: "gate2-read-failed", message: "boom-gate2" },
  ];

  const reason = describeMilestoneShipBlockers(blockers);

  assert.match(reason, /not-completed \(active\)/);
  assert.match(reason, /already-shipped \(shipped\)/);
  assert.match(reason, /certify-missing/);
  assert.match(reason, /certify-not-passing \(fail\)/);
  assert.match(reason, /certify-stale \(verdict rev 3, reopen rev 7\)/);
  assert.match(reason, /certify-read-failed \(boom-certify\)/);
  assert.match(reason, /audit-missing/);
  assert.match(reason, /audit-not-passing \(inconclusive\)/);
  assert.match(reason, /audit-stale \(verdict rev 4, reopen rev 8\)/);
  assert.match(reason, /audit-read-failed \(boom-audit\)/);
  assert.match(reason, /gate2-outstanding \(M001\/S01\)/);
  assert.match(reason, /gate2-read-failed \(boom-gate2\)/);
});

test("shipMilestone's thrown error contains the describe reason and the milestone id", () => {
  makeBase();
  recordPassingAudit();

  try {
    shipMilestone(shipInput("refusal/error-contains-reason-and-id"));
    assert.fail("expected shipMilestone to throw");
  } catch (error) {
    const message = (error as Error).message;
    assert.match(message, /M001/);
    assert.match(message, /certify-missing/);
  }
});

test("ship refuses an already-shipped milestone, naming already-shipped, and the shipped-event count stays at 1", () => {
  makeBase();
  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput("refusal/already-shipped/first"));

  assert.throws(
    () => shipMilestone(shipInput("refusal/already-shipped/second")),
    /already-shipped \(shipped\)/,
  );

  assert.equal(shippedEventCount(), 1);
});

test("a fixture failing two gates at once (no certify AND an outstanding Gate-2 entry) reports both blockers in one array and both kinds in one message", () => {
  makeBase();
  recordPassingAudit();
  registerOutstandingGate2();

  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "M001" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  assert.equal(authorization.blockers.length, 2);
  const kinds = new Set(authorization.blockers.map((blocker) => blocker.kind));
  assert.ok(kinds.has("certify-missing"));
  assert.ok(kinds.has("gate2-outstanding"));

  assert.throws(
    () => shipMilestone(shipInput("refusal/two-gates-at-once")),
    (error) => {
      const message = (error as Error).message;
      return message.includes("certify-missing") && message.includes("gate2-outstanding");
    },
  );
});

test("readMilestoneShipAuthorization reports milestone-missing for a nonexistent milestone", () => {
  makeBase();
  const authorization = readMilestoneShipAuthorization({ projectId: projectId(), milestoneId: "NOPE" });
  assert.equal(authorization.authorized, false);
  if (authorization.authorized) throw new Error("unreachable");
  assert.equal(authorization.blockers.length, 1);
  assert.equal(authorization.blockers[0]!.kind, "milestone-missing");
});

test("every refusal in this file leaves milestones.status unchanged and appends zero milestone.shipped events", () => {
  makeActiveBase();
  const beforeNotCompleted = getMilestone("M001")!.status;
  assert.throws(() => shipMilestone(shipInput("refusal/invariant/not-completed")));
  assert.equal(getMilestone("M001")!.status, beforeNotCompleted);
  assert.equal(shippedEventCount(), 0);

  completeMilestoneFixture();
  recordVerdict("milestone.certify.recorded", "milestone.certify", "fixture/refusal/invariant/certify-fail", "fail");
  recordPassingAudit("fixture/refusal/invariant/audit");
  const beforeCertifyFail = getMilestone("M001")!.status;
  assert.throws(() => shipMilestone(shipInput("refusal/invariant/certify-not-passing")));
  assert.equal(getMilestone("M001")!.status, beforeCertifyFail);
  assert.equal(shippedEventCount(), 0);
});
