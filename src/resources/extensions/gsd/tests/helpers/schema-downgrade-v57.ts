// Project/App: gsd-pi
// File Purpose: Shared V58 -> V57 schema downgrade helper (Phase 33). Extracted
// from requirement-milestone-attribution.test.ts (33-01 Task 3) so a second
// test file (milestone-ship-domain-operation.test.ts, 33-04 Task 2) can seed
// genuinely pre-migration data and exercise the REAL openDatabase upgrade
// path without duplicating this DDL, or importing a sibling .test.ts module
// (which would re-register its test() calls as a side effect).

import { DatabaseSync } from "node:sqlite";

export const REBUILT_TABLE_NAMES = [
  "requirements",
  "workflow_waivers",
  "workflow_requirement_dispositions",
  "workflow_acceptance_criteria",
];

/** Mirrors the production capture in db-requirement-milestone-attribution-schema.ts. */
export function captureSchemaObjects(raw: DatabaseSync): Array<{ name: string; sql: string; external: boolean }> {
  const placeholders = REBUILT_TABLE_NAMES.map((t) => `'${t}'`).join(", ");
  const likeClauses = REBUILT_TABLE_NAMES.map((t) => `sql LIKE '%${t}%'`).join(" OR ");
  const captured = raw.prepare(`
    SELECT name, sql, tbl_name
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (
        (type IN ('trigger', 'index') AND tbl_name IN (${placeholders}))
        OR (type = 'trigger' AND tbl_name NOT IN (${placeholders}) AND (${likeClauses}))
      )
  `).all() as Array<{ name: string; sql: string; tbl_name: string }>;
  return captured.map((r) => ({
    name: r.name,
    sql: r.sql,
    external: !REBUILT_TABLE_NAMES.includes(r.tbl_name),
  }));
}

/**
 * Downgrade a freshly-created (V58-shaped) database back to its V57 shape —
 * bare-id `requirements` PK, single-column FKs on the three child tables, no
 * `idx_requirements_legacy_id` — so tests can seed genuinely pre-migration
 * data and then exercise the REAL `openDatabase` upgrade path. Mirrors
 * `db-operator-attested-closeout-schema.test.ts`'s `downgradeToV56`.
 */
