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
  | { kind: "audit-missing" }
  | { kind: "audit-not-passing"; overallVerdict: string }
  | { kind: "gate2-outstanding"; entries: OutstandingGate2HumanUat[] };

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

  const certify = readLatestVerdictEvent(input.milestoneId, MILESTONE_CERTIFY_POLICY);
  if (!certify) {
    blockers.push({ kind: "certify-missing" });
  } else if (certify.overallVerdict !== "pass") {
    blockers.push({ kind: "certify-not-passing", overallVerdict: certify.overallVerdict });
  }

  const audit = readLatestVerdictEvent(input.milestoneId, MILESTONE_AUDIT_POLICY);
  if (!audit) {
    blockers.push({ kind: "audit-missing" });
  } else if (audit.overallVerdict !== "pass") {
    blockers.push({ kind: "audit-not-passing", overallVerdict: audit.overallVerdict });
  }

  const outstandingGate2HumanUat = readOutstandingGate2HumanUat({
    projectId: input.projectId,
    milestoneId: input.milestoneId,
  });
  if (outstandingGate2HumanUat.length > 0) {
    blockers.push({ kind: "gate2-outstanding", entries: outstandingGate2HumanUat });
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
