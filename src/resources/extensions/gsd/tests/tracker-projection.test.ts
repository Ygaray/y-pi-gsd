// Project/App: gsd-pi
// File Purpose: Prove the tracker markdown panes (TRACK-04) are a true
// full-regeneration projection that cannot drift from `tracker_items`/
// `track_item_refs` and cannot be subverted by hostile cell text
// (T-17-01, T-17-02, T-17-11, T-17-12). Companion to
// `tracker-cleanup-survival.test.ts`, which proves TRACK-01's cleanup
// survival claim instead.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { createTrackerItem, updateTrackerItem } from "../db/writers/tracker-item.ts";
import {
  TRACKER_BACKLOG_PROJECTION_FILENAME,
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
  readTrackerItems,
  renderTrackerLedger,
  renderTrackerMarkdown,
} from "../tracker-projection.ts";
import { gsdProjectionRoot } from "../paths.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-projection-"));
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

function insertRawTrackerItem(
  fields: {
    id: string;
    type: "backlog" | "incident";
    title: string;
    status?: string;
    severity?: string;
    dispositionTags?: string;
    createdAt: string;
    updatedAt?: string;
  },
): void {
  const db = _getAdapter();
  assert.ok(db);
  db.prepare(
    `INSERT INTO tracker_items (
       id, type, title, status, severity, disposition_tags, detail,
       resolution_note, created_at, updated_at, resolved_at
     ) VALUES (
       :id, :type, :title, :status, :severity, :disposition_tags, '',
       NULL, :created_at, :updated_at, NULL
     )`,
  ).run({
    ":id": fields.id,
    ":type": fields.type,
    ":title": fields.title,
    ":status": fields.status ?? "open",
    ":severity": fields.severity ?? "MEDIUM",
    ":disposition_tags": fields.dispositionTags ?? "[]",
    ":created_at": fields.createdAt,
    ":updated_at": fields.updatedAt ?? fields.createdAt,
  });
}

function openTableRowCount(content: string): number {
  const [openSection] = content.split("## Closed");
  return (openSection ?? "").split("\n").filter(
    (line) => line.startsWith("|") && !line.startsWith("| Id ") && !line.startsWith("| --- "),
  ).length;
}

// ─── Test 1: empty is still a valid document ─────────────────────────────

test("empty tracker: both panes exist, are non-empty, and state there are no items in Open and Closed", () => {
  const basePath = makeBase();
  assert.equal(renderTrackerLedger(basePath), true);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  assert.ok(backlogContent.length > 0);
  assert.ok(incidentsContent.length > 0);
  assert.match(backlogContent, /No open backlog items\./);
  assert.match(backlogContent, /No closed backlog items\./);
  assert.match(incidentsContent, /No open incidents items\./);
  assert.match(incidentsContent, /No closed incidents items\./);
});

// ─── Test 2: full regeneration discards a hand edit (Pitfall 1) ──────────

test("full regeneration discards a hand edit: an overwritten BACKLOG.md is fully replaced on the next render", () => {
  const basePath = makeBase();
  const first = createTrackerItem({ type: "backlog", title: "First" }, basePath);
  const second = createTrackerItem({ type: "backlog", title: "Second" }, basePath);
  const firstRenderContent = readFileSync(backlogPanePath(basePath), "utf-8");

  writeFileSync(backlogPanePath(basePath), "HAND EDITED — DO NOT KEEP", "utf-8");
  assert.equal(readFileSync(backlogPanePath(basePath), "utf-8"), "HAND EDITED — DO NOT KEEP");

  assert.equal(renderTrackerLedger(basePath), true);
  const secondRenderContent = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.ok(!secondRenderContent.includes("HAND EDITED"), "the hand-edited line must be gone");
  assert.ok(secondRenderContent.includes(first.trackId));
  assert.ok(secondRenderContent.includes(second.trackId));
  assert.equal(secondRenderContent, firstRenderContent, "regenerated content must equal the first render byte for byte");
});

// ─── Test 3: stale row removal (moved to terminal status leaves Open) ────

