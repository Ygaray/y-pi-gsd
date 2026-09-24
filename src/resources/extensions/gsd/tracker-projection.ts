// Project/App: gsd-pi
// File Purpose: Full-table-regeneration two-pane projection of the durable
// `tracker_items` table (TRACK-04) into `.gsd/BACKLOG.md` and
// `.gsd/INCIDENTS.md`. Both output files are generated, disposable,
// full-regeneration views — this module is the only place in the codebase
// permitted to open either pane file for writing.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDbOrNull } from "./db/engine.js";
import type {
  TrackerItemRefInput,
  TrackerItemRow,
  TrackerItemType,
} from "./db/writers/tracker-item.js";
import { gsdProjectionRoot } from "./paths.js";

export const TRACKER_BACKLOG_PROJECTION_FILENAME = "BACKLOG.md";
export const TRACKER_INCIDENTS_PROJECTION_FILENAME = "INCIDENTS.md";

const TERMINAL_STATUSES = new Set(["resolved", "closed", "wont-fix"]);

interface RawTrackerItemRow {
  id: unknown;
  type: unknown;
  title: unknown;
  status: unknown;
  severity: unknown;
  disposition_tags: unknown;
  detail: unknown;
  resolution_note: unknown;
  created_at: unknown;
  updated_at: unknown;
  resolved_at: unknown;
}

interface RawTrackItemRefRow {
  track_id: unknown;
  ref_kind: unknown;
  ref_value: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Parse a row's `disposition_tags` (untrusted DB content, T-17-02) without
 * ever throwing. A malformed value never blanks the whole row — it produces a
 * single marker tag so one bad row can never blank the whole pane.
 */
function parseDispositionTags(value: unknown): string[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("disposition_tags is not an array");
    return parsed.map((entry) => String(entry));
  } catch {
    return ["(tags unavailable)"];
  }
}

/**
 * A single whole-table read of both `tracker_items` and `track_item_refs`,
 * ordered oldest-first, grouped onto their parent rows in memory so the whole
 * read is two statements regardless of row count.
 */
export function readTrackerItems(): TrackerItemRow[] {
  const db = getDbOrNull();
  if (!db) return [];

  const itemRows = db
    .prepare(
      `
      SELECT id, type, title, status, severity, disposition_tags, detail,
        resolution_note, created_at, updated_at, resolved_at
      FROM tracker_items
      ORDER BY created_at ASC, id ASC
    `,
    )
    .all() as unknown as RawTrackerItemRow[];

  const refRows = db
    .prepare(
      `
      SELECT track_id, ref_kind, ref_value
      FROM track_item_refs
      ORDER BY track_id ASC, ref_kind ASC, ref_value ASC
    `,
    )
    .all() as unknown as RawTrackItemRefRow[];

  const refsByTrackId = new Map<string, TrackerItemRefInput[]>();
  for (const raw of refRows) {
    const trackId = String(raw.track_id);
    const list = refsByTrackId.get(trackId) ?? [];
    list.push({
      refKind: raw.ref_kind as TrackerItemRefInput["refKind"],
      refValue: String(raw.ref_value),
    });
    refsByTrackId.set(trackId, list);
  }

  return itemRows.map((row) => {
    const id = String(row.id);
    return {
      id,
      type: row.type as TrackerItemType,
      title: String(row.title),
      status: row.status as TrackerItemRow["status"],
      severity: row.severity as TrackerItemRow["severity"],
      dispositionTags: parseDispositionTags(row.disposition_tags),
      detail: String(row.detail ?? ""),
      resolutionNote: nullableString(row.resolution_note),
      createdAt: String(row.created_at),
      updatedAt: String(row.updated_at),
      resolvedAt: nullableString(row.resolved_at),
      refs: refsByTrackId.get(id) ?? [],
    };
  });
}

/**
 * Collapse newlines and escape `|` so one untrusted string cannot forge extra
 * table rows/columns in either operator-facing document (T-17-01, ASVS V5).
 */
function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

function renderRefs(refs: TrackerItemRefInput[]): string {
  if (refs.length === 0) return "-";
  return refs.map((ref) => escapeCell(`${ref.refKind}:${ref.refValue}`)).join(", ");
}

function renderTags(tags: string[]): string {
  if (tags.length === 0) return "-";
  return tags.map((tag) => escapeCell(tag)).join(", ");
}

