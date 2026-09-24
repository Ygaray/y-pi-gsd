// Project/App: gsd-pi
// File Purpose: Light typed writer for the per-project tracker store
// (TRACK-01..04). Tracker writes are agent- and operator-initiated CRUD with
// no revision-fencing requirement, so this deliberately does NOT route
// through the revision-fenced, event-sourced Domain Operation seam used for
// milestone/slice/task lifecycle authority — that seam supplies provenance
// this table does not carry.

import { getDb, transaction } from "../engine.js";
import { isNonEmptyString } from "../../validation.js";
import { renderTrackerLedger } from "../../tracker-projection.js";
import { logWarning } from "../../workflow-logger.js";

export const TRACKER_ITEM_ID_PREFIX = "TRACK-";

export type TrackerItemType = "backlog" | "incident";
export type TrackerItemStatus = "open" | "in-progress" | "resolved" | "closed" | "wont-fix";
export type TrackerItemSeverity = "HIGH" | "MEDIUM" | "LOW";
export type TrackerItemRefKind =
  | "phase"
  | "requirement"
  | "reviews_md"
  | "track_item"
  | "control_plane_incident";

export interface TrackerItemRefInput {
  refKind: TrackerItemRefKind;
  refValue: string;
}

export interface TrackerItemRow {
  id: string;
  type: TrackerItemType;
  title: string;
  status: TrackerItemStatus;
  severity: TrackerItemSeverity;
  dispositionTags: string[];
  detail: string;
  resolutionNote: string | null;
  createdAt: string;
  updatedAt: string;
  resolvedAt: string | null;
  refs: TrackerItemRefInput[];
}

export interface CreateTrackerItemInput {
  type: TrackerItemType;
  title: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  dispositionTags?: string[];
  refs?: TrackerItemRefInput[];
}

const TRACKER_ITEM_TYPES: readonly TrackerItemType[] = ["backlog", "incident"];
const TRACKER_ITEM_SEVERITIES: readonly TrackerItemSeverity[] = ["HIGH", "MEDIUM", "LOW"];
const TRACKER_ITEM_REF_KINDS: readonly TrackerItemRefKind[] = [
  "phase",
  "requirement",
  "reviews_md",
  "track_item",
  "control_plane_incident",
];

function validateCreateTrackerItemInput(input: CreateTrackerItemInput): {
  title: string;
  severity: TrackerItemSeverity;
  refs: TrackerItemRefInput[];
} {
  if (!isNonEmptyString(input.title)) {
    throw new Error("title is required");
  }
  if (!TRACKER_ITEM_TYPES.includes(input.type)) {
    throw new Error(`type must be one of ${TRACKER_ITEM_TYPES.join(", ")}`);
  }
  const severity = input.severity ?? "MEDIUM";
  if (!TRACKER_ITEM_SEVERITIES.includes(severity)) {
    throw new Error(`severity must be one of ${TRACKER_ITEM_SEVERITIES.join(", ")}`);
  }
  const refs = input.refs ?? [];
  for (const ref of refs) {
    if (!TRACKER_ITEM_REF_KINDS.includes(ref.refKind)) {
      throw new Error(`ref kind must be one of ${TRACKER_ITEM_REF_KINDS.join(", ")}`);
    }
    if (!isNonEmptyString(ref.refValue)) {
      throw new Error("ref value is required");
    }
  }
  return { title: input.title.trim(), severity, refs };
}

/**
 * Create one tracker item and its back-references in a single transaction,
 * then regenerate both markdown panes. The next id is computed with
 * `SUBSTR(id, 7)` (the six-character `TRACK-` prefix) INSIDE the same
 * transaction as the INSERT — the one deliberate difference from
 * `nextDecisionId`'s standalone pre-read — which closes the concurrent-create
 * race together with the `id TEXT PRIMARY KEY` constraint as a backstop.
 */
export function createTrackerItem(input: CreateTrackerItemInput, basePath: string): { trackId: string } {
  const { title, severity, refs } = validateCreateTrackerItemInput(input);
  const now = new Date().toISOString();

  const trackId = transaction(() => {
    const db = getDb();
    const maxRow = db
      .prepare(`SELECT MAX(CAST(SUBSTR(id, 7) AS INTEGER)) AS max_num FROM tracker_items`)
      .get() as Record<string, unknown> | undefined;
    const maxNum = maxRow ? (maxRow["max_num"] as number | null) : null;
    const nextId = `${TRACKER_ITEM_ID_PREFIX}${String((maxNum ?? 0) + 1).padStart(3, "0")}`;

    db.prepare(
      `INSERT INTO tracker_items (
         id, type, title, status, severity, disposition_tags, detail,
         resolution_note, created_at, updated_at, resolved_at
       ) VALUES (
         :id, :type, :title, 'open', :severity, :disposition_tags, :detail,
         NULL, :created_at, :updated_at, NULL
       )`,
    ).run({
      ":id": nextId,
      ":type": input.type,
      ":title": title,
      ":severity": severity,
      ":disposition_tags": JSON.stringify(input.dispositionTags ?? []),
      ":detail": input.detail ?? "",
      ":created_at": now,
      ":updated_at": now,
    });

    const refStmt = db.prepare(
      `INSERT INTO track_item_refs (track_id, ref_kind, ref_value, created_at)
       VALUES (:track_id, :ref_kind, :ref_value, :created_at)`,
    );
    for (const ref of refs) {
      refStmt.run({
        ":track_id": nextId,
        ":ref_kind": ref.refKind,
        ":ref_value": ref.refValue,
        ":created_at": now,
      });
    }

    return nextId;
  });

  // Commit first, render second — a pane-render failure must never propagate
  // and cost the caller an already-durable row.
  try {
    renderTrackerLedger(basePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("projection", `tracker pane render failed after createTrackerItem ${trackId}: ${msg}`);
  }

  return { trackId };
}