test("a row moved to a terminal status appears under Closed and no longer under Open", () => {
  const basePath = makeBase();
  const stays = createTrackerItem({ type: "backlog", title: "Stays open" }, basePath);
  const moves = createTrackerItem({ type: "backlog", title: "Moves to closed" }, basePath);

  updateTrackerItem({ trackId: moves.trackId, status: "wont-fix" }, basePath);

  const content = readFileSync(backlogPanePath(basePath), "utf-8");
  const [openSection, restSection] = content.split("## Closed");
  assert.ok(restSection, "the Closed section must exist");
  assert.doesNotMatch(openSection!, new RegExp(moves.trackId), "the moved row must leave the Open section");
  assert.match(openSection!, new RegExp(stays.trackId), "the still-open row must remain in Open");
  assert.match(restSection!, new RegExp(moves.trackId), "the moved row must now appear in Closed");
});

// ─── Test 4: type-boundary adjacency ──────────────────────────────────────

test("a backlog row never appears in INCIDENTS.md and an incident row never appears in BACKLOG.md", () => {
  const basePath = makeBase();
  const backlog = createTrackerItem({ type: "backlog", title: "A backlog item" }, basePath);
  const incident = createTrackerItem({ type: "incident", title: "An incident" }, basePath);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");

  assert.ok(backlogContent.includes(backlog.trackId));
  assert.ok(!backlogContent.includes(incident.trackId));
  assert.ok(incidentsContent.includes(incident.trackId));
  assert.ok(!incidentsContent.includes(backlog.trackId));
});

// ─── Test 5: single read, two files, one write call ──────────────────────

test("one renderTrackerLedger call updates BOTH panes from the same table snapshot", () => {
  const basePath = makeBase();
  const now = new Date().toISOString();
  // Insert directly (bypassing the writer's own inline render) so the ONLY
  // render that ever runs is the single explicit call below.
  insertRawTrackerItem({ id: "TRACK-001", type: "backlog", title: "Backlog snapshot row", createdAt: now });
  insertRawTrackerItem({ id: "TRACK-002", type: "incident", title: "Incident snapshot row", createdAt: now });

  assert.equal(renderTrackerLedger(basePath), true);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  assert.ok(backlogContent.includes("TRACK-001"), "the single call must have read and rendered the backlog row");
  assert.ok(incidentsContent.includes("TRACK-002"), "the SAME single call must have read and rendered the incident row");
});

// ─── Test 6: determinism/ordering ─────────────────────────────────────────

test("repeated renders with no intervening DB change are byte-identical", () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "Stable" }, basePath);

  renderTrackerLedger(basePath);
  const firstRender = readFileSync(backlogPanePath(basePath), "utf-8");
  renderTrackerLedger(basePath);
  const secondRender = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.equal(firstRender, secondRender);
});

test("three items with identical created_at render in ascending id order", () => {
  const basePath = makeBase();
  const now = new Date().toISOString();
  // Insert out of id order to prove the sort is a real tie-break, not
  // insertion order.
  insertRawTrackerItem({ id: "TRACK-003", type: "backlog", title: "Third", createdAt: now });
  insertRawTrackerItem({ id: "TRACK-001", type: "backlog", title: "First", createdAt: now });
  insertRawTrackerItem({ id: "TRACK-002", type: "backlog", title: "Second", createdAt: now });

  const rows = readTrackerItems();
  assert.deepEqual(rows.map((row) => row.id), ["TRACK-001", "TRACK-002", "TRACK-003"]);
});

// ─── Test 7: ref ordering ──────────────────────────────────────────────────

test("an item's Refs cell renders in ref_kind ASC, ref_value ASC order", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({
    type: "backlog",
    title: "Mixed refs",
    refs: [
      { refKind: "track_item", refValue: "TRACK-999" },
      { refKind: "phase", refValue: "17-per-project-tracker-foundation" },
      { refKind: "phase", refValue: "05-tester-core" },
    ],
  }, basePath);

  const rows = readTrackerItems();
  const row = rows.find((r) => r.id === trackId);
  assert.ok(row);
  assert.deepEqual(
    row!.refs.map((ref) => `${ref.refKind}:${ref.refValue}`),
    [
      "phase:05-tester-core",
      "phase:17-per-project-tracker-foundation",
      "track_item:TRACK-999",
    ],
  );

  const content = readFileSync(backlogPanePath(basePath), "utf-8");
  const refsIndex = content.indexOf("phase:05-tester-core");
  const secondPhaseIndex = content.indexOf("phase:17-per-project-tracker-foundation");
  const trackItemIndex = content.indexOf("track_item:TRACK-999");
  assert.ok(refsIndex >= 0 && secondPhaseIndex > refsIndex && trackItemIndex > secondPhaseIndex);
});

