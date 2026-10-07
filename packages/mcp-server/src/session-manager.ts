/**
 * SessionManager — manages RpcClient lifecycle for background GSD execution.
 *
 * One active session per projectDir. Tracks events in a ring buffer,
 * detects blockers, tracks terminal state, and accumulates cost using
 * the cumulative-max pattern (K004).
 */

import { readFileSync, existsSync } from 'node:fs';
import { resolve, join, delimiter } from 'node:path';
import { RpcClient } from '@opengsd/rpc-client';
import type { SdkAgentEvent, RpcInitResult, RpcCostUpdateEvent, RpcExtensionUIRequest } from '@opengsd/contracts';
import type {
  ManagedSession,
  ExecuteOptions,
  PendingBlocker,
  CostAccumulator,
  SessionStatus,
} from './types.js';
import { MAX_EVENTS, INIT_TIMEOUT_MS } from './types.js';
import { signalAutoLockPid } from './pid-registry.js';
import {
  getSessionEntry,
  isOrphanEntryAlive,
  killOrphanSessionPid,
  registerSessionEntry,
  removeSessionEntry,
  type SessionLivenessOptions,
  type SessionRegistryEntry,
} from './session-persist.js';
import { reconcileOrphanAttempt, type OrphanReconcileResult } from './orphan-reconcile.js';

// ---------------------------------------------------------------------------
// Inlined detection logic (from headless-events.ts — no internal package imports)
// ---------------------------------------------------------------------------

const FIRE_AND_FORGET_METHODS = new Set([
  'notify', 'setStatus', 'setWidget', 'setTitle', 'set_editor_text',
]);

const PAUSED_PREFIXES = [
  'auto-mode paused',
  'step-mode paused',
];

const TERMINAL_PREFIXES = [
  'auto-mode stopped',
  'step-mode stopped',
  'auto-mode complete',
  'no active milestone',
  'auto-mode idle',
];

function findExecutableOnPath(command: string): string | null {
  const pathValue = getPathEnvValue();
  if (!pathValue) return null;
  const extensions = process.platform === 'win32'
    ? ['', ...(process.env['PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD')
      .split(';')
      .filter(Boolean)]
    : [''];
  for (const dir of pathValue.split(delimiter)) {
    if (!dir) continue;
    for (const ext of extensions) {
      const candidate = join(dir, `${command}${ext}`);
      if (existsSync(candidate)) return candidate;
    }
  }
  return null;
}
function getPathEnvValue(env: NodeJS.ProcessEnv = process.env): string {
  return env['PATH'] ?? env['Path'] ?? env['path'] ?? '';
}

function isTerminalNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false;
  const message = String(event.message ?? '').toLowerCase();
  if (TERMINAL_PREFIXES.some((prefix) => message.startsWith(prefix))) return true;
  return PAUSED_PREFIXES.some((prefix) => message.startsWith(prefix)) && isNonBlockingPauseNotice(message);
}

function isNonBlockingPauseNotice(message: string): boolean {
  return message.includes('idempotent advance: unit already active');
}

function isOrchestratorPausedEvent(event: Record<string, unknown>): boolean {
  const data = event.data as Record<string, unknown> | undefined;
  const eventType = String(event.eventType ?? '');
  const name = String(data?.name ?? '');
  const reason = String(data?.reason ?? '').toLowerCase();
  return (
    eventType === 'orchestrator-guard-block' && name === 'advance-paused'
  ) || (
    eventType === 'orchestrator-terminal' && name === 'stop' && reason === 'pause'
  );
}

function isPausedEvent(event: Record<string, unknown>): boolean {
  if (isOrchestratorPausedEvent(event)) return true;
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false;
  const message = String(event.message ?? '').toLowerCase();
  if (isNonBlockingPauseNotice(message)) return false;
  return PAUSED_PREFIXES.some((prefix) => message.startsWith(prefix));
}

function isBlockedNotification(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request' || event.method !== 'notify') return false;
  const message = String(event.message ?? '').toLowerCase();
  return message.includes('blocked:');
}

function isBlockingUIRequest(event: Record<string, unknown>): boolean {
  if (event.type !== 'extension_ui_request') return false;
  const method = String(event.method ?? '');
  return !FIRE_AND_FORGET_METHODS.has(method);
}

