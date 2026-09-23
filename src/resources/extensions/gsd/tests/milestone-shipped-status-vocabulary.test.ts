// Project/App: gsd-pi
// File Purpose: RESEARCH Pitfall 1 regression net — the two independently
// maintained legacy-status vocabularies (LEGACY_STATUS_MAP,
// RAW_CLOSED_STATUSES) agree about shipped/archived, the widening touches
// nothing outside milestone rows, and a shipped milestone keeps its SUMMARY
// live in the render sweep alongside its new ARCHIVE artifact (15-03 Task 2).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { DomainJsonValue, DomainOperationContext } from "../db/domain-operation.ts";
import {
  compareLifecycleShadow,
  normalizeLegacyLifecycleStatus,
} from "../db/lifecycle-shadow-comparison.ts";
import { adoptOrTransitionLifecycle } from "../db/writers/lifecycle-commands.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import { clearParseCache } from "../files.ts";
import {
  _getAdapter,
  closeDatabase,
  executeDomainOperation,
  getActiveSliceFromDb,
  getActiveTaskFromDb,
  getMilestone,
  insertMilestone,
  insertRequirement,
  insertSlice,
  insertTask,
  openDatabase,
  readDomainOperationFence,
} from "../gsd-db.ts";
import {
  detectProjectionDrift,
  detectStaleRenders,
  renderAllFromDb,
  stripProjectionStamp,
} from "../markdown-renderer.ts";
import {
  shipMilestone,
  type ShipMilestoneInput,
} from "../milestone-ship-domain-operation.ts";
import { clearPathCache, targetMilestoneFile } from "../paths.ts";
import {
  isClosedStatus,
  isDeferredStatus,
  isFutureMilestoneStatus,
  isHiddenFromRoadmap,
  isInactiveStatus,
  isShippedStatus,
  isSkippedForDispatch,
  RAW_CLOSED_STATUSES,
  toStatus,
} from "../status-guards.ts";

const tempDirs = new Set<string>();

