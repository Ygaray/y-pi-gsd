// Project/App: gsd-pi
// File Purpose: End-to-end contract proving certifyMilestone() commits a durable,
// replayable "milestone.certify.recorded" verdict through the real domain-operation
// stack, writes only milestone-certify:-namespaced criteria, and refuses an
// out-of-namespace criterionKey (14-01-PLAN.md Task 1).

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
  type CertifyMilestoneCriterionInput,
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

  executeAtFence("test.certify.fixture", "fixture/certify/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
  return basePath;
}

function certifyCriterion(
  overrides: Partial<CertifyMilestoneCriterionInput> = {},
): CertifyMilestoneCriterionInput {
  return {
    criterionKey: "milestone-certify:gate-audit",
    evidenceClass: "artifact",
    description: "Every slice's durable gate evidence is current and passing.",
    verdict: "pass",
    rationale: "All slice quality_gates rows read pass with no open rework.",
    evidence: [{
      evidenceClass: "artifact",
      commandOrTool: "certify-milestone-audit",
      workingDirectory: "/tmp",
      startedAt: "2026-09-22T10:00:00.000Z",
      endedAt: "2026-09-22T10:00:01.000Z",
      observation: "passed",
      durableOutputRef: "artifact://certify/gate-audit",
      environment: { runner: "certify" },
    }],
    ...overrides,
  };
}

function certifyInput(
  idempotencyKey: string,
  overrides: Partial<CertifyMilestoneInput> = {},
): CertifyMilestoneInput {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
    verdict: "pass",
    rationale: "Certify stage found no unresolved gaps.",
    outcome: "succeeded",
    failureClass: "none",
    summary: "Certify recorded a passing verdict.",
    output: { stage: "certify" },
    criteria: [certifyCriterion()],
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

test("a criterionKey outside the certify namespace throws and writes nothing", () => {
  makeBase();
  const beforeEvents = Number(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.certify.recorded'
  `).count);
  const beforeCriteria = Number(row(`SELECT COUNT(*) AS count FROM workflow_acceptance_criteria`).count);

  assert.throws(() => {
    certifyMilestone(certifyInput("certify/public/wrong-namespace", {
      criteria: [certifyCriterion({ criterionKey: "milestone-validation:contract" })],
    }));
  }, /milestone-certify:/);

  assert.equal(Number(row(`
    SELECT COUNT(*) AS count FROM workflow_domain_events WHERE event_type = 'milestone.certify.recorded'
  `).count), beforeEvents);
  assert.equal(
    Number(row(`SELECT COUNT(*) AS count FROM workflow_acceptance_criteria`).count),
    beforeCriteria,
  );
});

test("certifyMilestone with an empty criteria array throws", () => {
  makeBase();
  assert.throws(() => {
    certifyMilestone(certifyInput("certify/public/empty-criteria", { criteria: [] }));
  }, /objective criteria/i);
});
