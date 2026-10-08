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
  canonicalProjectDir,
  findSessionEntryBySessionId,
  getSessionEntry,
  isOrphanEntryAlive,
  isRegistryOwnerAlive,
  isTombstoneEntry,
  killOrphanSessionPid,
  recordSessionExit,
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
 * - `'stale-entry-dropped'` — the row's pid was dead or recycled, or the row
 *   was an exit tombstone (never probed or signalled - its pid may have been
 *   recycled); the row was dropped and nothing was signalled.
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
 * Outcome vocabulary for `stopRegisteredDriver` (D-02, Phase 41 / DRIVER-02):
 * the registry-authorised stop of an untracked registered driver, used by
 * `cancelSessionByDir()` when no in-memory session holds the worktree.
 *
 * - `'no-entry'` - no registry row existed for this dir.
 * - `'stopped'` - the registered pid's death was confirmed (`'killed'` /
 *   `'force-killed'`) and its registry row was removed.
 * - `'dead-reconciled'` - the registered pid was dead or recycled, or the row
 *   was already an exit tombstone; nothing was signalled and the row is (now)
 *   an exit tombstone.
 * - `'kill-failed'` - the kill signal failed for a reason other than
 *   already-dead (e.g. `EPERM`); the process may still be alive, so the row is
 *   KEPT unchanged (PD-8 / CR-01) and the cancel must not report success.
 */
export type RegisteredDriverStopOutcome = 'no-entry' | 'stopped' | 'dead-reconciled' | 'kill-failed';

/** Result of `SessionManager.stopRegisteredDriver`. */
export interface RegisteredDriverStopResult {
  outcome: RegisteredDriverStopOutcome;
  /** The registry row that was acted on (absent for `'no-entry'`). */
  entry?: SessionRegistryEntry;
  /** Underlying kill error (only for `'kill-failed'`). */
  error?: string;
}

/**
 * Classification returned by `SessionManager.reconcileRegisteredDriver` (D-04,
 * Phase 41 / DRIVER-02): what the persisted registry says about a driver that
 * a read tool (gsd_status / gsd_result) could not resolve in memory.
 *
 * - `'no-entry'` - nothing persisted for the reference.
 * - `'tracked'` - this process holds an in-memory session for the row's dir;
 *   the row is its mirror and is left untouched.
 * - `'dead-reconciled'` - the pid is dead or recycled, or the row is already an
 *   exit tombstone; the row is an exit tombstone and nothing was signalled.
 * - `'orphan-alive'` - the pid is alive but not tracked by this process; it is
 *   reported, never signalled or settled.
 */
export type DriverReconcileOutcome = 'no-entry' | 'tracked' | 'dead-reconciled' | 'orphan-alive';