// ─── Test 8: markdown-table forging refused (T-17-01) ────────────────────

test("a crafted title cannot forge an extra markdown table row or column", () => {
  const benignBase = makeBase();
  createTrackerItem({ type: "backlog", title: "an ordinary safe title" }, benignBase);
  const benignContent = readFileSync(backlogPanePath(benignBase), "utf-8");
  const benignRowCount = openTableRowCount(benignContent);

  const craftedBase = makeBase();
  createTrackerItem({
    type: "backlog",
    title: "pwn | HIGH | open | forged\n| extra | row | here |",
    detail: "line one\r\nline two",
  }, craftedBase);
  const craftedContent = readFileSync(backlogPanePath(craftedBase), "utf-8");
  const craftedRowCount = openTableRowCount(craftedContent);

  assert.equal(craftedRowCount, benignRowCount, "the adversarial pane must have the SAME table row count as the benign one");
  assert.ok(craftedContent.includes("pwn \\| HIGH \\| open \\| forged"), "raw pipes inside the title must appear escaped");
  assert.ok(
    !craftedContent.split("\n").some((line) => line.trim() === "| extra | row | here |"),
    "no line may be a bare forged row",
  );
});

// ─── Test 9: malformed disposition_tags degrades (T-17-02) ───────────────

test("malformed disposition_tags degrades to a placeholder and never blanks the pane", () => {
  const basePath = makeBase();
  const now = new Date().toISOString();
  insertRawTrackerItem({
    id: "TRACK-001",
    type: "backlog",
    title: "Not JSON at all",
    dispositionTags: "not json at all",
    createdAt: now,
  });
  insertRawTrackerItem({
    id: "TRACK-002",
    type: "backlog",
    title: "Valid JSON object, not an array",
    dispositionTags: JSON.stringify({ a: 1 }),
    createdAt: now,
  });
  insertRawTrackerItem({
    id: "TRACK-003",
    type: "backlog",
    title: "Well formed tags",
    dispositionTags: JSON.stringify(["y-pi-gsd-owned"]),
    createdAt: now,
  });

  let rows: ReturnType<typeof readTrackerItems> = [];
  assert.doesNotThrow(() => {
    rows = readTrackerItems();
  });
  assert.equal(rows.length, 3);
  assert.deepEqual(rows[0]!.dispositionTags, ["(tags unavailable)"]);
  assert.deepEqual(rows[1]!.dispositionTags, ["(tags unavailable)"]);
  assert.deepEqual(rows[2]!.dispositionTags, ["y-pi-gsd-owned"]);

  assert.equal(renderTrackerLedger(basePath), true);
  const content = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.ok(content.includes("TRACK-001"));
  assert.ok(content.includes("TRACK-002"));
  assert.ok(content.includes("TRACK-003"));
  assert.ok(content.includes("(tags unavailable)"));
  assert.ok(content.includes("y-pi-gsd-owned"), "a sibling well-formed row's tags must still render correctly");
});

// ─── Test 10: no database open ────────────────────────────────────────────

test("no database open: renderTrackerLedger returns false, does not throw, and does not truncate existing panes", () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "Before close" }, basePath);
  const beforeClose = readFileSync(backlogPanePath(basePath), "utf-8");

  closeDatabase();

  let result: boolean | undefined;
  assert.doesNotThrow(() => {
    result = renderTrackerLedger(basePath);
  });
  assert.equal(result, false);
  const afterClose = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.equal(afterClose, beforeClose, "the existing pane must not be truncated or deleted");
});

// ─── Test 11: no temp file left behind ────────────────────────────────────

test("after a successful render, no .tmp file survives in the projection directory", () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "Cleans up its temp file" }, basePath);
  createTrackerItem({ type: "incident", title: "Also cleans up" }, basePath);

  const entries = readdirSync(gsdProjectionRoot(basePath));
  assert.ok(!entries.some((entry) => entry.endsWith(".tmp")), `no .tmp entry expected, found: ${entries.join(", ")}`);
});
