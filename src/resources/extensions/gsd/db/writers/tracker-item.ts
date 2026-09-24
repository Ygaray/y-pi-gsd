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
const TRACKER_ITEM_STATUSES: readonly TrackerItemStatus[] = [
  "open",
  "in-progress",
  "resolved",
  "closed",
  "wont-fix",
];
const TERMINAL_TRACKER_ITEM_STATUSES: readonly TrackerItemStatus[] = ["resolved", "closed", "wont-fix"];
const TRACKER_ITEM_REF_KINDS: readonly TrackerItemRefKind[] = [
  "phase",
  "requirement",
  "reviews_md",
  "track_item",
  "control_plane_incident",
];

/**
 * Mirrors `trg_tracker_items_transition`'s exact WHEN clause (the DB trigger
 * remains the backstop) so an illegal move is refused with a readable
 * message instead of a raw SQL abort: `open` -> any of in-progress/terminal;
 * `in-progress` -> open or any terminal; any terminal -> `open` only.
 */
function isLegalStatusTransition(current: TrackerItemStatus, requested: TrackerItemStatus): boolean {
  if (current === "open") {
    return requested === "in-progress" || TERMINAL_TRACKER_ITEM_STATUSES.includes(requested);
  }
  if (current === "in-progress") {
    return requested === "open" || TERMINAL_TRACKER_ITEM_STATUSES.includes(requested);
  }
  return requested === "open";
}

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
  const seenRefs = new Set<string>();
  for (const ref of refs) {
    if (!TRACKER_ITEM_REF_KINDS.includes(ref.refKind)) {
      throw new Error(`ref kind must be one of ${TRACKER_ITEM_REF_KINDS.join(", ")}`);
    }
    if (!isNonEmptyString(ref.refValue)) {
      throw new Error("ref value is required");
    }
    // WR-03: without this check, a duplicate (refKind, refValue) pair in the
    // same payload throws mid-transaction with the raw
    // `idx_track_item_refs_unique` driver message instead of a friendly one.
    const refKey = `${ref.refKind}:${ref.refValue}`;
    if (seenRefs.has(refKey)) {
      throw new Error(`duplicate ref ${refKey}`);
    }
    seenRefs.add(refKey);
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

export interface UpdateTrackerItemInput {
  trackId: string;
  title?: string;
  severity?: TrackerItemSeverity;
  detail?: string;
  dispositionTags?: string[];
  status?: TrackerItemStatus;
  refs?: TrackerItemRefInput[];
}

export interface ResolveTrackerItemInput {
  trackId: string;
  status: "resolved" | "closed" | "wont-fix";
  resolutionNote?: string;
}

/**
 * Update one or more mutable fields on a tracker item, and optionally
 * replace its whole back-reference set (D-01). Validates before touching the
 * database; at least one mutating field must be supplied. A status change is
 * pre-checked against the same whitelist `trg_tracker_items_transition`
 * encodes so an illegal move is refused with a readable message rather than
 * a raw SQL abort — the trigger remains the DB-level backstop. Reopening a
 * terminal item (new status `open`) clears `resolved_at`. Whole-set ref
 * replacement is one `DELETE` scoped to the parent id followed by one
 * `INSERT` per supplied ref, inside the same transaction as the UPDATE.
 */
export function updateTrackerItem(input: UpdateTrackerItemInput, basePath: string): { trackId: string; changed: boolean } {
  if (!isNonEmptyString(input.trackId)) {
    throw new Error("trackId is required");
  }
  if (input.title !== undefined && !isNonEmptyString(input.title)) {
    throw new Error("title must be non-blank");
  }
  if (input.severity !== undefined && !TRACKER_ITEM_SEVERITIES.includes(input.severity)) {
    throw new Error(`severity must be one of ${TRACKER_ITEM_SEVERITIES.join(", ")}`);
  }
  if (input.status !== undefined && !TRACKER_ITEM_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of ${TRACKER_ITEM_STATUSES.join(", ")}`);
  }
  const refs = input.refs;
  if (refs !== undefined) {
    const seenRefs = new Set<string>();
    for (const ref of refs) {
      if (!TRACKER_ITEM_REF_KINDS.includes(ref.refKind)) {
        throw new Error(`ref kind must be one of ${TRACKER_ITEM_REF_KINDS.join(", ")}`);
      }
      if (!isNonEmptyString(ref.refValue)) {
        throw new Error("ref value is required");
      }
      // WR-03: reject duplicate (refKind, refValue) pairs before the
      // transaction opens with a friendly message rather than letting the
      // unique index throw a raw driver error mid-transaction.
      const refKey = `${ref.refKind}:${ref.refValue}`;
      if (seenRefs.has(refKey)) {
        throw new Error(`duplicate ref ${refKey}`);
      }
      seenRefs.add(refKey);
    }
  }
  const hasMutation = input.title !== undefined
    || input.severity !== undefined
    || input.detail !== undefined
    || input.dispositionTags !== undefined
    || input.status !== undefined
    || refs !== undefined;
  if (!hasMutation) {
    throw new Error("no change requested");
  }

  const now = new Date().toISOString();
  const trackId = transaction(() => {
    const db = getDb();
    const current = db
      .prepare(`SELECT status FROM tracker_items WHERE id = :id`)
      .get({ ":id": input.trackId }) as Record<string, unknown> | undefined;
    if (!current) {
      throw new Error(`unknown tracker item ${input.trackId}`);
    }
    const currentStatus = String(current.status) as TrackerItemStatus;
    if (input.status !== undefined && input.status !== currentStatus) {
      if (!isLegalStatusTransition(currentStatus, input.status)) {
        throw new Error(`cannot move ${currentStatus} -> ${input.status}`);
      }
    }

    const sets: string[] = ["updated_at = :updated_at"];
    const params: Record<string, unknown> = { ":id": input.trackId, ":updated_at": now };
    if (input.title !== undefined) {
      sets.push("title = :title");
      params[":title"] = input.title.trim();
    }
    if (input.severity !== undefined) {
      sets.push("severity = :severity");
      params[":severity"] = input.severity;
    }
    if (input.detail !== undefined) {
      sets.push("detail = :detail");
      params[":detail"] = input.detail;
    }
    if (input.dispositionTags !== undefined) {
      sets.push("disposition_tags = :disposition_tags");
      params[":disposition_tags"] = JSON.stringify(input.dispositionTags);
    }
    if (input.status !== undefined) {
      sets.push("status = :status");
      params[":status"] = input.status;
      if (input.status === "open") {
        // A reopen clears the prior settlement timestamp.
        sets.push("resolved_at = NULL");
      }
    }
    db.prepare(`UPDATE tracker_items SET ${sets.join(", ")} WHERE id = :id`).run(params);

    if (refs !== undefined) {
      db.prepare(`DELETE FROM track_item_refs WHERE track_id = :id`).run({ ":id": input.trackId });
      const refStmt = db.prepare(
        `INSERT INTO track_item_refs (track_id, ref_kind, ref_value, created_at)
         VALUES (:track_id, :ref_kind, :ref_value, :created_at)`,
      );
      for (const ref of refs) {
        refStmt.run({
          ":track_id": input.trackId,
          ":ref_kind": ref.refKind,
          ":ref_value": ref.refValue,
          ":created_at": now,
        });
      }
    }

    return input.trackId;
  });

  try {
    renderTrackerLedger(basePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("projection", `tracker pane render failed after updateTrackerItem ${trackId}: ${msg}`);
  }

  return { trackId, changed: true };
}

/**
 * Settle a tracker item exactly once. Refuses (rather than silently
 * rewriting) when the item is already in a terminal status — the message
 * names the current status so a repeated close is a readable no-op, not a
 * data loss. Sets `status`, `resolved_at`, and the trimmed `resolutionNote`
 * (or NULL) inside one transaction.
 */
export function resolveTrackerItem(input: ResolveTrackerItemInput, basePath: string): { trackId: string; status: TrackerItemStatus } {
  if (!isNonEmptyString(input.trackId)) {
    throw new Error("trackId is required");
  }
  if (!TERMINAL_TRACKER_ITEM_STATUSES.includes(input.status)) {
    throw new Error(`status must be one of ${TERMINAL_TRACKER_ITEM_STATUSES.join(", ")}`);
  }

  const now = new Date().toISOString();
  transaction(() => {
    const db = getDb();
    const current = db
      .prepare(`SELECT status FROM tracker_items WHERE id = :id`)
      .get({ ":id": input.trackId }) as Record<string, unknown> | undefined;
    if (!current) {
      throw new Error(`unknown tracker item ${input.trackId}`);
    }
    const currentStatus = String(current.status) as TrackerItemStatus;
    if (TERMINAL_TRACKER_ITEM_STATUSES.includes(currentStatus)) {
      throw new Error(`tracker item ${input.trackId} is already ${currentStatus}`);
    }
    const note = input.resolutionNote?.trim();
    db.prepare(
      `UPDATE tracker_items
       SET status = :status, resolved_at = :resolved_at, resolution_note = :resolution_note, updated_at = :updated_at
       WHERE id = :id`,
    ).run({
      ":id": input.trackId,
      ":status": input.status,
      ":resolved_at": now,
      ":resolution_note": note && note.length > 0 ? note : null,
      ":updated_at": now,
    });
  });

  try {
    renderTrackerLedger(basePath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    logWarning("projection", `tracker pane render failed after resolveTrackerItem ${input.trackId}: ${msg}`);
  }

  return { trackId: input.trackId, status: input.status };
}
