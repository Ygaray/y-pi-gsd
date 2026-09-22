// Project/App: gsd-pi
// File Purpose: Proves certify's per-gap self-fix cap is DB-derived (COUNT(*)
// over workflow_domain_events), survives a database restart, keeps two gaps on
// the same slice budget-independent, and that cap-exhausted/non-fixable gaps
// batch-escalate into the Phase 13 Gate-2 ledger without dropping any gap
// (14-02-PLAN.md Task 1, D-02, T-14-08/T-14-09/T-14-11).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

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
import { escalateCertifyGapsToGate2 } from "../milestone-certify-domain-operation.ts";
import {
  CERTIFY_SELF_FIX_MAX_ATTEMPTS,
  countCertifySelfFixAttemptsForGap,
  recordCertifySelfFixAttempt,
  type CertifyGap,
} from "../milestone-certify-self-fix.ts";
import { clearPathCache } from "../paths.ts";

const tempDirs = new Set<string>();
let dbPath = "";

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
    actorId: "certify-self-fix-test",
  };
}

function makeBase(): { basePath: string; projectId: string } {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-certify-self-fix-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd", "milestones", "M001"), { recursive: true });
  writeFileSync(join(basePath, ".gsd", "milestones", "M001", "M001-CONTEXT.md"), "# M001\n");

  dbPath = join(basePath, ".gsd", "gsd.db");
  assert.equal(openDatabase(dbPath), true);
  insertMilestone({ id: "M001", title: "Self-fix cap", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "complete" });

  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType: "test.adopt",
    idempotencyKey: "fixture/certify-self-fix/adopt-lifecycle",
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: {},
  }, (context) => {
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
        projectionKey: "test/adopt-lifecycle",
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });

  const projectId = readDomainOperationFence().projectId;
  return { basePath, projectId };
}

function makeGap(overrides: Partial<CertifyGap> = {}): CertifyGap {
  return {
    gapId: "gate-pending:S01:CERT01",
    gapClass: "gate-pending",
    milestoneId: "M001",
    sliceId: "S01",
    gateId: "CERT01",
    ownerTurn: "certify-milestone",
    fixable: true,
    description: "CERT01 gate is pending for slice S01",
    evidence: "quality_gates row status=pending",
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

test("recordCertifySelfFixAttempt with 0 prior attempts commits cycle 1 and reopens the gate", () => {
  const { projectId } = makeBase();
  const gap = makeGap();

  const result = recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-1"),
    projectId,
    milestoneId: "M001",
    gap,
  });

  assert.equal(result.disposition, "self-fix-attempted");
  assert.equal(result.priorAttempts, 0);
  assert.equal(result.cycle, 1);

  const eventRows = rows(`
    SELECT payload_json FROM workflow_domain_events
    WHERE event_type = 'milestone.certify.self-fix-attempted'
  `);
  assert.equal(eventRows.length, 1);
  const payload = JSON.parse(String(eventRows[0]!["payload_json"])) as Record<string, unknown>;
  assert.equal(payload["cycle"], 1);
  assert.equal(payload["gapId"], gap.gapId);

  const gateRow = row(`
    SELECT status, verdict FROM quality_gates
    WHERE milestone_id = 'M001' AND slice_id = 'S01' AND gate_id = 'CERT01' AND task_id = ''
  `);
  assert.equal(gateRow["status"], "pending");
  assert.equal(gateRow["verdict"], "");
});

test("a third attempt after 2 prior commits cycle 3 and the event count for that gap is 3", () => {
  const { projectId } = makeBase();
  const gap = makeGap();

  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-1"), projectId, milestoneId: "M001", gap,
  });
  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-2"), projectId, milestoneId: "M001", gap,
  });
  const third = recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-3"), projectId, milestoneId: "M001", gap,
  });

  assert.equal(third.disposition, "self-fix-attempted");
  assert.equal(third.cycle, 3);
  assert.equal(
    countCertifySelfFixAttemptsForGap(projectId, "M001", gap.sliceId, gap.gapId),
    3,
  );
});

test("a fourth attempt after 3 prior does not commit and returns escalated", () => {
  const { projectId } = makeBase();
  const gap = makeGap();

  for (let i = 1; i <= 3; i += 1) {
    recordCertifySelfFixAttempt({
      invocation: invocation(`certify/self-fix/gapA/cycle-${i}`), projectId, milestoneId: "M001", gap,
    });
  }
  const fourth = recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-4"), projectId, milestoneId: "M001", gap,
  });

  assert.equal(fourth.disposition, "escalated");
  assert.equal(fourth.priorAttempts, 3);
  assert.equal(
    countCertifySelfFixAttemptsForGap(projectId, "M001", gap.sliceId, gap.gapId),
    3,
  );
});

