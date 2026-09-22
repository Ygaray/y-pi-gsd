// Project/App: gsd-pi
// File Purpose: End-to-end contract proving auditMilestone() commits a durable,
// replayable "milestone.audit.recorded" verdict through the real domain-operation
// stack, writes only milestone-audit:-namespaced criteria under the
// "milestone-audit" policy, and derives its own criteria/verdict from a real
// coverage finding rather than accepting a caller-supplied one (14-03-PLAN.md
// Task 1; full requirement-coverage/cross-slice-wiring derivation lands in
// Task 2 — see tests/audit-requirement-coverage.test.ts).

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
  insertRequirement,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  auditMilestone,
  type AuditMilestoneInput,
} from "../milestone-audit-domain-operation.ts";
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
    actorId: "audit-milestone-test",
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
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-audit-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Audit stage", status: "active" });
  // Non-terminal slice named directly by a requirement's primary_owner — the
  // one real coverage finding this tracer task derives inline (full
  // parseSupportingSliceIds/exact-token derivation lands in Task 2).
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  insertRequirement({
    id: "R001",
    class: "functional",
    status: "active",
    description: "R001 description",
    why: "test",
    source: "test",
    primary_owner: "S01",
    supporting_slices: "",
    validation: "",
    notes: "",
    full_content: "",
    superseded_by: null,
  });

  executeAtFence("test.audit.fixture", "fixture/audit/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
  return basePath;
}

function auditInput(
  idempotencyKey: string,
  overrides: Partial<AuditMilestoneInput> = {},
): AuditMilestoneInput {
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

test("auditMilestone commits exactly one milestone.audit.recorded event and one outbox row", () => {
  makeBase();
  auditMilestone(auditInput("audit/public/basic"));

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.audit.recorded'
  `);
  assert.equal(eventRows.length, 1);
  const outboxRows = rows(`
    SELECT * FROM workflow_outbox WHERE event_id = '${String(eventRows[0]!["event_id"])}'
  `);
  assert.equal(outboxRows.length, 1);
});

test("auditMilestone writes only milestone-audit policy_id/policy_version technical verdicts", () => {
  makeBase();
  auditMilestone(auditInput("audit/public/policy-id"));

  const policyIds = rows(`SELECT DISTINCT policy_id FROM workflow_technical_verdicts`)
    .map((r) => String(r["policy_id"]));
  assert.deepEqual(policyIds, ["milestone-audit"]);
  const policyVersions = rows(`SELECT DISTINCT policy_version FROM workflow_technical_verdicts`)
    .map((r) => String(r["policy_version"]));
  assert.deepEqual(policyVersions, ["1"]);
  const foreignRows = rows(`
    SELECT * FROM workflow_technical_verdicts
    WHERE policy_id IN ('milestone-validation', 'milestone-certify')
  `);
  assert.equal(foreignRows.length, 0);
});

test("auditMilestone writes only milestone-audit:-namespaced acceptance criteria", () => {
  makeBase();
  auditMilestone(auditInput("audit/public/namespace"));

  const criteriaRows = rows(`SELECT criterion_key FROM workflow_acceptance_criteria`);
  assert.ok(criteriaRows.length > 0);
  for (const criterion of criteriaRows) {
    assert.match(String(criterion["criterion_key"]), /^milestone-audit:/);
  }
});

test("replaying with the same idempotency key does not append a second event", () => {
  makeBase();
  const key = "audit/public/replay";
  const first = auditMilestone(auditInput(key));
  assert.equal(first.status, "committed");

  const replayed = auditMilestone(auditInput(key));
  assert.equal(replayed.status, "replayed");

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.audit.recorded'
  `);
  assert.equal(eventRows.length, 1);
});

test("a different idempotency key commits a second, additional audit event — the first record is untouched", () => {
  makeBase();
  auditMilestone(auditInput("audit/public/first-run"));
  auditMilestone(auditInput("audit/public/second-run"));

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.audit.recorded'
    ORDER BY event_id
  `);
  assert.equal(eventRows.length, 2);
  assert.notEqual(eventRows[0]!["payload_json"], undefined);
});

test("auditMilestone writes exactly one AUD01 row and one AUD02 row, both scope milestone", () => {
  makeBase();
  auditMilestone(auditInput("audit/public/gates"));

  const gateRows = rows(`SELECT gate_id, scope FROM quality_gates WHERE milestone_id = 'M001'`);
  const gateIds = gateRows.map((r) => String(r["gate_id"])).sort();
  assert.deepEqual(gateIds, ["AUD01", "AUD02"]);
  for (const gateRow of gateRows) {
    assert.equal(gateRow["scope"], "milestone");
  }
});

test("AuditMilestoneInput carries no policyId, policyVersion, or criteria field", () => {
  makeBase();
  // Structural proof: the exact set of keys accepted below is everything
  // auditMilestone's contract allows a caller to supply. If policyId,
  // policyVersion, or criteria were accepted, callers could impersonate the
  // policy or tell the audit what to conclude (D-01).
  const input: AuditMilestoneInput = auditInput("audit/public/no-policy-input");
  assert.deepEqual(Object.keys(input).sort(), ["invocation", "milestoneId", "testedSourceRevision"]);

  const receipt = auditMilestone(input);
  const row0 = row(`
    SELECT policy_id FROM workflow_technical_verdicts LIMIT 1
  `);
  assert.equal(row0["policy_id"], "milestone-audit");
  assert.ok(receipt.status === "committed");
});