export function downgradeToV57(dbPath: string): void {
  const raw = new DatabaseSync(dbPath);
  const captured = captureSchemaObjects(raw);
  raw.exec("PRAGMA foreign_keys = OFF");
  raw.exec("PRAGMA legacy_alter_table = ON");
  raw.exec("BEGIN");
  try {
    for (const obj of captured) {
      if (obj.external) raw.exec(`DROP TRIGGER IF EXISTS ${obj.name}`);
    }

    raw.exec(`
      CREATE TABLE requirements_v57 (
        id TEXT PRIMARY KEY,
        class TEXT NOT NULL DEFAULT '',
        status TEXT NOT NULL DEFAULT '',
        description TEXT NOT NULL DEFAULT '',
        why TEXT NOT NULL DEFAULT '',
        source TEXT NOT NULL DEFAULT '',
        primary_owner TEXT NOT NULL DEFAULT '',
        supporting_slices TEXT NOT NULL DEFAULT '',
        validation TEXT NOT NULL DEFAULT '',
        notes TEXT NOT NULL DEFAULT '',
        full_content TEXT NOT NULL DEFAULT '',
        superseded_by TEXT DEFAULT NULL
      );
      INSERT INTO requirements_v57 (id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by)
      SELECT id, class, status, description, why, source, primary_owner, supporting_slices, validation, notes, full_content, superseded_by
      FROM requirements;
      DROP TABLE requirements;
      ALTER TABLE requirements_v57 RENAME TO requirements;
    `);

    raw.exec(`
      CREATE TABLE workflow_waivers_v57 (
        waiver_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        lifecycle_id TEXT NOT NULL,
        requirement_id TEXT DEFAULT NULL,
        blocker_id TEXT DEFAULT NULL,
        waiver_status TEXT NOT NULL CHECK (waiver_status IN ('active', 'revoked', 'expired')),
        scope TEXT NOT NULL,
        rationale TEXT NOT NULL,
        granted_by_actor_type TEXT NOT NULL CHECK (granted_by_actor_type IN ('user', 'policy')),
        granted_by_actor_id TEXT DEFAULT NULL,
        granted_at TEXT NOT NULL,
        expires_at TEXT DEFAULT NULL,
        ended_at TEXT DEFAULT NULL,
        operation_id TEXT NOT NULL,
        project_revision INTEGER NOT NULL CHECK (project_revision > 0),
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
        ended_operation_id TEXT DEFAULT NULL,
        ended_project_revision INTEGER DEFAULT NULL,
        ended_authority_epoch INTEGER DEFAULT NULL,
        UNIQUE (waiver_id, requirement_id),
        CHECK (granted_by_actor_type != 'user' OR granted_by_actor_id IS NOT NULL),
        CHECK (
          (waiver_status = 'active' AND ended_at IS NULL
            AND ended_operation_id IS NULL AND ended_project_revision IS NULL
            AND ended_authority_epoch IS NULL) OR
          (waiver_status IN ('revoked', 'expired') AND ended_at IS NOT NULL
            AND ended_operation_id IS NOT NULL AND ended_project_revision > 0
            AND ended_authority_epoch >= 0)
        ),
        FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
        FOREIGN KEY (lifecycle_id, project_id)
          REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
        FOREIGN KEY (requirement_id) REFERENCES requirements(id),
        FOREIGN KEY (blocker_id, lifecycle_id)
          REFERENCES workflow_blockers(blocker_id, lifecycle_id),
        FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
          REFERENCES workflow_operations(
            operation_id, project_id, resulting_revision, resulting_authority_epoch
          ),
        FOREIGN KEY (ended_operation_id, project_id, ended_project_revision, ended_authority_epoch)
          REFERENCES workflow_operations(
            operation_id, project_id, resulting_revision, resulting_authority_epoch
          )
      );
      INSERT INTO workflow_waivers_v57 (
        waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
        waiver_status, scope, rationale, granted_by_actor_type,
        granted_by_actor_id, granted_at, expires_at, ended_at, operation_id,
        project_revision, authority_epoch, ended_operation_id,
        ended_project_revision, ended_authority_epoch
      )
      SELECT
        waiver_id, project_id, lifecycle_id, requirement_id, blocker_id,
        waiver_status, scope, rationale, granted_by_actor_type,
        granted_by_actor_id, granted_at, expires_at, ended_at, operation_id,
        project_revision, authority_epoch, ended_operation_id,
        ended_project_revision, ended_authority_epoch
      FROM workflow_waivers;
      DROP TABLE workflow_waivers;
      ALTER TABLE workflow_waivers_v57 RENAME TO workflow_waivers;
    `);

    raw.exec(`
      CREATE TABLE workflow_requirement_dispositions_v57 (
        disposition_id TEXT PRIMARY KEY,
        project_id TEXT NOT NULL,
        requirement_id TEXT NOT NULL,
        disposition TEXT NOT NULL CHECK (disposition IN ('unsatisfied', 'satisfied', 'waived')),
        waiver_id TEXT DEFAULT NULL,
        supersedes_disposition_id TEXT DEFAULT NULL UNIQUE,
        rationale TEXT NOT NULL,
        created_at TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        project_revision INTEGER NOT NULL CHECK (project_revision > 0),
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
        UNIQUE (disposition_id, requirement_id),
        CHECK (
          (disposition = 'waived' AND waiver_id IS NOT NULL) OR
          (disposition IN ('unsatisfied', 'satisfied') AND waiver_id IS NULL)
        ),
        FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
        FOREIGN KEY (requirement_id) REFERENCES requirements(id),
        FOREIGN KEY (waiver_id, requirement_id)
          REFERENCES workflow_waivers(waiver_id, requirement_id),
        FOREIGN KEY (supersedes_disposition_id, requirement_id)
          REFERENCES workflow_requirement_dispositions(disposition_id, requirement_id),
        FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
          REFERENCES workflow_operations(
            operation_id, project_id, resulting_revision, resulting_authority_epoch
          )
      );
      INSERT INTO workflow_requirement_dispositions_v57 (
        disposition_id, project_id, requirement_id, disposition,
        waiver_id, supersedes_disposition_id, rationale, created_at,
        operation_id, project_revision, authority_epoch
      )
      SELECT
        disposition_id, project_id, requirement_id, disposition,
        waiver_id, supersedes_disposition_id, rationale, created_at,
        operation_id, project_revision, authority_epoch
      FROM workflow_requirement_dispositions;
      DROP TABLE workflow_requirement_dispositions;
      ALTER TABLE workflow_requirement_dispositions_v57 RENAME TO workflow_requirement_dispositions;
    `);

    raw.exec(`
      CREATE TABLE workflow_acceptance_criteria_v57 (
        criterion_id TEXT PRIMARY KEY,
        criterion_key TEXT NOT NULL CHECK (
          length(trim(criterion_key)) > 0 AND criterion_key = lower(trim(criterion_key))
        ),
        project_id TEXT NOT NULL,
        lifecycle_id TEXT NOT NULL,
        requirement_id TEXT DEFAULT NULL,
        criterion_kind TEXT NOT NULL CHECK (criterion_kind IN ('technical', 'subjective_uat')),
        evidence_class TEXT NOT NULL CHECK (
          evidence_class IN ('command', 'runtime', 'browser', 'artifact', 'human')
        ),
        required INTEGER NOT NULL CHECK (required IN (0, 1)),
        description TEXT NOT NULL CHECK (length(trim(description)) > 0),
        supersedes_criterion_id TEXT DEFAULT NULL UNIQUE,
        created_at TEXT NOT NULL,
        operation_id TEXT NOT NULL,
        project_revision INTEGER NOT NULL CHECK (project_revision > 0),
        authority_epoch INTEGER NOT NULL CHECK (authority_epoch >= 0),
        UNIQUE (criterion_id, project_id, lifecycle_id),
        CHECK (
          (criterion_kind = 'technical' AND evidence_class != 'human') OR
          (criterion_kind = 'subjective_uat' AND evidence_class = 'human')
        ),
        FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
        FOREIGN KEY (lifecycle_id, project_id)
          REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
        FOREIGN KEY (requirement_id) REFERENCES requirements(id),
        FOREIGN KEY (supersedes_criterion_id)
          REFERENCES workflow_acceptance_criteria(criterion_id),
        FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
          REFERENCES workflow_operations(
            operation_id, project_id, resulting_revision, resulting_authority_epoch
          )
      );
      INSERT INTO workflow_acceptance_criteria_v57 (
        criterion_id, criterion_key, project_id, lifecycle_id,
        requirement_id, criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at, operation_id, project_revision,
        authority_epoch
      )
      SELECT
        criterion_id, criterion_key, project_id, lifecycle_id,
        requirement_id, criterion_kind, evidence_class, required, description,
        supersedes_criterion_id, created_at, operation_id, project_revision,
        authority_epoch
      FROM workflow_acceptance_criteria;
      DROP TABLE workflow_acceptance_criteria;
      ALTER TABLE workflow_acceptance_criteria_v57 RENAME TO workflow_acceptance_criteria;
    `);

    // `idx_requirements_legacy_id` (PR-2, V58) does not exist in the V57
    // shape — its WHERE clause names `milestone_id`, which requirements no
    // longer has after this downgrade.
    for (const obj of captured) {
      if (obj.name === "idx_requirements_legacy_id") continue;
      raw.exec(obj.sql);
    }

    raw.prepare("DELETE FROM schema_version WHERE version > 57").run();
    raw.exec("COMMIT");
  } catch (error) {
    raw.exec("ROLLBACK");
    throw error;
  } finally {
    raw.exec("PRAGMA foreign_keys = ON");
    raw.exec("PRAGMA legacy_alter_table = OFF");
  }
  raw.close();
}
