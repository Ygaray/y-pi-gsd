// Project/App: gsd-pi
// File Purpose: y-pi-gsd's ownership record for its own yahir-handoff entry, stored next to
// paused_session in runtime_kv, and the single close path used by resume and the
// paused_session clear sites (HANDOFF-01, D-04, D-06, DP-2, DP-8). Soft state only: losing
// the row never changes pause/resume mechanics. Never throws.

import { statSync } from "node:fs";

import { deleteRuntimeKv, getRuntimeKv, setRuntimeKv } from "./db/runtime-kv.js";
import { isDbAvailable } from "./gsd-db.js";
import { describeHandoffFailure, doneHandoff, dropHandoff, isValidHandoffId } from "./handoff-client.js";
import type { HandoffRunner } from "./handoff-client.js";
import { logWarning } from "./workflow-logger.js";

export const HANDOFF_KV_KEY = "y_pi_gsd_handoff";

export type HandoffSource = "pause" | "pause-work";

export interface StoredHandoff {
  id: string;
  createdAt: string;
  /** true when a paused_session existed at registration (DP-2 link gate) */
  hadPausedSession: boolean;
  source: HandoffSource;
}

export type CloseOutcome = {
  status: "no-record" | "skipped-unlinked" | "closed" | "already-closed" | "failed";
  id?: string;
  message?: string;
};

export interface CloseStoredHandoffOpts {
  /** only close when the record was registered together with a paused_session (DP-2) */
  requirePausedSessionLink?: boolean;
  sessionId?: string | null;
  run?: HandoffRunner;
  env?: NodeJS.ProcessEnv;
  timeoutMs?: number;
  onWarning?: (message: string) => void;
}

export function readStoredHandoff(): StoredHandoff | null {
  try {
    const raw = getRuntimeKv<unknown>("global", "", HANDOFF_KV_KEY);
    if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
    const r = raw as Record<string, unknown>;
    if (!isValidHandoffId(r.id)) return null;
    if (typeof r.createdAt !== "string") return null;
    if (typeof r.hadPausedSession !== "boolean") return null;
    if (r.source !== "pause" && r.source !== "pause-work") return null;
    return { id: r.id, createdAt: r.createdAt, hadPausedSession: r.hadPausedSession, source: r.source };
  } catch {
    return null;
  }
}

/** Returns false (and writes nothing) when the DB is unavailable. */
export function writeStoredHandoff(record: StoredHandoff): boolean {
  try {
    if (!isDbAvailable()) return false;
    setRuntimeKv("global", "", HANDOFF_KV_KEY, record);
    return true;
  } catch {
    return false;
  }
}

export function clearStoredHandoff(): void {
  try {
    deleteRuntimeKv("global", "", HANDOFF_KV_KEY);
  } catch {
    /* soft state */
  }
}

function isExistingDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Close (done/drop) the handoff y-pi-gsd itself registered — only ever the stored id, so a
 * foreign handoff can never be closed (T-45-09). The record is cleared on success and when the
 * entry is already closed or gone (exit 6/9); any other failure keeps it and warns once.
 */
export async function closeStoredHandoff(
  outcome: "done" | "drop",
  basePath: string,
  opts: CloseStoredHandoffOpts = {},
): Promise<CloseOutcome> {
  try {
    const record = readStoredHandoff();
    if (!record) return { status: "no-record" };
    if (opts.requirePausedSessionLink && !record.hadPausedSession) {
      return { status: "skipped-unlinked", id: record.id };
    }
    // id-addressed ops do not depend on the project, so a vanished base path falls back to cwd
    const cwd = isExistingDirectory(basePath) ? basePath : process.cwd();
    const close = outcome === "done" ? doneHandoff : dropHandoff;
    const result = await close(record.id, {
      cwd,
      sessionId: opts.sessionId,
      env: opts.env,
      run: opts.run,
      timeoutMs: opts.timeoutMs,
    });
    if (result.ok) {
      clearStoredHandoff();
      return { status: "closed", id: record.id };
    }
    if (result.kind === "not-allowed" || result.kind === "not-found") {
      clearStoredHandoff();
      return { status: "already-closed", id: record.id };
    }
    const message = describeHandoffFailure(result);
    logWarning("session", message, { file: "handoff-record.ts" });
    opts.onWarning?.(message);
    return { status: "failed", id: record.id, message };
  } catch (err) {
    const message = `handoff close failed: ${err instanceof Error ? err.message : String(err)}`;
    try {
      logWarning("session", message, { file: "handoff-record.ts" });
    } catch {
      /* never rethrow */
    }
    return { status: "failed", message };
  }
}
