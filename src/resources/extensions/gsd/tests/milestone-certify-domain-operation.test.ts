// Project/App: gsd-pi
// File Purpose: End-to-end contract proving certifyMilestone() commits a durable,
// replayable "milestone.certify.recorded" verdict through the real domain-operation
// stack, writes only milestone-certify:-namespaced criteria, and derives its own
// criteria/verdict rather than accepting a caller-supplied one (14-01-PLAN.md
// Task 1; contract updated by 14-02-PLAN.md Task 3, which made certify derive
// its own criteria — see tests/certify-milestone-end-to-end.test.ts for full
// gap-derivation/self-fix/escalation coverage).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  certifyMilestone,
  type CertifyMilestoneInput,
} from "../milestone-certify-domain-operation.ts";
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
    actorId: "certify-milestone-test",
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
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-certify-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Certify stage", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  // A satisfied, evaluated Gate-1 signal — without this, S01 is a terminal
  // slice with zero durable Gate-1 evidence, which auditMilestoneSliceGates
  // (Task 2) correctly reports as a gate1-record-missing gap rather than a
  // silent pass. These fixtures test certifyMilestone()'s domain-operation
  // contract, not gap derivation itself (see certify-gate-audit.test.ts and
  // certify-milestone-end-to-end.test.ts for that), so the fixture must be
  // genuinely gap-free to keep repeated calls deterministic under replay.
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
    VALUES ('M001', 'S01', 'CERT01', 'slice', '', 'complete', 'pass', '2026-09-22T00:00:00.000Z')
  `).run();

  executeAtFence("test.certify.fixture", "fixture/certify/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
  return basePath;
}

function certifyInput(
  idempotencyKey: string,
  overrides: Partial<CertifyMilestoneInput> = {},
): CertifyMilestoneInput {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
    ...overrides,
  };
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("certifyMilestone commits exactly one milestone.certify.recorded event and one outbox row", () => {
  makeBase();
  certifyMilestone(certifyInput("certify/public/basic"));

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.recorded'
  `);
  assert.equal(eventRows.length, 1);
  const outboxRows = rows(`
    SELECT * FROM workflow_outbox WHERE event_id = '${String(eventRows[0]!["event_id"])}'
  `);
  assert.equal(outboxRows.length, 1);
});

test("certifyMilestone writes only milestone-certify policy_id/policy_version technical verdicts", () => {
  makeBase();
  certifyMilestone(certifyInput("certify/public/policy-id"));

  const policyIds = rows(`SELECT DISTINCT policy_id FROM workflow_technical_verdicts`)
    .map((r) => String(r["policy_id"]));
  assert.deepEqual(policyIds, ["milestone-certify"]);
  const policyVersions = rows(`SELECT DISTINCT policy_version FROM workflow_technical_verdicts`)
    .map((r) => String(r["policy_version"]));
  assert.deepEqual(policyVersions, ["1"]);
  const validationPolicyRows = rows(`
    SELECT * FROM workflow_technical_verdicts WHERE policy_id = 'milestone-validation'
  `);
  assert.equal(validationPolicyRows.length, 0);
});

test("certifyMilestone writes only milestone-certify:-namespaced acceptance criteria", () => {
  makeBase();
  certifyMilestone(certifyInput("certify/public/namespace"));

  const criteriaRows = rows(`SELECT criterion_key FROM workflow_acceptance_criteria`);
  assert.ok(criteriaRows.length > 0);
  for (const criterion of criteriaRows) {
    assert.match(String(criterion["criterion_key"]), /^milestone-certify:/);
  }
});

test("replaying with the same idempotency key does not append a second event", () => {
  makeBase();
  const key = "certify/public/replay";
  const first = certifyMilestone(certifyInput(key));
  assert.equal(first.status, "committed");

  const replayed = certifyMilestone(certifyInput(key));
  assert.equal(replayed.status, "replayed");

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.recorded'
  `);
  assert.equal(eventRows.length, 1);
});

test("a different idempotency key commits a second, additional certify event", () => {
  makeBase();
  certifyMilestone(certifyInput("certify/public/first-run"));
  certifyMilestone(certifyInput("certify/public/second-run"));

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.recorded'
  `);
  assert.equal(eventRows.length, 2);
});

test("certifyMilestone always derives exactly the gate-audit and integration-check criteria — no caller-supplied criteria input exists", () => {
  makeBase();
  certifyMilestone(certifyInput("certify/public/derived-criteria"));

  const criteriaRows = rows(`
    SELECT criterion_key FROM workflow_acceptance_criteria ORDER BY criterion_key
  `).map((r) => String(r["criterion_key"]));
  assert.deepEqual(criteriaRows, [
    "milestone-certify:gate-audit",
    "milestone-certify:integration-check",
  ]);
});

test("certifyMilestone with a milestone that has zero slices records an inconclusive verdict, never pass", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-certify-empty-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M002"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M002", title: "Empty certify stage", status: "active" });
  executeAtFence("test.certify.fixture", "fixture/certify-empty/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M002", lifecycleStatus: "ready",
    });
  });

  const receipt = certifyMilestone(certifyInput("certify/public/empty-slices", { milestoneId: "M002" }));
  assert.equal(receipt.verdict, "inconclusive");

  const rationaleRow = row(`
    SELECT verdict.rationale AS rationale
    FROM workflow_technical_verdicts verdict
    JOIN workflow_acceptance_criteria criterion ON criterion.criterion_id = verdict.criterion_id
    WHERE criterion.criterion_key = 'milestone-certify:gate-audit'
  `);
  assert.match(String(rationaleRow["rationale"]), /no slices/i);
});