// ---------------------------------------------------------------------------
// gsd_status projection — recentEvents shaping (status-flood incident)
//
// A repeated `gsd_status` poll against a nested session re-emitted the raw
// event ring buffer verbatim, including intra-message streaming deltas
// (`toolcall_delta` et al. — one per streamed character/token chunk, never
// meaningful standalone) and unbounded tool payloads. One session's status
// was dumped 5 times in a row with growing 3.7 KB -> 47 KB payloads, flooding
// the human-facing transcript and contributing to context bloat. The
// projection below drops raw streaming fragments and caps per-event byte
// size before events are surfaced through `getResult().recentEvents`.
// ---------------------------------------------------------------------------

/** Intra-message streaming deltas — noise in a point-in-time status snapshot. */
const STREAMING_DELTA_EVENT_TYPES = new Set(['text_delta', 'thinking_delta', 'toolcall_delta']);

/** Max serialized size (bytes) for a single event in a `gsd_status` snapshot. */
const MAX_STATUS_EVENT_PAYLOAD_BYTES = 2_000;

/**
 * Cap an event's serialized size, replacing an oversized event with a
 * truncated preview plus an explicit elided-byte count. Keeps `gsd_status`
 * genuinely useful (recent meaningful events) without any single poll being
 * able to emit tens of KB from one large tool call/result.
 */
function boundEventPayload(event: SdkAgentEvent, maxBytes = MAX_STATUS_EVENT_PAYLOAD_BYTES): SdkAgentEvent {
  const serialized = JSON.stringify(event) ?? '';
  if (serialized.length <= maxBytes) return event;
  return {
    type: event.type,
    truncated: true,
    preview: serialized.slice(0, maxBytes),
    elidedBytes: serialized.length - maxBytes,
  };
}

/**
 * Project the raw event ring buffer into a bounded, human-safe set of recent
 * events for `gsd_status`: streaming deltas are dropped (not just trimmed to
 * `limit`, so meaningful events aren't crowded out by delta noise), and each
 * remaining event's payload is size-capped.
 */
export function projectRecentEvents(events: SdkAgentEvent[], limit: number): SdkAgentEvent[] {
  const meaningful = events.filter((event) => !STREAMING_DELTA_EVENT_TYPES.has(event.type));
  return meaningful.slice(-limit).map((event) => boundEventPayload(event));
}

// ---------------------------------------------------------------------------
// SessionManager
// ---------------------------------------------------------------------------

/**
 * Outcome vocabulary for `reapPersistedOrphanSession` (EXEC-01, Phase 39;
 * restored by 39-03-PLAN.md after 39-VERIFICATION.md gaps 1-3 reported that
 * commit 2a6fd9f7 silently reverted the phase's own locked "settled => no
 * kill" contract). `startSession()` is the only consumer of
 * `OrphanReapOutcome` outside this method — it gates whether the new driver
 * start proceeds or is declined.
 *
 * - `'no-entry'` — no persisted row existed for this `resolvedDir`.
 * - `'stale-entry-dropped'` — the row's pid was dead or recycled; the row
 *   was dropped and nothing was signalled.
 * - `'reaped'` — a confirmed-alive orphan was reconciled to a non-settled
 *   outcome (`'no-attempt'` or `'db-unavailable'`) and its pid was killed.
 * - `'settled-alive'` — a confirmed-alive orphan's Task Attempt was
 *   settled, so its pid was deliberately spared and its registry row was
 *   deliberately kept (PD-8, 39-03-PLAN.md).
 * - `'kill-failed'` — a confirmed-alive orphan was reconciled to a
 *   non-settled outcome, but the kill signal itself failed for a reason
 *   other than "already dead" (e.g. `EPERM`, a sandboxing/seccomp denial).
 *   The process may still be alive, so — mirroring the `'settled-alive'`
 *   rationale (PD-8) — its registry row is deliberately KEPT rather than
 *   dropped, so it remains reapable on a later attempt (CR-01,
 *   39-REVIEW.md).
 */
export type OrphanReapOutcome =
  | 'no-entry'
  | 'stale-entry-dropped'
  | 'reaped'
  | 'settled-alive'
  | 'kill-failed';

/**
 * Discriminant for `SessionDeclinedError` (WR-02, 39-REVIEW.md). `startSession()`
 * throws `Error` with the same "Session already active ..." prefix for three
 * semantically different situations, distinguishable before this type only by
 * substring-matching the parenthetical remainder of the message:
 *
 * - `'active'` — a genuinely running in-memory session exists; a hard stop,
 *   not retryable without first resolving/cancelling the existing session.
 * - `'reap-in-progress'` — a concurrent `startSession()` call for the same
 *   resolvedDir is already inside the awaited orphan reap; retryable once
 *   that call resolves.
 * - `'settled-alive'` — a confirmed-alive orphan's Task Attempt was settled
 *   and its pid deliberately spared; explicitly recoverable by re-issuing
 *   the call.
 * - `'kill-failed'` — the orphan reap's kill signal itself failed; the
 *   registry row was preserved so re-issuing the call will retry the kill.
 */
