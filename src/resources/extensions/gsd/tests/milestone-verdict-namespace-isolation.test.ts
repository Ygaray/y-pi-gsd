// Project/App: gsd-pi
// File Purpose: Regression net for the Task-1 D-01 namespace surgery — proves
// certify and validate-milestone's evidence live in provably separate buckets
// and neither can demote, supersede, or block the other's required criteria
// (14-01-PLAN.md Task 3).

import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  MILESTONE_AUDIT_POLICY,
  MILESTONE_CERTIFY_POLICY,
  MILESTONE_VALIDATION_POLICY,
} from "../db/writers/milestone-validation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  getGateIdsForTurn,
  getGatesForTurn,
  getOwnerTurn,
} from "../gate-registry.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  insertMilestone,
  insertSlice,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { certifyMilestone } from "../milestone-certify-domain-operation.ts";
import {
  validateMilestone,
  type ValidateMilestoneCriterionInput,
} from "../milestone-validation-domain-operation.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function rows(sql: string, params: Record<string, unknown> = {}): Array<Record<string, unknown>> {
  return db().prepare(sql).all(params);
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "namespace-isolation-test",
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
  const basePath = mkdtempSync(join(tmpdir(), "gsd-verdict-namespace-isolation-"));
  tempDirs.add(basePath);
  assert.equal(openDatabase(join(basePath, "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Namespace isolation", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  executeAtFence("test.namespace.fixture", "fixture/namespace/adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
  });
  return basePath;
}

function evidenceFor(ref: string) {
  return [{
    evidenceClass: "artifact" as const,
    commandOrTool: "namespace-isolation-harness",
    workingDirectory: "/tmp",
    startedAt: "2026-09-22T10:00:00.000Z",
    endedAt: "2026-09-22T10:00:01.000Z",
    observation: "passed" as const,
    durableOutputRef: ref,
    environment: { runner: "test" },
  }];
}

function validationCriteria(): ValidateMilestoneCriterionInput[] {
  return [
    {
      criterionKey: "milestone-validation:contract",
      evidenceClass: "artifact",
      description: "Contract criterion.",
      verdict: "pass",
      rationale: "Contract passed.",
      evidence: evidenceFor("artifact://validate/contract"),
    },
    {
      criterionKey: "milestone-validation:integration",
      evidenceClass: "artifact",
      description: "Integration criterion.",
      verdict: "pass",
      rationale: "Integration passed.",
      evidence: evidenceFor("artifact://validate/integration"),
    },
  ];
}

function runValidate(idempotencyKey: string) {
  return validateMilestone({
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
    policyId: "milestone-validation",
    policyVersion: "1",
    verdict: "pass",
    rationale: "Validate stage found no gaps.",
    outcome: "succeeded",
    failureClass: "none",
    summary: "Validation recorded a passing verdict.",
    output: { stage: "validate" },
    criteria: validationCriteria(),
  });
}

function runCertify(idempotencyKey: string) {
  return certifyMilestone({
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  });
}

/** Current (no successor) rows whose criterion_key matches the given prefix. */
function currentCriteriaWithPrefix(prefix: string): Array<Record<string, unknown>> {
  return rows(`
    SELECT criterion_id, criterion_key, required
    FROM workflow_acceptance_criteria criterion
    WHERE criterion.criterion_key LIKE :prefix ESCAPE '\\'
      AND NOT EXISTS (
        SELECT 1 FROM workflow_acceptance_criteria successor
        WHERE successor.supersedes_criterion_id = criterion.criterion_id
      )
    ORDER BY criterion.criterion_key
  `, { ":prefix": `${prefix.replace(/[\\%_]/g, (ch) => `\\${ch}`)}:%` });
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("validate then certify: both milestone-validation:* criteria stay current and required after a certify run", () => {
  makeBase();
  runValidate("namespace/validate-then-certify/validate");
  runCertify("namespace/validate-then-certify/certify");

  const validationCurrent = currentCriteriaWithPrefix("milestone-validation");
  assert.equal(validationCurrent.length, 2);
  for (const criterion of validationCurrent) {
    assert.equal(Boolean(criterion["required"]), true);
  }
});

test("certify then validate: the milestone-certify:* criterion stays current and required after a validate run", () => {
  makeBase();
  runCertify("namespace/certify-then-validate/certify");
  runValidate("namespace/certify-then-validate/validate");

  const certifyCurrent = currentCriteriaWithPrefix("milestone-certify");
  assert.equal(certifyCurrent.length, 2);
  for (const criterion of certifyCurrent) {
    assert.equal(Boolean(criterion["required"]), true);
  }
});

test("after certify, a validate run supplying only its own criteria is not rejected for missing the certify criterion", () => {
  makeBase();
  runCertify("namespace/no-cross-coverage/certify");

  assert.doesNotThrow(() => {
    runValidate("namespace/no-cross-coverage/validate");
  });
});

test("MILESTONE_VALIDATION_POLICY, MILESTONE_CERTIFY_POLICY, and MILESTONE_AUDIT_POLICY are mutually distinct on every D-01 axis", () => {
  const policies = [MILESTONE_VALIDATION_POLICY, MILESTONE_CERTIFY_POLICY, MILESTONE_AUDIT_POLICY];
  const axes: Array<keyof typeof MILESTONE_VALIDATION_POLICY> = [
    "criterionNamespace",
    "operationType",
    "eventType",
    "projectionKind",
  ];
  for (const axis of axes) {
    const values = policies.map((policy) => policy[axis]);
    assert.equal(new Set(values).size, values.length, `duplicate value on axis "${axis}": ${values.join(", ")}`);
  }
});

test("the certify/audit registry additions do not widen or move validate-milestone's own gate set", () => {
  const validateGateIds = getGatesForTurn("validate-milestone").map((def) => def.id);
  assert.deepEqual(validateGateIds, ["MV01", "MV02", "MV03", "MV04"]);
  assert.equal(getOwnerTurn("CERT02"), "certify-milestone");
  assert.equal(getOwnerTurn("AUD01"), "audit-milestone");
});

test("pre-existing owner-turn gate sets (gate-evaluate, execute-task) are unchanged", () => {
  assert.deepEqual(
    [...getGateIdsForTurn("gate-evaluate")].sort(),
    ["Q3", "Q4"],
  );
  assert.deepEqual(
    [...getGateIdsForTurn("execute-task")].sort(),
    ["Q5", "Q6", "Q7"],
  );
});
