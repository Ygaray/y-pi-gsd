// Project/App: gsd-pi
// File Purpose: RELY-01 evidence-guidance contract for gsd_validate_milestone's canonical path.

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  executeDomainOperation,
  type DomainOperationContext,
} from "../db/domain-operation.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import { clearPathCache } from "../paths.ts";
import { clearParseCache } from "../files.ts";
import { handleValidateMilestone } from "../tools/validate-milestone.ts";

const tempDirs = new Set<string>();

function executeAtFence(
  operationType: string,
  write: (context: Readonly<DomainOperationContext>) => void,
): void {
  const fence = readDomainOperationFence();
  executeDomainOperation({
    operationType,
    idempotencyKey: `fixture/${operationType}/${fence.revision}`,
    expectedRevision: fence.revision,
    expectedAuthorityEpoch: fence.authorityEpoch,
    actorType: "test",
    sourceTransport: "test",
    payload: { operationType },
  }, (context) => {
    write(context);
    return {
      events: [{
        eventType: operationType,
        entityType: "milestone",
        entityId: "M001",
        payload: { operationType },
        destinations: ["test"],
      }],
      projections: [{
        projectionKey: `fixture/${operationType}/${context.resultingRevision}`,
        projectionKind: "test",
        rendererVersion: "1",
      }],
    };
  });
}

/**
 * Builds an adopted-lifecycle M001 with a planned Contract verification
 * class, reaching `recordCanonicalValidation` via the canonical
 * (adopted-milestone) path — the only path this defect affects. With
 * `opts.skipGit` set, the `.git` steps are omitted so the verification
 * source cannot be snapshotted, exercising the "unresolvable source"
 * precedence case (Test 3).
 */
function makeCanonicalFixture(opts: { skipGit?: boolean } = {}): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-evidence-guidance-"));
  tempDirs.add(basePath);
  const milestoneDir = join(basePath, ".gsd", "milestones", "M001");
  const sliceDir = join(milestoneDir, "slices", "S01");
  mkdirSync(sliceDir, { recursive: true });
  if (!opts.skipGit) {
    writeFileSync(join(basePath, ".gitignore"), ".gsd/\n");
    writeFileSync(join(basePath, "source.ts"), "export const source = 'evidence-guidance';\n");
    execFileSync("git", ["init"], { cwd: basePath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: basePath });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: basePath });
    execFileSync("git", ["add", ".gitignore", "source.ts"], { cwd: basePath });
    execFileSync("git", ["commit", "-m", "fixture"], { cwd: basePath, stdio: "ignore" });
  }

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({
    id: "M001",
    title: "Evidence guidance",
    status: "active",
    planning: { verificationContract: "Contract check for RELY-01 evidence guidance." },
  });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Done", status: "complete" });
  insertTask({ id: "T01", milestoneId: "M001", sliceId: "S01", title: "Done", status: "complete" });
  executeAtFence("test.fixture.adopt", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone",
      milestoneId: "M001",
      lifecycleStatus: "ready",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "slice",
      milestoneId: "M001",
      sliceId: "S01",
      lifecycleStatus: "completed",
    });
    adoptOrTransitionLifecycle(context, {
      itemKind: "task",
      milestoneId: "M001",
      sliceId: "S01",
      taskId: "T01",
      lifecycleStatus: "completed",
    });
  });
  return basePath;
}

const VERIFICATION_CLASSES_TABLE =
  "| Class | Planned Check | Evidence | Verdict |\n| --- | --- | --- | --- |\n"
  + "| Contract | Contract check for RELY-01 evidence guidance. | pending | NEEDS-ATTENTION |";

const BASE_PARAMS = {
  milestoneId: "M001",
  verdict: "pass" as const,
  remediationRound: 0,
  successCriteriaChecklist: "- [x] Complete",
  sliceDeliveryAudit: "Delivered",
  crossSliceIntegration: "Passed",
  requirementCoverage: "Covered",
  verificationClasses: VERIFICATION_CLASSES_TABLE,
  verdictRationale: "Everything passes.",
};

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
  clearPathCache();
  clearParseCache();
});

test("a missing-evidence error carries the real current source revision", async () => {
  const basePath = makeCanonicalFixture();

  const result = await handleValidateMilestone(BASE_PARAMS, basePath, {
    invocation: {
      idempotencyKey: "test/evidence-guidance/missing-evidence",
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });

  assert.ok("error" in result, "missing evidence should be rejected");
  const message = "error" in result ? result.error : "";
  assert.match(message, /verificationClasses prose cannot authorize Milestone validation/);
  assert.match(message, /sha256:[0-9a-f]{16,}/);
});

test("the revision in the error is the one the tool would accept", async () => {
  const basePath = makeCanonicalFixture();

  const missing = await handleValidateMilestone(BASE_PARAMS, basePath, {
    invocation: {
      idempotencyKey: "test/evidence-guidance/round-trip-probe",
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });
  assert.ok("error" in missing, "missing evidence should be rejected");
  const captured = ("error" in missing ? missing.error : "").match(/sha256:[0-9a-f]{16,}/);
  assert.ok(captured, "expected a sha256 revision embedded in the missing-evidence error");
  const revision = captured![0];

  const result = await handleValidateMilestone({
    ...BASE_PARAMS,
    verificationEvidence: [{
      verificationClass: "Contract",
      testedSourceRevision: revision,
      rationale: "Contract check passed against current source.",
      evidenceClass: "command",
      commandOrTool: "pnpm test contract",
      workingDirectory: basePath,
      startedAt: "2026-07-14T10:00:00.000Z",
      endedAt: "2026-07-14T10:01:00.000Z",
      exitCode: 0,
      observation: "passed",
      durableOutputRef: "artifact://validation/contract",
      environment: { runner: "node-test" },
    }],
  }, basePath, {
    invocation: {
      idempotencyKey: "test/evidence-guidance/round-trip-retry",
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });

  assert.ok(!("error" in result), `unexpected error: ${"error" in result ? result.error : ""}`);
});

test("an unresolvable verification source is reported before missing evidence", async () => {
  const basePath = makeCanonicalFixture({ skipGit: true });

  const result = await handleValidateMilestone(BASE_PARAMS, basePath, {
    invocation: {
      idempotencyKey: "test/evidence-guidance/unresolvable-source",
      sourceTransport: "internal",
      actorType: "agent",
    },
    skipBrowserEvidenceGate: true,
  });

  assert.ok("error" in result, "an unresolvable source should be rejected");
  const message = "error" in result ? result.error : "";
  assert.doesNotMatch(message, /verificationClasses prose cannot authorize Milestone validation/);
  assert.match(message, /Unable to snapshot verification source/);
});
