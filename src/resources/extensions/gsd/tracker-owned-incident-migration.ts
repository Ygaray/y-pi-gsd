// Project/App: gsd-pi
// File Purpose: One-time, idempotent migration of genuinely y-pi-gsd-owned
// control-plane incidents into the durable tracker (D-01, D-02, D-04).
// Exactly one incident qualifies: GREEN-05/INC-2026-09-20-07, ruled
// y-pi-gsd-owned by strategic override (D-01). Every other open
// `affects: [gsd]` incident traces its root cause to gsd-core's own harness
// rather than to this project's source, and D-02 forbids bulk-importing
// those -- this module deliberately does not attempt to.

import {
  createTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemSeverity,
} from "./db/writers/tracker-item.js";
import { readTrackerItems } from "./tracker-projection.js";

/** The ownership verdict -- the literal example the tracker tool's own parameter documentation already uses. */
export const Y_PI_GSD_OWNED_TAG = "y-pi-gsd-owned";

/** Provenance tag: separates rows migrated from the control-plane log from natively-filed ones on a later query. */
export const MIGRATED_FROM_CONTROL_PLANE_TAG = "migrated-from-control-plane";

export interface OwnedControlPlaneIncident {
  incidentId: string;
  title: string;
  severity: TrackerItemSeverity;
  detail: string;
}

/**
 * The one control-plane incident D-01/D-02 rule y-pi-gsd-owned. Deliberately
 * a hand-authored constant list, not a query over the control-plane log --
 * the classification judgment that produced this single entry is this
 * phase's own analytical pass (RESEARCH's Working Classification Table),
 * not a mechanical filter this module re-derives at runtime.
 */
export const OWNED_CONTROL_PLANE_INCIDENTS: readonly OwnedControlPlaneIncident[] = [
  {
    incidentId: "INC-2026-09-20-07",
    // Deliberately no control-plane id prefix in the title -- Phase 17's
    // prohibition bars reusing control-plane id prefixes on tracker rows,
    // and the control_plane_incident ref below is the designed
    // cross-reference channel.
    title:
      "GREEN-05: y-pi-gsd owns close-time deferred/residual capture natively (retires the gsd-core acknowledge-matcher dependency)",
    // The incident's own Impact section states the defect strands the
    // headless close path at every future milestone and compounds as
    // un-acknowledgeable items accumulate; severity is the tracker's triage
    // signal, so it reads as a blocker.
    severity: "HIGH",
    detail:
      "Ownership settled 2026-09-23 by strategic override per D-01: gsd-core is being retired, "
      + "so y-pi-gsd must own its own close-time behavior. This overrides the where-the-code-lives-today "
      + "read, which points at the sibling gsd-core fork (yahir-gsd) where the fix already shipped on "
      + "2026-09-23 (commit e0d6e7d90 in src/audit.cts). y-pi-gsd's own native warn-and-capture resolution "
      + "lands in Phase 19 as GREEN-05, independent of whether the sibling fork's fix ever reaches "
      + "`verified`. The control-plane record remains the cross-project record for the sibling fork's fix; "
      + "this row is y-pi-gsd's own authority for its own native fix.",
  },
];

/**
 * Migrate every constant record in OWNED_CONTROL_PLANE_INCIDENTS into the
 * durable tracker. Idempotency is keyed on the existing `control_plane_incident`
 * ref -- not the title -- because the ref is the field the tracker schema
 * added for exactly this cross-reference (db-tracker-item-schema.ts) and a
 * title is free text a later edit could drift. Mirrors
 * tracker-legacy-backlog-seed.ts: opens no database connection of its own
 * (the caller must already have one open) and writes no SQL of any kind --
 * createTrackerItem owns the transaction, the id assignment, and the pane
 * regeneration.
 */
export function migrateOwnedControlPlaneIncidents(basePath: string): { created: string[]; skipped: string[] } {
  const existing = readTrackerItems();
  const created: string[] = [];
  const skipped: string[] = [];

  for (const record of OWNED_CONTROL_PLANE_INCIDENTS) {
    const alreadyMigrated = existing.some((item) =>
      item.refs.some((ref) => ref.refKind === "control_plane_incident" && ref.refValue === record.incidentId)
    );
    if (alreadyMigrated) {
      skipped.push(record.incidentId);
      continue;
    }

    const refs: TrackerItemRefInput[] = [{ refKind: "control_plane_incident", refValue: record.incidentId }];
    const { trackId } = createTrackerItem(
      {
        type: "incident",
        title: record.title,
        severity: record.severity,
        detail: record.detail,
        dispositionTags: [Y_PI_GSD_OWNED_TAG, MIGRATED_FROM_CONTROL_PLANE_TAG],
        refs,
      },
      basePath,
    );
    created.push(trackId);
  }

  return { created, skipped };
}