/** Result of `SessionManager.reconcileRegisteredDriver`. */
export interface DriverReconcileResult {
  outcome: DriverReconcileOutcome;
  /** The registry row as it stands after reconciling (absent for `'no-entry'`). */
  entry?: SessionRegistryEntry;
  /** Advisory owner-liveness (only for `'orphan-alive'`; null when no ownerPid). */
  ownerAlive?: boolean | null;
}

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
   *
   * Phase 41 (SC3): the reservation is keyed by the canonical (realpath)
   * dir via `startLockKey()` and ALSO covers the awaited `stop()` of an
   * evicted terminal session, so the replacement driver is never created
   * while the old one is still shutting down. D-02 (Phase 41): the
   * reservation also covers a registry cancel (`cancelSessionByDir`), so a
   * start and a cancel can never race on one worktree.
   */
  private startingLocks = new Set<string>();

  /**
   * Key for `startingLocks`: the canonical (realpath) worktree dir, so a
   * symlink alias and its target share one start lock (SC3, Phase 41).
   */
  private startLockKey(dir: string): string {
    return canonicalProjectDir(dir);
  }

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
    const lockKey = this.startLockKey(resolvedDir);

    // A concurrent startSession() for this worktree is already inside the
    // awaited eviction stop or orphan reap - reject it exactly like the
    // in-memory "already active" case (CR-02 guarantee, preserved across the
    // now-async reap and eviction). Checked FIRST: an evicting session is
    // still in `this.sessions` while its stop() is awaited.
    if (this.startingLocks.has(lockKey)) {
      throw new SessionDeclinedError('reap-in-progress', `Session already active for ${resolvedDir} (reap in progress)`);
    }

    const existing = this.getSessionByDir(resolvedDir);
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
      // map entry alone would orphan the child process. SC3 (Phase 41): the
      // stop is AWAITED under the start lock, so the replacement driver is
      // never created until the old one is confirmed stopped, and a racing
      // startSession() during the stop is declined 'reap-in-progress'.
      this.startingLocks.add(lockKey);
      try {
        try {
          await existing.client.stop();
        } catch {
          /* swallow */
        }
        this.sessions.delete(existing.projectDir);
        // INC-2026-09-29-02 fix 3 (Option B): this in-memory session owned the
        // persisted registry row for its dir - drop it now that we're
        // reclaiming its child, so a future restart doesn't mistake it for an
        // orphan.
        removeSessionEntry(existing.projectDir, this.getSessionRegistryPath());
      } finally {
        this.startingLocks.delete(lockKey);
      }
    } else {
      // INC-2026-09-29-02 fix 3 (Option B): no in-memory session for this
      // projectDir - but a persisted registry entry may reference a headless
      // child that is still alive from a PRIOR MCP server instance (the
      // in-memory Map is wiped on restart, so startSession()'s "already
      // active" guard above can't see it). Reap it before starting a new
      // driver so at most one driver ever runs per worktree, declining this
      // start if the reap says so (IN-01, 39-REVIEW.md: extracted to keep
      // startSession()'s top-level control flow scannable).
      await this.reapOrDeclineOrphan(resolvedDir);
    }

    const cliPath = options.cliPath ?? SessionManager.resolveCLIPath();

    const args: string[] = [];
    if (options.model) args.push('--model', options.model);
    if (options.bare) args.push('--bare');

    // Spawn the auto-driver DETACHED (its own process group). This session is a
    // long-lived daemon that must outlive the interactive session that started
    // it via gsd_execute — without detachment it shares that session's process
    // group and is killed the instant that session's turn completes (the
    // group-directed signal reaches the driver), aborting its first unit with
    // "received a termination signal" and stalling the milestone. The driver is
    // still owned here via RPC pipes + the persisted session registry, and torn
    // down explicitly (cancelSession/cleanup/reapOrDeclineOrphan all signal by
    // pid). Detachment is what makes the Phase 39 orphan-reconcile design real:
    // the driver can genuinely outlive this server and be reaped on restart.
    const client = this.createClient({ cliPath, cwd: resolvedDir, args, detached: true });

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

      // D-01 (Phase 41 / DRIVER-02): register the driver the moment its pid
      // exists - right after start() resolves, BEFORE the init() handshake and
      // before any prompt() dispatch - so an MCP-server crash during init()
      // cannot leave a live, detached, un-reapable driver with no registry
      // row. Accepted residual: RpcClient.start() spawns synchronously and
      // then waits 100 ms before resolving, so a server crash inside those
      // 100 ms can still leave an unregistered child; D-01 registers "after
      // start() resolves" by decision.
      const childPid = client.pid;
      const registeredStartTime = new Date().toISOString();
      if (typeof childPid !== 'number') {
        // Fail closed (SC1: no live driver outside the registry's view): the
        // catch below stops the client, so nothing is left running or
        // dispatched to without a registry row.
        throw new Error('driver pid unavailable after start(); refusing to dispatch an unregistered driver');
      }
      registerSessionEntry(
        {
          sessionId: '',
          projectDir: resolvedDir,
          pid: childPid,
          startTime: registeredStartTime,
          status: 'starting',
          ownerPid: process.pid,
        },
        this.getSessionRegistryPath(),
      );

      // Perform v2 init handshake
      const initResult: RpcInitResult = await Promise.race([
        client.init(),
        timeout(INIT_TIMEOUT_MS, `RpcClient.init() timed out after ${INIT_TIMEOUT_MS}ms`),
      ]) as RpcInitResult;

      session.sessionId = initResult.sessionId;
      session.status = 'running';

      // Upgrade the same registry key in place with the real sessionId and
      // 'running' status (registerSessionEntry overwrites the key).
      registerSessionEntry(
        {
          sessionId: session.sessionId,
          projectDir: resolvedDir,
          pid: childPid,
          startTime: registeredStartTime,
          status: 'running',
          ownerPid: process.pid,
        },
        this.getSessionRegistryPath(),
      );

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

      // Drop the registry row only once the child is confirmed stopped (the
      // stop above is awaited), mirroring _cancelSessionObject. A registry
      // I/O error must not mask the original start failure.
      try {
        removeSessionEntry(resolvedDir, this.getSessionRegistryPath());
      } catch { /* swallow registry cleanup errors */ }

      // Keep session in map so callers can inspect the error
      throw new Error(`Failed to start session for ${resolvedDir}: ${session.error}`);
    }
  }

  /**
   * Reap any persisted orphan for `resolvedDir` before `startSession()`
   * proceeds, declining the fresh start outright when the orphan's pid was
   * deliberately spared (`'settled-alive'`) or the reap's kill signal itself
   * failed (`'kill-failed'`) — in both cases a possibly-still-alive orphan
   * must not have a second driver spawned beside it. Extracted out of
   * `startSession()` (IN-01, 39-REVIEW.md) to keep that function's
   * top-level control flow scannable; owns the `startingLocks`
   * reservation/release for its own awaited `reapPersistedOrphanSession()`
   * call, including the WR-04 error-shape normalization on an unexpected
   * throw.
   *
   * No-op (returns without throwing) for every other `OrphanReapOutcome`
   * (`'no-entry'`, `'stale-entry-dropped'`, `'reaped'`) — `startSession()`
   * proceeds to spawn a new driver in all of those cases.
   */
  private async reapOrDeclineOrphan(resolvedDir: string): Promise<void> {
    let reapOutcome: OrphanReapOutcome = 'no-entry';
    const lockKey = this.startLockKey(resolvedDir);
    this.startingLocks.add(lockKey);
    try {
      reapOutcome = await this.reapPersistedOrphanSession(resolvedDir);
    } catch (err) {
      // WR-04 (39-REVIEW.md): if reapPersistedOrphanSession itself throws
      // (a corrupt registry file, or an invokeOrphanReconcile override
      // rejecting contrary to its documented "must never reject" contract),
      // normalize to the same "Failed to start session for ${resolvedDir}:
      // ..." shape every other startSession() failure mode uses, rather
      // than letting it escape unwrapped. The `finally` below still runs
      // before this rethrow propagates, so the reservation is released
      // either way.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`Failed to start session for ${resolvedDir}: ${message}`);
    } finally {
      this.startingLocks.delete(lockKey);
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

  /**
   * Factory seam for `RpcClient` construction (INC-2026-09-29-02 testability).
   * Subclasses can override to inject a duck-typed mock client without full
   * module mocking, while still exercising the real `startSession()` wiring.
   */
  protected createClient(options: { cliPath: string; cwd: string; args: string[]; detached?: boolean }): RpcClient {
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

    // Phase 41 safety (T-41-01): an exit tombstone records a death, never a
    // live claim. Its pid may have been recycled to an unrelated process, so
    // it is dropped WITHOUT any liveness probe or signal.
    if (isTombstoneEntry(entry)) {
      removeSessionEntry(resolvedDir, registryPath);
      return 'stale-entry-dropped';
    }

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
   * Look up a session by project directory. Alias-aware (SC3, Phase 41): a
   * direct hit on the resolved key wins; otherwise the session whose
   * canonical (realpath) dir equals the canonical form of `projectDir` is
   * returned, so a symlink alias and its target find the same session.
   * Linear scan is fine - we expect <10 concurrent sessions.
   */
  getSessionByDir(projectDir: string): ManagedSession | undefined {
    const direct = this.sessions.get(resolve(projectDir));
    if (direct) return direct;
    const canonical = canonicalProjectDir(projectDir);
    for (const session of this.sessions.values()) {
      if (canonicalProjectDir(session.projectDir) === canonical) return session;
    }
    return undefined;
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
   * Cancel a session looked up by project directory (D-02, Phase 41 / DRIVER-02:
   * the registry is the stop authority). Order:
   *
   * 1. in-memory session -> `_cancelSessionObject()` -> `RpcClient.stop()` (a
   *    live, self-spawned handle; its process-group teardown is kept per D-03
   *    so per-unit grandchildren die with the driver);
   * 2. persisted registry row -> `stopRegisteredDriver()`: settle the Attempt
   *    (best-effort), kill exactly the registered pid (single pid, recycled-pid
   *    guarded), remove the row only on confirmed death. Runs under the
   *    `startingLocks` reservation for the canonical dir, so it cannot race a
   *    `startSession()` on the same worktree;
   * 3. legacy `.gsd/auto.lock` -> ONLY when the registry holds no live claim
   *    (unregistered, terminal-started `/gsd auto` drivers - D-02's carve-out);
   * 4. otherwise the unchanged `Session not found for projectDir: <dir>` error.
   *
   * A failed kill (`'kill-failed'`) throws and keeps the row - a cancel never
   * reports success for an unconfirmed kill.
   */
  async cancelSessionByDir(projectDir: string): Promise<void> {
    const session = this.getSessionByDir(projectDir);
    if (session) {
      await this._cancelSessionObject(session);
      return;
    }

    const resolvedDir = resolve(projectDir);
    const lockKey = this.startLockKey(resolvedDir);
    if (this.startingLocks.has(lockKey)) {
      throw new Error(
        `Cannot cancel ${resolvedDir}: a session start or reap for this projectDir is in progress; retry once it settles`,
      );
    }

    this.startingLocks.add(lockKey);
    let stop: RegisteredDriverStopResult;
    try {
      stop = await this.stopRegisteredDriver(resolvedDir);
    } finally {
      this.startingLocks.delete(lockKey);
    }

    if (stop.outcome === 'stopped') return;

    if (stop.outcome === 'kill-failed') {
      throw new Error(
        `Failed to stop registered driver for ${resolvedDir}: pid=${stop.entry?.pid} kill signal failed: ${stop.error}; registry row preserved so the stop can be retried`,
      );
    }

    // 'no-entry' / 'dead-reconciled': the registry holds no live claim for this
    // dir - the legacy lock is the last resort (unregistered drivers only).
    const stopped = await this.stopDetachedAutoProcess(projectDir);
    if (stopped) return;

    if (stop.outcome === 'dead-reconciled') {
      throw new Error(
        `Session not found for projectDir: ${projectDir} (registered driver pid ${stop.entry?.pid} was no longer running; its registry row was reconciled to an exit record)`,
      );
    }
    throw new Error(`Session not found for projectDir: ${projectDir}`);
  }

  /**
   * Registry-authorised stop of an untracked registered driver (D-02). Settles
   * the DB-side Task Attempt best-effort, then kills EXACTLY the registered pid
   * and removes the row only after the death is confirmed.
   *
   * Single pid by design (orchestrator Q1): no process-group signal. Deferred,
   * accepted gap: an untracked driver's per-unit grandchildren can survive the
   * single-pid kill and keep touching the worktree until they exit.
   *
   * Q3 divergence from `reapPersistedOrphanSession`: an explicit cancel is user
   * intent, so it kills even when the settle reports `'settled'` (that method
   * still spares on `'settled'` for the start-time reap - Phase 39 contract
   * unchanged). This is deliberate, not a 39-03 regression.
   */
  protected async stopRegisteredDriver(resolvedDir: string): Promise<RegisteredDriverStopResult> {
    const registryPath = this.getSessionRegistryPath();
    const entry = getSessionEntry(resolvedDir, registryPath);
    if (!entry) return { outcome: 'no-entry' };

    // A tombstone records a death, never a live claim: no probe, no signal.
    if (isTombstoneEntry(entry)) return { outcome: 'dead-reconciled', entry };

    const livenessOptions = this.getSessionLivenessOptions();
    if (!isOrphanEntryAlive(entry, livenessOptions)) {
      this.tombstoneDeadEntry(entry);
      return { outcome: 'dead-reconciled', entry };
    }

    // Best-effort settle: the result never gates the kill (Q3).
    try {
      const settle = await this.invokeOrphanReconcile(entry, resolvedDir);
      process.stderr.write(
        `[gsd-mcp-server] D-02: cancel of ${resolvedDir} - attempt reconcile for pid=${entry.pid}: ${settle}\n`,
      );
    } catch (err) {
      process.stderr.write(
        `[gsd-mcp-server] D-02: cancel of ${resolvedDir} - attempt reconcile for pid=${entry.pid} failed (continuing with kill): ${err instanceof Error ? err.message : String(err)}\n`,
      );
    }

    const result = killOrphanSessionPid(entry.pid, entry.startTime, livenessOptions);

    if (typeof result === 'object') {
      process.stderr.write(
        `[gsd-mcp-server] D-02: failed to stop registered driver for ${resolvedDir} - pid=${entry.pid} kill signal failed: ${result.error}; row kept for retry\n`,
      );
      return { outcome: 'kill-failed', entry, error: result.error };
    }

    if (result === 'killed' || result === 'force-killed') {
      removeSessionEntry(resolvedDir, registryPath);
      return { outcome: 'stopped', entry };
    }

    // 'already-dead' / 'invalid' (recycled): nothing was (or may be) signalled.
    this.tombstoneDeadEntry(entry);
    return { outcome: 'dead-reconciled', entry };
  }

  /**
   * PD-41-A: drop a dead driver's liveness claim by rewriting its row as an
   * exit tombstone (kept for Phase 42's died-with-reason surface). The reason
   * is a fixed phrase, never stderr.
   */
  private tombstoneDeadEntry(entry: SessionRegistryEntry): void {
    recordSessionExit(
      entry.projectDir,
      {
        reason: `driver pid ${entry.pid} not running when reconciled; exit status unobserved`,
        code: null,
        signal: null,
        at: new Date().toISOString(),
      },
      entry.pid,
      this.getSessionRegistryPath(),
    );
  }

  /**
   * Look up the registered driver for a sessionId that no in-memory session
   * holds (e.g. after an MCP-server restart). Empty ids never match.
   */
  findRegisteredDriverBySessionId(sessionId: string): SessionRegistryEntry | undefined {
    return findSessionEntryBySessionId(sessionId, this.getSessionRegistryPath());
  }

  /**
   * D-04 (Phase 41 / DRIVER-02): classify what the persisted registry says
   * about a driver that has no in-memory session here, so gsd_status and
   * gsd_result can self-reconcile after an MCP-server restart.
   *
   * READ PATHS NEVER KILL. The registry is shared by every MCP-server process
   * on the box, so an untracked live row may be a healthy driver owned by a
   * peer server. Liveness comes only from `isOrphanEntryAlive` (signal 0 plus
   * the start-time guard - the single-authority rule in orphan-reconcile.ts).
   * This method never runs the Attempt-settle seam or any kill helper; a dead
   * or recycled pid's row is rewritten as an exit tombstone, a live one is left
   * byte-for-byte unchanged. Stopping is gsd_cancel's job (stopRegisteredDriver).
   * Idempotent: an existing tombstone is neither probed nor rewritten.
   */
  reconcileRegisteredDriver(ref: { projectDir?: string; sessionId?: string }): DriverReconcileResult {
    const registryPath = this.getSessionRegistryPath();
    let entry: SessionRegistryEntry | undefined;
    if (typeof ref.projectDir === 'string' && ref.projectDir.trim() !== '') {
      entry = getSessionEntry(ref.projectDir.trim(), registryPath);
    } else if (typeof ref.sessionId === 'string') {
      entry = findSessionEntryBySessionId(ref.sessionId, registryPath);
    }
    if (!entry) return { outcome: 'no-entry' };

    if (this.getSessionByDir(entry.projectDir)) return { outcome: 'tracked', entry };

    if (isTombstoneEntry(entry)) return { outcome: 'dead-reconciled', entry };

    const livenessOptions = this.getSessionLivenessOptions();
    if (!isOrphanEntryAlive(entry, livenessOptions)) {
      this.tombstoneDeadEntry(entry);
      return {
        outcome: 'dead-reconciled',
        entry: getSessionEntry(entry.projectDir, registryPath) ?? entry,
      };
    }

    return {
      outcome: 'orphan-alive',
      entry,
      ownerAlive: isRegistryOwnerAlive(entry, livenessOptions),
    };
  }

  /**
   * D-02 DEMOTED last resort: signals the pid named by `.gsd/auto.lock`. Reached
   * only when the registry holds no live claim for the dir (unregistered
   * terminal-started `/gsd auto` or pre-registry drivers) - never for a
   * gsd_execute driver while it is registered. Behaviour locked by the parity
   * test 'mcp signals a guarded detached auto.lock PID while daemon has no
   * fallback'.
   */
  protected async stopDetachedAutoProcess(projectDir: string): Promise<boolean> {
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
      // (or being stopped, above) - drop its persisted registry row so the
      // registry doesn't accumulate stale entries across restarts. A tombstone
      // records a driver that already died and is kept for Phase 42.
      const registryPath = this.getSessionRegistryPath();
      if (!isTombstoneEntry(getSessionEntry(session.projectDir, registryPath))) {
        removeSessionEntry(session.projectDir, registryPath);
      }
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
    // Phase 42 D-03 / PD-41-A: the death reason now survives an MCP-server
    // restart as an exit tombstone. Binding to the driver's pid means a newer
    // driver's row is never clobbered; a tombstone is never probed or signalled
    // and is replaced by the next startSession() for the worktree.
    const pid = session.client.pid;
    if (typeof pid === 'number') {
      try {
        recordSessionExit(
          session.projectDir,
          { reason: session.error, code: info.code, signal: info.signal, at: new Date().toISOString() },
          pid,
          this.getSessionRegistryPath(),
        );
      } catch {
        /* an exit listener must never throw */
      }
    }
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