export type SessionDeclineReason = 'active' | 'reap-in-progress' | 'settled-alive' | 'kill-failed';

/**
 * Thrown by `startSession()` whenever it declines to start a new session for
 * a `projectDir` (WR-02, 39-REVIEW.md). Callers that need to distinguish the
 * four decline cases programmatically can branch on `.reason` instead of
 * parsing the human-readable message prose, while every caller that merely
 * surfaces `err.message` (e.g. the MCP tool layer) keeps working unchanged —
 * this is a plain `Error` subclass, so `instanceof Error` and `.message`
 * behave exactly as before.
 */
export class SessionDeclinedError extends Error {
  readonly reason: SessionDeclineReason;

  constructor(reason: SessionDeclineReason, message: string) {
    super(message);
    this.name = 'SessionDeclinedError';
    this.reason = reason;
  }
}

export class SessionManager {
  /** Sessions keyed by projectDir for duplicate-start prevention */
  private sessions = new Map<string, ManagedSession>();

  /**
   * Synchronous reservation guard (EXEC-01, Phase 39 ripple). The orphan
   * reconcile the fresh-start branch now awaits (`reapPersistedOrphanSession`)
   * yields control back to the microtask queue even when it resolves
   * immediately — breaking the pre-existing CR-02 guarantee that a second
   * same-projectDir `startSession()` fired before the first is awaited can
   * never observe an empty `this.sessions` map. This set closes that window:
   * it is reserved synchronously, before the first await.
   *
   * WR-03 (39-REVIEW.md): it is released in the `finally` block immediately
   * after the awaited `reapPersistedOrphanSession()` call resolves — well
   * BEFORE `this.sessions.set(resolvedDir, session)` is reached, not "once
   * the real session is inserted" as an earlier version of this comment
   * claimed. The gap between that release and the `this.sessions.set(...)`
   * insert (the decline check, `resolveCLIPath()`, `createClient()`,
   * building the session shell) is safe today ONLY because every statement
   * in it is synchronous with no intervening `await` — a future change that
   * adds an `await` in that stretch would silently reopen the exact race
   * this lock exists to close. Keep that stretch synchronous, or move the
   * lock's release to cover it, before adding any `await` there.
   */
  private startingLocks = new Set<string>();

