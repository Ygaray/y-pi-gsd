// Project/App: gsd-pi
// File Purpose: Coverage for the per-project tracker's deterministic status
// summary (`getTrackerStatusSummary`, D-02, TRACK-05) and `/gsd track list`
// rendering it (TRACK-03). COUNT/GROUP BY correctness, the three legitimate
// empty cases, the never-fails-open contract, and the list command's
// filters/default-routing all live here per the plan's file assignment.

import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { withCommandCwd } from "../commands/context.ts";
import { handleTrack } from "../commands-tracker.ts";
import { createTrackerItem, resolveTrackerItem } from "../db/writers/tracker-item.ts";
import { getTrackerStatusSummary } from "../db/queries.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-queries-tracker-status-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
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

// ─── Test 1: grouping, adjacency ─────────────────────────────────────────

test("getTrackerStatusSummary: groups rows into one summary row per (type, status) pair", () => {
  const basePath = makeBase();
  const a = createTrackerItem({ type: "backlog", title: "b-open-1" }, basePath);
  createTrackerItem({ type: "backlog", title: "b-open-2" }, basePath);
  const c = createTrackerItem({ type: "backlog", title: "b-closed-1" }, basePath);
  createTrackerItem({ type: "incident", title: "i-open-1" }, basePath);
  void a;
  // Settle one backlog item so it lands in a different (type, status) bucket.
  resolveTrackerItem({ trackId: c.trackId, status: "closed" }, basePath);

  const summary = getTrackerStatusSummary();
  assert.equal(summary.length, 3);
  const byPair = new Map(summary.map((row) => [`${row.type}:${row.status}`, row.count]));
  assert.equal(byPair.get("backlog:closed"), 1);
  assert.equal(byPair.get("backlog:open"), 2);
  assert.equal(byPair.get("incident:open"), 1);
});

// ─── Test 2: ordering ─────────────────────────────────────────────────────

test("getTrackerStatusSummary: rows are ordered type ASC, status ASC", () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "incident", title: "settle me" }, basePath);
  resolveTrackerItem({ trackId, status: "closed" }, basePath);
  createTrackerItem({ type: "incident", title: "stays open" }, basePath);
  createTrackerItem({ type: "backlog", title: "also open" }, basePath);

  const summary = getTrackerStatusSummary();
  assert.deepEqual(summary, [
    { type: "backlog", status: "open", count: 1 },
    { type: "incident", status: "closed", count: 1 },
    { type: "incident", status: "open", count: 1 },
  ]);
});

// ─── Test 3: empty tracker ─────────────────────────────────────────────────

test("getTrackerStatusSummary: an open database with zero tracker rows returns []", () => {
  makeBase();
  assert.deepEqual(getTrackerStatusSummary(), []);
});

// ─── Test 4: no database open ─────────────────────────────────────────────

test("getTrackerStatusSummary: no open database returns [] and does not throw", () => {
  makeBase();
  closeDatabase();
  assert.doesNotThrow(() => getTrackerStatusSummary());
  assert.deepEqual(getTrackerStatusSummary(), []);
});

// ─── Test 5: table not provisioned ────────────────────────────────────────

test("getTrackerStatusSummary: tracker tables never provisioned returns [] and does not throw", () => {
  makeBase();
  const db = _getAdapter();
  assert.ok(db);
  db.exec("DROP TABLE track_item_refs");
  db.exec("DROP TABLE tracker_items");

  assert.doesNotThrow(() => getTrackerStatusSummary());
  assert.deepEqual(getTrackerStatusSummary(), []);
});

// ─── Test 6: never fails open ─────────────────────────────────────────────

test("getTrackerStatusSummary: an unreadable tracker throws rather than rendering zero", () => {
  makeBase();
  const db = _getAdapter();
  assert.ok(db);
  db.exec("DROP TABLE tracker_items");
  db.exec("CREATE TABLE tracker_items (id TEXT PRIMARY KEY, type TEXT NOT NULL)");

  assert.throws(() => getTrackerStatusSummary());
});

