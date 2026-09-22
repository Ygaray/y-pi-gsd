// Project/App: gsd-pi
// File Purpose: End-to-end proof that a single certifyMilestone() call audits
// every slice's gaps from durable state, self-fixes fixable gaps under the
// durable per-gap cap of 3, escalates the rest into the Gate-2 ledger in one
// batched call per slice, writes its own CERT01/CERT02 rows, and accounts for
// every gap it found (14-02-PLAN.md Task 3).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainOperationContext } from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import { getGateIdsForTurn } from "../gate-registry.ts";
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
    sourceTransport: "internal",
    actorType: "agent",
    actorId: "certify-e2e-test",
  };
}

function certifyInput(idempotencyKey: string): CertifyMilestoneInput {
  return {
    invocation: invocation(idempotencyKey),
    milestoneId: "M001",
    testedSourceRevision: "sha256:fixture-revision",
  };
}

function openFixture(): void {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-certify-e2e-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Certify e2e", status: "active" });

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: "fixture/certify-e2e/adopt",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context: Readonly<DomainOperationContext>) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "ready",
    });
    return {
      events: [{
        eventType: "test.adopted",
        entityType: "milestone",
        entityId: "M001",
        payload: {},
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: "test/certify-e2e/adopt",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("a milestone with one clean slice certifies pass and writes one CERT01 row per slice plus one CERT02 row", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, evaluated_at)
    VALUES ('M001', 'S01', 'CERT01', 'slice', '', 'complete', 'pass', '2026-09-22T00:00:00.000Z')
  `).run();

  const receipt = certifyMilestone(certifyInput("e2e/clean"));
  assert.equal(receipt.verdict, "pass");
  assert.equal(receipt.gaps.length, 0);

  assert.equal(rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT01'`).length, 1);
  assert.equal(rows(`SELECT * FROM quality_gates WHERE gate_id = 'CERT02'`).length, 1);
});

test("a gate-pending gap records a fail verdict, commits one self-fix attempt at cycle 1, and leaves the gate pending", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();

  const receipt = certifyMilestone(certifyInput("e2e/gate-pending"));
  assert.equal(receipt.verdict, "fail");
  assert.equal(receipt.selfFixAttempted.length, 1);
  assert.equal(receipt.selfFixAttempted[0]!.cycle, 1);

  assert.equal(rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.self-fix-attempted'
  `).length, 1);

  const gateRow = row(`
    SELECT status, verdict FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'Q8' AND task_id = ''
  `);
  assert.equal(gateRow["status"], "pending");
});

test("re-running certify three times against a gap that never closes commits exactly 3 attempt events and the 4th run escalates", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();

  certifyMilestone(certifyInput("e2e/never-closes/1"));
  certifyMilestone(certifyInput("e2e/never-closes/2"));
  const third = certifyMilestone(certifyInput("e2e/never-closes/3"));
  assert.equal(third.selfFixAttempted.length, 1);
  assert.equal(third.selfFixAttempted[0]!.cycle, 3);
  assert.equal(rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.self-fix-attempted'
  `).length, 3);

  const fourth = certifyMilestone(certifyInput("e2e/never-closes/4"));
  assert.equal(fourth.selfFixAttempted.length, 0);
  assert.equal(fourth.escalated.length, 1);
  assert.equal(rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.self-fix-attempted'
  `).length, 3);

  assert.equal(rows(`SELECT * FROM human_uat_pending WHERE slice_id = 'S01'`).length, 1);
});

test("a gate1-record-missing gap escalates on the first pass with zero attempt events", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  const receipt = certifyMilestone(certifyInput("e2e/record-missing"));
  assert.equal(receipt.selfFixAttempted.length, 0);
  assert.equal(receipt.escalated.length, 1);
  assert.equal(receipt.escalated[0]!.gap.gapClass, "gate1-record-missing");
  assert.equal(rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.certify.self-fix-attempted'
  `).length, 0);
});

