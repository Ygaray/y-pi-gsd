// Project/App: gsd-pi
// File Purpose: End-to-end proof of the v55 per-project tracker store
// (TRACK-01, TRACK-02, TRACK-03, TRACK-04): schema at v55 -> createTrackerItem
// -> both panes regenerated -> /gsd track add drives the same path.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { SCHEMA_VERSION, _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { withCommandCwd } from "../commands/context.ts";
import { handleTrack } from "../commands-tracker.ts";
import { createTrackerItem } from "../db/writers/tracker-item.ts";
import {
  TRACKER_BACKLOG_PROJECTION_FILENAME,
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
  readTrackerItems,
  renderTrackerLedger,
  renderTrackerMarkdown,
} from "../tracker-projection.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-item-schema-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function backlogPanePath(basePath: string): string {
  return join(basePath, ".gsd", TRACKER_BACKLOG_PROJECTION_FILENAME);
}

function incidentsPanePath(basePath: string): string {
  return join(basePath, ".gsd", TRACKER_INCIDENTS_PROJECTION_FILENAME);
}

function makeMockCtx(): ExtensionCommandContext & { _notifications: Array<{ message: string; type: string }> } {
  const notifications: Array<{ message: string; type: string }> = [];
  return {
    ui: {
      notify: (message: string, type: string) => {
        notifications.push({ message, type });
      },
    },
    _notifications: notifications,
  } as unknown as ExtensionCommandContext & { _notifications: typeof notifications };
}

const mockPi = {} as unknown as ExtensionAPI;

// ─── Test 1: schema at v55 ──────────────────────────────────────────────

