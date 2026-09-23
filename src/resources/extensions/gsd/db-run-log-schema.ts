// Project/App: gsd-pi
// File Purpose: v54 milestone run-log schema (DRIVER-01).
//
// `milestone_run_log` is the DB-authoritative record of a milestone run's
// lifecycle -- one row per (milestone, run, attempt), mirroring the Gate-2
// human-UAT ledger pattern (D-01). The row is written inside the SAME
// Domain Operation transaction that commits the
// `milestone.run-log.recorded` event (Pattern 2), and it is the phase's
// tracer: the first write-path from the headless host process (`src/`)
// into a Domain Operation in this repository.
//
// Row identity embeds the attempt number
// (`RUN-{milestoneId}-{runId}-a{attempt}`, RESEARCH Pitfall 2) so a
// pause-then-resume of the same run creates a NEW row instead of upserting
// onto the existing one -- lifecycle history survives repeated pause/resume
// cycles. `resume_from` carries the durable `--from N` pointer (16-03).
//
// Trigger guards (identity-immutable, whitelist-transition, delete-blocking)
// enforce the DRIVER-01 lifecycle contract mechanically rather than by
// convention. The two invariant indexes make a silently double-started run
// a DB-level constraint violation (`idx_milestone_run_log_one_active`) and
// make the attempt-numbered identity enforceable at the DB, not only in the
// id string (`idx_milestone_run_log_attempt`, RESEARCH Pitfall 2).

import type { DbAdapter } from "./db-adapter.js";

export function createRunLogSchemaV54(db: DbAdapter): void {
  const foundation = db.prepare(`
    SELECT 1 AS present FROM sqlite_master WHERE type = 'table' AND name = 'workflow_operations'
  `).get() as Record<string, unknown> | undefined;
  if (!foundation) {
    // Synthetic or partially-provisioned databases (e.g. sealed import
    // fixtures stamped at a newer version without every foundation table)
    // carry no operation provenance to reference -- there is nothing to
    // create or index.
    return;
  }

  db.exec(`
    CREATE TABLE IF NOT EXISTS milestone_run_log (
      entry_id TEXT PRIMARY KEY,
      project_id TEXT NOT NULL,
      milestone_id TEXT NOT NULL,
      run_id TEXT NOT NULL,
      attempt INTEGER NOT NULL CHECK (attempt >= 1),
      status TEXT NOT NULL CHECK (status IN ('running', 'paused', 'resumed', 'completed', 'failed')),
      resume_from INTEGER DEFAULT NULL CHECK (resume_from IS NULL OR resume_from >= 1),
      pause_kind TEXT DEFAULT NULL,
      reason TEXT DEFAULT NULL,
      host_pid INTEGER NOT NULL CHECK (host_pid > 0),
      started_at TEXT NOT NULL,
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
    CREATE INDEX IF NOT EXISTS idx_milestone_run_log_status
    ON milestone_run_log(project_id, milestone_id, status)
  `);

  // Single-active-run: a DB-level constraint violation, not a convention
  // (ROADMAP SC2's "already-active run is detected rather than silently
  // double-started").
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_run_log_one_active
    ON milestone_run_log(project_id, milestone_id)
    WHERE status = 'running'
  `);

  // Attempt-numbered identity, enforced at the DB (RESEARCH Pitfall 2): a
  // pause/resume of the same run cannot collapse two attempts onto one row.
  db.exec(`
    CREATE UNIQUE INDEX IF NOT EXISTS idx_milestone_run_log_attempt
    ON milestone_run_log(project_id, milestone_id, run_id, attempt)
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_milestone_run_log_identity_immutable");
  db.exec(`
    CREATE TRIGGER trg_milestone_run_log_identity_immutable
    BEFORE UPDATE ON milestone_run_log
    WHEN NEW.entry_id != OLD.entry_id
      OR NEW.project_id != OLD.project_id
      OR NEW.milestone_id != OLD.milestone_id
      OR NEW.run_id != OLD.run_id
      OR NEW.attempt != OLD.attempt
      OR NEW.host_pid != OLD.host_pid
      OR NEW.started_at != OLD.started_at
      OR NEW.created_operation_id != OLD.created_operation_id
    BEGIN
      SELECT RAISE(ABORT, 'milestone run-log identity is immutable');
    END
  `);

  // Whitelist transition (Task 1's locked vocabulary): running -> paused |
  // completed | failed; paused -> resumed | failed. resumed, completed, and
  // failed are terminal -- zero outgoing transitions. Every other UPDATE of
  // status (including a same-status no-op UPDATE) aborts.
  db.exec("DROP TRIGGER IF EXISTS trg_milestone_run_log_transition");
  db.exec(`
    CREATE TRIGGER trg_milestone_run_log_transition
    BEFORE UPDATE ON milestone_run_log
    WHEN NOT (
      (OLD.status = 'running' AND NEW.status IN ('paused', 'completed', 'failed'))
      OR (OLD.status = 'paused' AND NEW.status IN ('resumed', 'failed'))
    )
    BEGIN
      SELECT RAISE(ABORT, 'invalid milestone run-log status transition');
    END
  `);

  db.exec("DROP TRIGGER IF EXISTS trg_milestone_run_log_delete");
  db.exec(`
    CREATE TRIGGER trg_milestone_run_log_delete
    BEFORE DELETE ON milestone_run_log
    BEGIN
      SELECT RAISE(ABORT, 'milestone run-log records are durable history');
    END
  `);
}
