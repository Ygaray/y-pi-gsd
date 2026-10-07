/**
 * @opengsd/mcp-server — orphan-child dedup across MCP-server restarts
 * (INC-2026-09-29-02 fix 3 Option B).
 *
 * SessionManager's in-memory `sessions` Map is wiped on every server
 * restart. A headless child spawned by the PRIOR server instance for a
 * given projectDir can still be alive — invisible to the new server's
 * in-memory map, so `startSession()`'s "already active" guard can't see it,
 * and a fresh `gsd_execute` launches a SECOND driver on the same worktree.
 *
 * These tests exercise the real `SessionManager.startSession()` (not a
 * duplicated re-implementation) via the `createClient()` factory seam, plus
 * the new `getSessionRegistryPath()` / `getSessionLivenessOptions()` seams,
 * so the actual production orphan-detection/reap wiring is under test —
 * with fake pid signaling so no real process is ever touched.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager } from './session-manager.js';
import { getSessionEntry, registerSessionEntry, type SessionLivenessOptions, type SessionRegistryEntry } from './session-persist.js';
import {
  reconcileOrphanAttempt,
  type OrphanReconcileBridge,
  type OrphanReconcileDeps,
  type OrphanReconcileResult,
} from './orphan-reconcile.js';
import type { RpcClient } from '@opengsd/rpc-client';
import type { ManagedSession } from './types.js';

// ---------------------------------------------------------------------------
// Mock RpcClient (duck-typed — mirrors the pattern in mcp-server.test.ts /
// session-exit-detection.test.ts, extended with a `.pid` getter so
// SessionManager can persist a registry entry).
// ---------------------------------------------------------------------------

class MockRpcClient {
  started = false;
  stopped = false;
  aborted = false;
  prompted: string[] = [];
  pid: number | undefined;

  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];

  startError: Error | null = null;
  initError: Error | null = null;
  initSessionId = 'mock-session-001';

  cwd: string;
  args: string[];

  constructor(options?: Record<string, unknown>) {
    this.cwd = (options?.cwd as string) ?? '';
    this.args = (options?.args as string[]) ?? [];
  }

  async start(): Promise<void> {
    if (this.startError) throw this.startError;
    this.started = true;
  }

  async stop(): Promise<void> {
    this.stopped = true;
  }

  async init(): Promise<{ sessionId: string; version: string }> {
    if (this.initError) throw this.initError;
    return { sessionId: this.initSessionId, version: '2.51.0' };
  }

  onEvent(listener: (event: Record<string, unknown>) => void): () => void {
    this.eventListeners.push(listener);
    return () => {
      const idx = this.eventListeners.indexOf(listener);
      if (idx >= 0) this.eventListeners.splice(idx, 1);
    };
  }

  onExit(_listener: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): () => void {
    return () => {};
  }

  /** Drive `handleEvent()` for CR-01's completed-session cleanup coverage. */
  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  async prompt(message: string): Promise<void> {
    this.prompted.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  sendUIResponse(_requestId: string, _response: Record<string, unknown>): void {
    /* not exercised */
  }
}

// ---------------------------------------------------------------------------
// TestableSessionManager — overrides the client factory + the two new
// persistence seams, so the real startSession()/reapPersistedOrphanSession()
// run unmodified against an isolated registry file and fake pid signaling.
// ---------------------------------------------------------------------------

class TestableSessionManager extends SessionManager {
  lastClient: MockRpcClient | null = null;
  allClients: MockRpcClient[] = [];
  private sessionCounter = 0;
  nextPid = 50000;

  registryPath: string;
  killedPids: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
  /** pids considered "alive" by the fake liveness probe (defaults: none). */
  alivePids = new Set<number>();

  /** Queued reconcile results — consumed FIFO, one per reconcile call. */
  reconcileResults: OrphanReconcileResult[] = [];
  /** Every reconcile call this manager made, for Pitfall-1 fall-through assertions. */
  reconcileCalls: Array<{ pid: number; resolvedDir: string }> = [];

  constructor(registryPath: string) {
    super();
    this.registryPath = registryPath;
  }