test("schema: tracker_items + track_item_refs + triggers exist at v55 on fresh install", () => {
  const basePath = makeBase();
  const db = _getAdapter();
  assert.ok(db);

  const tableNames = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('tracker_items', 'track_item_refs')`,
  ).all() as Array<Record<string, unknown>>).map((row) => String(row.name));
  assert.deepEqual(tableNames.sort(), ["track_item_refs", "tracker_items"]);

  const triggerNames = (db.prepare(
    `SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'trg_tracker_items_%'`,
  ).all() as Array<Record<string, unknown>>).map((row) => String(row.name));
  assert.deepEqual(triggerNames.sort(), [
    "trg_tracker_items_delete",
    "trg_tracker_items_identity_immutable",
    "trg_tracker_items_transition",
  ]);

  assert.equal(Number(db.prepare("PRAGMA user_version").get()?.["user_version"] ?? 0), 55);
  assert.equal(SCHEMA_VERSION, 55);
  void basePath;
});

// ─── Test 2: create + refs (D-01) ───────────────────────────────────────

test("createTrackerItem: two refs sharing a ref_kind but differing ref_value both persist", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem(
    {
      type: "backlog",
      title: "Two reviews_md refs",
      refs: [
        { refKind: "reviews_md", refValue: "REVIEWS.md#finding-1" },
        { refKind: "reviews_md", refValue: "REVIEWS.md#finding-2" },
      ],
    },
    basePath,
  );
  assert.equal(trackId, "TRACK-001");

  const db = _getAdapter();
  assert.ok(db);
  const item = db.prepare("SELECT status FROM tracker_items WHERE id = 'TRACK-001'").get() as Record<string, unknown>;
  assert.equal(item.status, "open");

  const refCount = Number(
    db.prepare("SELECT COUNT(*) AS n FROM track_item_refs WHERE track_id = 'TRACK-001'").get()?.["n"] ?? 0,
  );
  assert.equal(refCount, 2);
});

// ─── Test 3: sequential ids + adjacency ─────────────────────────────────

test("createTrackerItem: sequential ids, and byte-identical payloads never merge", () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "First" }, basePath);
  const second = createTrackerItem({ type: "backlog", title: "Same title" }, basePath);
  assert.equal(second.trackId, "TRACK-002");

  const third = createTrackerItem({ type: "backlog", title: "Same title" }, basePath);
  assert.equal(third.trackId, "TRACK-003");
  assert.notEqual(second.trackId, third.trackId);

  const db = _getAdapter();
  assert.ok(db);
  const count = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items").get()?.["n"] ?? 0);
  assert.equal(count, 3);
});

// ─── Test 4: empty/blank input ───────────────────────────────────────────

test("createTrackerItem: blank title throws and writes nothing; empty refs succeeds", () => {
  const basePath = makeBase();
  const db = _getAdapter();
  assert.ok(db);

  assert.throws(
    () => createTrackerItem({ type: "backlog", title: "   " }, basePath),
    /title is required/,
  );
  assert.equal(Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items").get()?.["n"] ?? 0), 0);

  const { trackId } = createTrackerItem({ type: "backlog", title: "No refs", refs: [] }, basePath);
  assert.equal(trackId, "TRACK-001");
});

// ─── Test 5: closed vocabularies ─────────────────────────────────────────

test("schema: type/status/severity/ref_kind CHECK constraints admit only their closed vocabulary", () => {
  const basePath = makeBase();
  void basePath;
  const db = _getAdapter();
  assert.ok(db);

  const now = new Date().toISOString();
  const insertItem = (id: string, type: string, status: string, severity: string) =>
    db.prepare(
      `INSERT INTO tracker_items (id, type, title, status, severity, created_at, updated_at)
       VALUES ('${id}', '${type}', 'x', '${status}', '${severity}', '${now}', '${now}')`,
    ).run();

  assert.throws(() => insertItem("TRACK-X1", "feature", "open", "HIGH"), /CHECK/);
  assert.throws(() => insertItem("TRACK-X2", "backlog", "blocked", "HIGH"), /CHECK/);
  assert.throws(() => insertItem("TRACK-X3", "backlog", "open", "CRITICAL"), /CHECK/);

  // A valid parent row to hang ref_kind checks off of.
  insertItem("TRACK-VALID", "backlog", "open", "HIGH");

  const insertRef = (refKind: string) =>
    db.prepare(
      `INSERT INTO track_item_refs (track_id, ref_kind, ref_value, created_at)
       VALUES ('TRACK-VALID', '${refKind}', 'v-${refKind}', '${now}')`,
    ).run();

  assert.throws(() => insertRef("milestone"), /CHECK/);
  for (const kind of ["phase", "requirement", "reviews_md", "track_item", "control_plane_incident"]) {
    assert.doesNotThrow(() => insertRef(kind));
  }
});

// ─── Test 6: ref uniqueness ───────────────────────────────────────────────

test("schema: duplicate (track_id, ref_kind, ref_value) is rejected by the unique index", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem(
    { type: "backlog", title: "Ref uniqueness", refs: [{ refKind: "phase", refValue: "17" }] },
    basePath,
  );
  const db = _getAdapter();
  assert.ok(db);
  const now = new Date().toISOString();
  assert.throws(
    () => db.prepare(
      `INSERT INTO track_item_refs (track_id, ref_kind, ref_value, created_at)
       VALUES ('${trackId}', 'phase', '17', '${now}')`,
    ).run(),
    /UNIQUE/,
  );
});

// ─── Test 7: transition whitelist + idempotency ──────────────────────────

test("schema: the transition trigger whitelists status moves and permits non-status edits", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "Transitions" }, basePath);
  const db = _getAdapter();
  assert.ok(db);

  const setStatus = (status: string) =>
    db.prepare(`UPDATE tracker_items SET status = '${status}' WHERE id = '${trackId}'`).run();
  const setTitle = (title: string) =>
    db.prepare(`UPDATE tracker_items SET title = '${title}' WHERE id = '${trackId}'`).run();

  assert.doesNotThrow(() => setStatus("in-progress"));
  assert.doesNotThrow(() => setStatus("resolved"));
  assert.doesNotThrow(() => setStatus("open")); // reopen
  assert.doesNotThrow(() => setStatus("resolved"));
  assert.throws(() => setStatus("closed"), /invalid tracker item status transition/);
  assert.doesNotThrow(() => setStatus("open"));
  assert.throws(() => setStatus("retired"), /CHECK|invalid tracker item status transition/);
  // A title-only edit that leaves status unchanged must be allowed.
  assert.doesNotThrow(() => setTitle("Transitions renamed"));
});

// ─── Test 8: identity immutability ───────────────────────────────────────

test("schema: id, type, and created_at are immutable after insert", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "Identity" }, basePath);
  const db = _getAdapter();
  assert.ok(db);

  assert.throws(
    () => db.prepare(`UPDATE tracker_items SET id = 'TRACK-999' WHERE id = '${trackId}'`).run(),
    /tracker item identity is immutable/,
  );
  assert.throws(
    () => db.prepare(`UPDATE tracker_items SET type = 'incident' WHERE id = '${trackId}'`).run(),
    /tracker item identity is immutable/,
  );
  assert.throws(
    () => db.prepare(`UPDATE tracker_items SET created_at = '1999-01-01T00:00:00.000Z' WHERE id = '${trackId}'`).run(),
    /tracker item identity is immutable/,
  );
});

// ─── Test 9: non-delete (TRACK-01's mechanism) ───────────────────────────

test("schema: no code path can DELETE a tracker_items row", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "Durable" }, basePath);
  const db = _getAdapter();
  assert.ok(db);

  assert.throws(
    () => db.prepare(`DELETE FROM tracker_items WHERE id = '${trackId}'`).run(),
    /tracker items are durable history/,
  );
  const stillPresent = db.prepare(`SELECT id FROM tracker_items WHERE id = '${trackId}'`).get();
  assert.ok(stillPresent);
});

// ─── Test 10: projection regenerated by the writer (TRACK-04) ───────────

test("createTrackerItem regenerates both BACKLOG.md and INCIDENTS.md from the writer itself", () => {
  const basePath = makeBase();
  const backlog = createTrackerItem({ type: "backlog", title: "A backlog item" }, basePath);
  const incident = createTrackerItem({ type: "incident", title: "An incident" }, basePath);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");

  assert.ok(backlogContent.length > 0);
  assert.ok(incidentsContent.length > 0);
  assert.ok(backlogContent.includes(backlog.trackId));
  assert.ok(!backlogContent.includes(incident.trackId));
  assert.ok(incidentsContent.includes(incident.trackId));
  assert.ok(!incidentsContent.includes(backlog.trackId));
});

// ─── Test 11: empty panes ─────────────────────────────────────────────────

test("renderTrackerLedger: an empty tracker still renders both panes as non-empty documents", () => {
  const basePath = makeBase();
  const wrote = renderTrackerLedger(basePath);
  assert.equal(wrote, true);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  assert.ok(backlogContent.length > 0);
  assert.ok(incidentsContent.length > 0);
  assert.match(backlogContent, /No open backlog items\./);
  assert.match(incidentsContent, /No open incidents items\./);
});

// ─── Test 12: markdown-cell escaping (T-17-01) ───────────────────────────

test("a crafted title cannot forge an extra markdown table row or column", () => {
  const safeBase = makeBase();
  createTrackerItem({ type: "backlog", title: "an ordinary safe title" }, safeBase);
  const safeRendered = renderTrackerMarkdown(readTrackerItems(), "backlog");
  const safeLineCount = safeRendered.split("\n").length;
  closeDatabase();

  const craftedBase = makeBase();
  createTrackerItem({ type: "backlog", title: "evil | row\nsecond line" }, craftedBase);
  const craftedRendered = renderTrackerMarkdown(readTrackerItems(), "backlog");
  const craftedLines = craftedRendered.split("\n");

  assert.ok(craftedRendered.includes("evil \\| row second line"), "the pipe must be escaped and the newline collapsed onto one line");
  assert.ok(
    !craftedLines.some((line) => line.trim() === "second line"),
    "the raw newline must never start a standalone line",
  );
  const rowLines = craftedLines.filter((line) => line.startsWith("| TRACK-"));
  assert.equal(rowLines.length, 1, "exactly one row line for the one item created — no extra row forged");
  assert.equal(
    craftedLines.length,
    safeLineCount,
    "a crafted title with an embedded newline produces the SAME total line count as an equivalent one-item, safe-title render — no extra line was forged",
  );
});

// ─── Test 13: ordering ────────────────────────────────────────────────────

test("readTrackerItems orders created_at ASC, id ASC; repeated renders are byte-identical", () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "First" }, basePath);
  createTrackerItem({ type: "backlog", title: "Second" }, basePath);
  createTrackerItem({ type: "backlog", title: "Third" }, basePath);

  const rows = readTrackerItems();
  assert.deepEqual(rows.map((row) => row.id), ["TRACK-001", "TRACK-002", "TRACK-003"]);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].createdAt <= rows[i].createdAt);
  }

  renderTrackerLedger(basePath);
  const firstRender = readFileSync(backlogPanePath(basePath), "utf-8");
  renderTrackerLedger(basePath);
  const secondRender = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.equal(firstRender, secondRender);
});

// ─── Test 14: the tracer's far end (TRACK-03) ────────────────────────────

test("handleTrack('add ...') drives command -> writer -> DB row -> regenerated pane", async () => {
  const basePath = makeBase();
  const ctx = makeMockCtx();
  await withCommandCwd(basePath, () =>
    handleTrack(
      'add --type incident --title "tracer end to end" --severity HIGH --ref phase:17',
      ctx,
      mockPi,
    ));

  const db = _getAdapter();
  assert.ok(db);
  const itemCount = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items").get()?.["n"] ?? 0);
  assert.equal(itemCount, 1);
  const item = db.prepare("SELECT type, severity FROM tracker_items").get() as Record<string, unknown>;
  assert.equal(item.type, "incident");
  assert.equal(item.severity, "HIGH");

  const refCount = Number(
    db.prepare(
      "SELECT COUNT(*) AS n FROM track_item_refs WHERE ref_kind = 'phase' AND ref_value = '17'",
    ).get()?.["n"] ?? 0,
  );
  assert.equal(refCount, 1);

  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  const createdId = String((db.prepare("SELECT id FROM tracker_items").get() as Record<string, unknown>).id);
  assert.ok(incidentsContent.includes(createdId));

  assert.equal(ctx._notifications.length, 1);
  assert.ok(ctx._notifications[0].message.includes(createdId));
});
