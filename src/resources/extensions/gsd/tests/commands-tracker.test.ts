// Project/App: gsd-pi
// File Purpose: Command-surface coverage for the per-project tracker's
// `update`/`close` writers and the `/gsd track update`/`/gsd track close`
// verbs (TRACK-02, TRACK-03, TRACK-04). `add`/schema/projection coverage
// lives in db-tracker-item-schema.test.ts (17-01); this file owns 17-02's
// new writer functions and command verbs end to end.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { withCommandCwd } from "../commands/context.ts";
import { handleTrack } from "../commands-tracker.ts";
import { createTrackerItem, resolveTrackerItem, updateTrackerItem } from "../db/writers/tracker-item.ts";
import { TRACKER_BACKLOG_PROJECTION_FILENAME } from "../tracker-projection.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-commands-tracker-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  return basePath;
}

function backlogPanePath(basePath: string): string {
  return join(basePath, ".gsd", TRACKER_BACKLOG_PROJECTION_FILENAME);
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

function getRow(basePath: string, trackId: string): Record<string, unknown> {
  void basePath;
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

// ─── Test 1: update mutable fields (TRACK-02) ────────────────────────────

test("updateTrackerItem: title, severity, detail, dispositionTags persist; id/type/created_at unchanged", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "original" }, basePath);
  const before = getRow(basePath, trackId);

  const { changed } = updateTrackerItem(
    {
      trackId,
      title: "renamed",
      severity: "LOW",
      detail: "more context",
      dispositionTags: ["y-pi-gsd-owned"],
    },
    basePath,
  );
  assert.equal(changed, true);

  const after = getRow(basePath, trackId);
  assert.equal(after.title, "renamed");
  assert.equal(after.severity, "LOW");
  assert.equal(after.detail, "more context");
  assert.deepEqual(JSON.parse(String(after.disposition_tags)), ["y-pi-gsd-owned"]);
  assert.equal(after.id, before.id);
  assert.equal(after.type, before.type);
  assert.equal(after.created_at, before.created_at);
  assert.ok(String(after.updated_at) >= String(before.updated_at));
});

// ─── Test 2: whole-set ref replacement (D-01) ────────────────────────────

test("updateTrackerItem: supplying refs replaces the whole set, not a merge", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem(
    {
      type: "backlog",
      title: "refs",
      refs: [
        { refKind: "phase", refValue: "17" },
        { refKind: "requirement", refValue: "TRACK-02" },
      ],
    },
    basePath,
  );
  assert.equal(refRows(trackId).length, 2);

  updateTrackerItem(
    {
      trackId,
      refs: [
        { refKind: "reviews_md", refValue: "REVIEWS.md#1" },
        { refKind: "reviews_md", refValue: "REVIEWS.md#2" },
      ],
    },
    basePath,
  );

  const rows = refRows(trackId);
  assert.equal(rows.length, 2);
  for (const row of rows) assert.equal(row.ref_kind, "reviews_md");
  assert.deepEqual(
    rows.map((r) => r.ref_value).sort(),
    ["REVIEWS.md#1", "REVIEWS.md#2"],
  );
});

// ─── Test 3: legal status advance ────────────────────────────────────────

test("updateTrackerItem: open -> in-progress -> resolved succeeds", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "advance" }, basePath);

  updateTrackerItem({ trackId, status: "in-progress" }, basePath);
  assert.equal(getRow(basePath, trackId).status, "in-progress");

  updateTrackerItem({ trackId, status: "resolved" }, basePath);
  assert.equal(getRow(basePath, trackId).status, "resolved");
});

// ─── Test 4: illegal status move refused readably ────────────────────────