/**
 * Optional per-row detail/resolution-note lines, rendered only when the
 * underlying field is present -- an item with neither adds no extra output
 * (must_haves.truths T-17-01: a crafted title must add exactly one row line).
 */
function renderItemDetailLines(row: TrackerItemRow): string[] {
  const lines: string[] = [];
  if (row.detail.trim().length > 0) {
    lines.push(`  - Detail: ${escapeCell(row.detail)}`);
  }
  if (row.resolutionNote !== null && row.resolutionNote.trim().length > 0) {
    lines.push(`  - Resolution: ${escapeCell(row.resolutionNote)}`);
  }
  return lines;
}

/**
 * Pure function: the ENTIRE document for one pane from `rows`, never a patch.
 * The document declares itself a generated, read-only projection so an
 * operator never mistakes it for an editable source of truth
 * (must_haves.prohibitions, T-17-06).
 */
export function renderTrackerMarkdown(rows: TrackerItemRow[], pane: TrackerItemType): string {
  const heading = pane === "backlog" ? "Backlog" : "Incidents";
  const open = rows.filter((row) => !TERMINAL_STATUSES.has(row.status));
  const closed = rows.filter((row) => TERMINAL_STATUSES.has(row.status));

  const lines: string[] = [];
  lines.push(`# ${heading}`);
  lines.push("");
  lines.push(
    `> Generated, read-only projection of the \`tracker_items\` table (type = '${pane}'). `
      + "Regenerated in full on every write -- manual edits are discarded.",
  );
  lines.push("");
  lines.push("## Open");
  lines.push("");
  if (open.length === 0) {
    lines.push(`No open ${heading.toLowerCase()} items.`);
  } else {
    lines.push("| Id | Severity | Status | Title | Tags | Refs | Updated |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of open) {
      lines.push(
        `| ${escapeCell(row.id)} | ${escapeCell(row.severity)} | ${escapeCell(row.status)} | `
          + `${escapeCell(row.title)} | ${renderTags(row.dispositionTags)} | ${renderRefs(row.refs)} | `
          + `${escapeCell(row.updatedAt)} |`,
      );
    }
    const openDetailLines = open.flatMap((row) => renderItemDetailLines(row));
    if (openDetailLines.length > 0) {
      lines.push("");
      lines.push(...openDetailLines);
    }
  }
  lines.push("");
  lines.push("## Closed");
  lines.push("");
  if (closed.length === 0) {
    lines.push(`No closed ${heading.toLowerCase()} items.`);
  } else {
    lines.push("| Id | Severity | Status | Title | Tags | Refs | Updated |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of closed) {
      lines.push(
        `| ${escapeCell(row.id)} | ${escapeCell(row.severity)} | ${escapeCell(row.status)} | `
          + `${escapeCell(row.title)} | ${renderTags(row.dispositionTags)} | ${renderRefs(row.refs)} | `
          + `${escapeCell(row.updatedAt)} |`,
      );
    }
    const closedDetailLines = closed.flatMap((row) => renderItemDetailLines(row));
    if (closedDetailLines.length > 0) {
      lines.push("");
      lines.push(...closedDetailLines);
    }
  }
  lines.push("");
  return lines.join("\n");
}

function writeProjectionFile(basePath: string, filename: string, content: string): void {
  const dir = gsdProjectionRoot(basePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, filename);
  const temporaryPath = `${target}.tmp`;
  writeFileSync(temporaryPath, content, "utf-8");
  renameSync(temporaryPath, target);
}

/**
 * Synchronous atomic writer for BOTH panes. Returns `false` immediately when
 * no database is open (never throws); otherwise takes ONE `readTrackerItems()`
 * result, renders both panes from it, and writes each through the atomic
 * tmp-write + rename idiom so a reader never observes a half-written file.
 */
export function renderTrackerLedger(basePath: string): boolean {
  if (getDbOrNull() === null) return false;
  const rows = readTrackerItems();
  const backlogRows = rows.filter((row) => row.type === "backlog");
  const incidentRows = rows.filter((row) => row.type === "incident");
  writeProjectionFile(basePath, TRACKER_BACKLOG_PROJECTION_FILENAME, renderTrackerMarkdown(backlogRows, "backlog"));
  writeProjectionFile(basePath, TRACKER_INCIDENTS_PROJECTION_FILENAME, renderTrackerMarkdown(incidentRows, "incident"));
  return true;
}
