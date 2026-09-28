// Project/App: gsd-pi
// File Purpose: V58 requirement-to-milestone attribution — schema-level
// `milestone_id` on `requirements` plus composite-FK widening on the three
// referencing audit tables (Phase 33, RELY-05, RD-01 Option 2, TRACK-002).
//
// Mirrors the V57 `operator-attested` precedent's foreign-keys-off table
// rebuild exactly, but touches FOUR tables instead of one: `requirements`'s
// primary key widens from bare `id` to composite `(milestone_id, id)`
// (D-01), and `workflow_waivers`, `workflow_requirement_dispositions`, and
// `workflow_acceptance_criteria` each hold a
// `FOREIGN KEY (requirement_id) REFERENCES requirements(id)` that breaks the
// moment the parent's shape changes (RESEARCH NEW-1, verified live:
// `foreign key mismatch` on first write). RD-01 Option 2 widens all three to
// a composite `FOREIGN KEY (milestone_id, requirement_id)
// REFERENCES requirements(milestone_id, id)` rather than dropping the FK.
//
// PR-1 (planner correctness repair): the three child `milestone_id` columns
// are NULLABLE, not NOT NULL as RD-01's guidance literally said — a
// populated database has pre-migration `requirements` rows backfilled to
// NULL (D-02), and `workflow_acceptance_criteria` rows written by
// `db/writers/task-verification.ts` bind no `requirement_id` at all, so a
// NOT NULL child column is unrepresentable for them. A table CHECK requires
// `milestone_id` to stay NULL whenever `requirement_id` is NULL, and SQLite
// skips FK enforcement entirely when any composite-key column is NULL
// (PR-3), so un-threaded write sites (plan 33-02's scope) degrade safely to
// "not yet FK-checked" rather than throwing mid-phase.
//
// PR-2: `idx_requirements_legacy_id`, a UNIQUE index on `requirements(id)
// WHERE milestone_id IS NULL`, preserves single-id uniqueness for legacy
// (NULL-milestone) rows — SQLite treats NULLs as distinct inside a plain
// composite unique constraint, so the bare composite PK alone would let two
// legacy rows share one id and silently break `INSERT OR REPLACE`'s dedup.

import type { DbAdapter } from "./db-adapter.js";
import { TERMINAL_STATUS_SQL } from "./db/sql-constants.js";
import { logWarning } from "./workflow-logger.js";

export const REQUIREMENTS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS {NAME} (
    milestone_id TEXT DEFAULT NULL,
    id TEXT NOT NULL,
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
    superseded_by TEXT DEFAULT NULL,
    PRIMARY KEY (milestone_id, id)
  )
`;

// Not templated: this index always attaches to the live `requirements`
// table name, for both the fresh-install path and the post-rebuild path.
export const REQUIREMENTS_LEGACY_ID_INDEX_DDL =
  "CREATE UNIQUE INDEX IF NOT EXISTS idx_requirements_legacy_id ON requirements(id) WHERE milestone_id IS NULL";

export const WORKFLOW_WAIVERS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS {NAME} (
    waiver_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    lifecycle_id TEXT NOT NULL,
    milestone_id TEXT DEFAULT NULL,
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
    CHECK (milestone_id IS NULL OR requirement_id IS NOT NULL),
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
    FOREIGN KEY (milestone_id, requirement_id) REFERENCES requirements(milestone_id, id),
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
  )
`;

export const WORKFLOW_REQUIREMENT_DISPOSITIONS_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS {NAME} (
    disposition_id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL,
    milestone_id TEXT DEFAULT NULL,
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
    CHECK (milestone_id IS NULL OR requirement_id IS NOT NULL),
    FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
    FOREIGN KEY (milestone_id, requirement_id) REFERENCES requirements(milestone_id, id),
    FOREIGN KEY (waiver_id, requirement_id)
      REFERENCES workflow_waivers(waiver_id, requirement_id),
    FOREIGN KEY (supersedes_disposition_id, requirement_id)
      REFERENCES workflow_requirement_dispositions(disposition_id, requirement_id),
    FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
      REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
  )
