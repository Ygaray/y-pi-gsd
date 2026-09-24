// Project/App: gsd-pi
// File Purpose: Proof that D-03's backlog supersession holds: the retired
// file-authoritative /gsd backlog command cannot be reached at all, the
// redirect delegates onto real /gsd track actions, and
// `seedSupersededBacklogEntries` migrates exactly the three ROADMAP
// `999.1`-`999.3` entries into the tracker -- idempotently, with their
// rationale and provenance refs intact, and positively excluding `999.4`/
// `999.5`.

import assert from "node:assert/strict";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import type { ExtensionAPI, ExtensionCommandContext } from "@gsd/pi-coding-agent";

import { _getAdapter, closeDatabase, openDatabase } from "../gsd-db.ts";
import { withCommandCwd } from "../commands/context.ts";
import { handleWorkflowCommand } from "../commands/handlers/workflow.ts";
import {
  SUPERSEDED_BACKLOG_ENTRIES,
  SUPERSEDED_BACKLOG_TAG,
  seedSupersededBacklogEntries,
} from "../tracker-legacy-backlog-seed.ts";
import {
  TRACKER_BACKLOG_PROJECTION_FILENAME,
  TRACKER_INCIDENTS_PROJECTION_FILENAME,
} from "../tracker-projection.ts";

const tempDirs = new Set<string>();

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

function makeBase(): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-tracker-supersede-"));
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

// ─── Test 1: the retired module is gone, D-03 ────────────────────────────

test("commands-backlog.ts is gone and cannot be imported (D-03)", async () => {
  const modulePath = join(import.meta.dirname, "..", "commands-backlog.ts");
  assert.equal(existsSync(modulePath), false);
  // Built via concatenation (not a literal specifier) so tsc never tries to
  // statically resolve a module that is supposed to be gone -- this is the
  // runtime proof that the D-03 dynamic-import dispatch path would fail too.
  const deletedModuleSpecifier = "../commands-backlog" + ".js";
  await assert.rejects(() => import(deletedModuleSpecifier));
});

// ─── Test 2: seed creates exactly three rows ─────────────────────────────

test("seedSupersededBacklogEntries: creates exactly three backlog rows carrying the supersession tag", () => {
  const basePath = makeBase();

  const { created, skipped } = seedSupersededBacklogEntries(basePath);

  assert.equal(created.length, 3);
  assert.equal(skipped.length, 0);

  const rows = allRows();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    assert.equal(row.type, "backlog");
    assert.equal(row.status, "open");
    const title = String(row.title);
    assert.ok(
      title.startsWith("[999.1] ") || title.startsWith("[999.2] ") || title.startsWith("[999.3] "),
      `unexpected title: ${title}`,
    );
    const tags = JSON.parse(String(row.disposition_tags)) as string[];
    assert.ok(tags.includes(SUPERSEDED_BACKLOG_TAG));
  }
});

// ─── Test 3: excluded entries are positively absent ──────────────────────

test("seedSupersededBacklogEntries: 999.4 and 999.5 are positively absent, total row count is exactly 3", () => {
  const basePath = makeBase();

  seedSupersededBacklogEntries(basePath);

  const rows = allRows();
  assert.equal(rows.length, 3);
  for (const row of rows) {
    const title = String(row.title);
    assert.ok(!title.includes("999.4"), `unexpected 999.4 row: ${title}`);
    assert.ok(!title.includes("999.5"), `unexpected 999.5 row: ${title}`);
  }
});

// ─── Test 4: idempotency ──────────────────────────────────────────────────

test("seedSupersededBacklogEntries: a second call creates nothing and leaves rows unchanged", () => {
  const basePath = makeBase();

  const first = seedSupersededBacklogEntries(basePath);
  assert.equal(first.created.length, 3);
  const before = allRows();

  const second = seedSupersededBacklogEntries(basePath);
  assert.equal(second.created.length, 0);
  assert.equal(second.skipped.length, 3);

  const after = allRows();
  assert.equal(after.length, 3);
  for (let i = 0; i < before.length; i++) {
    assert.equal(after[i].id, before[i].id);
    assert.equal(after[i].created_at, before[i].created_at);
  }
});

// ─── Test 5: provenance refs and non-empty rationale ─────────────────────

test("seedSupersededBacklogEntries: 999.2 carries a phase ref, 999.3 carries requirement refs, every detail is non-empty", () => {
  const basePath = makeBase();

  seedSupersededBacklogEntries(basePath);

  const rows = allRows();
  for (const row of rows) {
    assert.ok(String(row.detail).trim().length > 0, `expected non-empty detail for ${row.id}`);
  }

  const row992 = rows.find((r) => String(r.title).startsWith("[999.2] "));
  assert.ok(row992);
  const refs992 = refsFor(String(row992!.id));
  assert.ok(refs992.some((r) => r.ref_kind === "phase" && String(r.ref_value).includes("15-ship-archive-close-out")));

  const row993 = rows.find((r) => String(r.title).startsWith("[999.3] "));
  assert.ok(row993);
  const refs993 = refsFor(String(row993!.id));
  const refValues = refs993.filter((r) => r.ref_kind === "requirement").map((r) => String(r.ref_value));
  for (const expected of ["CONV-06", "CONV-07", "BACKPORT-01", "BACKPORT-02"]) {
    assert.ok(refValues.includes(expected), `expected requirement ref ${expected}, got ${refValues.join(", ")}`);
  }
});

// ─── Test 6: pane regeneration ────────────────────────────────────────────

test("seedSupersededBacklogEntries: BACKLOG.md lists all three ids and titles; INCIDENTS.md stays empty", () => {
  const basePath = makeBase();

  const { created } = seedSupersededBacklogEntries(basePath);

  const backlogContent = readFileSync(backlogPanePath(basePath), "utf-8");
  for (const id of created) {
    assert.match(backlogContent, new RegExp(id));
  }
  for (const entry of SUPERSEDED_BACKLOG_ENTRIES) {
    assert.ok(backlogContent.includes(entry.title), `expected title in pane: ${entry.title}`);
  }

  const incidentsContent = readFileSync(incidentsPanePath(basePath), "utf-8");
  assert.match(incidentsContent, /No open incidents items\./);
  assert.match(incidentsContent, /No closed incidents items\./);
});

// ─── Test 7: the redirect delegates ──────────────────────────────────────

test("handleWorkflowCommand('backlog list') delegates to /gsd track instead of dead-ending", async () => {
  const basePath = makeBase();
  seedSupersededBacklogEntries(basePath);
  const ctx = makeMockCtx();

  const handled = await withCommandCwd(basePath, () => handleWorkflowCommand("backlog list", ctx, mockPi));

  assert.equal(handled, true);
  assert.ok(ctx._notifications.length >= 2);
  assert.ok(
    ctx._notifications.some((n) => n.message.includes("/gsd track")),
    `expected a notification naming /gsd track, got: ${JSON.stringify(ctx._notifications)}`,
  );
  const listNotification = ctx._notifications[ctx._notifications.length - 1];
  assert.ok(listNotification.message.includes("999.1"), `expected tracker list output, got: ${listNotification.message}`);
});
