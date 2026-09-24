// Project/App: gsd-pi
// File Purpose: Proof that captureMilestoneCloseoutResiduals (GREEN-05,
// D-05) is idempotent, order-preserving, writes only schema-permitted ref
// kinds, never throws on a per-item write failure, and — mirroring the
// Phase 17-04 leak this project already paid for once — every test here
// runs against a temp-directory database, never the operator's real
// .gsd/gsd.db.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { captureMilestoneCloseoutResiduals } from "../milestone-closeout-residual-capture.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-milestone-residual-capture-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function allRows(): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db);
  return db.prepare("SELECT * FROM tracker_items ORDER BY id ASC").all() as Array<Record<string, unknown>>;
}

function refsFor(trackId: string): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db);
  return db
    .prepare("SELECT ref_kind, ref_value FROM track_item_refs WHERE track_id = :id ORDER BY ref_kind, ref_value")
    .all({ ":id": trackId }) as Array<Record<string, unknown>>;
}

// ─── Test 1: empty ─────────────────────────────────────────────────────────

test("captureMilestoneCloseoutResiduals: an empty item array is a no-op", () => {
  const basePath = makeBase();
  const before = allRows().length;

  const result = captureMilestoneCloseoutResiduals({ milestoneId: "M001", items: [], basePath });

  assert.deepEqual(result, { created: [], skipped: [], failures: [] });
  assert.equal(allRows().length, before);
});

// ─── Test 2: single item ───────────────────────────────────────────────────
// This is the RED-phase target test: it must fail for real against the
// stub (which never creates a row) before any real implementation lands.

test("captureMilestoneCloseoutResiduals: a single item creates exactly one correctly-shaped row", () => {
  const basePath = makeBase();

  const result = captureMilestoneCloseoutResiduals({
    milestoneId: "M001",
    items: [{
      title: "Un-acknowledgeable deferred item",
      severity: "MEDIUM",
      detail: "carried forward from close",
    }],
    basePath,
  });

  assert.equal(result.created.length, 1);
  const trackId = result.created[0]!;
  const rows = allRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.id, trackId);
  assert.equal(row.type, "backlog");
  assert.equal(row.title, "Un-acknowledgeable deferred item");
  assert.equal(row.severity, "MEDIUM");
  assert.equal(row.detail, "carried forward from close");
  const tags = JSON.parse(String(row.disposition_tags)) as string[];
  assert.ok(tags.includes("milestone:M001"), `expected a milestone:M001 disposition tag, got ${JSON.stringify(tags)}`);
  assert.equal(result.skipped.length, 0);
  // WR-02/IN-01 fix: a successful capture never populates `failures` — the
  // field is failure-only, so a caller can treat non-empty as "attention
  // needed" without it firing on every successful close.
  assert.equal(result.failures.length, 0);
});

// ─── Test 3: adjacency / idempotency ───────────────────────────────────────

test("captureMilestoneCloseoutResiduals: a duplicate item within one call collapses to one row, and a repeated call creates nothing", () => {
  const basePath = makeBase();
  const item = { title: "Repeated deferred item", severity: "LOW" as const };

  const first = captureMilestoneCloseoutResiduals({ milestoneId: "M001", items: [item, item], basePath });
  assert.equal(first.created.length, 1);
  assert.deepEqual(first.skipped, ["Repeated deferred item"]);
  assert.equal(allRows().length, 1);

  const second = captureMilestoneCloseoutResiduals({ milestoneId: "M001", items: [item, item], basePath });
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.skipped, ["Repeated deferred item", "Repeated deferred item"]);
  assert.equal(allRows().length, 1);
});

// ─── Test 4: ordering ───────────────────────────────────────────────────────

test("captureMilestoneCloseoutResiduals: capture order matches input order and TRACK ids increase monotonically", () => {
  const basePath = makeBase();

  const result = captureMilestoneCloseoutResiduals({
    milestoneId: "M001",
    items: [
      { title: "First deferred item" },
      { title: "Second deferred item" },
      { title: "Third deferred item" },
    ],
    basePath,
  });

  assert.equal(result.created.length, 3);
  const numbers = result.created.map((id) => Number(id.slice("TRACK-".length)));
  assert.ok(numbers[0]! < numbers[1]! && numbers[1]! < numbers[2]!, `expected strictly increasing ids, got ${JSON.stringify(numbers)}`);

  const rows = allRows();
  assert.deepEqual(
    rows.map((r) => r.title),
    ["First deferred item", "Second deferred item", "Third deferred item"],
  );
});

// ─── Test 5: refs ───────────────────────────────────────────────────────────

test("captureMilestoneCloseoutResiduals: refs are written only for supplied phase/requirement/control-plane-incident identifiers, using permitted ref kinds", () => {
  const basePath = makeBase();

  const result = captureMilestoneCloseoutResiduals({
    milestoneId: "M001",
    items: [
      {
        title: "Item with full back-references",
        phaseId: "17",
        requirementId: "GREEN-05",
        supersedesControlPlaneIncidentId: "INC-2026-09-20-07",
      },
      { title: "Item with no back-references" },
    ],
    basePath,
  });

  assert.equal(result.created.length, 2);
  const [withRefsId, withoutRefsId] = result.created as [string, string];

  const refs = refsFor(withRefsId);
  assert.equal(refs.length, 3);
  assert.deepEqual(
    refs.map((r) => `${r.ref_kind}:${r.ref_value}`).sort(),
    ["control_plane_incident:INC-2026-09-20-07", "phase:17", "requirement:GREEN-05"],
  );

  assert.equal(refsFor(withoutRefsId).length, 0);
});

// ─── Test 6: write failure never throws ────────────────────────────────────

test("captureMilestoneCloseoutResiduals: a write failure is recorded in failures and never thrown", () => {
  const basePath = makeBase();

  const result = captureMilestoneCloseoutResiduals({
    milestoneId: "M001",
    // A whitespace-only title trips createTrackerItem's own
    // validateCreateTrackerItemInput ("title is required") — a real
    // production failure path, not a mock.
    items: [{ title: "   " }],
    basePath,
  });

  assert.equal(result.created.length, 0);
  assert.equal(result.skipped.length, 0);
  assert.equal(result.failures.length, 1);
  assert.match(result.failures[0]!, /title is required/);
  assert.equal(allRows().length, 0);
});

// ─── Test 7: sandboxed, never the live project database ───────────────────

test("captureMilestoneCloseoutResiduals: writes are scoped to the sandboxed temp database, never a shared/live one", () => {
  const basePathA = makeBase();
  assert.ok(basePathA.startsWith(tmpdir()), `fixture basePath must live under tmpdir(), got ${basePathA}`);

  const result = captureMilestoneCloseoutResiduals({
    milestoneId: "M001",
    items: [{ title: "Sandbox-scoped residual item" }],
    basePath: basePathA,
  });
  assert.equal(result.created.length, 1);

  // A second, independent sandboxed database never sees the first call's
  // row — proves the writer is scoped entirely to the caller's own open
  // connection, never a shared/live one.
  closeDatabase();
  makeBase();
  assert.equal(allRows().length, 0);
});
