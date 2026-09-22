// Project/App: gsd-pi
// File Purpose: Full-table-regeneration coverage for the Gate-2 human-UAT
// pending ledger projection (LEDGER-01, D-04).

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExecutionInvocation } from "../execution-invocation.ts";
import { _getAdapter, closeDatabase, insertMilestone, insertSlice, openDatabase } from "../gsd-db.ts";
import {
  HUMAN_UAT_PENDING_PROJECTION_FILENAME,
  readHumanUatPendingLedger,
  renderHumanUatPendingLedger,
} from "../human-uat-pending-projection.ts";
import { registerGate2HumanUatPending } from "../milestone-gate2-human-uat-domain-operation.ts";

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return {
    idempotencyKey,
    sourceTransport: "internal",
    actorType: "agent",
  };
}

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-human-uat-projection-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: "M001", title: "Gate-2 projection", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", status: "active" });
  insertSlice({ id: "S02", milestoneId: "M001", status: "active" });
  return basePath;
}

function projectionPath(basePath: string): string {
  return join(basePath, ".gsd", HUMAN_UAT_PENDING_PROJECTION_FILENAME);
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("empty ledger: renders a valid document stating there are no pending entries", () => {
  const basePath = makeBase();
  const wrote = renderHumanUatPendingLedger(basePath);
  assert.equal(wrote, true);
  const content = readFileSync(projectionPath(basePath), "utf-8");
  assert.ok(content.length > 0, "the file must be non-empty even for an empty ledger");
  assert.match(content, /No outstanding Gate-2 human-UAT entries\./);
});

test("full regeneration: two pending entries render, then a direct status flip moves one to Signed off", () => {
  const basePath = makeBase();
  const first = registerGate2HumanUatPending({
    invocation: invocation("fixture/projection/register-1"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: could not verify offline sync",
    partialCriteria: [{ criterion: "Offline sync", evidence: "Manual check needed" }],
  });
  const second = registerGate2HumanUatPending({
    invocation: invocation("fixture/projection/register-2"),
    milestoneId: "M001",
    sliceId: "S02",
    reason: "PARTIAL: could not verify push notifications",
    partialCriteria: [{ criterion: "Push notifications", evidence: "No device available" }],
  });

  assert.ok(renderHumanUatPendingLedger(basePath));
  let content = readFileSync(projectionPath(basePath), "utf-8");
  assert.match(content, new RegExp(first.entryId));
  assert.match(content, new RegExp(second.entryId));

  _getAdapter()!
    .prepare(
      "UPDATE human_uat_pending SET status = 'signed-off', signed_off_at = :at, signed_off_by = :by WHERE entry_id = :id",
    )
    .run({ ":at": new Date().toISOString(), ":by": "operator", ":id": first.entryId });

  assert.ok(renderHumanUatPendingLedger(basePath));
  content = readFileSync(projectionPath(basePath), "utf-8");
  const [outstandingSection, restSection] = content.split("## Signed off");
  assert.ok(restSection, "the Signed off section must exist");
  assert.doesNotMatch(
    outstandingSection!,
    new RegExp(first.entryId),
    "a signed-off entry must leave the Outstanding table -- proving whole-document rewrite, not an append",
  );
  assert.match(outstandingSection!, new RegExp(second.entryId), "the still-pending entry must remain Outstanding");
  assert.match(restSection!, new RegExp(first.entryId), "the signed-off entry must now appear in the Signed off section");
});

test("hand edits are discarded: an overwritten file is fully replaced on the next render", () => {
  const basePath = makeBase();
  registerGate2HumanUatPending({
    invocation: invocation("fixture/projection/register-hand-edit"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: hand-edit test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.ok(renderHumanUatPendingLedger(basePath));
  writeFileSync(projectionPath(basePath), "HAND EDITED", "utf-8");
  assert.equal(readFileSync(projectionPath(basePath), "utf-8"), "HAND EDITED");

  assert.ok(renderHumanUatPendingLedger(basePath));
  const content = readFileSync(projectionPath(basePath), "utf-8");
  assert.ok(!content.includes("HAND EDITED"), "a hand edit must never survive the next render (D-04)");
});

test("self-declaring: the rendered content names itself a generated read-only projection", () => {
  const basePath = makeBase();
  registerGate2HumanUatPending({
    invocation: invocation("fixture/projection/register-self-declaring"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: self-declaring test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  assert.ok(renderHumanUatPendingLedger(basePath));
  const content = readFileSync(projectionPath(basePath), "utf-8");
  assert.match(content, /## Outstanding/);
  assert.match(content, /generated,? read-only projection/i);
  assert.match(content, /manual edits are discarded/i);
  assert.match(content, /human-uat sign-off/);
});

test("no database open: renderHumanUatPendingLedger returns false and does not throw", () => {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-human-uat-projection-nodb-"));
  tempDirs.add(basePath);
  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = renderHumanUatPendingLedger(basePath);
  });
  assert.equal(result, false);
});

test("readHumanUatPendingLedger: a whole-table read reflects a registered row", () => {
  const basePath = makeBase();
  registerGate2HumanUatPending({
    invocation: invocation("fixture/projection/read-1"),
    milestoneId: "M001",
    sliceId: "S01",
    reason: "PARTIAL: read test",
    partialCriteria: [{ criterion: "A", evidence: "a" }],
  });
  const rows = readHumanUatPendingLedger();
  assert.equal(rows.length, 1);
  assert.equal(rows[0]!.status, "pending");
  assert.equal(rows[0]!.milestoneId, "M001");
  assert.equal(rows[0]!.sliceId, "S01");
});
