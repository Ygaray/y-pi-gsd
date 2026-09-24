// Project/App: gsd-pi
// File Purpose: v55 per-project tracker store (TRACK-01, TRACK-02).
//
// `tracker_items` + `track_item_refs` are written by the light typed writer
// (`db/writers/tracker-item.ts`), not the revision-fenced, event-sourced
// Domain Operation seam used for milestone/slice/task lifecycle authority —
// so unlike the Gate-2 `human_uat_pending` analog this schema carries plain
// `created_at`/`updated_at` timestamps instead of operation provenance
// columns, and no `project_authority` / `workflow_operations` foreign keys.

import type { DbAdapter } from "./db-adapter.js";

export function createTrackerItemSchemaV55(db: DbAdapter): void {
  const foundation = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_operations'
  `).get() as Record<string, unknown> | undefined;
  if (!foundation) {
    // Synthetic or partially-provisioned databases (e.g. sealed import
    // fixtures stamped at a newer version without every foundation table)
    // carry no operation provenance to reference — there is nothing to
    // create or index.
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS tracker_items (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL CHECK (type IN ('backlog', 'incident')),
      title TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('open', 'in-progress', 'resolved', 'closed', 'wont-fix')),
      severity TEXT NOT NULL CHECK (severity IN ('HIGH', 'MEDIUM', 'LOW')),
      disposition_tags TEXT NOT NULL DEFAULT '[]',
      detail TEXT NOT NULL DEFAULT '',
      resolution_note TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      resolved_at TEXT DEFAULT NULL
    )
  `);

  // D-01's N:N back-reference side table: one item can carry MULTIPLE refs of
  // the SAME ref_kind (e.g. two reviews_md refs) — a shape flat nullable
  // columns on tracker_items could not express. `control_plane_incident` is
  // adopted from RESEARCH A1 so Phase 18 can point a migrated row at a
  // control-plane incident id without its own migration.
  db.exec(`
    CREATE TABLE IF NOT EXISTS track_item_refs (
      track_id TEXT NOT NULL REFERENCES tracker_items(id),
      ref_kind TEXT NOT NULL CHECK (ref_kind IN ('phase', 'requirement', 'reviews_md', 'track_item', 'control_plane_incident')),
      ref_value TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracker_items_type_status
    ON tracker_items(type, status)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_tracker_items_created
    ON tracker_items(created_at, id)
  `);
  // The unique index is what makes a duplicate ref collapse to one row while
  // two refs of the same kind with different values both persist.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_track_item_refs_unique
    ON track_item_refs(track_id, ref_kind, ref_value)
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_tracker_items_identity_immutable");
  db.exec(`
    CREATE TRIGGER trg_tracker_items_identity_immutable
    BEFORE UPDATE ON tracker_items
    WHEN NEW.id != OLD.id
      OR NEW.type != OLD.type
      OR NEW.created_at != OLD.created_at
    BEGIN
      SELECT RAISE(ABORT, 'tracker item identity is immutable');
    END
  `);

  // The leading `NEW.status != OLD.status` clause is load-bearing: without it
  // every title, severity, or tag edit would be rejected because it is not a
  // whitelisted status transition. Terminal states may only return to `open`
  // (an explicit reopen), never slide sideways into another terminal state.
  db.exec("DROP TRIGGER IF EXISTS trg_tracker_items_transition");
  db.exec(`
    CREATE TRIGGER trg_tracker_items_transition
    BEFORE UPDATE ON tracker_items
    WHEN NEW.status != OLD.status AND NOT (
      (OLD.status = 'open' AND NEW.status IN ('in-progress', 'resolved', 'closed', 'wont-fix'))
      OR (OLD.status = 'in-progress' AND NEW.status IN ('open', 'resolved', 'closed', 'wont-fix'))
      OR (OLD.status IN ('resolved', 'closed', 'wont-fix') AND NEW.status = 'open')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid tracker item status transition');
    END
  `);

  // The literal mechanism behind TRACK-01's cleanup survival: no code path,
  // including any future cleanup or archive workflow, can remove a row —
  // only change its status. Deliberately NOT added to track_item_refs: refs
  // are mutable link metadata that 17-02's update path replaces with a
  // delete-then-insert inside one transaction.
  db.exec("DROP TRIGGER IF EXISTS trg_tracker_items_delete");
  db.exec(`
    CREATE TRIGGER trg_tracker_items_delete
    BEFORE DELETE ON tracker_items
    BEGIN
      SELECT RAISE(ABORT, 'tracker items are durable history');
    END
  `);
}
