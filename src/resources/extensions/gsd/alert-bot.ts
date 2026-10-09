// GSD Extension — GSD-alert-bot producer
// Tees auto-mode run events into the sibling GSD-alert-bot (a standing Discord alerter).
//
// Product independence: the bot is reached ONLY through its `gsd-alert-emit` CLI contract,
// resolved on PATH — no imports from the bot, no hardcoded install path. Absent CLI = no-op.
// Best-effort like every other notification channel: spawned detached with stdio ignored,
// unref'd, and every failure swallowed, so a missing/slow/broken bot can never affect a run.

import childProcess from "node:child_process";
import { accessSync, constants } from "node:fs";
import { delimiter, join } from "node:path";

export type AlertBotEvent = "blocked" | "needs_input" | "milestone_complete";

export interface AlertBotFields {
  event: AlertBotEvent;
  project: string;
  title: string;
}

interface DetachedChild {
  unref(): void;
  on(event: "error", listener: () => void): unknown;
}

export interface AlertBotDeps {
  resolveBin?: () => string | null;
  spawnFn?: (bin: string, argv: string[], opts: { detached: true; stdio: "ignore" }) => DetachedChild;
}

const BIN_NAME = "gsd-alert-emit";

/** Loud events page the operator (mention); quiet ones are progress pings. */
const SEVERITY: Record<AlertBotEvent, "loud" | "quiet"> = {
  blocked: "loud",
  needs_input: "loud",
  milestone_complete: "quiet",
};

/**
 * Resolve `gsd-alert-emit` on PATH, or null. Also null under `node --test` (NODE_TEST_CONTEXT is
 * inherited by every child) or with GSD_ALERT_DISABLE=1, so test runs never reach the live bot.
 */
export function resolveAlertEmitBin(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (env.NODE_TEST_CONTEXT || env.GSD_ALERT_DISABLE === "1") return null;
    for (const dir of (env.PATH ?? "").split(delimiter).filter(Boolean)) {
      const candidate = join(dir, BIN_NAME);
      try {
        accessSync(candidate, constants.X_OK);
        return candidate;
      } catch {
        // not here — keep looking
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** Fire-and-forget: never throws, never blocks. */
export function emitAlertBotEvent(fields: AlertBotFields, deps: AlertBotDeps = {}): void {
  try {
    const bin = (deps.resolveBin ?? resolveAlertEmitBin)();
    if (!bin) return;
    const spawnFn = deps.spawnFn ?? ((b, argv, opts) => childProcess.spawn(b, argv, opts));
    const child = spawnFn(bin, [
      "--source", "y-pi-gsd",
      "--project", fields.project,
      "--event", fields.event,
      "--severity", SEVERITY[fields.event],
      "--title", fields.title,
    ], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {
    // Non-fatal — alert-bot delivery is best-effort
  }
}