test("updateTrackerItem: resolved -> closed is refused with a readable message, row unchanged", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "illegal move" }, basePath);
  updateTrackerItem({ trackId, status: "resolved" }, basePath);
  const before = getRow(basePath, trackId);

  assert.throws(
    () => updateTrackerItem({ trackId, status: "closed" }, basePath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /resolved/);
      assert.match(err.message, /closed/);
      assert.doesNotMatch(err.message.toLowerCase(), /raise\(abort/);
      assert.doesNotMatch(err.message.toLowerCase(), /sqlite/);
      return true;
    },
  );

  const after = getRow(basePath, trackId);
  assert.equal(after.status, before.status);
});

// ─── Test 5: close/resolve (TRACK-03) ────────────────────────────────────

test("resolveTrackerItem: sets status, resolved_at, resolution_note, advances updated_at", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "incident", title: "close me" }, basePath);
  const before = getRow(basePath, trackId);

  const { status } = resolveTrackerItem({ trackId, status: "closed", resolutionNote: "fixed" }, basePath);
  assert.equal(status, "closed");

  const after = getRow(basePath, trackId);
  assert.equal(after.status, "closed");
  assert.ok(after.resolved_at);
  assert.equal(after.resolution_note, "fixed");
  assert.ok(String(after.updated_at) >= String(before.updated_at));
});

// ─── Test 6: repeat close refused (idempotency) ──────────────────────────

test("resolveTrackerItem: closing an already-terminal item is refused and leaves the row byte-identical", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "incident", title: "settle once" }, basePath);
  resolveTrackerItem({ trackId, status: "closed", resolutionNote: "first" }, basePath);
  const settled = getRow(basePath, trackId);

  assert.throws(
    () => resolveTrackerItem({ trackId, status: "resolved" }, basePath),
    (err: unknown) => {
      assert.ok(err instanceof Error);
      assert.match(err.message, /already/);
      assert.match(err.message, /closed/);
      return true;
    },
  );

  const after = getRow(basePath, trackId);
  assert.equal(after.status, settled.status);
  assert.equal(after.resolved_at, settled.resolved_at);
  assert.equal(after.resolution_note, settled.resolution_note);
});

// ─── Test 7: reopen ───────────────────────────────────────────────────────

test("updateTrackerItem: closed -> open succeeds and clears resolved_at", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "incident", title: "reopen me" }, basePath);
  resolveTrackerItem({ trackId, status: "closed", resolutionNote: "settled" }, basePath);
  assert.ok(getRow(basePath, trackId).resolved_at);

  updateTrackerItem({ trackId, status: "open" }, basePath);
  const after = getRow(basePath, trackId);
  assert.equal(after.status, "open");
  assert.equal(after.resolved_at, null);
});

// ─── Test 8: panes regenerate on both new paths (TRACK-04) ───────────────

test("updateTrackerItem and resolveTrackerItem both regenerate the backlog pane", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "before rename" }, basePath);

  updateTrackerItem({ trackId, title: "after rename" }, basePath);
  const afterUpdate = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.match(afterUpdate, /after rename/);

  resolveTrackerItem({ trackId, status: "wont-fix", resolutionNote: "superseded" }, basePath);
  const afterClose = readFileSync(backlogPanePath(basePath), "utf-8");
  assert.match(afterClose, /## Closed/);
  const closedSection = afterClose.slice(afterClose.indexOf("## Closed"));
  assert.match(closedSection, new RegExp(trackId));
});

// ─── Test 9: /gsd track update end to end ────────────────────────────────

test("handleTrack('update ...') applies severity, tag, and ref changes and notifies the id", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "operator update" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () =>
    handleTrack(
      `update ${trackId} --severity HIGH --tag deferred-to-phase-21 --ref reviews_md:REVIEWS.md`,
      ctx,
      mockPi,
    ));

  const row = getRow(basePath, trackId);
  assert.equal(row.severity, "HIGH");
  assert.deepEqual(JSON.parse(String(row.disposition_tags)), ["deferred-to-phase-21"]);
  const refs = refRows(trackId);
  assert.equal(refs.length, 1);
  assert.equal(refs[0].ref_kind, "reviews_md");

  assert.equal(ctx._notifications.length, 1);
  assert.ok(ctx._notifications[0].message.includes(trackId));
});