  protected override createClient(options: { cliPath: string; cwd: string; args: string[] }): RpcClient {
    this.sessionCounter++;
    const client = new MockRpcClient(options);
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    client.pid = this.nextPid++;
    this.lastClient = client;
    this.allClients.push(client);
    return client as unknown as RpcClient;
  }

  protected override getSessionRegistryPath(): string | undefined {
    return this.registryPath;
  }

  protected override getSessionLivenessOptions(): SessionLivenessOptions {
    return {
      kill: (pid, signal) => {
        this.killedPids.push({ pid, signal });
        if (signal === 0 || signal === undefined) {
          if (!this.alivePids.has(pid)) {
            const err = new Error('no such process') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
          return;
        }
        // SIGTERM/SIGKILL "kills" it for subsequent liveness probes.
        this.alivePids.delete(pid);
      },
      getProcessStartTime: () => null, // unknown — tolerated by the guard
      waitForExit: () => {},
    };
  }

  getInternalSession(projectDir: string): ManagedSession | undefined {
    return this.getSessionByDir(projectDir);
  }

  /**
   * Fourth testability seam (D-04): fakes the DB-based reconcile decision so
   * these tests never touch a real SQLite file or spawned RpcClient. Pushes
   * every call onto `reconcileCalls` and returns the next queued result,
   * defaulting an empty queue to `'no-attempt'` so every pre-existing kill-
   * path test case in this file keeps passing unchanged.
   */
  protected override async reconcileOrphanAttempt(
    entry: SessionRegistryEntry,
    resolvedDir: string,
  ): Promise<OrphanReconcileResult> {
    this.reconcileCalls.push({ pid: entry.pid, resolvedDir });
    return this.reconcileResults.shift() ?? 'no-attempt';
  }

  /** Drives the reap directly, without going through startSession(). */
  async reapOrphanForTest(resolvedDir: string): Promise<void> {
    return this.reapPersistedOrphanSession(resolvedDir);
  }
}

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-orphan-dedup-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function createManager(): TestableSessionManager {
  return new TestableSessionManager(join(tmp, 'session-instances.json'));
}

describe('SessionManager — orphan-child dedup across MCP-server restarts (INC-2026-09-29-02 fix 3 Option B)', () => {
  it('persists a registry entry for the projectDir once the session is running', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-a');

    const sessionId = await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    const entry = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(entry, 'expected a persisted registry entry');
    assert.equal(entry?.sessionId, sessionId);
    assert.equal(entry?.pid, sm.lastClient!.pid);
  });

  it('kills a live orphan from a prior server instance and clears its stale entry before starting a new session', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-b');
    const orphanPid = 40001;

    // Simulate a prior MCP server instance's persisted entry for this
    // projectDir, referencing a child that is STILL ALIVE (no in-memory
    // session exists in `sm` — its Map was never populated for this dir,
    // exactly like a fresh server process after a restart).
    registerSessionEntry(
      {
        sessionId: 'stale-session-999',
        projectDir,
        pid: orphanPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(orphanPid);

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    // The orphan must have been signaled (SIGTERM, at minimum).
    assert.ok(
      sm.killedPids.some((k) => k.pid === orphanPid && k.signal === 'SIGTERM'),
      `expected orphan pid ${orphanPid} to receive SIGTERM, got: ${JSON.stringify(sm.killedPids)}`,
    );

    // Exactly one driver is now on record for this projectDir — the NEW
    // session's entry, not the stale one.
    const entry = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(entry);
    assert.notEqual(entry?.pid, orphanPid);
    assert.equal(entry?.pid, sm.lastClient!.pid);
  });

  it('does NOT kill anything when the persisted pid is already dead — just drops the stale row', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-c');
    const deadPid = 40002;

    registerSessionEntry(
      {
        sessionId: 'stale-session-dead',
        projectDir,
        pid: deadPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    // NOTE: deadPid intentionally NOT added to sm.alivePids — liveness probe reports ESRCH.

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.ok(
      !sm.killedPids.some((k) => k.pid === deadPid && k.signal === 'SIGTERM'),
      'must not send SIGTERM to an already-dead pid',
    );
    const entry = getSessionEntry(projectDir, sm.registryPath);
    assert.equal(entry?.pid, sm.lastClient!.pid, 'new session entry should have replaced the dead one');
  });

  it('does not touch a pid recycled by an unrelated process (start-time guard)', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-d');
    const recycledPid = 40003;
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');

    registerSessionEntry(
      {
        sessionId: 'stale-session-recycled',
        projectDir,
        pid: recycledPid,
        startTime: recordedAt.toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(recycledPid);

    // Override just for this test: the "alive" pid actually started two
    // minutes AFTER the recorded time — an unrelated process claimed the
    // recycled pid, so it must never be signaled with a real kill signal.
    const originalGetLiveness = sm['getSessionLivenessOptions'].bind(sm);
    (sm as unknown as { getSessionLivenessOptions: () => SessionLivenessOptions }).getSessionLivenessOptions = () => ({
      ...originalGetLiveness(),
      getProcessStartTime: () => recordedAt.getTime() + 120_000,
    });

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.ok(
      !sm.killedPids.some((k) => k.pid === recycledPid && (k.signal === 'SIGTERM' || k.signal === 'SIGKILL')),
      'must never signal a pid whose actual start time postdates the recorded one',
    );
  });

  it('settles a live orphan\'s Attempt instead of killing it (EXEC-01, Phase 39)', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-settled');
    const orphanPid = 40010;

    registerSessionEntry(
      {
        sessionId: 'stale-session-settled',
        projectDir,
        pid: orphanPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(orphanPid);
    sm.reconcileResults.push('settled');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    // The orphan's Attempt was settled — it must NOT be killed (no SIGTERM or
    // SIGKILL). A signal-0 liveness probe from isOrphanEntryAlive() is
    // expected and is not a kill.
    assert.ok(
      !sm.killedPids.some((k) => k.pid === orphanPid && (k.signal === 'SIGTERM' || k.signal === 'SIGKILL')),
      `expected orphan pid ${orphanPid} to receive no SIGTERM/SIGKILL, got: ${JSON.stringify(sm.killedPids)}`,
    );

    // The stale registry entry is still cleared, and exactly one new driver
    // client was created.
    const entry = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(entry);
    assert.notEqual(entry?.pid, orphanPid);
    assert.equal(entry?.pid, sm.lastClient!.pid);
    assert.equal(sm.allClients.length, 1);

    // The new seam was actually consulted — the decision is not bypassed.
    assert.ok(
      sm.reconcileCalls.some((c) => c.pid === orphanPid && c.resolvedDir === resolve(projectDir)),
      `expected a reconcile call for pid ${orphanPid}, got: ${JSON.stringify(sm.reconcileCalls)}`,
    );
  });

  it('kills a live orphan when there is no Attempt to settle — models the D-02 non-auto-mode orphan with no `workers` row (EXEC-01, Phase 39)', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-no-attempt');
    const orphanPid = 40011;

    registerSessionEntry(
      {
        sessionId: 'stale-session-no-attempt',
        projectDir,
        pid: orphanPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(orphanPid);
    sm.reconcileResults.push('no-attempt');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.ok(
      sm.killedPids.some((k) => k.pid === orphanPid && k.signal === 'SIGTERM'),
      `expected orphan pid ${orphanPid} to receive SIGTERM, got: ${JSON.stringify(sm.killedPids)}`,
    );
    assert.equal(
      sm.reconcileCalls.filter((c) => c.pid === orphanPid).length,
      1,
      'the kill must be reached by falling through a real reconcile attempt, not by skipping it',
    );
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, sm.lastClient!.pid);
  });

  it('kills a live orphan when the reconcile cannot reach the database (EXEC-01, Phase 39)', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-db-unavailable');
    const orphanPid = 40012;

    registerSessionEntry(
      {
        sessionId: 'stale-session-db-unavailable',
        projectDir,
        pid: orphanPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(orphanPid);
    sm.reconcileResults.push('db-unavailable');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.ok(
      sm.killedPids.some((k) => k.pid === orphanPid && k.signal === 'SIGTERM'),
      `expected orphan pid ${orphanPid} to receive SIGTERM, got: ${JSON.stringify(sm.killedPids)}`,
    );
    assert.equal(
      sm.reconcileCalls.filter((c) => c.pid === orphanPid).length,
      1,
      'the kill must be reached by falling through a real reconcile attempt, not by skipping it',
    );
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, sm.lastClient!.pid);
  });

  it('REGRESSION GUARD: without orphan detection, a duplicate driver could start for the same projectDir after a simulated restart', async () => {
    // This test documents the exact failure mode fix 3 (Option B) closes: a
    // FRESH SessionManager (simulating a new MCP server process after
    // restart) has an EMPTY in-memory map, so naive duplicate-start
    // prevention (which only checks the in-memory Map) would see no
    // conflict and launch a second driver even though the orphan is still
    // alive. Assert that the fixed startSession() instead reaps the orphan
    // — i.e. the orphan pid was signaled — rather than silently starting a
    // second live driver alongside it unnoticed.
    const sm = createManager();
    const projectDir = join(tmp, 'proj-e');
    const orphanPid = 40004;

    registerSessionEntry(
      {
        sessionId: 'stale-session-restart-sim',
        projectDir,
        pid: orphanPid,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );
    sm.alivePids.add(orphanPid);

    // sm's in-memory map has ZERO entries for projectDir — exactly the
    // post-restart state. A naive `this.sessions.get(resolvedDir)` guard
    // alone would find nothing and let this call through unopposed.
    assert.equal(sm.getInternalSession(projectDir), undefined);

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.ok(
      sm.killedPids.some((k) => k.pid === orphanPid && k.signal === 'SIGTERM'),
      'orphan must be reaped before the new driver is allowed to start — otherwise two drivers run concurrently',
    );
  });
});

// ---------------------------------------------------------------------------
// CR-01 (34-REVIEW.md): SessionManager.cleanup() must not delete a session's
// persisted registry row without first stopping its child. Before this fix,
// `cleanup()` unconditionally called `removeSessionEntry()` for every
// session but only called `client.stop()` for a subset of statuses —
// `completed` fell through both: its child was never stopped AND the one
// registry row that could have identified it as an orphan on the next
// server start was erased, reopening the double-driver failure mode fix 3B
// (RELY-09) was built to close.
// ---------------------------------------------------------------------------

describe('SessionManager.cleanup() — completed session must not be orphaned-and-forgotten (CR-01)', () => {
  it('a natural "auto-mode complete" notification stops the child and drops the registry row immediately — the root fix, not just at shutdown', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-completed-immediate');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    assert.ok(getSessionEntry(projectDir, sm.registryPath), 'precondition: registry row must exist while running');
    assert.equal(client.stopped, false, 'precondition: child must still be running pre-completion');

    // Drive the session to 'completed' via the real terminal-notification
    // path in handleEvent() — not a status write, so this exercises the
    // exact route production code uses.
    client.emitEvent({
      type: 'extension_ui_request',
      method: 'notify',
      message: 'auto-mode complete',
    });

    const session = sm.getInternalSession(projectDir)!;
    assert.equal(session.status, 'completed');
    assert.equal(client.stopped, true, 'natural completion must stop the child immediately, not leak it until shutdown');
    assert.equal(
      getSessionEntry(projectDir, sm.registryPath),
      undefined,
      'registry row must be dropped immediately once the child is actually stopped',
    );
  });

  it('cleanup() stops a completed session\'s child defensively even if it somehow reached completed without being stopped elsewhere', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-completed-defensive');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;
    const session = sm.getInternalSession(projectDir)!;

    // Simulate reaching 'completed' via a path that bypasses the
    // terminal-notification stop call above, so cleanup()'s own
    // unconditional-stop guarantee is exercised in isolation — cleanup()
    // must never assume a 'completed' session's child is already stopped.
    session.status = 'completed';
    assert.equal(client.stopped, false, 'precondition: child not yet stopped');
    assert.ok(getSessionEntry(projectDir, sm.registryPath), 'precondition: registry row must exist pre-cleanup');

    await sm.cleanup();

    assert.equal(client.stopped, true, 'cleanup() must stop a completed session\'s child, not leak it');
    assert.equal(
      getSessionEntry(projectDir, sm.registryPath),
      undefined,
      'registry row removal is fine once the child is actually stopped',
    );
  });
});

// ---------------------------------------------------------------------------
// CR-02 (34-REVIEW.md, filed there as WR-01): assess whether concurrent
// `startSession()` calls for the same projectDir can race on the persisted
// registry pid. Node.js async functions run their synchronous prefix
// (everything before the first `await`) to completion before yielding —
// `startSession()`'s "already active" guard (the `existing` check) and the
// synchronous `this.sessions.set(resolvedDir, session)` insert are BOTH in
// that prefix, with no `await` between them. So a second `startSession()`
// call for the same projectDir can never observe the pre-insert state: by
// the time any other code (including a second call to `startSession()`)
// gets a turn, the first call has already either thrown past the guard or
// inserted into `this.sessions` and suspended at its first internal
// `await` (`client.start()`). This test proves that guarantee holds even
// when the second call is fired without awaiting the first — the narrowest
// window the review could describe — rather than merely asserting it in
// prose. No code change: this closes CR-02 as accepted-with-rationale.
// ---------------------------------------------------------------------------

describe('SessionManager.startSession() — concurrent same-projectDir race (CR-02, accepted-with-rationale)', () => {
  it('a second startSession() for the same projectDir, fired before the first is awaited, is rejected by the synchronous guard — never races the registry write', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-concurrent');

    // Deliberately not awaited — the whole point is to fire it back-to-back
    // with the second call, inside the same synchronous stretch of code.
    const first = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    await assert.rejects(
      () => sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' }),
      /already active/,
      'a same-projectDir call issued before the first resolves must be rejected, not silently race it',
    );

    const sessionId = await first;

    // Exactly one child was ever spawned, and the persisted registry entry
    // matches the ONE session actually tracked in-memory — no
    // overwrite-by-the-loser scenario occurred.
    assert.equal(sm.allClients.length, 1, 'the rejected call must never have reached createClient()');
    const entry = getSessionEntry(projectDir, sm.registryPath);
    assert.equal(entry?.sessionId, sessionId);
    assert.equal(entry?.pid, sm.lastClient!.pid);
  });
});

// ---------------------------------------------------------------------------
// orphan-reconcile.ts — reconcileOrphanAttempt, exercised directly against a
// hand-built fake bridge (D-04: no real SQLite file anywhere in this suite).
// Covers Task 2's non-settled-outcome test map: a rejecting bridge load, a
// false ensureDbOpen, zero query rows, and an empty settled-id array all map
// onto the correct outcome, and the bound query parameters are asserted
// executably (Pitfall 4).
// ---------------------------------------------------------------------------

interface FakeOrphanReconcileBridgeCalls {
  ensureDbOpen: string[];
  getDb: number;
  settleRunningAttemptsForWorker: string[];
  prepareParams: Array<Record<string, unknown>>;
}

function createFakeOrphanReconcileBridge(config: {
  ensureDbOpenResult?: boolean;
  queryRows?: Array<{ worker_id: string }>;
  settledIdsByWorker?: Record<string, string[]>;
} = {}): { bridge: OrphanReconcileBridge; calls: FakeOrphanReconcileBridgeCalls } {
  const calls: FakeOrphanReconcileBridgeCalls = {
    ensureDbOpen: [],
    getDb: 0,
    settleRunningAttemptsForWorker: [],
    prepareParams: [],
  };
  const bridge: OrphanReconcileBridge = {
    async ensureDbOpen(projectDir: string) {
      calls.ensureDbOpen.push(projectDir);
      return config.ensureDbOpenResult ?? true;
    },
    getDb() {
      calls.getDb++;
      return {
        prepare(_sql: string) {
          return {
            all(params?: Record<string, unknown>) {
              calls.prepareParams.push(params ?? {});
              return config.queryRows ?? [];
            },
          };
        },
      };
    },
    settleRunningAttemptsForWorker(workerId: string) {
      calls.settleRunningAttemptsForWorker.push(workerId);
      return config.settledIdsByWorker?.[workerId] ?? [];
    },
  };
  return { bridge, calls };
}

describe('orphan-reconcile.ts — reconcileOrphanAttempt (module-level, D-04)', () => {
  const baseEntry: SessionRegistryEntry = {
    sessionId: 'session-under-test',
    projectDir: '/tmp/does-not-matter',
    pid: 50099,
    startTime: new Date().toISOString(),
    status: 'running',
  };
  const stubHostname = () => 'test-host';
  const stubNormalizeProjectRoot = (dir: string) => `normalized:${dir}`;

  it('returns \'db-unavailable\' when loadBridge rejects, rather than propagating the rejection', async () => {
    const deps: OrphanReconcileDeps = {
      loadBridge: async () => {
        throw new Error('bridge import failed');
      },
      hostname: stubHostname,
      normalizeProjectRoot: stubNormalizeProjectRoot,
    };
    const result = await reconcileOrphanAttempt(baseEntry, '/proj', deps);
    assert.equal(result, 'db-unavailable');
  });

  it('returns \'db-unavailable\' when ensureDbOpen resolves false, and never calls getDb', async () => {
    const { bridge, calls } = createFakeOrphanReconcileBridge({ ensureDbOpenResult: false });
    const deps: OrphanReconcileDeps = {
      loadBridge: async () => bridge,
      hostname: stubHostname,
      normalizeProjectRoot: stubNormalizeProjectRoot,
    };
    const result = await reconcileOrphanAttempt(baseEntry, '/proj', deps);
    assert.equal(result, 'db-unavailable');
    assert.equal(calls.getDb, 0);
  });

  it('returns \'no-attempt\' when the pid-join query returns zero rows, and never calls settleRunningAttemptsForWorker', async () => {
    const { bridge, calls } = createFakeOrphanReconcileBridge({ queryRows: [] });
    const deps: OrphanReconcileDeps = {
      loadBridge: async () => bridge,
      hostname: stubHostname,
      normalizeProjectRoot: stubNormalizeProjectRoot,
    };
    const result = await reconcileOrphanAttempt(baseEntry, '/proj', deps);
    assert.equal(result, 'no-attempt');
    assert.equal(calls.settleRunningAttemptsForWorker.length, 0);

    // Pitfall 4 (executable proof): the bound parameters are exactly the
    // entry's pid, the stubbed host, and the stubbed normalized project root.
    assert.deepEqual(calls.prepareParams, [
      { ':pid': baseEntry.pid, ':host': 'test-host', ':project_root': 'normalized:/proj' },
    ]);
  });

  it('returns \'no-attempt\' (not \'settled\') when the matched worker\'s settle returns an empty array — the count, not the absence of a throw, decides', async () => {
    const { bridge, calls } = createFakeOrphanReconcileBridge({
      queryRows: [{ worker_id: 'worker-1' }],
      settledIdsByWorker: { 'worker-1': [] },
    });
    const deps: OrphanReconcileDeps = {
      loadBridge: async () => bridge,
      hostname: stubHostname,
      normalizeProjectRoot: stubNormalizeProjectRoot,
    };
    const result = await reconcileOrphanAttempt(baseEntry, '/proj', deps);
    assert.equal(result, 'no-attempt');
    assert.equal(calls.settleRunningAttemptsForWorker.length, 1);

    assert.deepEqual(calls.prepareParams, [
      { ':pid': baseEntry.pid, ':host': 'test-host', ':project_root': 'normalized:/proj' },
    ]);
  });

  it('returns \'settled\' when the matched worker\'s settle returns at least one attempt id', async () => {
    const { bridge } = createFakeOrphanReconcileBridge({
      queryRows: [{ worker_id: 'worker-1' }],
      settledIdsByWorker: { 'worker-1': ['attempt-1'] },
    });
    const deps: OrphanReconcileDeps = {
      loadBridge: async () => bridge,
      hostname: stubHostname,
      normalizeProjectRoot: stubNormalizeProjectRoot,
    };
    const result = await reconcileOrphanAttempt(baseEntry, '/proj', deps);
    assert.equal(result, 'settled');
  });
});
