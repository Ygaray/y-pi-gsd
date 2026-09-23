// Project/App: gsd-pi
// File Purpose: Deterministic DB-only Milestone ship-authorization query — the
// three-way gate (already completed + certify pass + audit pass + Gate-2
// clean) that milestone.ship reads inside its own Domain Operation callback.

import { normalizeLegacyLifecycleStatus } from "./lifecycle-shadow-comparison.js";
import { getDb } from "./engine.js";
import { getMilestone } from "./queries.js";
import {
  MILESTONE_AUDIT_POLICY,
  MILESTONE_CERTIFY_POLICY,
  type MilestoneVerdictPolicy,
} from "./writers/milestone-validation.js";
import {
  readOutstandingGate2HumanUat,
  type OutstandingGate2HumanUat,
} from "../milestone-gate2-human-uat-domain-operation.js";
import { isShippedStatus } from "../status-guards.js";

export interface MilestoneShipAuthorizationInput {
  projectId: string;
  milestoneId: string;
}

export type MilestoneShipBlocker =
  | { kind: "milestone-missing" }
  | { kind: "not-completed"; legacyStatus: string }
  | { kind: "already-shipped"; legacyStatus: string }
  | { kind: "certify-missing" }
  | { kind: "certify-not-passing"; overallVerdict: string }
  | { kind: "certify-stale"; verdictRevision: number; reopenRevision: number }
  | { kind: "certify-read-failed"; message: string }
  | { kind: "audit-missing" }
  | { kind: "audit-not-passing"; overallVerdict: string }
  | { kind: "audit-stale"; verdictRevision: number; reopenRevision: number }
  | { kind: "audit-read-failed"; message: string }
  | { kind: "gate2-outstanding"; entries: OutstandingGate2HumanUat[] }
  | { kind: "gate2-read-failed"; message: string };

export type MilestoneShipAuthorization =
  | {
    authorized: true;
    certifyEventId: string;
    certifyRevision: number;
    auditEventId: string;
    auditRevision: number;
  }
  | {
    authorized: false;
    blockers: MilestoneShipBlocker[];
  };

interface VerdictEventRow {
  event_id: string;
  project_revision: number;
  payload_json: string;
}

interface VerdictEvent {
  eventId: string;
  revision: number;
  overallVerdict: string;
}

/**
 * Latest `project_revision` at which this milestone was reopened, or `null`
 * if it has never been reopened. `project_revision` is the only valid
 * ordering key here (`workflow_domain_events.event_id` is a `randomUUID()`
 * with no chronological meaning) — do not sort by `event_id`.
 */
function readLatestMilestoneReopenRevision(input: {
  projectId: string;
  milestoneId: string;
}): number | null {
  const row = getDb().prepare(`
    SELECT MAX(event.project_revision) AS revision
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id AND operation.project_id = event.project_id
    WHERE event.event_type = 'milestone.reopened'
      AND event.entity_type = 'milestone'
      AND event.entity_id = :milestone_id
      AND event.project_id = :project_id
      AND operation.operation_type = 'milestone.reopen'
  `).get({
    ":milestone_id": input.milestoneId,
    ":project_id": input.projectId,
  }) as unknown as { revision: number | null } | undefined;
  const revision = row?.revision;
  return revision === null || revision === undefined ? null : Number(revision);
}

function readLatestVerdictEvent(
  milestoneId: string,
  policy: MilestoneVerdictPolicy,
): VerdictEvent | null {
  const row = getDb().prepare(`
    SELECT event.event_id, event.project_revision, event.payload_json
    FROM workflow_domain_events event
    JOIN workflow_operations operation
      ON operation.operation_id = event.operation_id AND operation.project_id = event.project_id
    WHERE event.event_type = :event_type
      AND event.entity_type = 'milestone'
      AND event.entity_id = :milestone_id
      AND operation.operation_type = :operation_type
    ORDER BY event.project_revision DESC, event.event_index DESC, event.event_id DESC
    LIMIT 1
  `).get({
    ":event_type": policy.eventType,
    ":milestone_id": milestoneId,
    ":operation_type": policy.operationType,
  }) as unknown as VerdictEventRow | undefined;
  if (!row) return null;
  const parsed = JSON.parse(row.payload_json) as unknown;
  const overallVerdict = parsed && typeof parsed === "object" && !Array.isArray(parsed)
    && typeof (parsed as Record<string, unknown>)["overallVerdict"] === "string"
    ? (parsed as Record<string, unknown>)["overallVerdict"] as string
    : "";
  return { eventId: row.event_id, revision: row.project_revision, overallVerdict };
}

/**
 * Pure, DB-read-only three-way ship gate (D-03): the milestone must already
 * be canonically completed, the latest certify verdict must be "pass", the
 * latest audit verdict must be "pass", and Gate-2 must have zero outstanding
 * entries. Every applicable blocker is accumulated — never short-circuits on
 * the first failure — so a caller can report every unmet gate at once.
 *
 * Reads only: `readOutstandingGate2HumanUat` is the SAME event-head read
 * `completeMilestone` uses — never the display-only `human_uat_pending`
 * table (db-human-uat-pending-schema.ts:1-11).
 */
