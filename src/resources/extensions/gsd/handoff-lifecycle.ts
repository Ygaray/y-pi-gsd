// Project/App: gsd-pi
// File Purpose: y-pi-gsd's pause-side yahir-handoff integration (HANDOFF-01): registers a
// handoff from canonical state on the two explicit operator pauses only (D-01/D-03); never
// throws and never blocks a pause (D-09).

import type { ExtensionCommandContext } from "@gsd/pi-coding-agent";
import { basename } from "node:path";

import { sanitizeCliText } from "./commands-doc.js";
import { buildHandoffBody } from "./handoff-body.js";
import { createHandoff, describeHandoffFailure } from "./handoff-client.js";
import type { HandoffRunner } from "./handoff-client.js";
import { writeStoredHandoff } from "./handoff-record.js";
import { projectRoot } from "./commands/context.js";
import { isDbAvailable } from "./gsd-db.js";
import { readPausedSessionMetadata } from "./interrupted-session.js";

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
      notes: null,
      now,
    });

    const sid = ctx.sessionManager?.getSessionId?.();
    const sessionId = typeof sid === "string" && sid !== "" ? sid : null;
    const result = await createHandoff(
      { title, body },
      { cwd: basePath, sessionId, env: deps.env, run: deps.run, timeoutMs: deps.timeoutMs },
    );
    if (!result.ok) {
      const message = `pause saved; handoff not registered — ${describeHandoffFailure(result)}`;
      say(message, "warning");
      return { status: "failed", message };
    }
    const entry = result.value;
    writeStoredHandoff({
      id: entry.id,
      createdAt: entry.createdAt ?? now.toISOString(),
      hadPausedSession: paused !== null,
      source,
    });
    say(`Handoff registered: ${entry.id} — ${title}. Resume it with /gsd resume-work.`, "info");
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