test("a milestone with zero slices certifies inconclusive, never pass, with rationale naming no slices", () => {
  openFixture();

  const receipt = certifyMilestone(certifyInput("e2e/zero-slices"));
  assert.equal(receipt.verdict, "inconclusive");

  const rationaleRow = row(`
    SELECT verdict.rationale AS rationale
    FROM workflow_technical_verdicts verdict
    JOIN workflow_acceptance_criteria criterion ON criterion.criterion_id = verdict.criterion_id
    WHERE criterion.criterion_key = 'milestone-certify:gate-audit'
  `);
  assert.match(String(rationaleRow["rationale"]), /no slices/i);
});

test("every gap lands in exactly one disposition bucket and bucket sizes sum to the gap count", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'pending')
  `).run();
  insertSlice({ id: "S02", milestoneId: "M001", status: "complete" });

  const receipt = certifyMilestone(certifyInput("e2e/bucket-sum"));
  assert.equal(receipt.gaps.length, 2);
  assert.equal(
    receipt.selfFixAttempted.length + receipt.escalated.length + receipt.alreadyEscalated.length,
    receipt.gaps.length,
  );
  assert.equal(receipt.selfFixAttempted.length, 1);
  assert.equal(receipt.escalated.length, 1);
});

test("a persistent integration-gap escalates on the first pass and already-escalates on the second", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "in_progress" });
  db().prepare(`
    INSERT INTO slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
    VALUES ('M001', 'S01', 'S02')
  `).run();

  const first = certifyMilestone(certifyInput("e2e/persistent-integration/1"));
  assert.ok(first.escalated.some((outcome) => outcome.gap.gapClass === "integration-gap"));

  const second = certifyMilestone(certifyInput("e2e/persistent-integration/2"));
  const integrationOutcome = second.alreadyEscalated.find(
    (outcome) => outcome.gap.gapClass === "integration-gap",
  );
  assert.ok(integrationOutcome, "expected the persistent integration-gap to be already-escalated");

  const cert01Row = row(`
    SELECT findings FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'CERT01' AND task_id = ''
  `);
  assert.match(String(cert01Row["findings"]), /already-escalated/);
});

test("certify writes no quality_gates row outside its own certify-milestone gate ids; MV03 and Q8 rows stay byte-identical", () => {
  openFixture();
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    VALUES ('M001', 'S01', 'CERT01', 'slice', '', 'complete', 'pass', 'r', 'f', '2026-09-22T00:00:00.000Z')
  `).run();
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    VALUES ('M001', 'S01', 'MV03', 'milestone', '', 'complete', 'pass', 'mv03-rationale', 'mv03-findings', '2026-09-22T00:00:00.000Z')
  `).run();
  db().prepare(`
    INSERT INTO quality_gates (milestone_id, slice_id, gate_id, scope, task_id, status, verdict, rationale, findings, evaluated_at)
    VALUES ('M001', 'S01', 'Q8', 'slice', '', 'complete', 'pass', 'q8-rationale', 'q8-findings', '2026-09-22T00:00:00.000Z')
  `).run();

  const mv03Before = row(`SELECT * FROM quality_gates WHERE gate_id = 'MV03'`);
  const q8Before = row(`SELECT * FROM quality_gates WHERE gate_id = 'Q8'`);

  const certifyGateIds = new Set([...getGateIdsForTurn("certify-milestone")] as string[]);
  certifyMilestone(certifyInput("e2e/no-cross-write"));

  const allGateIds = rows(`SELECT DISTINCT gate_id FROM quality_gates`).map((r) => String(r["gate_id"]));
  for (const gateId of allGateIds) {
    if (gateId === "MV03" || gateId === "Q8") continue;
    assert.ok(certifyGateIds.has(gateId), `unexpected gate id written by certify: ${gateId}`);
  }

  assert.deepEqual(row(`SELECT * FROM quality_gates WHERE gate_id = 'MV03'`), mv03Before);
  assert.deepEqual(row(`SELECT * FROM quality_gates WHERE gate_id = 'Q8'`), q8Before);
});