  /**
   * Start a new GSD auto-mode session for the given project directory.
   *
   * Rejects if a session already exists for this projectDir.
   * Creates an RpcClient, starts the process, performs the v2 init handshake,
   * wires event tracking, and sends '/gsd auto' to begin execution.
   */
  async startSession(projectDir: string, options: ExecuteOptions = {}): Promise<string> {
    if (!projectDir || projectDir.trim() === '') {
      throw new Error('projectDir is required and cannot be empty');
    }

    const resolvedDir = resolve(projectDir);

    const existing = this.sessions.get(resolvedDir);
    if (existing) {
      // Only block when a genuinely active session is running. Terminal
      // states (paused, error, completed, cancelled) are evicted so the caller can
      // start a fresh session for the same projectDir.
      if (existing.status === 'starting' || existing.status === 'running' || existing.status === 'blocked') {
        throw new SessionDeclinedError(
          'active',
          `Session already active for ${resolvedDir} (sessionId: ${existing.sessionId}, status: ${existing.status})`
        );
      }
      existing.unsubscribe?.();
      // Reclaim the evicted session's live headless child process. A paused (or
      // otherwise terminal) session keeps its RpcClient alive, so deleting the
      // map entry alone would orphan the child process.
      void existing.client.stop().catch(() => { /* swallow */ });
      this.sessions.delete(resolvedDir);
      // INC-2026-09-29-02 fix 3 (Option B): this in-memory session owned the
      // persisted registry row for resolvedDir — drop it now that we're
      // reclaiming its child, so a future restart doesn't mistake it for an
      // orphan.
      removeSessionEntry(resolvedDir, this.getSessionRegistryPath());
    } else if (this.startingLocks.has(resolvedDir)) {
      // A concurrent startSession() call for this same resolvedDir is
      // already inside the awaited reap below — reject it exactly like the
      // in-memory "already active" case above (CR-02 guarantee, preserved
      // across the now-async reap).
      throw new SessionDeclinedError('reap-in-progress', `Session already active for ${resolvedDir} (reap in progress)`);
    } else {
      // INC-2026-09-29-02 fix 3 (Option B): no in-memory session for this
      // projectDir — but a persisted registry entry may reference a headless
      // child that is still alive from a PRIOR MCP server instance (the
      // in-memory Map is wiped on restart, so startSession()'s "already
      // active" guard above can't see it). Reap it before starting a new
      // driver so at most one driver ever runs per worktree.
      let reapOutcome: OrphanReapOutcome = 'no-entry';
      this.startingLocks.add(resolvedDir);
      try {
        reapOutcome = await this.reapPersistedOrphanSession(resolvedDir);
      } finally {
        this.startingLocks.delete(resolvedDir);
      }
      // EXEC-01 (Phase 39, 39-REVIEW.md CR-01's alternative (b)): the
      // reservation is released above BEFORE this decline check, with no
      // await between the release and the throw — a decline is not a reap
      // failure, so the lock must not be held across it (a concurrent
      // startSession() for this resolvedDir must observe the real decline
      // reason below, not a misleading "reap in progress").
      if (reapOutcome === 'settled-alive' || reapOutcome === 'kill-failed') {
        // CR-01 (39-REVIEW.md): a 'kill-failed' outcome means the signal
        // attempt itself failed (the orphan may still be alive) and its
        // registry row was deliberately preserved (see
        // reapPersistedOrphanSession below) — decline exactly like
        // 'settled-alive' rather than silently spawning a second driver
        // beside a possibly-still-alive orphan.
        const detail = reapOutcome === 'settled-alive'
          ? `its dangling Task Attempt was settled and the live process was deliberately left running rather than signalled; re-issuing this call will reclaim the now-settled pid`
          : `the kill signal failed (see server logs for the underlying error) and the process may still be alive; its registry row was preserved so re-issuing this call will retry the kill`;
        throw new SessionDeclinedError(
          reapOutcome,
          `Session already active for ${resolvedDir} (a still-alive orphaned driver from a prior MCP server instance holds this worktree; ${detail})`
        );
      }
    }

    const cliPath = options.cliPath ?? SessionManager.resolveCLIPath();

    const args: string[] = [];
    if (options.model) args.push('--model', options.model);
    if (options.bare) args.push('--bare');

    const client = this.createClient({ cliPath, cwd: resolvedDir, args });

    // Build the session shell before async operations so we can track state
    const session: ManagedSession = {
      sessionId: '', // filled after init
      projectDir: resolvedDir,
      status: 'starting',
      client,
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };

    // Insert into map early (keyed by dir) so concurrent starts are rejected
    this.sessions.set(resolvedDir, session);

    try {
      // Start the process with timeout
      await Promise.race([
        client.start(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.start() timed out after ${INIT_TIMEOUT_MS}ms`),
      ]);

      // Perform v2 init handshake
      const initResult: RpcInitResult = await Promise.race([
        client.init(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.init() timed out after ${INIT_TIMEOUT_MS}ms`),
      ]) as RpcInitResult;

      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // INC-2026-09-29-02 fix 3 (Option B): persist this session's child pid
      // now that it's known, so a subsequent MCP server restart can detect
      // this driver as a live orphan (rather than launching a duplicate) if
      // this server instance dies without a clean teardown.
      const childPid = client.pid;
      if (typeof childPid === 'number') {
        registerSessionEntry(
          {
            sessionId: session.sessionId,
            projectDir: resolvedDir,
            pid: childPid,
            startTime: new Date().toISOString(),
            status: session.status,
          },
          this.getSessionRegistryPath(),
        );
      }

      // Wire event tracking
      const unsubscribeEvents = client.onEvent((event: SdkAgentEvent) => {
        this.handleEvent(session, event);
      });

      // INC-2026-09-29-02: before this, a dead child process (crash,
      // SIGTERM, OOM) never emitted any agent event, so SessionManager had
      // zero wiring to notice — the session sat at a stale 'running' status
      // forever (a zombie). Combined into the single `session.unsubscribe`
      // below so every existing eviction/cancel/cleanup call site tears
      // this down too, with no changes needed at those call sites.
      const unsubscribeExit = client.onExit((info) => {
        this.handleUnexpectedExit(session, info);
      });

      session.unsubscribe = () => {
        unsubscribeEvents();
        unsubscribeExit();
      };

      // Kick off auto-mode
      const command = options.command ?? '/gsd auto';
      await client.prompt(command);

      return session.sessionId;
    } catch (err) {
      session.status = 'error';
      session.error = err instanceof Error ? err.message : String(err);

      // Attempt cleanup
      try { await client.stop(); } catch { /* swallow cleanup errors */ }

      // Keep session in map so callers can inspect the error
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }

  /**
   * Factory seam for `RpcClient` construction (INC-2026-09-29-02 testability).
   * Subclasses can override to inject a duck-typed mock client without full
   * module mocking, while still exercising the real `startSession()` wiring.
   */
  protected createClient(options: { cliPath: string; cwd: string; args: string[] }): RpcClient {
    return new RpcClient(options);
  }

  /**
   * Testability seam (INC-2026-09-29-02 fix 3 Option B) — override to point
   * the persisted session registry at an isolated temp file instead of the
   * real `GSD_HOME`/session-instances.json.
   */
  protected getSessionRegistryPath(): string | undefined {
    return undefined;
  }

  /**
   * Testability seam (INC-2026-09-29-02 fix 3 Option B) — override to inject
   * fake `kill`/`getProcessStartTime` so tests never signal a real pid.
   */
  protected getSessionLivenessOptions(): SessionLivenessOptions {
    return {};
  }

  /**
   * Testability seam (EXEC-01, Phase 39) — override to inject a fake
   * reconcile result (`'settled' | 'no-attempt' | 'db-unavailable'`) without
   * touching a real SQLite file. Production implementation delegates to
   * `orphan-reconcile.ts`'s `reconcileOrphanAttempt`.
   *
   * WR-03 (39-REVIEW.md): deliberately named differently from the imported
   * module-level `reconcileOrphanAttempt` this delegates to — an identical
   * name was correct today only because the body referenced the bare
   * (unqualified) import, not `this`; a future edit that reflexively
   * qualified the call as `this.reconcileOrphanAttempt(...)` would have been
   * a compiler-silent unbounded-recursion bug.
   */
  protected invokeOrphanReconcile(
    entry: SessionRegistryEntry,
    resolvedDir: string,
  ): Promise<OrphanReconcileResult> {
    return reconcileOrphanAttempt(entry, resolvedDir);
  }

  /**
   * Detect and reap an orphaned headless child left by a PRIOR MCP server
   * instance for `resolvedDir` — see the module-level comment on
   * session-persist.ts for the full incident context. No-op when there is no
   * persisted entry, when the recorded pid is already dead, or when the
   * recorded pid has been recycled by an unrelated process (start-time
   * guard) — in all of those cases the stale row is simply dropped.
   *
   * A confirmed-alive orphan's DB-side Task Attempt is reconciled before
   * anything signals its pid (EXEC-01, Phase 39, D-03 insertion point). A
   * `'settled'` reconcile outcome returns `'settled-alive'` — the pid is
   * deliberately spared and the registry row is deliberately kept, per the
   * restored "settled => no kill" contract (39-CONTEXT.md D-04, ROADMAP
   * criteria 1/3; restored by 39-03-PLAN.md per 39-REVIEW.md CR-01's
   * alternative (b) after 39-VERIFICATION.md gaps 1-3). The pid is only
   * killed when the reconcile conclusively reports there is nothing to
   * settle (`'no-attempt'`) or that the database could not be reached
   * (`'db-unavailable'`).
   */
  protected async reapPersistedOrphanSession(resolvedDir: string): Promise<OrphanReapOutcome> {
    const registryPath = this.getSessionRegistryPath();
    const entry = getSessionEntry(resolvedDir, registryPath);
    if (!entry) return 'no-entry';

    const livenessOptions = this.getSessionLivenessOptions();
    if (!isOrphanEntryAlive(entry, livenessOptions)) {
      removeSessionEntry(resolvedDir, registryPath);
      return 'stale-entry-dropped';
    }

    // Restored design (EXEC-01, Phase 39; 39-REVIEW.md CR-01's alternative
    // (b)): 39-VERIFICATION.md gaps 1-3 reported that commit 2a6fd9f7 — the
    // original CR-01 fix — made this branch kill the pid unconditionally,
    // silently reverting the phase's own locked "settled => no kill"
    // contract (39-CONTEXT.md D-04, ROADMAP criteria 1/3). A 'settled'
    // outcome now spares the still-alive pid instead — it must NOT reach
    // killOrphanSessionPid. CR-01's real double-driver bug (a confirmed-
    // alive pid left running while startSession() spawns a brand-new driver
    // for the same resolvedDir) is closed instead by startSession()
    // declining the new start on this outcome (see below), not by killing
    // the pid. The registry row is deliberately KEPT (PD-8): dropping it
    // here would erase the only record of the still-alive orphan, so a
    // later start would see no entry, spawn a second driver, and strand the
    // spared process as an unreapable, invisible leak. A later start
    // attempt for the same resolvedDir re-reaps this same row; by then the
    // Attempt was already settled, so the reconcile reports 'no-attempt'
    // and falls through to the unchanged kill below (PD-9) — the decline is
    // recoverable, not a permanent lockout.
    const reconcileResult = await this.invokeOrphanReconcile(entry, resolvedDir);
    if (reconcileResult === 'settled') {
      process.stderr.write(
        `[gsd-mcp-server] INC-2026-09-29-02: reconciled orphaned headless session for ${resolvedDir} left by a prior MCP server instance — settled its Attempt; pid=${entry.pid} is being left alive on purpose and the new driver start is being declined\n`,
      );
      return 'settled-alive';
    }

    const result = killOrphanSessionPid(entry.pid, entry.startTime, livenessOptions);

    if (typeof result === 'object') {
      // CR-01 (39-REVIEW.md): the kill signal itself failed for a reason
      // other than "already dead" (e.g. EPERM because the child is owned by
      // a different uid, or a sandboxing/seccomp denial) — the process may
      // still be alive, it was NOT confirmed dead. The exact same PD-8
      // reasoning that keeps the registry row on a 'settled' outcome (above)
      // applies here: dropping it would erase the only record of a
      // still-alive orphan, letting a later startSession() see 'no-entry'
      // and spawn a second driver alongside an untracked, unreapable leak.
      // Keep the row and report a distinct outcome so startSession() can
      // decline the new start exactly like 'settled-alive'.
      process.stderr.write(
        `[gsd-mcp-server] INC-2026-09-29-02: failed to reap orphaned headless session for ${resolvedDir} — pid=${entry.pid} kill signal failed: ${result.error}; registry row preserved so it remains reapable on a later attempt\n`,
      );
      return 'kill-failed';
    }

    const label = result === 'killed'
      ? `killed orphan pid=${entry.pid}`
      : result === 'force-killed'
        ? `force-killed orphan pid=${entry.pid}`
        : result === 'already-dead'
          ? `orphan pid=${entry.pid} already dead`
          : `ignored invalid/recycled orphan pid=${String(entry.pid)}`;
    process.stderr.write(
      `[gsd-mcp-server] INC-2026-09-29-02: reaped orphaned headless session for ${resolvedDir} left by a prior MCP server instance — ${label}\n`,
    );
    removeSessionEntry(resolvedDir, registryPath);
    return 'reaped';
  }

  /**
   * Look up a session by sessionId.
   * Linear scan is fine — we expect <10 concurrent sessions.
   *
   * Empty sessionId is rejected explicitly: in-progress sessions carry an
   * empty sessionId until init() resolves, so an empty-string lookup would
   * otherwise match the first in-flight session and silently target the
   * wrong one (e.g. cancel a different caller's session).
   */
  getSession(sessionId: string): ManagedSession | undefined {
    if (!sessionId) return undefined;
    for (const session of this.sessions.values()) {
      if (session.sessionId === sessionId) return session;
    }
    return undefined;
  }

  /**
   * Look up a session by project directory (direct map lookup).
   */
  getSessionByDir(projectDir: string): ManagedSession | undefined {
    return this.sessions.get(resolve(projectDir));
  }

  /**
   * Return the only tracked session, if there is exactly one.
   *
   * MCP clients occasionally lose the sessionId returned from gsd_execute while
   * still talking to the same server process. A sole-session fallback lets
   * read-only status polling recover without guessing across projects.
   */
  getOnlySession(): ManagedSession | undefined {
    let only: ManagedSession | undefined;
    for (const session of this.sessions.values()) {
      if (only) return undefined;
      only = session;
    }
    return only;
  }

  /**
   * Snapshot tracked sessions for diagnostics and ambiguity errors.
   */
  listSessions(): ManagedSession[] {
    return [...this.sessions.values()];
  }

  /**
   * Resolve a pending blocker by sending a UI response.
   */
  async resolveBlocker(sessionId: string, response: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    if (!session.pendingBlocker) throw new Error(`No pending blocker for session ${sessionId}`);

    const blocker = session.pendingBlocker;
    session.client.sendUIResponse(blocker.id, { value: response });
    session.pendingBlocker = null;
    if (session.status === 'blocked') {
      session.status = 'running';
    }
  }

  /**
   * Cancel a running session — abort current operation then stop the process.
   */
  async cancelSession(sessionId: string): Promise<void> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);
    await this._cancelSessionObject(session);
  }

  /**
   * Cancel a session looked up by project directory.
   *
   * This is the fallback path for interactive sessions (started via `/gsd auto`
   * in the terminal) and sessions from a restarted MCP server that have no
   * registered sessionId. The sessions map is keyed by projectDir, so this
   * lookup always succeeds for any tracked session regardless of sessionId.
   */
  async cancelSessionByDir(projectDir: string): Promise<void> {
    const session = this.getSessionByDir(projectDir);
    if (session) {
      await this._cancelSessionObject(session);
      return;
    }
    const stopped = await this.stopDetachedAutoProcess(projectDir);
    if (!stopped) {
      throw new Error(`Session not found for projectDir: ${projectDir}`);
    }
  }

  private async stopDetachedAutoProcess(projectDir: string): Promise<boolean> {
    const lockPath = join(projectDir, '.gsd', 'auto.lock');
    if (!existsSync(lockPath)) return false;
    try {
      const lockData = JSON.parse(readFileSync(lockPath, 'utf-8'));
      return signalAutoLockPid(lockData, projectDir) === 'signaled';
    } catch {
      return false;
    }
  }

  /**
   * Internal: perform abort + stop + mark cancelled on a resolved session object.
   */
  private async _cancelSessionObject(session: ManagedSession): Promise<void> {
    try {
      await session.client.abort();
    } catch { /* may already be stopped */ }

    try {
      await session.client.stop();
    } catch { /* swallow */ }

    session.status = 'cancelled';
    session.unsubscribe?.();
    // INC-2026-09-29-02 fix 3 (Option B): the child is genuinely stopped now
    // — drop its persisted registry row so a future restart doesn't treat it
    // as a live orphan.
    removeSessionEntry(session.projectDir, this.getSessionRegistryPath());
  }

  /**
   * Build a HeadlessJsonResult-shaped object from accumulated session state.
   */
  getResult(sessionId: string): Record<string, unknown> {
    const session = this.getSession(sessionId);
    if (!session) throw new Error(`Session not found: ${sessionId}`);

    const durationMs = Date.now() - session.startTime;

    return {
      sessionId: session.sessionId,
      projectDir: session.projectDir,
      status: session.status,
      durationMs,
      cost: session.cost,
      recentEvents: projectRecentEvents(session.events, 10),
      pendingBlocker: session.pendingBlocker
        ? { id: session.pendingBlocker.id, method: session.pendingBlocker.method, message: session.pendingBlocker.message }
        : null,
      error: session.error ?? null,
    };
  }

  /**
   * Stop all active sessions and clean up resources.
   */
  async cleanup(): Promise<void> {
    const stopPromises: Promise<void>[] = [];

    for (const session of this.sessions.values()) {
      session.unsubscribe?.();
      // A paused OR completed session still owns a live headless child
      // process (its RpcClient is retained for resume — and, in the
      // `completed` case, because the terminal-notification branch in
      // `handleEvent()` never calls `client.stop()` itself; the underlying
      // RPC agent is long-lived and does not exit on its own). Excluding
      // `completed` here (CR-01, 34-REVIEW.md) used to leak that child AND
      // erase the one registry row that could have identified it as an
      // orphan on the next server start — reopening the double-driver
      // failure mode fix 3B (RELY-09) closed. `error`/`cancelled` sessions
      // have already had `client.stop()` called on the path that put them
      // in that status, but `RpcClient.stop()` is a no-op once
      // `this.process` is already null, so stopping them again is harmless
      // — simplest to just stop unconditionally rather than track "already
      // stopped" as a separate bit of state.
      stopPromises.push(
        session.client.stop().catch(() => { /* swallow */ })
      );
      session.status = 'cancelled';
      // INC-2026-09-29-02 fix 3 (Option B): the child is genuinely stopped
      // (or being stopped, above) — drop its persisted registry row so the
      // registry doesn't accumulate stale entries across restarts.
      removeSessionEntry(session.projectDir, this.getSessionRegistryPath());
    }

    await Promise.allSettled(stopPromises);
  }

  /**
   * Resolve the GSD CLI path.
   *
   * 1. GSD_CLI_PATH env var (highest priority)
   * 2. PATH lookup → resolve to the actual gsd executable/shim
   */
  static resolveCLIPath(): string {
    // Check env var first
    const envPath = process.env['GSD_CLI_PATH'];
    if (envPath) return resolve(envPath);

    const gsdBin = findExecutableOnPath('gsd');
    if (gsdBin) {
      return resolve(gsdBin);
    }

    throw new Error(
      'Cannot find GSD CLI. Set GSD_CLI_PATH environment variable or ensure `gsd` is in PATH.'
    );
  }

  // ---------------------------------------------------------------------------
  // Private: Event Handling
  // ---------------------------------------------------------------------------

  /**
   * INC-2026-09-29-02: the child process can die (crash, SIGTERM, OOM) with
   * no corresponding agent event ever emitted. Only an *unexpected* exit —
   * not one caused by our own stop()/abort()-driven teardown (eviction,
   * cancelSession, cleanup) — transitions the session to a terminal 'error'
   * status, so getResult() surfaces the dead session instead of a stale
   * 'running'. A session that already reached a terminal status by other
   * means (completed/cancelled/error) is left alone.
   */
  private handleUnexpectedExit(
    session: ManagedSession,
    info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }
  ): void {
    if (info.expected) return;
    if (session.status === 'completed' || session.status === 'cancelled' || session.status === 'error') {
      return;
    }

    const reason = info.signal ? `signal ${info.signal}` : `code ${info.code}`;
    session.status = 'error';
    session.error = `Agent process exited unexpectedly (${reason})`;
    session.pendingBlocker = null;
    // INC-2026-09-29-02 fix 3 (Option B): the child is gone — drop its
    // persisted registry row so a future restart doesn't treat a dead pid as
    // a live orphan (isOrphanEntryAlive would already reject a dead pid, but
    // dropping it here keeps the registry from accumulating stale rows).
    removeSessionEntry(session.projectDir, this.getSessionRegistryPath());
  }

  private handleEvent(session: ManagedSession, event: SdkAgentEvent): void {
    // Ring buffer: push and trim
    session.events.push(event);
    if (session.events.length > MAX_EVENTS) {
      session.events.splice(0, session.events.length - MAX_EVENTS);
    }

    // Cost tracking (K004 — cumulative-max)
    if (event.type === 'cost_update') {
      const costEvent = event as unknown as RpcCostUpdateEvent;
      session.cost.totalCost = Math.max(session.cost.totalCost, costEvent.cumulativeCost ?? 0);
      if (costEvent.tokens) {
        session.cost.tokens.input = Math.max(session.cost.tokens.input, costEvent.tokens.input ?? 0);
        session.cost.tokens.output = Math.max(session.cost.tokens.output, costEvent.tokens.output ?? 0);
        session.cost.tokens.cacheRead = Math.max(session.cost.tokens.cacheRead, costEvent.tokens.cacheRead ?? 0);
        session.cost.tokens.cacheWrite = Math.max(session.cost.tokens.cacheWrite, costEvent.tokens.cacheWrite ?? 0);
      }
    }

    // Paused detection — pauseAuto() is resumable and must not leave the
    // session looking active, or duplicate-start prevention will deadlock.
    // Keep the RpcClient event subscription so resumed output and later
    // terminal/blocked notifications still reach handleEvent (a paused session
    // stays resumable); it is torn down on cleanup/eviction instead.
    if (isPausedEvent(event as Record<string, unknown>)) {
      session.status = 'paused';
      session.pendingBlocker = null;
      return;
    }

    // Terminal detection — auto-mode/step-mode stopped
    if (isTerminalNotification(event as Record<string, unknown>)) {
      // Check if it's a blocked stop (not truly terminal — it's a blocker)
      if (isBlockedNotification(event as Record<string, unknown>)) {
        session.status = 'blocked';
        session.pendingBlocker = extractBlocker(event);
      } else {
        session.status = 'completed';
        session.unsubscribe?.();
        // CR-01 (34-REVIEW.md): natural completion never otherwise stops
        // the underlying headless child — the RPC agent is long-lived and
        // does not exit on its own after 'auto-mode complete'. Reclaim it
        // and drop the persisted registry row immediately, rather than
        // leaking it until the next same-projectDir launch (the eviction
        // branch in startSession()) or full server shutdown (cleanup()).
        void session.client.stop().catch(() => { /* swallow */ });
        removeSessionEntry(session.projectDir, this.getSessionRegistryPath());
      }
      return;
    }

    // Blocker detection — non-fire-and-forget extension_ui_request
    if (isBlockingUIRequest(event as Record<string, unknown>)) {
      session.status = 'blocked';
      session.pendingBlocker = extractBlocker(event);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function timeout(ms: number, message: string): Promise<never> {
  return new Promise((_, reject) => {
    setTimeout(() => reject(new Error(message)), ms);
  });
}

function extractBlocker(event: SdkAgentEvent): PendingBlocker {
  const uiEvent = event as unknown as RpcExtensionUIRequest;
  return {
    id: String(uiEvent.id ?? ''),
    method: uiEvent.method,
    message: String((uiEvent as Record<string, unknown>).title ?? (uiEvent as Record<string, unknown>).message ?? ''),
    event: uiEvent,
  };
}
