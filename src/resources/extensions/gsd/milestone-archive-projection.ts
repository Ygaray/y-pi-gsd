// Project/App: gsd-pi
// File Purpose: Rebuild Milestone archive projections from the durable,
// immutable milestone.shipped event — clones the read/parse/pure-render trio
// milestone-summary-projection.ts already proves end-to-end for
// milestone.completed -> SUMMARY.md.

import { getDb } from "./db/engine.js";
import {
  MILESTONE_SHIPPED_EVENT_TYPE,
  type MilestoneArchiveSnapshot,
} from "./milestone-ship-domain-operation.js";

export interface MilestoneArchiveProjection {
  operationId: string;
  shippedAt: string;
  previousLegacyStatus: string;
  certifyEventId: string;
  auditEventId: string;
  snapshot: MilestoneArchiveSnapshot;
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== "string") {
    throw new Error(`Milestone archive event ${field} is corrupt`);
  }
  return value;
}

function requiredStringOrNull(value: unknown, field: string): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value !== "string") {
    throw new Error(`Milestone archive event ${field} is corrupt`);
  }
  return value;
}

function requiredNumber(value: unknown, field: string): number {
  if (typeof value !== "number" || !Number.isFinite(value)) {
    throw new Error(`Milestone archive event ${field} is corrupt`);
  }
  return value;
}

function requiredObject(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`Milestone archive event ${field} is corrupt`);
  }
  return value as Record<string, unknown>;
}

function requiredArray(value: unknown, field: string): unknown[] {
  if (!Array.isArray(value)) {
    throw new Error(`Milestone archive event ${field} is corrupt`);
  }
  return value;
}

function snapshotFromPayload(value: unknown): MilestoneArchiveSnapshot {
  const snapshot = requiredObject(value, "snapshot");
  const milestone = requiredObject(snapshot["milestone"], "snapshot.milestone");
  const slices = requiredArray(snapshot["slices"], "snapshot.slices");
  const requirements = requiredArray(snapshot["requirements"], "snapshot.requirements");

  return {
    milestone: {
      id: requiredString(milestone["id"], "snapshot.milestone.id"),
      title: requiredString(milestone["title"], "snapshot.milestone.title"),
      status: requiredString(milestone["status"], "snapshot.milestone.status"),
      completedAt: requiredStringOrNull(milestone["completedAt"], "snapshot.milestone.completedAt"),
    },
    slices: slices.map((entry, index) => {
      const slice = requiredObject(entry, `snapshot.slices[${index}]`);
      return {
        id: requiredString(slice["id"], `snapshot.slices[${index}].id`),
        title: requiredString(slice["title"], `snapshot.slices[${index}].title`),
        status: requiredString(slice["status"], `snapshot.slices[${index}].status`),
        sequence: requiredNumber(slice["sequence"], `snapshot.slices[${index}].sequence`),
        completedAt: requiredStringOrNull(
          slice["completedAt"],
          `snapshot.slices[${index}].completedAt`,
        ),
      };
    }),
    requirements: requirements.map((entry, index) => {
      const requirement = requiredObject(entry, `snapshot.requirements[${index}]`);
      return {
        id: requiredString(requirement["id"], `snapshot.requirements[${index}].id`),
        status: requiredString(requirement["status"], `snapshot.requirements[${index}].status`),
        primaryOwner: requiredString(
          requirement["primaryOwner"],
          `snapshot.requirements[${index}].primaryOwner`,
        ),
        supportingSlices: requiredString(
          requirement["supportingSlices"],
          `snapshot.requirements[${index}].supportingSlices`,
        ),
      };
    }),
    capturedAt: requiredString(snapshot["capturedAt"], "snapshot.capturedAt"),
  };
}

/** Read-only, pure parse of the milestone's latest immutable ship event —
 * never re-derives the archive from live mutable DB state (prohibition:
 * an already-shipped milestone's archive must read the same after later
 * edits to slices, requirements, or the roadmap). */
export function readMilestoneArchiveProjection(
  milestoneId: string,
): MilestoneArchiveProjection | null {
  const row = getDb().prepare(`
    SELECT operation_id, payload_json
    FROM workflow_domain_events
    WHERE event_type = :event_type
      AND entity_type = 'milestone'
      AND entity_id = :milestone_id
    ORDER BY project_revision DESC, event_index DESC
    LIMIT 1
  `).get({
    ":event_type": MILESTONE_SHIPPED_EVENT_TYPE,
    ":milestone_id": milestoneId,
  }) as Record<string, unknown> | undefined;
  if (!row) return null;

  const parsed = JSON.parse(String(row["payload_json"])) as unknown;
  const payload = requiredObject(parsed, "payload");

  return {
    operationId: requiredString(row["operation_id"], "operationId"),
    shippedAt: requiredString(payload["shippedAt"], "shippedAt"),
    previousLegacyStatus: requiredString(payload["previousLegacyStatus"], "previousLegacyStatus"),
    certifyEventId: requiredString(payload["certifyEventId"], "certifyEventId"),
    auditEventId: requiredString(payload["auditEventId"], "auditEventId"),
    snapshot: snapshotFromPayload(payload["snapshot"]),
  };
}

/** Pure render, no I/O — the full roadmap/requirements snapshot tables are
 * 15-04's job; this settles the architecture (event payload in, markdown
 * string out, no DB handle) with a short body naming the milestone, the
 * shipped timestamp, and the two authorizing event ids. */
export function renderMilestoneArchiveMarkdown(
  milestoneId: string,
  projection: MilestoneArchiveProjection,
): string {
  const title = projection.snapshot.milestone.title || milestoneId;

  return `---
id: ${milestoneId}
title: "${title}"
status: shipped
shipped_at: ${projection.shippedAt}
completed_at: ${projection.snapshot.milestone.completedAt ?? ""}
certify_event_id: ${projection.certifyEventId}
audit_event_id: ${projection.auditEventId}
---

# ${milestoneId}: ${title}

Milestone \`${milestoneId}\` shipped at ${projection.shippedAt}, authorized by
certify event \`${projection.certifyEventId}\` and audit event
\`${projection.auditEventId}\`.
`;
}