`;

export const WORKFLOW_ACCEPTANCE_CRITERIA_TABLE_DDL = `
  CREATE TABLE IF NOT EXISTS {NAME} (
    criterion_id TEXT PRIMARY KEY,
    criterion_key TEXT NOT NULL CHECK (
      length(trim(criterion_key)) > 0 AND criterion_key = lower(trim(criterion_key))
    ),
    project_id TEXT NOT NULL,
    lifecycle_id TEXT NOT NULL,
    milestone_id TEXT DEFAULT NULL,
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
    CHECK (milestone_id IS NULL OR requirement_id IS NOT NULL),
    FOREIGN KEY (project_id) REFERENCES project_authority(project_id),
    FOREIGN KEY (lifecycle_id, project_id)
      REFERENCES workflow_item_lifecycles(lifecycle_id, project_id),
    FOREIGN KEY (milestone_id, requirement_id) REFERENCES requirements(milestone_id, id),
    FOREIGN KEY (supersedes_criterion_id)
      REFERENCES workflow_acceptance_criteria(criterion_id),
    FOREIGN KEY (operation_id, project_id, project_revision, authority_epoch)
      REFERENCES workflow_operations(
        operation_id, project_id, resulting_revision, resulting_authority_epoch
      )
  )
`;

const REBUILT_TABLES = [
  "requirements",
  "workflow_waivers",
  "workflow_requirement_dispositions",
  "workflow_acceptance_criteria",
] as const;

function tableSql(db: DbAdapter, name: string): string | undefined {
  const row = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  ).get(name) as Record<string, unknown> | undefined;
  return typeof row?.["sql"] === "string" ? (row["sql"] as string) : undefined;
}

interface CapturedSchemaObject {
  name: string;
  sql: string;
  external: boolean;
}

/**
 * Read every trigger and index attached to the four rebuilt tables, PLUS any
 * trigger defined on ANOTHER table whose body names one of the four (e.g.
 * `workflow_technical_verdicts`' scope trigger joins through
 * `workflow_acceptance_criteria`). `DROP TABLE` silently discards a table's
 * OWN triggers/indexes and leaves external references dangling — both
 * categories must be captured before the drop and recreated after the
 * rename, mirroring `rebuildWorkflowItemLifecyclesForOperatorAttested`.
 * Read directly from `sqlite_master` (not a hardcoded DDL list) so this
 * generalizes across every schema version that has ever added a trigger
 * referencing these tables.
 */
function captureAttachedSchemaObjects(db: DbAdapter): CapturedSchemaObject[] {
  const placeholders = REBUILT_TABLES.map((t) => `'${t}'`).join(", ");
  const likeClauses = REBUILT_TABLES.map((t) => `sql LIKE '%${t}%'`).join(" OR ");
  const rows = db.prepare(`
    SELECT name, sql, tbl_name
    FROM sqlite_master
    WHERE sql IS NOT NULL
      AND (
        (type IN ('trigger', 'index') AND tbl_name IN (${placeholders}))
        OR (type = 'trigger' AND tbl_name NOT IN (${placeholders}) AND (${likeClauses}))
      )
  `).all() as Array<Record<string, unknown>>;
  return rows.map((r) => ({
    name: String(r["name"]),
    sql: String(r["sql"]),
    external: !(REBUILT_TABLES as readonly string[]).includes(String(r["tbl_name"])),
  }));
}

const REQUIREMENTS_COLUMNS = [
  "milestone_id", "id", "class", "status", "description", "why", "source",
  "primary_owner", "supporting_slices", "validation", "notes", "full_content",
  "superseded_by",
];

const WORKFLOW_WAIVERS_COLUMNS = [
  "waiver_id", "project_id", "lifecycle_id", "milestone_id", "requirement_id",
  "blocker_id", "waiver_status", "scope", "rationale", "granted_by_actor_type",
  "granted_by_actor_id", "granted_at", "expires_at", "ended_at", "operation_id",
  "project_revision", "authority_epoch", "ended_operation_id",
  "ended_project_revision", "ended_authority_epoch",
];

const WORKFLOW_REQUIREMENT_DISPOSITIONS_COLUMNS = [
  "disposition_id", "project_id", "milestone_id", "requirement_id", "disposition",
  "waiver_id", "supersedes_disposition_id", "rationale", "created_at",
  "operation_id", "project_revision", "authority_epoch",
];

const WORKFLOW_ACCEPTANCE_CRITERIA_COLUMNS = [
  "criterion_id", "criterion_key", "project_id", "lifecycle_id", "milestone_id",
  "requirement_id", "criterion_kind", "evidence_class", "required", "description",
  "supersedes_criterion_id", "created_at", "operation_id", "project_revision",
  "authority_epoch",
];

/**
 * Create `{name}_v58` from `ddl`, copy every row from `name` (binding NULL
 * for the new `milestone_id` column), drop `name`, and rename `_v58` onto
 * `name`. Caller owns the surrounding foreign-keys-off transaction.
 */
function countRows(db: DbAdapter, name: string): number {
  const result = db.prepare(`SELECT COUNT(*) AS c FROM ${name}`).get() as Record<string, unknown> | undefined;
  return Number(result?.["c"] ?? 0);
}

/**
 * Create `{name}_v58` from `ddl`, copy every row from `name` (binding NULL
 * for the new `milestone_id` column), drop `name`, and rename `_v58` onto
 * `name`. Caller owns the surrounding foreign-keys-off transaction.
 */
function rebuildTable(db: DbAdapter, name: string, ddl: string, columns: readonly string[]): void {
  const newName = `${name}_v58`;
  const selectColumns = columns.map((c) => (c === "milestone_id" ? "NULL" : c)).join(", ");
  db.exec(ddl.replace("{NAME}", newName));
  db.exec(`
    INSERT INTO ${newName} (${columns.join(", ")})
    SELECT ${selectColumns}
    FROM ${name}
  `);
  db.exec(`DROP TABLE ${name}`);
  db.exec(`ALTER TABLE ${newName} RENAME TO ${name}`);
}

/**
 * Pitfall NEW-2 (Task 3, D-02 narrow exception): after the rebuild leaves
 * every `requirements` row NULL, re-attribute the SINGLE currently-active
 * (non-terminal, non-parked) milestone's own pre-migration rows to itself —
 * otherwise that milestone's own in-flight requirements silently vanish
 * from its future ship snapshot the moment it ships. D-02's prohibition on
 * re-deriving attribution via slice-id matching does not apply here: D-02
 * forbids it because the heuristic is ambiguous when several milestones
 * could claim a row, and at migration time there is at most one candidate.
 * If zero or more than one non-terminal milestone exists, skip the
 * carve-out entirely (a wrong attribution is worse than an absent one) and
 * log a warning so the skip is observable.
 *
 * Deliberately does NOT call `getActiveMilestoneIdFromDb()`: that reads the
 * module-global database handle, which is not installed during a migration,
 * and it returns a summary object rather than a bare id.
 */
function applyActiveMilestoneCarveOut(db: DbAdapter): void {
  const candidates = db.prepare(
    `SELECT id FROM milestones WHERE status NOT IN (${TERMINAL_STATUS_SQL}, 'parked')`,
  ).all() as Array<Record<string, unknown>>;
  if (candidates.length !== 1) {
    logWarning(
      "db",
      `V58 active-milestone carve-out skipped: found ${candidates.length} non-terminal, non-parked ` +
        "milestone(s) (must be exactly 1) — all pre-migration requirement rows stay NULL",
    );
    return;
  }
  const activeMilestoneId = String(candidates[0]!["id"]);
  const sliceRows = db.prepare("SELECT id FROM slices WHERE milestone_id = ?").all(activeMilestoneId) as Array<
    Record<string, unknown>
  >;
  const sliceIds = new Set(sliceRows.map((r) => String(r["id"])));
  if (sliceIds.size === 0) return;

  const candidateRequirements = db.prepare(
    "SELECT id, primary_owner, supporting_slices FROM requirements WHERE milestone_id IS NULL",
  ).all() as Array<Record<string, unknown>>;
  const claim = db.prepare("UPDATE requirements SET milestone_id = :milestone_id WHERE id = :id AND milestone_id IS NULL");
  for (const requirement of candidateRequirements) {
    const primaryOwner = String(requirement["primary_owner"] ?? "");
    const supportingSlices = String(requirement["supporting_slices"] ?? "")
      .split(/[,\s]+/)
      .filter((id) => id.length > 0);
    const matches = sliceIds.has(primaryOwner) || supportingSlices.some((id) => sliceIds.has(id));
    if (matches) {
      claim.run({ ":milestone_id": activeMilestoneId, ":id": String(requirement["id"]) });
    }
  }
}

/**
 * Rebuild `requirements` onto composite `PRIMARY KEY (milestone_id, id)` and
 * widen the three referencing audit tables onto composite foreign keys
 * (RD-01 Option 2 / D-01). Runs SQLite's prescribed foreign-keys-off table
 * rebuild — the pragma cannot change inside a transaction, so callers MUST
 * invoke this before opening the migration transaction. Fresh installs skip
 * this entirely: `migrateSchema` short-circuits before the hoisted call
 * below even runs, because a fresh database is already stamped at
 * SCHEMA_VERSION by the time `migrateSchema` is reached.
 *
 * Order matters: `requirements` is rebuilt FIRST, so each child's new
 * composite foreign key resolves against the already-rebuilt parent by the
 * time that child table is (re)created. All four rebuilds share ONE
 * foreign-keys-off transaction, so the parent's momentarily-stale-shaped
 * children are never subject to enforcement mid-sequence.
 *
 * Task 3 hardening: a row-count parity check on every table that exists
 * here throws before COMMIT if the copy dropped or duplicated any row — the
 * pre-existing `backupDatabaseBeforeMigration` already snapshotted the file
 * before this runs, so a thrown parity error leaves the operator with a
 * recoverable copy rather than a half-rebuilt database.
 */
export function rebuildRequirementsForMilestoneAttribution(db: DbAdapter): void {
  const requirementsSql = tableSql(db, "requirements");
  if (typeof requirementsSql !== "string") return; // not created yet
  if (requirementsSql.includes("milestone_id")) return; // already migrated (idempotent)

  const captured = captureAttachedSchemaObjects(db);
  const childSpecs = [
    { name: "workflow_waivers", ddl: WORKFLOW_WAIVERS_TABLE_DDL, columns: WORKFLOW_WAIVERS_COLUMNS },
    {
      name: "workflow_requirement_dispositions",
      ddl: WORKFLOW_REQUIREMENT_DISPOSITIONS_TABLE_DDL,
      columns: WORKFLOW_REQUIREMENT_DISPOSITIONS_COLUMNS,
    },
    {
      name: "workflow_acceptance_criteria",
      ddl: WORKFLOW_ACCEPTANCE_CRITERIA_TABLE_DDL,
      columns: WORKFLOW_ACCEPTANCE_CRITERIA_COLUMNS,
    },
  ] as const;
  const existingChildren = childSpecs.filter((child) => tableSql(db, child.name) !== undefined);

  const beforeCounts = new Map<string, number>();
  beforeCounts.set("requirements", countRows(db, "requirements"));
  for (const child of existingChildren) beforeCounts.set(child.name, countRows(db, child.name));

  db.exec("PRAGMA foreign_keys = OFF");
  db.exec("PRAGMA legacy_alter_table = ON");
  db.exec("BEGIN");
  try {
    for (const obj of captured) {
      if (obj.external) db.exec(`DROP TRIGGER IF EXISTS ${obj.name}`);
    }

    // `requirements` has existed since V1, so it always exists here.
    rebuildTable(db, "requirements", REQUIREMENTS_TABLE_DDL, REQUIREMENTS_COLUMNS);

    // The three child tables were added at V32/V34 — a pre-V32 legacy
    // database being upgraded through this hoisted step does not have them
    // yet. Skip rebuilding a table that does not exist: the migration
    // ladder's own createXSchemaVN step creates it later, already in the
    // final composite-FK shape (its DDL is sourced from these same shared
    // templates), so there is nothing to rebuild.
    for (const child of existingChildren) {
      rebuildTable(db, child.name, child.ddl, child.columns);
    }

    const afterCounts = new Map<string, number>();
    afterCounts.set("requirements", countRows(db, "requirements"));
    for (const child of existingChildren) afterCounts.set(child.name, countRows(db, child.name));
    for (const [name, before] of beforeCounts) {
      const after = afterCounts.get(name);
      if (after !== before) {
        throw new Error(`V58 rebuild row-count mismatch on ${name}: before=${before} after=${after}`);
      }
    }

    applyActiveMilestoneCarveOut(db);

    db.exec(REQUIREMENTS_LEGACY_ID_INDEX_DDL);

    for (const obj of captured) {
      db.exec(obj.sql);
    }

    db.exec("COMMIT");
  } catch (error) {
    try { db.exec("ROLLBACK"); } catch { /* already rolled back */ }
    throw error;
  } finally {
    db.exec("PRAGMA foreign_keys = ON");
    db.exec("PRAGMA legacy_alter_table = OFF");
  }
}