export function readMilestoneShipAuthorization(
  input: MilestoneShipAuthorizationInput,
): MilestoneShipAuthorization {
  const milestone = getMilestone(input.milestoneId);
  if (!milestone) {
    return { authorized: false, blockers: [{ kind: "milestone-missing" }] };
  }

  const blockers: MilestoneShipBlocker[] = [];
  const rawStatus = milestone.status;
  // Order matters: after D-01, a shipped status ALSO normalizes to
  // "completed", so the already-shipped check must run first or it would
  // never fire.
  if (isShippedStatus(rawStatus)) {
    blockers.push({ kind: "already-shipped", legacyStatus: rawStatus });
  } else if (normalizeLegacyLifecycleStatus(rawStatus) !== "completed") {
    blockers.push({ kind: "not-completed", legacyStatus: rawStatus });
  }

  // A `null` reopen revision means the milestone was never reopened — absence
  // of a reopen is not staleness (OQ2, 15-01). Read once, reuse for both
  // certify and audit's staleness comparisons below.
  const reopenRevision = readLatestMilestoneReopenRevision({
    projectId: input.projectId,
    milestoneId: input.milestoneId,
  });

  // Each evidence read is wrapped in its own try/catch: a read that throws
  // must become a `*-read-failed` blocker, never be treated as "clean" or
  // silently downgraded to "missing" — a fail-open guard is a no-op exactly
  // when something is wrong (T-15-05). A failure on one read must not
  // suppress the other reads: catch per read, keep accumulating.
  let certify: VerdictEvent | null = null;
  let certifyReadFailed = false;
  try {
    certify = readLatestVerdictEvent(input.milestoneId, MILESTONE_CERTIFY_POLICY);
  } catch (error) {
    certifyReadFailed = true;
    blockers.push({ kind: "certify-read-failed", message: (error as Error).message });
  }
  if (!certifyReadFailed) {
    if (!certify) {
      blockers.push({ kind: "certify-missing" });
    } else if (certify.overallVerdict !== "pass") {
      blockers.push({ kind: "certify-not-passing", overallVerdict: certify.overallVerdict });
    } else if (reopenRevision !== null && certify.revision < reopenRevision) {
      blockers.push({ kind: "certify-stale", verdictRevision: certify.revision, reopenRevision });
    }
  }

  let audit: VerdictEvent | null = null;
  let auditReadFailed = false;
  try {
    audit = readLatestVerdictEvent(input.milestoneId, MILESTONE_AUDIT_POLICY);
  } catch (error) {
    auditReadFailed = true;
    blockers.push({ kind: "audit-read-failed", message: (error as Error).message });
  }
  if (!auditReadFailed) {
    if (!audit) {
      blockers.push({ kind: "audit-missing" });
    } else if (audit.overallVerdict !== "pass") {
      blockers.push({ kind: "audit-not-passing", overallVerdict: audit.overallVerdict });
    } else if (reopenRevision !== null && audit.revision < reopenRevision) {
      blockers.push({ kind: "audit-stale", verdictRevision: audit.revision, reopenRevision });
    }
  }

  try {
    const outstandingGate2HumanUat = readOutstandingGate2HumanUat({
      projectId: input.projectId,
      milestoneId: input.milestoneId,
    });
    if (outstandingGate2HumanUat.length > 0) {
      blockers.push({ kind: "gate2-outstanding", entries: outstandingGate2HumanUat });
    }
  } catch (error) {
    blockers.push({ kind: "gate2-read-failed", message: (error as Error).message });
  }

  if (blockers.length > 0) {
    return { authorized: false, blockers };
  }

  return {
    authorized: true,
    certifyEventId: certify!.eventId,
    certifyRevision: certify!.revision,
    auditEventId: audit!.eventId,
    auditRevision: audit!.revision,
  };
}

function describeMilestoneShipBlocker(blocker: MilestoneShipBlocker): string {
  switch (blocker.kind) {
    case "milestone-missing":
      return "milestone-missing";
    case "not-completed":
      return `not-completed (${blocker.legacyStatus})`;
    case "already-shipped":
      return `already-shipped (${blocker.legacyStatus})`;
    case "certify-missing":
      return "certify-missing";
    case "certify-not-passing":
      return `certify-not-passing (${blocker.overallVerdict})`;
    case "certify-stale":
      return `certify-stale (verdict rev ${blocker.verdictRevision}, reopen rev ${blocker.reopenRevision})`;
    case "certify-read-failed":
      return `certify-read-failed (${blocker.message})`;
    case "audit-missing":
      return "audit-missing";
    case "audit-not-passing":
      return `audit-not-passing (${blocker.overallVerdict})`;
    case "audit-stale":
      return `audit-stale (verdict rev ${blocker.verdictRevision}, reopen rev ${blocker.reopenRevision})`;
    case "audit-read-failed":
      return `audit-read-failed (${blocker.message})`;
    case "gate2-outstanding": {
      const pairs = blocker.entries.map((entry) => `${entry.milestoneId}/${entry.sliceId}`);
      return `gate2-outstanding (${pairs.join(", ")})`;
    }
    case "gate2-read-failed":
      return `gate2-read-failed (${blocker.message})`;
    default: {
      // Exhaustive switch (Task 1 acceptance criteria): adding a new
      // MilestoneShipBlocker member without a rendering branch above must be
      // a compile error, not a silently generic message.
      const exhaustive: never = blocker;
      throw new Error(`Unhandled MilestoneShipBlocker kind: ${JSON.stringify(exhaustive)}`);
    }
  }
}

/**
 * Render every blocker in `blockers` as a single-line, comma-joined reason —
 * the operator-visible surface `shipMilestone` interpolates into its thrown
 * `MilestoneLifecycleValidationError` (ROADMAP SC2). Each segment leads with
 * the blocker's `kind` and appends its distinguishing data in parentheses,
 * keeping the kind-first convention of `blockerSummary`
 * (`db/writers/milestone-lifecycle.ts:158-160`).
 */
export function describeMilestoneShipBlockers(blockers: MilestoneShipBlocker[]): string {
  return blockers.map((blocker) => describeMilestoneShipBlocker(blocker)).join(", ");
}
