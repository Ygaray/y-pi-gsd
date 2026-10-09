// GSD MCP Server — GSD-alert-bot producer for the out-of-process ask_user_questions tool
//
// The claude-code provider asks questions through this server, not through the in-process
// ask_user_questions extension tool, so the extension's needs_input alert never sees them.
// This server cannot read the host's auto-mode state, so the host tells it per query via env
// (injected in claude-code-cli/stream-adapter.ts injectAlertBotSessionContext):
//
//   GSD_UNATTENDED=1      nobody is watching: auto-mode active for this project, headless, or no UI
//   GSD_ALERT_PROJECT     the project slug (original project root, not an auto worktree)
//   GSD_ALERT_BOT=0       operator opted out (notifications.alert_bot: false)
//
// Without GSD_UNATTENDED=1 nothing is sent — that includes every host that is not y-pi-gsd's
// claude-code provider (e.g. Claude Code's own gsd-workflow sessions).
//
// Product independence: the bot is reached ONLY through its `gsd-alert-emit` CLI contract,
// resolved on PATH. Deliberately duplicated from src/resources/extensions/gsd/alert-bot.ts
// (no cross-package import). Detached, stdio ignored, unref'd, every failure swallowed.

import childProcess from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { basename, delimiter, join } from 'node:path';

const BIN_NAME = 'gsd-alert-emit';

export const ALERT_BOT_UNATTENDED_ENV = 'GSD_UNATTENDED';
export const ALERT_BOT_PROJECT_ENV = 'GSD_ALERT_PROJECT';
export const ALERT_BOT_ENABLED_ENV = 'GSD_ALERT_BOT';

interface DetachedChild {
  unref(): void;
  on(event: 'error', listener: () => void): unknown;
}

export interface McpAlertBotDeps {
  env?: NodeJS.ProcessEnv;
  resolveBin?: (env: NodeJS.ProcessEnv) => string | null;
  spawnFn?: (bin: string, argv: string[], opts: { detached: true; stdio: 'ignore' }) => DetachedChild;
}

/**
 * Resolve `gsd-alert-emit` on PATH, or null. Also null under a test runner (`node --test` sets
 * NODE_TEST_CONTEXT; vitest sets VITEST) or with GSD_ALERT_DISABLE=1.
 */
export function resolveAlertEmitBin(env: NodeJS.ProcessEnv = process.env): string | null {
  try {
    if (env.NODE_TEST_CONTEXT || env.VITEST || env.GSD_ALERT_DISABLE === '1') return null;
    for (const dir of (env.PATH ?? '').split(delimiter).filter(Boolean)) {
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

/**
 * Tee a pending ask_user_questions prompt to GSD-alert-bot as `needs_input`, but only when the
 * host marked this query unattended. Fire-and-forget: never throws, never blocks the question.
 */
export function emitNeedsInputAlert(
  questions: ReadonlyArray<{ question: string }>,
  deps: McpAlertBotDeps = {},
): void {
  try {
    const env = deps.env ?? process.env;
    if (env[ALERT_BOT_UNATTENDED_ENV] !== '1') return;
    if (env[ALERT_BOT_ENABLED_ENV] === '0') return;
    const bin = (deps.resolveBin ?? resolveAlertEmitBin)(env);
    if (!bin) return;
    const project = env[ALERT_BOT_PROJECT_ENV]?.trim()
      || basename(env.GSD_WORKFLOW_PROJECT_ROOT?.trim() || process.cwd());
    const title = questions[0]?.question ?? 'Question waiting for an answer';
    const spawnFn = deps.spawnFn ?? ((b, argv, opts) => childProcess.spawn(b, argv, opts));
    const child = spawnFn(bin, [
      '--source', 'y-pi-gsd',
      '--project', project,
      '--event', 'needs_input',
      '--severity', 'loud',
      '--title', title,
      '--dedup-key', `needs_input:${title}`,
    ], { detached: true, stdio: 'ignore' });
    child.on('error', () => {});
    child.unref();
  } catch {
    // Non-fatal — alert-bot delivery is best-effort
  }
}