test("two different gapIds on the same slice keep independent counts", () => {
  const { projectId } = makeBase();
  const gapA = makeGap({ gapId: "gate-pending:S01:CERT01" });
  const gapB = makeGap({ gapId: "gate-flagged:S01:CERT01", gapClass: "gate-flagged" });

  for (let i = 1; i <= 3; i += 1) {
    recordCertifySelfFixAttempt({
      invocation: invocation(`certify/self-fix/gapA/cycle-${i}`), projectId, milestoneId: "M001", gap: gapA,
    });
  }
  assert.equal(
    countCertifySelfFixAttemptsForGap(projectId, "M001", gapB.sliceId, gapB.gapId),
    0,
  );

  const first = recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapB/cycle-1"), projectId, milestoneId: "M001", gap: gapB,
  });
  assert.equal(first.disposition, "self-fix-attempted");
  assert.equal(first.cycle, 1);
});

test("countCertifySelfFixAttemptsForGap survives a database close/reopen", () => {
  const { projectId } = makeBase();
  const gap = makeGap();

  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-1"), projectId, milestoneId: "M001", gap,
  });
  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-2"), projectId, milestoneId: "M001", gap,
  });

  closeDatabase();
  assert.equal(openDatabase(dbPath), true);

  assert.equal(
    countCertifySelfFixAttemptsForGap(projectId, "M001", gap.sliceId, gap.gapId),
    2,
  );
});

test("escalateCertifyGapsToGate2 batches two escalating gaps into one human_uat_pending row", () => {
  makeBase();
  const gapA = makeGap({ gapId: "gate-pending:S01:CERT01", fixable: false, gapClass: "gate1-record-missing" });
  const gapB = makeGap({ gapId: "integration-gap:S01:CERT02", gapClass: "integration-gap", fixable: false, gateId: "CERT02" });

  const result = escalateCertifyGapsToGate2({
    invocation: invocation("certify/escalate/S01/first"),
    milestoneId: "M001",
    sliceId: "S01",
    gaps: [gapA, gapB],
  });

  assert.equal(result.disposition, "escalated");

  const pendingRows = rows(`SELECT partial_criteria_json FROM human_uat_pending WHERE slice_id = 'S01'`);
  assert.equal(pendingRows.length, 1);
  const criteria = JSON.parse(String(pendingRows[0]!["partial_criteria_json"])) as unknown[];
  assert.equal(criteria.length, 2);

  const eventRows = rows(`
    SELECT * FROM workflow_domain_events WHERE event_type = 'milestone.gate2-human-uat-required'
  `);
  assert.equal(eventRows.length, 1);
});

test("escalateCertifyGapsToGate2 called again while pending returns already-escalated and writes nothing new", () => {
  makeBase();
  const gapA = makeGap({ gapId: "gate-pending:S01:CERT01", fixable: false, gapClass: "gate1-record-missing" });

  const first = escalateCertifyGapsToGate2({
    invocation: invocation("certify/escalate/S01/first"),
    milestoneId: "M001",
    sliceId: "S01",
    gaps: [gapA],
  });
  assert.equal(first.disposition, "escalated");

  const second = escalateCertifyGapsToGate2({
    invocation: invocation("certify/escalate/S01/second"),
    milestoneId: "M001",
    sliceId: "S01",
    gaps: [gapA],
  });
  assert.equal(second.disposition, "already-escalated");

  const pendingRows = rows(`SELECT * FROM human_uat_pending WHERE slice_id = 'S01'`);
  assert.equal(pendingRows.length, 1);
});

test("CERTIFY_SELF_FIX_MAX_ATTEMPTS is exactly 3 and a gap at exactly 2 attempts is still fixable", () => {
  assert.equal(CERTIFY_SELF_FIX_MAX_ATTEMPTS, 3);

  const { projectId } = makeBase();
  const gap = makeGap();
  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-1"), projectId, milestoneId: "M001", gap,
  });
  recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-2"), projectId, milestoneId: "M001", gap,
  });
  assert.equal(
    countCertifySelfFixAttemptsForGap(projectId, "M001", gap.sliceId, gap.gapId),
    2,
  );
  const third = recordCertifySelfFixAttempt({
    invocation: invocation("certify/self-fix/gapA/cycle-3"), projectId, milestoneId: "M001", gap,
  });
  assert.equal(third.disposition, "self-fix-attempted");
});
