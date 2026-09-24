// Project/App: gsd-pi
// File Purpose: v56 plan-review convergence cycle store (Phase 20, CONV-01).
//
// Mirrors `db-tracker-item-schema.ts`'s V55 shape: the same `sqlite_master`
// `workflow_operations` foundation-presence probe (return early when absent —
// synthetic/sealed fixture DBs carry nothing to migrate), the same
// `CHECK (x IN (...))` closed status set, and the same index-creation idiom.
//
// `plan_review_cycles` is a DEDICATED table (RESEARCH.md Pitfall 3 / Alternatives
// Considered) — unlike `rework_briefs`, which shares one table across two
// features via a `LIKE`-on-id-shape workaround (`gsd-db.ts:1271-1282`'s own
// comment documents that as a compromise), this feature never needs a `LIKE`
// scope to count its own rows. Each cycle number gets its OWN row
// (`PRC-{milestoneId}-{sliceId}-c{cycle}`) rather than upserting one row per
// target, so `countPlanReviewCyclesForTarget`'s `SELECT COUNT(*)` genuinely
// advances across cycles (the Phase 12 Plan 1 lesson).

import type { DbAdapter } from "./db-adapter.js";

export function createPlanReviewCycleSchemaV56(db: DbAdapter): void {
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
    CREATE TABLE IF NOT EXISTS plan_review_cycles (
      id TEXT PRIMARY KEY,
      milestone_id TEXT NOT NULL,
      slice_id TEXT NOT NULL DEFAULT '',
      cycle INTEGER NOT NULL,
      max_cycles INTEGER NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('review-pending', 'reround-dispatched', 'converged', 'cap-hit')),
      high_count INTEGER NOT NULL DEFAULT 0,
      actionable_count INTEGER NOT NULL DEFAULT 0,
      lane_states TEXT NOT NULL DEFAULT '[]',
      artifact_path TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `);

  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_review_cycles_target
    ON plan_review_cycles(milestone_id, slice_id, cycle)
  `);
  db.exec(`
    CREATE INDEX IF NOT EXISTS idx_plan_review_cycles_status
    ON plan_review_cycles(milestone_id, slice_id, status)
  `);
}
