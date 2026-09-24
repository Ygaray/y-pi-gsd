// Project/App: gsd-pi
// File Purpose: One-time, idempotent migration of the superseded
// file-authoritative backlog entries (ROADMAP `999.1`-`999.3`) into the
// durable tracker store (D-03). This module reads a hand-authored constant
// list and deliberately does NOT parse any markdown file -- reintroducing a
// parser would reintroduce the file as an authority, exactly the second
// backlog representation D-03 exists to eliminate.

import {
  createTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemSeverity,
} from "./db/writers/tracker-item.js";
import { readTrackerItems } from "./tracker-projection.js";

/** Groups the three seeded rows for later querying (e.g. `/gsd track list`). */
export const SUPERSEDED_BACKLOG_TAG = "superseded-file-backlog";

interface SupersededBacklogEntry {
  legacyId: string;
  title: string;
  severity: TrackerItemSeverity;
  detail: string;
  refs: TrackerItemRefInput[];
}

/**
 * The three ROADMAP `999.1`-`999.3` entries RESEARCH's "D-03: Enumerated
 * 999.x Backlog Entries to Migrate" section named for migration. The other
 * two legacy backlog entries from that same ROADMAP section are deliberately
 * absent from this list -- CONTEXT.md's Deferred Ideas name them as
 * candidate first tracker entries that are explicitly out of Phase 17 scope,
 * and the tracker's non-delete trigger means a mistakenly seeded row can
 * never be removed, only closed.
 */
export const SUPERSEDED_BACKLOG_ENTRIES: readonly SupersededBacklogEntry[] = [
  {
    legacyId: "999.1",
    title: "[999.1] Per-slice orchestrator-Agent + stage-JSON contract (control-plane \"D\" pattern)",
    severity: "LOW",
    detail:
      "During the 2026-09-21 v3 scoping chat we chose pi-gsd's native auto-loop plus "
      + "in-turn subagent fan-out (write-gate-enforced per-unit allowlists) as the "
      + "milestone driver, and deferred grafting control-plane's explicit per-stage "
      + "structured return contract (advance/needs_human/incomplete) on top. Reconsider "
      + "if the DB-derived loop proves hard to reason about, or if per-phase isolation, "
      + "per-phase model routing, or an explicit master<->orchestrator split is wanted.",
    refs: [],
  },
  {
    legacyId: "999.2",
    title: "[999.2] Schema-level milestone_id on requirements (CR-02 full fix)",
    severity: "MEDIUM",
    detail:
      "From the v3 Phase 15 Gate-2 sign-off. `requirements` has no milestone column; the "
      + "ship archive-snapshot scopes requirements to a milestone by matching "
      + "primary_owner/supporting_slices against slice ids, but slices.id is unique only "
      + "per-milestone. Add a milestone_id column populated at creation so attribution is "
      + "structural, not string-matched. Defense-in-depth: single-active-milestone is a "
      + "documentation convention (docs have flaked), not a schema constraint.",
    refs: [{ refKind: "phase", refValue: "15-ship-archive-close-out" }],
  },
  {
    legacyId: "999.3",
    title: "[999.3] Code-review-lane convergence (CONV-06/07) + gsd-core backport (BACKPORT-01/02)",
    severity: "LOW",
    detail:
      "Deferred beyond v4 per REQUIREMENTS.md's Future Requirements. The convergence half "
      + "extends the tracker-promotion mechanism to the code-review lane (closing "
      + "INC-2026-07-02-01's loss class) once a milestone picks that work up; the backport "
      + "half moves the per-project tracker and the residual-HIGH disposition into "
      + "gsd-core proper via an upstream `git merge upstream` (never `/gsd-update`), once "
      + "this fork's version has proven out.",
    refs: [
      { refKind: "requirement", refValue: "CONV-06" },
      { refKind: "requirement", refValue: "CONV-07" },
      { refKind: "requirement", refValue: "BACKPORT-01" },
      { refKind: "requirement", refValue: "BACKPORT-02" },
    ],
  },
];

/**
 * Seed the three superseded backlog entries into the durable tracker store.
 * Idempotency keys on the `[<legacyId>] ` title prefix (human-readable in the
 * pane and in `/gsd track list`, needing no schema change): any entry whose
 * prefix already appears on an existing row is skipped rather than
 * re-created. Requires the caller to have already opened the project
 * database (mirrors every other tracker writer -- this module never opens
 * its own connection).
 */
export function seedSupersededBacklogEntries(basePath: string): { created: string[]; skipped: string[] } {
  const existing = readTrackerItems();
  const created: string[] = [];
  const skipped: string[] = [];

  for (const entry of SUPERSEDED_BACKLOG_ENTRIES) {
    const prefix = `[${entry.legacyId}] `;
    const alreadySeeded = existing.some((item) => item.title.startsWith(prefix));
    if (alreadySeeded) {
      skipped.push(entry.legacyId);
      continue;
    }

    const { trackId } = createTrackerItem(
      {
        type: "backlog",
        title: entry.title,
        severity: entry.severity,
        detail: entry.detail,
        dispositionTags: [SUPERSEDED_BACKLOG_TAG],
        refs: entry.refs,
      },
      basePath,
    );
    created.push(trackId);
  }

  return { created, skipped };
}
