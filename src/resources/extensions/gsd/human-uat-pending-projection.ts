// Project/App: gsd-pi
// File Purpose: Gate-2 human-UAT pending ledger projection (LEDGER-01, D-04).
//
// Full-table regeneration, read-then-render projection of the durable
// `human_uat_pending` table (13-01) into `.gsd/HUMAN-UAT-PENDING.md`. This
// ledger spans every milestone in the project (FA-7), so it deliberately
// carries no per-artifact table row of its own; both call sites that need
// it are synchronous, so the write is a plain synchronous read-render-rename
// (FA-8), the same atomic-write idiom `RuleRegistry` already uses for its
// own persisted hook state.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDbOrNull } from "./db/engine.js";
import type {
  Gate2HumanUatPartialCriterion,
  HumanUatPendingRow,
} from "./db/writers/milestone-gate2-human-uat.js";
import { gsdProjectionRoot } from "./paths.js";

export const HUMAN_UAT_PENDING_PROJECTION_FILENAME = "HUMAN-UAT-PENDING.md";

export type { HumanUatPendingRow };

interface RawHumanUatPendingRow {
  entry_id: unknown;
  project_id: unknown;
  milestone_id: unknown;
  slice_id: unknown;
  task_id: unknown;
  artifact_path: unknown;
  partial_criteria_json: unknown;
  reason: unknown;
  status: unknown;
  signed_off_at: unknown;
  signed_off_by: unknown;
  signoff_note: unknown;
  created_at: unknown;
  updated_at: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

/**
 * Parse a row's `partial_criteria_json` (untrusted DB content, T-13-05)
 * without ever throwing. A malformed value never produces "no criteria" --
 * that would silently understate an outstanding entry's evidence -- it
 * instead produces a single marker criterion so the render layer still has
 * something to show.
 */
function parsePartialCriteria(value: unknown): Gate2HumanUatPartialCriterion[] {
  if (typeof value !== "string" || value.trim().length === 0) return [];
  try {
    const parsed = JSON.parse(value) as unknown;
    if (!Array.isArray(parsed)) throw new Error("partial_criteria_json is not an array");
    return parsed.filter(
      (entry): entry is Gate2HumanUatPartialCriterion =>
        Boolean(entry) && typeof entry === "object" && typeof (entry as { criterion?: unknown }).criterion === "string",
    );
  } catch {
    return [{ criterion: "(criteria unavailable)", evidence: "" }];
  }
}

/**
 * A single whole-table read of the ledger, ordered oldest-first. The DB row
 * is the only writable source for THIS projection (D-04) -- the milestone
 * close guard's own authority is the event head, never this table; this
 * function is purely a display/read surface (`readOutstandingGate2HumanUat`
 * is the guard's read, not this one).
 */
export function readHumanUatPendingLedger(): HumanUatPendingRow[] {
  const db = getDbOrNull();
  if (!db) return [];
  const rows = db
    .prepare(
      `
    SELECT entry_id, project_id, milestone_id, slice_id, task_id, artifact_path,
      partial_criteria_json, reason, status, signed_off_at, signed_off_by,
      signoff_note, created_at, updated_at
    FROM human_uat_pending
    ORDER BY created_at ASC, entry_id ASC
  `,
    )
    .all() as unknown as RawHumanUatPendingRow[];
  return rows.map((row) => ({
    entryId: String(row.entry_id),
    projectId: String(row.project_id),
    milestoneId: String(row.milestone_id),
    sliceId: String(row.slice_id),
    taskId: nullableString(row.task_id),
    artifactPath: nullableString(row.artifact_path),
    partialCriteria: parsePartialCriteria(row.partial_criteria_json),
    reason: String(row.reason),
    status: row.status as HumanUatPendingRow["status"],
    signedOffAt: nullableString(row.signed_off_at),
    signedOffBy: nullableString(row.signed_off_by),
    signoffNote: nullableString(row.signoff_note),
    createdAt: String(row.created_at),
    updatedAt: String(row.updated_at),
  }));
}

/**
 * Collapse newlines and escape `|` so one bad row's untrusted prose cannot
 * forge extra table rows/columns in the operator-facing document (T-13-05,
 * ASVS V5).
 */
function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

function renderPartialCriteriaList(row: HumanUatPendingRow): string[] {
  if (row.partialCriteria.length === 0) return [];
  const lines = [`- **${escapeCell(row.entryId)}** partial criteria:`];
  for (const criterion of row.partialCriteria) {
    const evidence = criterion.evidence ? ` — ${escapeCell(criterion.evidence)}` : "";
    lines.push(`  - ${escapeCell(criterion.criterion)}${evidence}`);
  }
  return lines;
}

/**
 * Pure function: the ENTIRE document from `rows`, never a patch (D-04). The
 * document declares itself a generated projection so an operator never
 * mistakes it for an editable source of truth (must_haves.prohibitions).
 */
export function renderHumanUatPendingMarkdown(rows: HumanUatPendingRow[]): string {
  const outstanding = rows.filter((row) => row.status === "pending");
  const signedOff = rows.filter((row) => row.status !== "pending");

  const lines: string[] = [];
  lines.push("# Human UAT Pending (Gate-2)");
  lines.push("");
  lines.push(
    "> Generated, read-only projection of the `human_uat_pending` table. "
      + "Regenerated in full on every ledger write -- manual edits are discarded. "
      + "Sign off through `/gsd human-uat sign-off <entry-id>`.",
  );
  lines.push("");
  lines.push("## Outstanding");
  lines.push("");
  if (outstanding.length === 0) {
    lines.push("No outstanding Gate-2 human-UAT entries.");
  } else {
    lines.push("| Entry | Milestone | Slice | Task | Reason | Raised |");
    lines.push("| --- | --- | --- | --- | --- | --- |");
    for (const row of outstanding) {
      lines.push(
        `| ${escapeCell(row.entryId)} | ${escapeCell(row.milestoneId)} | ${escapeCell(row.sliceId)} | `
          + `${escapeCell(row.taskId ?? "-")} | ${escapeCell(row.reason)} | ${escapeCell(row.createdAt)} |`,
      );
    }
    const criteriaLines = outstanding.flatMap((row) => renderPartialCriteriaList(row));
    if (criteriaLines.length > 0) {
      lines.push("");
      lines.push(...criteriaLines);
    }
  }
  lines.push("");
  lines.push("## Signed off");
  lines.push("");
  if (signedOff.length === 0) {
    lines.push("No signed-off Gate-2 human-UAT entries yet.");
  } else {
    lines.push("| Entry | Milestone | Slice | Disposition | Signed off at | Signed off by | Note |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of signedOff) {
      lines.push(
        `| ${escapeCell(row.entryId)} | ${escapeCell(row.milestoneId)} | ${escapeCell(row.sliceId)} | `
          + `${escapeCell(row.status)} | ${escapeCell(row.signedOffAt ?? "-")} | `
          + `${escapeCell(row.signedOffBy ?? "-")} | ${escapeCell(row.signoffNote ?? "-")} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Synchronous atomic writer. Returns `false` immediately when no database is
 * open (never throws); otherwise regenerates `.gsd/HUMAN-UAT-PENDING.md` in
 * full and returns `true`. Writes to a temp path and renames into place so a
 * reader never observes a half-written file.
 */
export function renderHumanUatPendingLedger(basePath: string): boolean {
  if (getDbOrNull() === null) return false;
  const rows = readHumanUatPendingLedger();
  const content = renderHumanUatPendingMarkdown(rows);
  const dir = gsdProjectionRoot(basePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, HUMAN_UAT_PENDING_PROJECTION_FILENAME);
  const temporaryPath = `${target}.tmp`;
  writeFileSync(temporaryPath, content, "utf-8");
  renameSync(temporaryPath, target);
  return true;
}
