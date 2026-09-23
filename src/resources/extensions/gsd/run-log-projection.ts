// Project/App: gsd-pi
// File Purpose: Milestone run-log projection (DRIVER-01, ROADMAP SC1).
//
// Full-table regeneration, read-then-render projection of the durable
// `milestone_run_log` table into `.gsd/RUN-LOG.md`, readable independently
// of the raw JSONL journal (D-01). Both call sites are synchronous, so the
// write is a plain synchronous read-render-rename, mirroring the Gate-2
// human-UAT ledger's own atomic-write idiom.

import { existsSync, mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { getDbOrNull } from "./db/engine.js";
import type {
  MilestoneRunLogRow,
  MilestoneRunLogStatus,
} from "./db/writers/milestone-run-log.js";
import { gsdProjectionRoot } from "./paths.js";

export const RUN_LOG_PROJECTION_FILENAME = "RUN-LOG.md";

export type { MilestoneRunLogRow };

interface RawMilestoneRunLogRow {
  entry_id: unknown;
  project_id: unknown;
  milestone_id: unknown;
  run_id: unknown;
  attempt: unknown;
  status: unknown;
  resume_from: unknown;
  pause_kind: unknown;
  reason: unknown;
  host_pid: unknown;
  started_at: unknown;
  updated_at: unknown;
}

function nullableString(value: unknown): string | null {
  return value === null || value === undefined ? null : String(value);
}

function nullableNumber(value: unknown): number | null {
  return value === null || value === undefined ? null : Number(value);
}

/**
 * A single whole-table read of the run-log, ordered oldest-first. The DB
 * row is the only writable source for THIS projection -- this function is
 * purely a display/read surface.
 */
export function readMilestoneRunLog(): MilestoneRunLogRow[] {
  const db = getDbOrNull();
  if (!db) return [];
  const rows = db
    .prepare(
      `
    SELECT entry_id, project_id, milestone_id, run_id, attempt, status,
      resume_from, pause_kind, reason, host_pid, started_at, updated_at
    FROM milestone_run_log
    ORDER BY started_at ASC, entry_id ASC
  `,
    )
    .all() as unknown as RawMilestoneRunLogRow[];
  return rows.map((row) => ({
    entryId: String(row.entry_id),
    projectId: String(row.project_id),
    milestoneId: String(row.milestone_id),
    runId: String(row.run_id),
    attempt: Number(row.attempt),
    status: row.status as MilestoneRunLogStatus,
    resumeFrom: nullableNumber(row.resume_from),
    pauseKind: nullableString(row.pause_kind),
    reason: nullableString(row.reason),
    hostPid: Number(row.host_pid),
    startedAt: String(row.started_at),
    updatedAt: String(row.updated_at),
  }));
}

/**
 * The single `status = 'running'` row for a milestone, or null when no run
 * is currently active. The partial unique index
 * (`idx_milestone_run_log_one_active`, Task 3) guarantees at most one such
 * row per (project, milestone) can ever exist.
 */
export function getActiveMilestoneRun(milestoneId: string): MilestoneRunLogRow | null {
  const running = readMilestoneRunLog().filter(
    (row) => row.milestoneId === milestoneId && row.status === "running",
  );
  return running.length > 0 ? running[running.length - 1]! : null;
}

/**
 * Collapse newlines and escape `|` so one bad row's untrusted prose (a
 * pause `reason`) cannot forge extra table rows/columns in the
 * operator-facing document (T-16-01, ASVS V5).
 */
function escapeCell(value: string): string {
  return value.replace(/\r\n|\r|\n/g, " ").replace(/\|/g, "\\|");
}

/**
 * Pure function: the ENTIRE document from `rows`, never a patch. The
 * document declares itself a generated projection so an operator never
 * mistakes it for an editable source of truth.
 */
export function renderMilestoneRunLogMarkdown(rows: MilestoneRunLogRow[]): string {
  const lines: string[] = [];
  lines.push("# Milestone Run Log");
  lines.push("");
  lines.push(
    "> Generated, read-only projection of the `milestone_run_log` table. "
      + "Regenerated in full on every run-log write -- manual edits are discarded.",
  );
  lines.push("");
  if (rows.length === 0) {
    lines.push("No run-log entries yet.");
  } else {
    lines.push("| Entry | Milestone | Run | Attempt | Status | Started | Updated |");
    lines.push("| --- | --- | --- | --- | --- | --- | --- |");
    for (const row of rows) {
      lines.push(
        `| ${escapeCell(row.entryId)} | ${escapeCell(row.milestoneId)} | ${escapeCell(row.runId)} | `
          + `${row.attempt} | ${escapeCell(row.status)} | ${escapeCell(row.startedAt)} | `
          + `${escapeCell(row.updatedAt)} |`,
      );
    }
  }
  lines.push("");
  return lines.join("\n");
}

/**
 * Synchronous atomic writer. Returns `false` immediately when no database
 * is open (never throws); otherwise regenerates `.gsd/RUN-LOG.md` in full
 * and returns `true`. Writes to a temp path and renames into place so a
 * reader never observes a half-written file.
 */
export function renderMilestoneRunLog(basePath: string): boolean {
  if (getDbOrNull() === null) return false;
  const rows = readMilestoneRunLog();
  const content = renderMilestoneRunLogMarkdown(rows);
  const dir = gsdProjectionRoot(basePath);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  const target = join(dir, RUN_LOG_PROJECTION_FILENAME);
  const temporaryPath = `${target}.tmp`;
  writeFileSync(temporaryPath, content, "utf-8");
  renameSync(temporaryPath, target);
  return true;
}