function db() {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "pi-tool",
    actorType: "agent",
    actorId: "ship-vocabulary-test",
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
    payload: Record<string, DomainJsonValue>;
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
      events: [{ ...emitted, destinations: ["test"] }],
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

function recordPassingCertify(idempotencyKey = "fixture/vocabulary/certify"): void {
  recordVerdict("milestone.certify.recorded", "milestone.certify", idempotencyKey, "pass");
}

function recordPassingAudit(idempotencyKey = "fixture/vocabulary/audit"): void {
  recordVerdict("milestone.audit.recorded", "milestone.audit", idempotencyKey, "pass");
}

/** Already-completed, ship-ready single-slice fixture — mirrors 15-01's
 * `milestone-ship-domain-operation.test.ts` `makeBase()`. */
function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-ship-vocabulary-"));
  tempDirs.add(basePath);
  // Deliberately does NOT pre-create a `.gsd/milestones/M001` legacy-layout
  // directory: Tests 7-9 drive the real `renderAllFromDb` sweep entry point
  // (not the individual render functions), and resolving a canonical
  // flat-phase layout consistently from the very first write is what keeps
  // every `targetMilestoneFile(...)` read-back call in this file pointed at
  // the SAME path the sweep actually wrote.
  mkdirSync(join(basePath, ".gsd"), { recursive: true });

  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Ship vocabulary", status: "active" });
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

  executeAtFence("test.ship.fixture", "fixture/vocabulary/ready", (context) => {
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

  const completedAt = "2026-09-22T00:00:00.000Z";
  // A genuine `milestone.completed` event (not merely the legacy status
  // write) is required so `readMilestoneCompletionProjection` — and
  // therefore `renderMilestoneSummary`/`renderAllFromDb` — has something real
  // to render; a bare status flip leaves the projection null and SUMMARY
  // never gets written, which is exactly what Tests 7-9 need to observe.
  executeAtFence("milestone.complete", "fixture/vocabulary/complete", (context) => {
    adoptOrTransitionLifecycle(context, {
      itemKind: "milestone", milestoneId: "M001", lifecycleStatus: "completed",
    });
    db().prepare(`
      UPDATE milestones SET status = 'complete', completed_at = :completed_at WHERE id = 'M001'
    `).run({ ":completed_at": completedAt });
  }, () => ({
    eventType: "milestone.completed",
    entityType: "milestone",
    entityId: "M001",
    payload: {
      completedAt,
      closeout: {
        title: "Ship vocabulary",
        oneLiner: "Completed before shipping.",
        narrative: "The completed milestone is ready for the ship-vocabulary fixture.",
        successCriteriaResults: "Passed.",
        definitionOfDoneResults: "Passed.",
        requirementOutcomes: "Covered.",
        keyDecisions: [],
        keyFiles: [],
        lessonsLearned: [],
        followUps: "None.",
        deviations: "None.",
      },
    },
  }));

  return basePath;
}

function shipInput(idempotencyKey: string): ShipMilestoneInput {
  return { invocation: invocation(idempotencyKey), milestoneId: "M001" };
}

function shipTheMilestone(idempotencyKey = "vocabulary/ship"): void {
  recordPassingCertify();
  recordPassingAudit();
  shipMilestone(shipInput(idempotencyKey));
}

afterEach(() => {
  clearPathCache();
  clearParseCache();
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("isClosedStatus, isInactiveStatus, and isSkippedForDispatch all return true for shipped and archived", () => {
  for (const status of ["shipped", "archived"]) {
    assert.equal(isClosedStatus(status), true, status);
    assert.equal(isInactiveStatus(status), true, status);
    assert.equal(isSkippedForDispatch(status), true, status);
  }
});

test("toStatus returns shipped/archived verbatim, and neither equals \"complete\"", () => {
  assert.equal(toStatus("shipped"), "shipped");
  assert.equal(toStatus("archived"), "archived");
  assert.notEqual(toStatus("shipped"), "complete");
  assert.notEqual(toStatus("archived"), "complete");
});

test("normalizeLegacyLifecycleStatus maps shipped/archived to completed, and compareLifecycleShadow reports a match against canonical completed", () => {
  assert.equal(normalizeLegacyLifecycleStatus("shipped"), "completed");
  assert.equal(normalizeLegacyLifecycleStatus("archived"), "completed");
  assert.equal(compareLifecycleShadow("shipped", "completed").kind, "semantic_match_exact_delta");
  assert.equal(compareLifecycleShadow("archived", "completed").kind, "semantic_match_exact_delta");
  // "match" requires legacyStatus === canonicalStatus verbatim; shipped/archived
  // are legal legacy literals with no canonical counterpart (the canonical
  // vocabulary has no "shipped" member), so their true convergence signal
  // against the real canonical status ("completed") is the semantic-match
  // kind asserted above — proven directly by shipMilestoneHierarchy's own
  // postcondition in 15-01 (`shipping preserves canonical lifecycle at
  // completed and the shadow stays matched`).
});

test("isHiddenFromRoadmap, isDeferredStatus, and isFutureMilestoneStatus are all false for shipped and archived", () => {
  for (const status of ["shipped", "archived"]) {
    assert.equal(isHiddenFromRoadmap(status), false, status);
    assert.equal(isDeferredStatus(status), false, status);
    assert.equal(isFutureMilestoneStatus(status), false, status);
  }
});

test("RAW_CLOSED_STATUSES still begins with its original six members in order, with shipped/archived appended", () => {
  assert.deepEqual(RAW_CLOSED_STATUSES.slice(0, 6), [
    "complete", "done", "skipped", "closed", "cancelled", "blocker-accepted",
  ]);
  assert.deepEqual(RAW_CLOSED_STATUSES.slice(6), ["shipped", "archived"]);
});

test("shipping a milestone changes no terminal-status-filtered slice or task query result", () => {
  makeBase();
  const sliceBefore = getActiveSliceFromDb("M001");
  const taskBefore = getActiveTaskFromDb("M001", "S01");

  shipTheMilestone();

  const sliceAfter = getActiveSliceFromDb("M001");
  const taskAfter = getActiveTaskFromDb("M001", "S01");
  assert.deepEqual(sliceAfter, sliceBefore);
  assert.deepEqual(taskAfter, taskBefore);
  assert.equal(getMilestone("M001")!.status, "shipped");
});

test("a full render sweep still writes the SUMMARY artifact after shipping, byte-identical (stamp aside) to the pre-ship render", async () => {
  const basePath = makeBase();
  const summaryPath = targetMilestoneFile(basePath, "M001", "SUMMARY", "Ship vocabulary");

  const beforeShipResult = await renderAllFromDb(basePath);
  assert.ok(beforeShipResult.rendered > 0);
  const summaryWhileComplete = stripProjectionStamp(readFileSync(summaryPath, "utf-8"));

  shipTheMilestone();

  const afterShipResult = await renderAllFromDb(basePath);
  assert.ok(afterShipResult.rendered > 0);
  const summaryAfterShip = stripProjectionStamp(readFileSync(summaryPath, "utf-8"));

  assert.equal(summaryAfterShip, summaryWhileComplete);
});

test("the render sweep's drift-detection pass still reports the shipped milestone's SUMMARY as a render intent", async () => {
  const basePath = makeBase();
  shipTheMilestone();
  await renderAllFromDb(basePath);

  const summaryPath = targetMilestoneFile(basePath, "M001", "SUMMARY", "Ship vocabulary");
  const original = readFileSync(summaryPath, "utf-8");
  writeFileSync(summaryPath, `${original}\nout-of-band hand-edit\n`);

  const stale = detectProjectionDrift(basePath);
  const summaryDrift = stale.find((entry) => entry.path === summaryPath);
  assert.ok(summaryDrift, "a shipped milestone's SUMMARY must still be drift-checked");
  assert.match(summaryDrift!.reason, /differs from DB render intent/);
});

test("the same sweep also writes the ARCHIVE artifact, coexisting with SUMMARY in the milestone directory", async () => {
  const basePath = makeBase();
  shipTheMilestone();

  const result = await renderAllFromDb(basePath);
  assert.ok(result.rendered > 0);
  assert.deepEqual(result.errors, []);

  const summaryPath = targetMilestoneFile(basePath, "M001", "SUMMARY", "Ship vocabulary");
  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship vocabulary");
  assert.ok(readFileSync(summaryPath, "utf-8").length > 0);
  assert.ok(readFileSync(archivePath, "utf-8").length > 0);
});

test("the render sweep's drift-detection pass also reports a hand-edited ARCHIVE.md, mirroring the SUMMARY-drift test (CR-03)", async () => {
  const basePath = makeBase();
  shipTheMilestone();
  await renderAllFromDb(basePath);

  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship vocabulary");
  const original = readFileSync(archivePath, "utf-8");
  writeFileSync(archivePath, `${original}\nout-of-band hand-edit\n`);

  const stale = detectProjectionDrift(basePath);
  const archiveDrift = stale.find((entry) => entry.path === archivePath);
  assert.ok(archiveDrift, "a shipped milestone's ARCHIVE must be drift-checked, not invisible to reconciliation");
  assert.match(archiveDrift!.reason, /differs from DB render intent/);
});

test("a deleted ARCHIVE.md for an already-shipped milestone is reported as a missing render (CR-03)", async () => {
  const basePath = makeBase();
  shipTheMilestone();
  await renderAllFromDb(basePath);

  const archivePath = targetMilestoneFile(basePath, "M001", "ARCHIVE", "Ship vocabulary");
  assert.ok(readFileSync(archivePath, "utf-8").length > 0);
  unlinkSync(archivePath);

  const stale = detectStaleRenders(basePath);
  const archiveMissing = stale.find((entry) => entry.path === archivePath);
  assert.ok(archiveMissing, "a deleted ARCHIVE.md for a shipped milestone must be detected as a missing render");
  assert.match(archiveMissing!.reason, /ARCHIVE\.md missing on disk/);
});
