// Project/App: gsd-pi
// File Purpose: the session_start notice that tells a fresh y-pi-gsd session a yahir-handoff
// is waiting (HANDOFF-01 SC2). Read-only toward the store: it never takes, closes or drops
// anything (D-05) and never shows the CLI's own rendered text, which carries another
// harness's commands (D-07). Every line is written here from the structured handoffs[].

import type { ExtensionContext } from "@gsd/pi-coding-agent";

import { sanitizeCliText } from "./commands-doc.js";
import { isDbAvailable } from "./gsd-db.js";
import { describeHandoffFailure, noticeHandoffs } from "./handoff-client.js";
import type { HandoffEntry, HandoffRunner } from "./handoff-client.js";
import { readStoredHandoff } from "./handoff-record.js";
import type { StoredHandoff } from "./handoff-record.js";

/** Handoff lines shown in one startup notify; the rest collapse into an overflow line (DP-10). */
export const STARTUP_NOTICE_MAX_LINES = 5;
/** Per-title cap in characters (DP-10, T-45-17). */
export const NOTICE_TITLE_MAX = 100;

export interface StartupNoticeInput {
  /** SessionStartEvent.reason; undefined when the host passed no event */
  reason?: string;
  autoActive: boolean;
  autoPaused: boolean;
}

export interface StartupNoticeDeps {
  run?: HandoffRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  /** test seam: replaces the isDbAvailable()-guarded read of the stored record */
  readStored?: () => StoredHandoff | null | undefined;
}

/**
 * Startup-only gating (D-07): a fresh interactive start, never reload/new/resume/fork, never a
 * per-unit newSession restart while auto runs or is paused, never without a UI.
 */
export function shouldShowStartupNotice(input: StartupNoticeInput, hasUI: boolean): boolean {
  return input.reason === "startup" && hasUI === true && !input.autoActive && !input.autoPaused;
}

/** "just now" / "<n>m ago" / "<n>h ago" / "<n>d ago"; null when the timestamp is unparsable. */
export function formatHandoffAge(createdAt: string | null, now: Date): string | null {
  if (createdAt === null) return null;
  const then = Date.parse(createdAt);
  if (Number.isNaN(then)) return null;
  const diffMs = Math.max(0, now.getTime() - then);
  const minutes = Math.floor(diffMs / 60_000);
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function cleanTitle(title: string): string {
  const flat = sanitizeCliText(title).replace(/\s+/g, " ").trim();
  if (flat === "") return "(untitled)";
  return flat.length > NOTICE_TITLE_MAX ? flat.slice(0, NOTICE_TITLE_MAX).trimEnd() : flat;
}

/** Tracer form: the pickable y-pi-gsd lines only. Returns null when there is nothing to show. */
export function formatStartupNotice(
  entries: HandoffEntry[],
  stored: StoredHandoff | null | undefined,
  takenStored: HandoffEntry | null,
  now: Date,
): string | null {
  void takenStored;
  const lines: string[] = [];
  for (const entry of entries) {
    if (entry.harness !== "y-pi-gsd") continue;
    if (stored !== undefined && stored?.id !== entry.id) continue;
    const age = formatHandoffAge(entry.createdAt, now);
    lines.push(`Handoff waiting: ${cleanTitle(entry.title)}${age === null ? "" : ` · ${age}`} — /gsd resume-work (${entry.id})`);
  }
  return lines.length === 0 ? null : lines.join("\n");
}

/** One warning line that always names "yahir-handoff notice failed" plus the exit code or kind. */
function failureWarning(described: string): string {
  const prefix = "yahir-handoff notice failed";
  if (described.startsWith(prefix)) return sanitizeCliText(described);
  return sanitizeCliText(`${prefix} — ${described.replace(/^yahir-handoff notice /, "")}`);
}

/**
 * Run `yahir-handoff notice --json` and show one y-pi-gsd-written notify. Never throws into
 * the session_start hook. Silent when the CLI is not installed (D-09); one warning when it fails.
 */
export async function showStartupNotice(
  input: StartupNoticeInput,
  ctx: ExtensionContext,
  basePath: string,
  deps: StartupNoticeDeps = {},
): Promise<void> {
  try {
    if (!shouldShowStartupNotice(input, ctx.hasUI)) return;
    // DP-11: never open the DB from a background task; read the record only if it is already open.
    const stored = deps.readStored ? deps.readStored() : isDbAvailable() ? readStoredHandoff() : undefined;
    const sessionIdRaw = ctx.sessionManager?.getSessionId?.();
    const sessionId = typeof sessionIdRaw === "string" && sessionIdRaw !== "" ? sessionIdRaw : undefined;
    const result = await noticeHandoffs({
      cwd: basePath,
      sessionId,
      env: deps.env,
      run: deps.run,
      timeoutMs: deps.timeoutMs,
    });
    if (result.ok === false) {
      if (result.kind === "not-installed") return;
      ctx.ui.notify(failureWarning(describeHandoffFailure(result)), "warning");
      return;
    }
    const line = formatStartupNotice(result.value.handoffs, stored, null, deps.now?.() ?? new Date());
    if (line !== null) ctx.ui.notify(sanitizeCliText(line).replace(/\r/g, ""), "info");
  } catch {
    /* fail-open: the notice must never break startup */
  }
}
