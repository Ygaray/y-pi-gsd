// Project/App: gsd-pi
// File Purpose: y-pi-gsd's pause-side yahir-handoff integration (HANDOFF-01): registers a
// handoff from canonical state on the two explicit operator pauses only (D-01/D-03); never
// throws and never blocks a pause (D-09).

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { lstatSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";

import { sanitizeCliText } from "./commands-doc.js";
import { buildHandoffBody } from "./handoff-body.js";
import type { HandoffNotes } from "./handoff-body.js";
import { createHandoff, describeHandoffFailure, showHandoff } from "./handoff-client.js";
import type { HandoffCallOpts, HandoffFailure, HandoffRunner } from "./handoff-client.js";
import { readStoredHandoff, writeStoredHandoff } from "./handoff-record.js";
import { projectRoot } from "./commands/context.js";
import { isDbAvailable } from "./gsd-db.js";
import { readPausedSessionMetadata } from "./interrupted-session.js";
import { gsdRoot } from "./paths.js";

export type RegisterSource = "pause" | "pause-work";

/** The subset of GSDState the handoff body needs. */
export interface StateSnapshot {
  activeMilestone: { id: string; title?: string } | null;
  activeSlice: { id: string; title?: string } | null;
  activeTask: { id: string; title?: string } | null;
  phase: string | null;
  nextAction: string | null;
  blockers: string[];
  recentDecisions: string[];
}

export interface PauseHandoffDeps {
  run?: HandoffRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  now?: () => Date;
  readState?: (basePath: string) => Promise<StateSnapshot | null>;
  isAutoActive?: () => boolean;
}

export type RegisterOutcome = { status: "registered" | "skipped" | "failed"; id?: string; message?: string };

export const HANDOFF_NOT_ON_PATH_WARNING = "pause saved; handoff not registered — yahir-handoff not on PATH";

const HANDOFF_NOTES_FILE_MAX_BYTES = 1024 * 1024;

/**
 * The LLM-written `.gsd/HANDOFF.md`, when present as a regular file of at most 1 MiB. A symlink
 * is refused (lstat, not stat): a repository could point it at a secret file that would then be
 * persisted into the shared handoff store. It may
 * predate this pause (the pause-work prompt writes it after registration), so the body labels it
 * with the mtime returned here. Never throws.
 */
export function readHandoffNotes(basePath: string): HandoffNotes | null {
  try {
    const file = join(gsdRoot(basePath), "HANDOFF.md");
    const stat = lstatSync(file); // lstat: a symlink is not isFile()
    if (!stat.isFile() || stat.size > HANDOFF_NOTES_FILE_MAX_BYTES) return null;
    return { text: readFileSync(file, "utf-8"), mtime: stat.mtime.toISOString() };
  } catch {
    return null;
  }
}

function pauseFailureMessage(f: HandoffFailure): string {
  if (f.kind === "not-installed") return HANDOFF_NOT_ON_PATH_WARNING;
  if (f.op === "create" && f.kind === "timeout") {
    return "pause saved; the handoff may have been registered — yahir-handoff create timed out; check `yahir-handoff ls`";
  }
  return `pause saved; handoff not registered — ${describeHandoffFailure(f)}`;
}

async function defaultReadState(basePath: string): Promise<StateSnapshot | null> {
  const { deriveState } = await import("./state.js");
  const s = await deriveState(basePath);
  return {
    activeMilestone: s.activeMilestone,
    activeSlice: s.activeSlice,
    activeTask: s.activeTask,
    phase: s.phase,
    nextAction: s.nextAction,
    blockers: s.blockers,
    recentDecisions: s.recentDecisions,
  };
}

async function defaultIsAutoActive(): Promise<boolean> {
  try {
    const { isAutoActive } = await import("./auto.js");
    return isAutoActive();
  } catch {
    return false;
  }
}

export async function registerPauseHandoff(
  ctx: ExtensionCommandContext,
  source: RegisterSource,
  deps: PauseHandoffDeps = {},
): Promise<RegisterOutcome> {
  // Single notify boundary (T-45-12): every message is sanitized before it reaches the TUI.
  const say = (message: string, level: "info" | "warning"): void => {
    ctx.ui.notify(sanitizeCliText(message), level);
  };
  try {
    let basePath: string;
    try {
      basePath = projectRoot();
    } catch (err) {
      const message = `pause saved; handoff not registered — ${err instanceof Error ? err.message : String(err)}`;
      say(message, "warning");
      return { status: "skipped", message };
    }

    if (source === "pause-work") {
      try {
        const { ensureDbOpen } = await import("./bootstrap/dynamic-tools.js");
        await ensureDbOpen(basePath);
      } catch {
        /* the isDbAvailable check below reports it */
      }
    }
    if (!isDbAvailable()) {
      // DP-16: no CLI call without a tracked project database, so no untracked orphan handoff.
      const message =
        "pause saved; handoff not registered — this project's database is not open, so y-pi-gsd could not track a handoff";
      say(message, "warning");
      return { status: "skipped", message };
    }

    const paused = readPausedSessionMetadata(basePath);
    let state: StateSnapshot | null = null;
    try {
      state = await (deps.readState ?? defaultReadState)(basePath);
    } catch {
      state = null;
    }
    const autoActive = deps.isAutoActive ? deps.isAutoActive() : await defaultIsAutoActive();
    const now = (deps.now ?? (() => new Date()))();

    const { title, body } = buildHandoffBody({
      source,
      projectName: basename(basePath),
      milestone: state?.activeMilestone ?? null,
      slice: state?.activeSlice ?? null,
      task: state?.activeTask ?? null,
      phase: state?.phase ?? null,
      nextAction: state?.nextAction ?? null,
      blockers: state?.blockers ?? [],
      recentDecisions: state?.recentDecisions ?? [],
      paused,
      autoActiveAtRegistration: autoActive,
      notes: readHandoffNotes(basePath),
      now,
    });

    const sid = ctx.sessionManager?.getSessionId?.();
    const sessionId = typeof sid === "string" && sid !== "" ? sid : null;
    const callOpts: HandoffCallOpts = {
      cwd: basePath,
      sessionId,
      env: deps.env,
      run: deps.run,
      timeoutMs: deps.timeoutMs,
    };

    // The CLI calls below can take up to ~26 s in the worst case (8 s timeout + 5 s grace, up to
    // three serial calls) and the caller awaits them, so signal progress before the first one.
    say("Registering handoff…", "info");

    // D-04 / DP-12: supersede only a stored entry that is still open or taken, checked with
    // show first; any show failure other than "unknown id" keeps the old record and aborts.
    let supersedes: string | null = null;
    const stored = readStoredHandoff();
    if (stored) {
      const shown = await showHandoff(stored.id, callOpts);
      if (shown.ok) {
        if (shown.value.state === "open" || shown.value.state === "taken") supersedes = stored.id;
      } else if (shown.kind === "not-installed") {
        say(HANDOFF_NOT_ON_PATH_WARNING, "warning");
        return { status: "failed", message: HANDOFF_NOT_ON_PATH_WARNING };
      } else if (shown.kind !== "not-found") {
        const message = `pause saved; handoff not registered — could not check the previous handoff: ${describeHandoffFailure(shown)}`;
        say(message, "warning");
        return { status: "failed", message };
      }
    }

    let result = await createHandoff({ title, body, supersedes }, callOpts);
    if (!result.ok && supersedes !== null && (result.kind === "not-allowed" || result.kind === "not-found")) {
      // The stored entry closed (or vanished) between show and create: one plain retry.
      supersedes = null;
      result = await createHandoff({ title, body, supersedes: null }, callOpts);
    }
    if (!result.ok) {
      const message = pauseFailureMessage(result);
      say(message, "warning");
      return { status: "failed", message };
    }
    const entry = result.value;
    const recorded = writeStoredHandoff({
      id: entry.id,
      createdAt: entry.createdAt ?? now.toISOString(),
      hadPausedSession: paused !== null,
      source,
    });
    if (!recorded) {
      const message = `handoff ${entry.id} was registered but y-pi-gsd could not record it; remove it with \`yahir-handoff drop ${entry.id}\``;
      say(message, "warning");
      return { status: "failed", id: entry.id, message };
    }
    const replaces = supersedes !== null ? ` (replaces ${supersedes})` : "";
    say(`Handoff registered: ${entry.id}${replaces} — ${title}. Resume it with /gsd resume-work.`, "info");
    return { status: "registered", id: entry.id };
  } catch (err) {
    const message = `pause saved; handoff not registered — unexpected error: ${err instanceof Error ? err.message : String(err)}`;
    try {
      say(message, "warning");
    } catch {
      /* never rethrow */
    }
    return { status: "failed", message };
  }
}
