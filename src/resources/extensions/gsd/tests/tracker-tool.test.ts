// Project/App: gsd-pi
// File Purpose: Tool-surface coverage for the per-project tracker (TRACK-03)
// plus the command-vs-tool identical-DB-state parity proof (RESEARCH
// Pitfall 5) -- the reason this test file exists. `add`/schema/projection
// coverage lives in db-tracker-item-schema.test.ts (17-01); update/close/list
// command-surface coverage lives in commands-tracker.test.ts (17-02); this
// file owns 17-04's `gsd_track_*` tool handlers and executors.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { handleTrack } from "../commands-tracker.ts";
import {
  handleTrackClose,
  handleTrackCreate,
  handleTrackList,
  handleTrackUpdate,
} from "../tools/tracker-tool.ts";
import {
  executeTrackClose,
  executeTrackCreate,
  executeTrackList,
  executeTrackUpdate,
} from "../tools/workflow-tool-executors.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-tool-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

/** A directory with no `.gsd` at all -- ensureDbOpen refuses "missing-gsd-dir". */
function makeEmptyDir(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-tool-empty-"));
  tempDirs.add(basePath);
  return basePath;
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

function getRow(trackId: string): Record<string, unknown> {
  const db = _getAdapter();
  assert.ok(db);
  const row = db.prepare("SELECT * FROM tracker_items WHERE id = :id").get({ ":id": trackId }) as
    | Record<string, unknown>
    | undefined;
  assert.ok(row, `expected a row for ${trackId}`);
  return row;
}

function refRows(trackId: string): Array<Record<string, unknown>> {
  const db = _getAdapter();
  assert.ok(db);
  return db
    .prepare("SELECT ref_kind, ref_value FROM track_item_refs WHERE track_id = :id ORDER BY ref_kind, ref_value")
    .all({ ":id": trackId }) as Array<Record<string, unknown>>;
}

function trackIdOf(result: { trackId: string } | { error: string }): string {
  assert.ok(!("error" in result), `expected success, got ${JSON.stringify(result)}`);
  return (result as { trackId: string }).trackId;
}

// ─── Test 1: create through the tool ───────────────────────────────────────

test("handleTrackCreate: files an item and its refs, returns the new id", async () => {
  const basePath = makeBase();
  const result = await handleTrackCreate(
    { type: "incident", title: "tool-filed defect", severity: "HIGH", refs: [{ refKind: "phase", refValue: "17" }] },
    basePath,
  );
  const trackId = trackIdOf(result);
  assert.match(trackId, /^TRACK-\d{3}$/);

  const row = getRow(trackId);
  assert.equal(row.type, "incident");
  assert.equal(row.title, "tool-filed defect");
  assert.equal(row.severity, "HIGH");
  assert.deepEqual(refRows(trackId), [{ ref_kind: "phase", ref_value: "17" }]);
});

// ─── Test 2: validation returns, never throws ──────────────────────────────

test("handleTrackCreate: validation failures return { error }, never throw, and write nothing", async () => {
  const basePath = makeBase();

  const blank = await handleTrackCreate({ type: "incident", title: "   " }, basePath);
  assert.ok("error" in blank);
  assert.match((blank as { error: string }).error, /title/i);

  const unknownType = await handleTrackCreate({ type: "not-a-type" as never, title: "x" }, basePath);
  assert.ok("error" in unknownType);
  assert.match((unknownType as { error: string }).error, /type/i);

  const unknownSeverity = await handleTrackCreate(
    { type: "backlog", title: "x", severity: "URGENT" as never },
    basePath,
  );
  assert.ok("error" in unknownSeverity);
  assert.match((unknownSeverity as { error: string }).error, /severity/i);

  const unknownRefKind = await handleTrackCreate(
    { type: "backlog", title: "x", refs: [{ refKind: "not-a-kind" as never, refValue: "1" }] },
    basePath,
  );
  assert.ok("error" in unknownRefKind);
  assert.match((unknownRefKind as { error: string }).error, /ref kind/i);

  const db = _getAdapter();
  assert.ok(db);
  const count = db.prepare("SELECT COUNT(*) AS c FROM tracker_items").get() as { c: number };
  assert.equal(count.c, 0);
});

// ─── Test 3: update through the tool ───────────────────────────────────────

test("handleTrackUpdate: applies fields and refs; illegal status move returns { error } naming both statuses", async () => {
  const basePath = makeBase();
  const trackId = trackIdOf(await handleTrackCreate({ type: "backlog", title: "original" }, basePath));

  const updated = await handleTrackUpdate(
    { trackId, severity: "LOW", status: "in-progress", refs: [{ refKind: "phase", refValue: "17" }] },
    basePath,
  );
  assert.ok(!("error" in updated));
  assert.equal((updated as { trackId: string }).trackId, trackId);

  const row = getRow(trackId);
  assert.equal(row.severity, "LOW");
  assert.equal(row.status, "in-progress");
  assert.deepEqual(refRows(trackId), [{ ref_kind: "phase", ref_value: "17" }]);

  // Settle it, then attempt an illegal move back from a terminal status.
  const closed = await handleTrackClose({ trackId, status: "closed" }, basePath);
  assert.ok(!("error" in closed));
  const illegal = await handleTrackUpdate({ trackId, status: "in-progress" }, basePath);
  assert.ok("error" in illegal);
  assert.match((illegal as { error: string }).error, /closed/);
  assert.match((illegal as { error: string }).error, /in-progress/);
});

// ─── Test 4: close through the tool ────────────────────────────────────────

test("handleTrackClose: settles the item; a second close returns { error } naming the current status", async () => {
  const basePath = makeBase();
  const trackId = trackIdOf(await handleTrackCreate({ type: "incident", title: "to close" }, basePath));

  const closed = await handleTrackClose({ trackId, status: "wont-fix", resolutionNote: "superseded" }, basePath);
  assert.ok(!("error" in closed));
  assert.equal((closed as { status: string }).status, "wont-fix");

  const row = getRow(trackId);
  assert.equal(row.status, "wont-fix");
  assert.equal(row.resolution_note, "superseded");

  const again = await handleTrackClose({ trackId, status: "closed" }, basePath);
  assert.ok("error" in again);
  assert.match((again as { error: string }).error, /wont-fix/);
});

// ─── Test 5: list through the tool ─────────────────────────────────────────

test("handleTrackList: created_at ASC, id ASC order plus the type/status summary; --type filter", async () => {
  const basePath = makeBase();
  const backlogId = trackIdOf(await handleTrackCreate({ type: "backlog", title: "b1" }, basePath));
  const incidentId = trackIdOf(await handleTrackCreate({ type: "incident", title: "i1" }, basePath));

  const all = await handleTrackList({});
  assert.ok(!("error" in all));
  const items = (all as { items: Array<{ id: string }> }).items;
  assert.deepEqual(items.map((i) => i.id), [backlogId, incidentId]);

  const summary = (all as { summary: Array<{ type: string; status: string; count: number }> }).summary;
  assert.ok(summary.some((row) => row.type === "backlog" && row.status === "open" && row.count === 1));
  assert.ok(summary.some((row) => row.type === "incident" && row.status === "open" && row.count === 1));

  const onlyIncidents = await handleTrackList({ type: "incident" });
  assert.ok(!("error" in onlyIncidents));
  assert.deepEqual((onlyIncidents as { items: Array<{ id: string }> }).items.map((i) => i.id), [incidentId]);
});

// ─── Test 6: parity -- the reason this test file exists ───────────────────

test("parity: /gsd track and the gsd_track_* tool reach identical DB state for equivalent create/update/close", async () => {
  const basePath = makeBase();
  const ctx = makeMockCtx();

  // Create: one item through each surface with equivalent payloads.
  await handleTrack(
    'add --type backlog --title "parity" --severity LOW --detail "d" --tag t1 --ref phase:17 --ref requirement:TRACK-03',
    ctx,
    mockPi,
  );
  const commandRows = _getAdapter()!.prepare("SELECT * FROM tracker_items ORDER BY id ASC").all() as Array<
    Record<string, unknown>
  >;
  assert.equal(commandRows.length, 1);
  const commandTrackId = String(commandRows[0]!.id);

  const toolTrackId = trackIdOf(
    await handleTrackCreate(
      {
        type: "backlog",
        title: "parity",
        severity: "LOW",
        detail: "d",
        dispositionTags: ["t1"],
        refs: [
          { refKind: "phase", refValue: "17" },
          { refKind: "requirement", refValue: "TRACK-03" },
        ],
      },
      basePath,
    ),
  );

  const parityColumns = [
    "type",
    "title",
    "status",
    "severity",
    "disposition_tags",
    "detail",
    "resolution_note",
    "resolved_at",
  ];
  for (const col of parityColumns) {
    assert.equal(getRow(toolTrackId)[col], getRow(commandTrackId)[col], `create: column ${col} diverged`);
  }
  assert.deepEqual(refRows(toolTrackId), refRows(commandTrackId), "create: ref sets diverged");

  // Update: the same status/severity/ref change through both surfaces.
  await handleTrack(`update ${commandTrackId} --severity HIGH --status in-progress --ref phase:18`, ctx, mockPi);
  const toolUpdate = await handleTrackUpdate(
    { trackId: toolTrackId, severity: "HIGH", status: "in-progress", refs: [{ refKind: "phase", refValue: "18" }] },
    basePath,
  );
  assert.ok(!("error" in toolUpdate));
  for (const col of ["severity", "status", "disposition_tags", "detail"]) {
    assert.equal(getRow(toolTrackId)[col], getRow(commandTrackId)[col], `update: column ${col} diverged`);
  }
  assert.deepEqual(refRows(toolTrackId), refRows(commandTrackId), "update: ref sets diverged");

  // Close: settle both items identically.
  await handleTrack(`close ${commandTrackId} --status wont-fix --note "superseded"`, ctx, mockPi);
  const toolClose = await handleTrackClose(
    { trackId: toolTrackId, status: "wont-fix", resolutionNote: "superseded" },
    basePath,
  );
  assert.ok(!("error" in toolClose));
  for (const col of ["status", "resolution_note"]) {
    assert.equal(getRow(toolTrackId)[col], getRow(commandTrackId)[col], `close: column ${col} diverged`);
  }
});

// ─── Test 7: parity of refusals ─────────────────────────────────────────────

test("parity of refusals: command and tool surfaces refuse identical invalid input with the same message text", async () => {
  const basePath = makeBase();
  const ctx = makeMockCtx();

  // Blank title.
  await handleTrack('add --type backlog --title "   "', ctx, mockPi);
  const commandBlankMsg = ctx._notifications.at(-1)!.message;
  const toolBlank = await handleTrackCreate({ type: "backlog", title: "   " }, basePath);
  assert.ok("error" in toolBlank);
  assert.ok(commandBlankMsg.includes((toolBlank as { error: string }).error));

  // Unknown/illegal status transition.
  const trackId = trackIdOf(await handleTrackCreate({ type: "backlog", title: "refusal-parity" }, basePath));
  const closeResult = await handleTrackClose({ trackId, status: "closed" }, basePath);
  assert.ok(!("error" in closeResult));

  await handleTrack(`update ${trackId} --status in-progress`, ctx, mockPi);
  const commandTransitionMsg = ctx._notifications.at(-1)!.message;
  const toolTransition = await handleTrackUpdate({ trackId, status: "in-progress" }, basePath);
  assert.ok("error" in toolTransition);
  assert.ok(commandTransitionMsg.includes((toolTransition as { error: string }).error));

  // Unknown id.
  await handleTrack("close TRACK-999", ctx, mockPi);
  const commandUnknownMsg = ctx._notifications.at(-1)!.message;
  const toolUnknown = await handleTrackClose({ trackId: "TRACK-999", status: "closed" }, basePath);
  assert.ok("error" in toolUnknown);
  assert.ok(commandUnknownMsg.includes((toolUnknown as { error: string }).error));
});

// ─── Test 8: executor guards on database availability ──────────────────────

test("executeTrackCreate: guards on database availability, resolves isError rather than throwing", async () => {
  const emptyDir = makeEmptyDir();
  const result = await executeTrackCreate({ type: "backlog", title: "x" }, emptyDir);
  assert.equal(result.isError, true);
  assert.equal(result.details.error, "db_unavailable");
});

test("executeTrackUpdate/executeTrackClose/executeTrackList: also guard on database availability", async () => {
  const emptyDir = makeEmptyDir();

  const updateResult = await executeTrackUpdate({ trackId: "TRACK-001", severity: "LOW" }, emptyDir);
  assert.equal(updateResult.isError, true);
  assert.equal(updateResult.details.error, "db_unavailable");

  const closeResult = await executeTrackClose({ trackId: "TRACK-001" }, emptyDir);
  assert.equal(closeResult.isError, true);
  assert.equal(closeResult.details.error, "db_unavailable");

  const listResult = await executeTrackList({}, emptyDir);
  assert.equal(listResult.isError, true);
  assert.equal(listResult.details.error, "db_unavailable");
});

// ─── Test 9: executor success shape ─────────────────────────────────────────

test("executeTrackCreate: success shape names the created id, details.operation is track_create, no isError", async () => {
  const basePath = makeBase();
  const result = await executeTrackCreate({ type: "backlog", title: "via-executor" }, basePath);
  assert.equal(result.isError, undefined);
  assert.equal(result.details.operation, "track_create");
  assert.match(result.content[0]!.text, /TRACK-\d{3}/);
});

test("executeTrackUpdate/executeTrackClose/executeTrackList: success shapes name their operation, no isError", async () => {
  const basePath = makeBase();
  const created = await executeTrackCreate({ type: "backlog", title: "round-trip" }, basePath);
  assert.equal(created.isError, undefined);
  const trackId = String(created.details.trackId);

  const updated = await executeTrackUpdate({ trackId, severity: "HIGH" }, basePath);
  assert.equal(updated.isError, undefined);
  assert.equal(updated.details.operation, "track_update");
  assert.equal(updated.details.trackId, trackId);

  const closed = await executeTrackClose({ trackId, status: "resolved" }, basePath);
  assert.equal(closed.isError, undefined);
  assert.equal(closed.details.operation, "track_close");
  assert.equal(closed.details.status, "resolved");

  const listed = await executeTrackList({ all: true }, basePath);
  assert.equal(listed.isError, undefined);
  assert.equal(listed.details.operation, "track_list");
  assert.equal(listed.details.count, 1);
});
