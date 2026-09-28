// Project/App: gsd-pi
// File Purpose: Single decision point for child-row milestone attribution
// (Phase 33 Plan 33-02, RD-01 Option 2, D-03). Every production INSERT that
// binds a non-null `requirement_id` into `workflow_waivers`,
// `workflow_requirement_dispositions`, or `workflow_acceptance_criteria`
// resolves that requirement's OWN `milestone_id` through this function
// rather than re-deriving its own lookup — a future write site should copy
// this call, not hand-roll an equivalent query.
//
// Placed under `db/`, not `db/writers/`: it performs no mutation, and
// `db/writers/` membership is what the single-writer allowlist enumerates —
// a read-only helper there would force an unrelated allowlist edit.

import { getDb } from "./engine.js";

interface RequirementMilestoneRow {
  milestone_id: string | null;
}

/**
 * Resolve the milestone a requirement id actually belongs to, from the
 * caller's own milestone context.
 *
 * - A null/empty `requirementId` returns null without querying — a child row
 *   with no parent requirement has no milestone to record.
 * - When a requirement row exists under the caller's own `contextMilestoneId`,
 *   that milestone's id is returned — deterministically, even when a second
 *   row with the same id exists under a different milestone (the row query
 *   is filtered to the caller's own context or a legacy NULL row, and a
 *   context match is always ordered ahead of a legacy NULL match).
 * - When the ONLY matching row is a legacy row whose own `milestone_id` is
 *   NULL, null is returned rather than the caller's context — attributing it
 *   to the caller's context would name a parent key that does not exist and
 *   throw a foreign key mismatch at INSERT time. Returning null is safe and
 *   correct: per Plan 33-01's PR-1 the child `milestone_id` column is
 *   nullable, and SQLite skips foreign-key enforcement entirely on any-NULL
 *   composite-key columns, so the row is accepted and simply carries no
 *   attribution — the same state it has today.
 * - When the id exists only under some OTHER milestone (not the caller's
 *   context, not a legacy NULL row), null is returned — this function never
 *   attributes a child row to a milestone the caller did not name.
 * - When no requirement row with that id exists at all, null is returned.
 */
export function resolveRequirementMilestoneId(
  requirementId: string | null | undefined,
  contextMilestoneId: string | null | undefined,
): string | null {
  const id = requirementId?.trim();
  if (!id) return null;
  const contextId = contextMilestoneId?.trim() || null;
  const row = getDb().prepare(`
    SELECT milestone_id
    FROM requirements
    WHERE id = :id
      AND (milestone_id IS :context_milestone_id OR milestone_id IS NULL)
    ORDER BY (milestone_id IS :context_milestone_id) DESC
    LIMIT 1
  `).get({
    ":id": id,
    ":context_milestone_id": contextId,
  }) as RequirementMilestoneRow | undefined;
  return row?.milestone_id ?? null;
}