// ─── Test 9b: /gsd track update --clear-tags/--clear-refs (IN-01) ────────

test("handleTrack('update ... --clear-tags --clear-refs') clears both sets to an explicit empty array", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem(
    {
      type: "backlog",
      title: "clearable",
      dispositionTags: ["deferred-to-phase-21"],
      refs: [{ refKind: "phase", refValue: "17" }],
    },
    basePath,
  );
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () =>
    handleTrack(`update ${trackId} --clear-tags --clear-refs`, ctx, mockPi));

  const row = getRow(basePath, trackId);
  assert.deepEqual(JSON.parse(String(row.disposition_tags)), []);
  assert.equal(refRows(trackId).length, 0);
  assert.equal(ctx._notifications.length, 1);
  assert.ok(ctx._notifications[0].message.includes(trackId));
});

test("handleTrack('update ... --clear-tags --tag ...') refuses the ambiguous combination and writes nothing", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem(
    { type: "backlog", title: "ambiguous clear", dispositionTags: ["kept"] },
    basePath,
  );
  const before = getRow(basePath, trackId);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () =>
    handleTrack(`update ${trackId} --clear-tags --tag new-tag`, ctx, mockPi));

  assert.equal(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].message, /--clear-tags cannot be combined with --tag/);
  const after = getRow(basePath, trackId);
  assert.equal(after.updated_at, before.updated_at);
  assert.deepEqual(JSON.parse(String(after.disposition_tags)), ["kept"]);
});

// ─── Test 10: /gsd track close end to end ────────────────────────────────

test("handleTrack('close ...') settles the row and notifies the resulting status", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "operator close" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () =>
    handleTrack(`close ${trackId} --status wont-fix --note "superseded"`, ctx, mockPi));

  const row = getRow(basePath, trackId);
  assert.equal(row.status, "wont-fix");
  assert.equal(row.resolution_note, "superseded");

  assert.equal(ctx._notifications.length, 1);
  assert.ok(ctx._notifications[0].message.includes("wont-fix"));
});

// ─── Test 11: empty/missing arguments write nothing ──────────────────────

test("handleTrack('close') without an id reports the missing id and writes nothing", async () => {
  const basePath = makeBase();
  const ctx = makeMockCtx();
  const db = _getAdapter();
  assert.ok(db);
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items WHERE status != 'open'").get()?.["n"] ?? 0);

  await withCommandCwd(basePath, () => handleTrack("close", ctx, mockPi));

  assert.equal(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].message, /close requires a tracker id/);
  const after = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items WHERE status != 'open'").get()?.["n"] ?? 0);
  assert.equal(after, before);
});

test("handleTrack('update <id>') with no mutating flag reports nothing requested and writes nothing", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "no-op update" }, basePath);
  const before = getRow(basePath, trackId);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () => handleTrack(`update ${trackId}`, ctx, mockPi));

  assert.equal(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].message, /no change requested/);
  const after = getRow(basePath, trackId);
  assert.equal(after.updated_at, before.updated_at);
});

// ─── Test 12: unknown id ──────────────────────────────────────────────────

test("handleTrack('close TRACK-999') notifies an error naming the unknown id and writes nothing", async () => {
  const basePath = makeBase();
  const ctx = makeMockCtx();
  const db = _getAdapter();
  assert.ok(db);
  const before = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items").get()?.["n"] ?? 0);

  await withCommandCwd(basePath, () => handleTrack("close TRACK-999", ctx, mockPi));

  assert.equal(ctx._notifications.length, 1);
  assert.match(ctx._notifications[0].message, /TRACK-999/);
  const after = Number(db.prepare("SELECT COUNT(*) AS n FROM tracker_items").get()?.["n"] ?? 0);
  assert.equal(after, before);
});