// ─── Test 7: /gsd track list renders the summary (D-02) ──────────────────

test("handleTrack('list') notifies a one-line summary plus item lines in created_at ASC, id ASC order", async () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "first filed" }, basePath);
  createTrackerItem({ type: "incident", title: "second filed" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () => handleTrack("list", ctx, mockPi));

  assert.ok(ctx._notifications.length >= 2, "expects a summary notification and an item-list notification");
  const summaryMessage = ctx._notifications[0].message;
  assert.match(summaryMessage, /backlog/);
  assert.match(summaryMessage, /incident/);
  assert.match(summaryMessage, /open/);

  const itemsMessage = ctx._notifications[ctx._notifications.length - 1].message;
  const firstIndex = itemsMessage.indexOf("first filed");
  const secondIndex = itemsMessage.indexOf("second filed");
  assert.ok(firstIndex >= 0 && secondIndex >= 0, "both items should be listed");
  assert.ok(firstIndex < secondIndex, "items must be listed in created_at ASC, id ASC order");
});

// ─── Test 8: /gsd track list filters ──────────────────────────────────────

test("handleTrack('list --type incident') lists only incidents", async () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "a backlog item" }, basePath);
  createTrackerItem({ type: "incident", title: "an incident item" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () => handleTrack("list --type incident", ctx, mockPi));

  const itemsMessage = ctx._notifications[ctx._notifications.length - 1].message;
  assert.match(itemsMessage, /an incident item/);
  assert.doesNotMatch(itemsMessage, /a backlog item/);
});

test("handleTrack('list --status open') lists only open items", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "will be closed" }, basePath);
  resolveTrackerItem({ trackId, status: "closed" }, basePath);
  createTrackerItem({ type: "backlog", title: "stays open" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () => handleTrack("list --status open", ctx, mockPi));

  const itemsMessage = ctx._notifications[ctx._notifications.length - 1].message;
  assert.match(itemsMessage, /stays open/);
  assert.doesNotMatch(itemsMessage, /will be closed/);
});

test("handleTrack('list') defaults to open + in-progress; --all includes terminal items", async () => {
  const basePath = makeBase();
  const { trackId } = createTrackerItem({ type: "backlog", title: "terminal item" }, basePath);
  resolveTrackerItem({ trackId, status: "wont-fix" }, basePath);
  createTrackerItem({ type: "backlog", title: "active item" }, basePath);

  const defaultCtx = makeMockCtx();
  await withCommandCwd(basePath, () => handleTrack("list", defaultCtx, mockPi));
  const defaultMessage = defaultCtx._notifications[defaultCtx._notifications.length - 1].message;
  assert.match(defaultMessage, /active item/);
  assert.doesNotMatch(defaultMessage, /terminal item/);

  const allCtx = makeMockCtx();
  await withCommandCwd(basePath, () => handleTrack("list --all", allCtx, mockPi));
  const allMessage = allCtx._notifications[allCtx._notifications.length - 1].message;
  assert.match(allMessage, /active item/);
  assert.match(allMessage, /terminal item/);
});

// ─── Test 9: empty invocation behaves exactly as list ─────────────────────

test("handleTrack('') behaves exactly as list -- no error, no usage dump", async () => {
  const basePath = makeBase();
  createTrackerItem({ type: "backlog", title: "visible via empty invocation" }, basePath);
  const ctx = makeMockCtx();

  await withCommandCwd(basePath, () => handleTrack("", ctx, mockPi));

  for (const notification of ctx._notifications) {
    assert.notEqual(notification.type, "warning");
    assert.doesNotMatch(notification.message, /^Usage:/);
  }
  const itemsMessage = ctx._notifications[ctx._notifications.length - 1].message;
  assert.match(itemsMessage, /visible via empty invocation/);
});
