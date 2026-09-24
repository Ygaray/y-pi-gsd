// Project/App: gsd-pi
// File Purpose: Idempotent close-time capture of unresolvable deferred/
// residual milestone-closeout items into the durable per-project tracker
// (GREEN-05, D-05). This module is called POST-COMMIT from
// completeMilestone — after executeDomainOperation returns, never from
// inside its callback — because createTrackerItem's own transaction writes
// markdown panes (.gsd/INCIDENTS.md, .gsd/BACKLOG.md) to disk, and a
// rolled-back domain-operation transaction must never leave those panes
// describing rows that do not exist (see 19-05-PLAN.md "Design decisions
// resolved at planning time" #1). This module never throws: by the time it
// runs the milestone has already committed, so a captured item's write
// failing becomes a warning on the caller's receipt, never a re-raised
// exception — re-raising here would reintroduce exactly the close-time halt
// D-05 exists to remove.

import {
  createTrackerItem,
  type TrackerItemRefInput,
  type TrackerItemSeverity,
} from "./db/writers/tracker-item.js";
import { immediateTransaction } from "./db/engine.js";
import { readTrackerItems } from "./tracker-projection.js";

/**
 * Stable class marker so every close-time residual capture is queryable as
 * a group, independent of which milestone produced it. Not exported — the
 * module's export surface is fixed to exactly the three symbols below; a
 * caller that needs this literal re-derives it or matches by prefix.
 */
const MILESTONE_CLOSEOUT_RESIDUAL_TAG = "milestone-closeout-residual";

export interface MilestoneCloseoutResidualItem {
  title: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  phaseId?: string;
  requirementId?: string;
  supersedesControlPlaneIncidentId?: string;
}

export interface MilestoneCloseoutResidualCapture {
  created: string[];
  skipped: string[];
  /**
   * Genuine per-item write failures ONLY (WR-02/IN-01 fix) — never populated
   * on a successful capture. A future caller/UI can safely treat a non-empty
   * `failures` array as "something needs attention" without it firing on
   * every successful close that captured at least one item. Successful
   * captures are fully described by `created` (the trackId list); logging a
   * matching success-path message here would just duplicate that
   * information in the same channel a failure uses.
   */
  failures: string[];
}

/**
 * Build the schema-permitted refs for one item — `phase`/`requirement`/
 * `control_plane_incident` only, each included only when the caller
 * supplied the corresponding id. There is deliberately no `milestone` ref
 * kind: the closing milestone is carried as a disposition tag instead (D-05
 * design decision #3) so this plan adds no schema migration.
 */
function itemRefs(item: MilestoneCloseoutResidualItem): TrackerItemRefInput[] {
  const refs: TrackerItemRefInput[] = [];
  if (item.phaseId) refs.push({ refKind: "phase", refValue: item.phaseId });
  if (item.requirementId) refs.push({ refKind: "requirement", refValue: item.requirementId });
  if (item.supersedesControlPlaneIncidentId) {
    refs.push({ refKind: "control_plane_incident", refValue: item.supersedesControlPlaneIncidentId });
  }
  return refs;
}

/**
 * A stable, order-independent identity over a normalised title plus its ref
 * set — the key both an existing tracker row and an earlier item in this
 * same call are compared against, so a repeated close (or a duplicate
 * within one closeout) collapses to exactly one row instead of piling up.
 */
function itemIdentity(title: string, refs: readonly TrackerItemRefInput[]): string {
  const normalizedTitle = title.trim();
  const refKey = [...refs]
    .map((ref) => `${ref.refKind}:${ref.refValue}`)
    .sort()
    .join("|");
  return `${normalizedTitle}::${refKey}`;
}

/**
 * Capture every unresolvable deferred/residual closeout item into the
 * durable tracker. Mirrors migrateOwnedControlPlaneIncidents's check-then-act
 * shape: one immediateTransaction so the whole batch is atomic against a
 * concurrent close, one readTrackerItems() read before the loop, then
 * createTrackerItem per genuinely-new item.
 *
 * Severity->type rule (a planner choice, not a source-artifact mandate,
 * per 19-05-PLAN.md's "Flagged assumptions"): a HIGH-severity item becomes
 * an `incident` row; everything else (including a missing severity,
 * defaulted the same way createTrackerItem itself defaults it) becomes a
 * `backlog` row.
 *
 * Never throws: a per-item createTrackerItem failure is caught and recorded
 * in `failures`, and the loop continues to the next item. The caller has
 * already committed its own transaction by the time this function runs —
 * see the file-purpose header above.
 */
export function captureMilestoneCloseoutResiduals(input: {
  milestoneId: string;
  items: MilestoneCloseoutResidualItem[];
  basePath: string;
}): MilestoneCloseoutResidualCapture {
  return immediateTransaction(() => {
    const existing = readTrackerItems();
    const existingIdentities = new Set(
      existing.map((row) => itemIdentity(row.title, row.refs)),
    );
    const claimedThisCall = new Set<string>();

    const created: string[] = [];
    const skipped: string[] = [];
    const failures: string[] = [];

    for (const item of input.items) {
      const refs = itemRefs(item);
      const identity = itemIdentity(item.title, refs);

      if (existingIdentities.has(identity) || claimedThisCall.has(identity)) {
        skipped.push(item.title.trim());
        continue;
      }
      claimedThisCall.add(identity);

      const severity: TrackerItemSeverity = item.severity ?? "MEDIUM";
      const type = severity === "HIGH" ? "incident" : "backlog";

      try {
        const { trackId } = createTrackerItem(
          {
            type,
            title: item.title,
            severity,
            detail: item.detail ?? "",
            dispositionTags: [`milestone:${input.milestoneId}`, MILESTONE_CLOSEOUT_RESIDUAL_TAG],
            refs,
          },
          input.basePath,
        );
        created.push(trackId);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        failures.push(`Failed to capture residual item "${item.title.trim()}": ${message}`);
      }
    }

    return { created, skipped, failures };
  });
}
