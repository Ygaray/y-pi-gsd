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
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager } from './session-manager.js';
import { getSessionEntry, registerSessionEntry, type SessionLivenessOptions } from './session-persist.js';
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
