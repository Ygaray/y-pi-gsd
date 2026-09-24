// Project/App: gsd-pi
// File Purpose: Proof that the one-time GREEN-05/INC-2026-09-20-07 migration
// (D-01, D-02, D-04) writes exactly one correctly-shaped `incident`-type
// tracker row with a bidirectional control-plane back-reference, is
// idempotent on re-run (the tracker table is delete-blocking-trigger
// protected, so a duplicate could only ever be closed, never removed), and
// projects into the regenerated incidents pane. Test 5 proves D-02's
// anti-pollution filter mechanically: the constant list this phase migrates
// from holds exactly one record.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import {
  MIGRATED_FROM_CONTROL_PLANE_TAG,
  OWNED_CONTROL_PLANE_INCIDENTS,
  Y_PI_GSD_OWNED_TAG,
  migrateOwnedControlPlaneIncidents,
} from "../tracker-owned-incident-migration.ts";
import { TRACKER_BACKLOG_PROJECTION_FILENAME, TRACKER_INCIDENTS_PROJECTION_FILENAME } from "../tracker-projection.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-owned-incident-migration-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function incidentsPanePath(basePath: string): string {
  return join(basePath, ".gsd", TRACKER_INCIDENTS_PROJECTION_FILENAME);
}

function backlogPanePath(basePath: string): string {
  return join(basePath, ".gsd", TRACKER_BACKLOG_PROJECTION_FILENAME);
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

// ─── Test 1: one correctly-shaped row ─────────────────────────────────────

test("migrateOwnedControlPlaneIncidents: creates exactly one correctly-shaped incident row", () => {
  const basePath = makeBase();

  const { created, skipped } = migrateOwnedControlPlaneIncidents(basePath);

  assert.equal(created.length, 1);
  assert.equal(skipped.length, 0);

  const rows = allRows();
  assert.equal(rows.length, 1);
  const row = rows[0]!;
  assert.equal(row.type, "incident");
  assert.equal(row.status, "open");
  assert.equal(row.severity, "HIGH");
  const tags = JSON.parse(String(row.disposition_tags)) as string[];
  assert.ok(tags.includes(Y_PI_GSD_OWNED_TAG));
  assert.ok(tags.includes(MIGRATED_FROM_CONTROL_PLANE_TAG));
  assert.ok(String(row.detail).trim().length > 0);
});

// ─── Test 2: the back-reference ───────────────────────────────────────────

test("migrateOwnedControlPlaneIncidents: the created row carries exactly one control_plane_incident ref naming GREEN-05", () => {
  const basePath = makeBase();

  const { created } = migrateOwnedControlPlaneIncidents(basePath);
  const trackId = created[0]!;

  const refs = refsFor(trackId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0]!.ref_kind, "control_plane_incident");
  assert.equal(refs[0]!.ref_value, "INC-2026-09-20-07");
});

// ─── Test 3: idempotency ───────────────────────────────────────────────────

test("migrateOwnedControlPlaneIncidents: a second call creates nothing and reports the incident as skipped", () => {
  const basePath = makeBase();

  const first = migrateOwnedControlPlaneIncidents(basePath);
  assert.equal(first.created.length, 1);
  const before = allRows();

  const second = migrateOwnedControlPlaneIncidents(basePath);
  assert.equal(second.created.length, 0);
  assert.deepEqual(second.skipped, ["INC-2026-09-20-07"]);

  const after = allRows();
  assert.equal(after.length, 1);
  assert.equal(after[0]!.id, before[0]!.id);
  assert.equal(after[0]!.created_at, before[0]!.created_at);
});

// ─── Test 4: pane projection ───────────────────────────────────────────────

test("migrateOwnedControlPlaneIncidents: the incidents pane renders the created row, the backlog pane stays empty", () => {
  const basePath = makeBase();

  const { created } = migrateOwnedControlPlaneIncidents(basePath);
  const trackId = created[0]!;

  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  assert.match(incidentsContent, new RegExp(trackId));
  for (const record of OWNED_CONTROL_PLANE_INCIDENTS) {
    assert.ok(incidentsContent.includes(record.title), `expected title in pane: ${record.title}`);
  }
  assert.ok(incidentsContent.includes(Y_PI_GSD_OWNED_TAG));
  assert.ok(incidentsContent.includes(MIGRATED_FROM_CONTROL_PLANE_TAG));
  assert.doesNotMatch(incidentsContent, /No open incidents items\./);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.match(backlogContent, /No open backlog items\./);
});

// ─── Test 5: positive scope proof (D-02 anti-pollution filter) ────────────

test("OWNED_CONTROL_PLANE_INCIDENTS: holds exactly one record, the GREEN-05 incident id", () => {
  assert.equal(OWNED_CONTROL_PLANE_INCIDENTS.length, 1);
  assert.equal(OWNED_CONTROL_PLANE_INCIDENTS[0]!.incidentId, "INC-2026-09-20-07");
});
