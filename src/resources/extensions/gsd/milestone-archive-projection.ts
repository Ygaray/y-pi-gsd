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
  certifyRevision: number;
  auditEventId: string;
  auditRevision: number;
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
    certifyRevision: requiredNumber(payload["certifyRevision"], "certifyRevision"),
    auditEventId: requiredString(payload["auditEventId"], "auditEventId"),
    auditRevision: requiredNumber(payload["auditRevision"], "auditRevision"),
    snapshot: snapshotFromPayload(payload["snapshot"]),
  };
}

/**
 * Collapse newlines and escape `|` so one operator-authored planning string
 * (a slice title, a requirement description) cannot forge an extra table
 * row/column in this document — copied verbatim from
 * `human-uat-pending-projection.ts:118-120` (module-private there, so it
 * cannot be imported).
 */
function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

const ROADMAP_EMPTY_ROW = "| _(none)_ | _(none)_ | _(none)_ | _(none)_ |";
const REQUIREMENTS_EMPTY_ROW = "| _(none)_ | _(none)_ | _(none)_ | _(none)_ |";

function renderRoadmapSnapshotTable(slices: MilestoneArchiveSnapshot["slices"]): string {
  const header = "| Slice | Title | Status | Completed |\n| --- | --- | --- | --- |";
  if (slices.length === 0) return `${header}\n${ROADMAP_EMPTY_ROW}`;
  const rows = slices.map((slice) => (
    `| ${escapeCell(slice.id)} | ${escapeCell(slice.title)} | ${escapeCell(slice.status)} | `
      + `${escapeCell(slice.completedAt ?? "")} |`
  ));
  return `${header}\n${rows.join("\n")}`;
}

function renderRequirementsSnapshotTable(
  requirements: MilestoneArchiveSnapshot["requirements"],
): string {
  const header = "| Requirement | Status | Primary owner | Supporting slices |\n| --- | --- | --- | --- |";
  if (requirements.length === 0) return `${header}\n${REQUIREMENTS_EMPTY_ROW}`;
  const rows = requirements.map((requirement) => (
    `| ${escapeCell(requirement.id)} | ${escapeCell(requirement.status)} | `
      + `${escapeCell(requirement.primaryOwner)} | ${escapeCell(requirement.supportingSlices)} |`
  ));
  return `${header}\n${rows.join("\n")}`;
}

/**
 * Pure render, no I/O: the entire ARCHIVE document from the projection alone
 * (D-04) — front matter, the ship authorization, the full roadmap and
 * requirements snapshots (every cell escaped), and a scope note recording
 * that physical phase-directory archival is a separate, out-of-scope
 * operator workflow. Every interpolated value traces to a projection field;
 * nothing here reads the clock, a random source, or an unordered iteration,
 * so re-rendering the same projection twice is byte-identical.
 */
export function renderMilestoneArchiveMarkdown(
  milestoneId: string,
  projection: MilestoneArchiveProjection,
): string {
  const rawTitle = projection.snapshot.milestone.title || milestoneId;
  const title = escapeCell(rawTitle);
  const status = escapeCell(projection.snapshot.milestone.status);
  const completedAt = projection.snapshot.milestone.completedAt ?? "";

  return `---
id: ${milestoneId}
title: "${title}"
status: ${status}
shipped_at: ${projection.shippedAt}
completed_at: ${completedAt}
certify_event_id: ${projection.certifyEventId}
audit_event_id: ${projection.auditEventId}
---

# ${milestoneId}: ${title}

Milestone \`${milestoneId}\` shipped at ${projection.shippedAt}, authorized by
certify event \`${projection.certifyEventId}\` and audit event
\`${projection.auditEventId}\`.

## Ship Authorization

| Gate | Result |
| --- | --- |
| Certify | Passed — event \`${projection.certifyEventId}\` (revision ${projection.certifyRevision}) |
| Audit | Passed — event \`${projection.auditEventId}\` (revision ${projection.auditRevision}) |
| Gate-2 Human-UAT | 0 outstanding entries |

## Roadmap Snapshot

${renderRoadmapSnapshotTable(projection.snapshot.slices)}

## Requirements Snapshot

${renderRequirementsSnapshotTable(projection.snapshot.requirements)}

## Scope Note

This artifact is the archive record for milestone \`${milestoneId}\`. Moving,
renaming, or removing its physical phase directories is not part of shipping
— that is owned by a separate operator workflow, not this projection.
`;
}
