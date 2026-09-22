// Project/App: gsd-pi
// File Purpose: v52 Gate-2 human-UAT pending ledger (LEDGER-01).
//
// `human_uat_pending` is the materialized projector row for a Gate-2
// human-UAT-required registration (D-03 #1, #3): the row is written inside the
// SAME Domain Operation transaction that commits the
// `milestone.gate2-human-uat-required` event and its outbox row, but it is
// only ever a READ surface for humans/tooling — the milestone close guard
// (`completeMilestone`) never reads this table, only the event head
// (`workflow_domain_events` + `workflow_outbox`).
//
// The `status` column is the one field this table's rows mutate after
// insert (`pending` -> `signed-off` | `signed-off-with-gap`, 13-04's
// sign-off/drain surface), so — unlike a fully-immutable receipt table —
// this schema needs a whitelist transition trigger (mirroring
// `trg_workflow_lifecycle_transition`) rather than a blanket
// BEFORE-UPDATE-RAISE(ABORT) immutability trigger.

import type { DbAdapter } from "./db-adapter.js";

export function createHumanUatPendingSchemaV52(db: DbAdapter): void {
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
    CREATE TABLE IF NOT EXISTS human_uat_pending (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL,
      task_id TEXT DEFAULT NULL,
      artifact_path TEXT DEFAULT NULL,
      partial_criteria_json TEXT NOT NULL DEFAULT '[]',
      reason TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'signed-off', 'signed-off-with-gap')),
      signed_off_at TEXT DEFAULT NULL,
      signed_off_by TEXT DEFAULT NULL,
      signoff_note TEXT DEFAULT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      created_operation_id TEXT NOT NULL,
      created_project_revision INTEGER NOT NULL CHECK (created_project_revision > 0),
      created_authority_epoch INTEGER NOT NULL CHECK (created_authority_epoch >= 0),
      last_operation_id TEXT NOT NULL,
      last_project_revision INTEGER NOT NULL CHECK (last_project_revision > 0),
      last_authority_epoch INTEGER NOT NULL CHECK (last_authority_epoch >= 0),
      FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
      FOREIGN KEY (last_operation_id, project_id, last_project_revision, last_authority_epoch)
        REFERENCES workflow_operations(
          operation_id, project_id, resulting_revision, resulting_authority_epoch
        )
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_human_uat_pending_status
    ON human_uat_pending(project_id, milestone_id, status)
  `);
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_human_uat_pending_one_open
    ON human_uat_pending(project_id, milestone_id, slice_id)
    WHERE status = 'pending'
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_human_uat_pending_identity_immutable");
  db.exec(`
    CREATE TRIGGER trg_human_uat_pending_identity_immutable
    BEFORE UPDATE ON human_uat_pending
    WHEN NEW.entry_id != OLD.entry_id
      OR NEW.project_id != OLD.project_id
      OR NEW.milestone_id != OLD.milestone_id
      OR NEW.slice_id != OLD.slice_id
      OR NEW.created_at != OLD.created_at
      OR NEW.created_operation_id != OLD.created_operation_id
    BEGIN
      SELECT RAISE(ABORT, 'human UAT pending identity is immutable');
    END
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_human_uat_pending_transition");
  db.exec(`
    CREATE TRIGGER trg_human_uat_pending_transition
    BEFORE UPDATE ON human_uat_pending
    WHEN NOT (
      OLD.status = 'pending' AND NEW.status IN ('signed-off', 'signed-off-with-gap')
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid human UAT pending status transition');
    END
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_human_uat_pending_delete");
  db.exec(`
    CREATE TRIGGER trg_human_uat_pending_delete
    BEFORE DELETE ON human_uat_pending
    BEGIN
      SELECT RAISE(ABORT, 'human UAT pending records are durable history');
    END
  `);
}
