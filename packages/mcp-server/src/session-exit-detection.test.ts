/**
 * @opengsd/mcp-server — session exit detection (INC-2026-09-29-02).
 *
 * When a headless GSD session's child process dies (crash / SIGTERM, e.g.
 * exit code 143) SessionManager previously had zero wiring to notice: it
 * only ever subscribed to `client.onEvent(...)` (agent events), so a dead
 * child left the session as a zombie `status: 'running'` forever — no
 * terminal status, no error recorded.
 *
 * These tests exercise the real `SessionManager.startSession()` (not a
 * duplicated re-implementation) via the `createClient()` factory seam, so
 * the actual production wiring added for this incident is under test.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager } from './session-manager.js';
import type { SessionLivenessOptions } from './session-persist.js';
import type { RpcClient } from '@opengsd/rpc-client';
import type { ManagedSession } from './types.js';

// ---------------------------------------------------------------------------
// Mock RpcClient (duck-typed to match the RpcClient interface used by
// SessionManager — mirrors the pattern in mcp-server.test.ts's MockRpcClient,
// extended with onExit()/simulateExit() for this incident).
// ---------------------------------------------------------------------------

type ExitListener = (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void;

class MockRpcClient {
  started = false;
  /** Mirrors RpcClient's private `_stopped` — set by stop() before the
   *  (simulated) child actually exits. Used to compute `expected` the same
   *  way the real RpcClient does. */
  stopped = false;
  aborted = false;
  prompted: string[] = [];
  /** Driver pid - D-01 (Phase 41) fails closed when this is not a number. */
  pid: number | undefined;

  private eventListeners: Array<(event: Record<string, unknown>) => void> = [];
  private exitListeners: ExitListener[] = [];

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

  onExit(listener: ExitListener): () => void {
    this.exitListeners.push(listener);
    return () => {
      const idx = this.exitListeners.indexOf(listener);
      if (idx >= 0) this.exitListeners.splice(idx, 1);
    };
  }

  async prompt(message: string): Promise<void> {
    this.prompted.push(message);
  }

  async abort(): Promise<void> {
    this.aborted = true;
  }

  sendUIResponse(_requestId: string, _response: Record<string, unknown>): void {
    /* not exercised by these tests */
  }

  /** Test helper — emit an agent event to all listeners. */
  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) listener(event);
  }

  /**
   * Test helper — simulate the child process exiting. `expected` is derived
   * from `stopped` exactly the way the real RpcClient derives it from
   * `_stopped`: true only when `stop()` was called before the exit fires.
   */
  simulateExit(code: number | null, signal: NodeJS.Signals | null = null): void {
    const expected = this.stopped;
    for (const listener of this.exitListeners) listener({ code, signal, expected });
  }
}

// ---------------------------------------------------------------------------
// TestableSessionManager — overrides only the client factory seam, so the
// real startSession()/handleEvent()/handleUnexpectedExit() run unmodified.
// ---------------------------------------------------------------------------

class TestableSessionManager extends SessionManager {
  lastClient: MockRpcClient | null = null;
  allClients: MockRpcClient[] = [];
  private sessionCounter = 0;
  nextInitError: Error | null = null;
  nextStartError: Error | null = null;
  nextPid = 61000;

  /** Temp registry so the real ~/.gsd/session-instances.json is never touched. */
  private readonly registryPath: string;

  constructor(registryPath: string) {
    super();
    this.registryPath = registryPath;
  }

  protected override getSessionRegistryPath(): string | undefined {
    return this.registryPath;
  }

  protected override getSessionLivenessOptions(): SessionLivenessOptions {
    return {
      kill: (_pid, signal) => {
        if (signal === 0 || signal === undefined) {
          const err = new Error('no such process') as NodeJS.ErrnoException;
          err.code = 'ESRCH';
          throw err;
        }
      },
      getProcessStartTime: () => null,
      waitForExit: () => {},
    };
  }

  protected override createClient(options: { cliPath: string; cwd: string; args: string[] }): RpcClient {
    this.sessionCounter++;
    const client = new MockRpcClient(options);
    client.pid = this.nextPid++;
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    if (this.nextStartError) {
      client.startError = this.nextStartError;
      this.nextStartError = null;
    }
    if (this.nextInitError) {
      client.initError = this.nextInitError;
      this.nextInitError = null;
    }
    this.lastClient = client;
    this.allClients.push(client);
    return client as unknown as RpcClient;
  }

  /** Expose the session map for assertions. */
  getInternalSession(projectDir: string): ManagedSession | undefined {
    return this.getSessionByDir(projectDir);
  }
}

function createManager(registryPath: string): TestableSessionManager {
  return new TestableSessionManager(registryPath);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('SessionManager — unexpected child exit detection (INC-2026-09-29-02)', () => {
  let sm: TestableSessionManager;
  let tmp: string;

  beforeEach(() => {
    tmp = mkdtempSync(join(tmpdir(), 'mcp-exit-detect-'));
    sm = createManager(join(tmp, 'session-instances.json'));
  });

  afterEach(() => {
    rmSync(tmp, { recursive: true, force: true });
  });

  it('marks a running session terminal (error) when the child exits unexpectedly with a nonzero code', async () => {
    const sessionId = await sm.startSession('/tmp/exit-detect-1', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;
    assert.equal(session.status, 'running');

    // Simulate a crash: exit code 143 (128 + SIGTERM), no explicit signal
    // reported, and stop() was never called — this is an unexpected death.
    sm.lastClient!.simulateExit(143, null);

    assert.equal(session.status, 'error');
    assert.match(session.error ?? '', /143/);
    assert.match(session.error ?? '', /unexpectedly/);
  });

  it('marks a running session terminal (error) when the child is killed by a signal', async () => {
    const sessionId = await sm.startSession('/tmp/exit-detect-2', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;

    sm.lastClient!.simulateExit(null, 'SIGKILL');

    assert.equal(session.status, 'error');
    assert.match(session.error ?? '', /SIGKILL/);
  });

  it('does NOT mark the session errored when the exit follows our own stop() (cancelSession)', async () => {
    const sessionId = await sm.startSession('/tmp/exit-detect-3', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;

    await sm.cancelSession(sessionId);
    assert.equal(session.status, 'cancelled');

    // The real RpcClient fires 'exit' asynchronously, after stop() has
    // already set `_stopped = true` — simulate that ordering here.
    sm.lastClient!.simulateExit(0, null);

    // Must remain 'cancelled' — an intentional teardown must never be
    // clobbered into 'error' by the exit that teardown itself caused.
    assert.equal(session.status, 'cancelled');
    assert.equal(session.error, undefined);
  });

  it('a dead session surfaces its terminal status + error via getResult() instead of a stale "running"', async () => {
    const sessionId = await sm.startSession('/tmp/exit-detect-4', { cliPath: '/usr/bin/gsd' });

    sm.lastClient!.simulateExit(143, null);

    const result = sm.getResult(sessionId);
    assert.equal(result.status, 'error');
    assert.match(String(result.error), /143/);
  });

  it('does not clobber a status already made terminal by a prior blocking/terminal agent event', async () => {
    const sessionId = await sm.startSession('/tmp/exit-detect-5', { cliPath: '/usr/bin/gsd' });
    const session = sm.getSession(sessionId)!;

    // Drive the session to 'completed' via the normal event path first.
    sm.lastClient!.emitEvent({ type: 'extension_ui_request', method: 'notify', message: 'auto-mode complete' });
    assert.equal(session.status, 'completed');

    // The process later exits (naturally) — must not overwrite 'completed'.
    sm.lastClient!.simulateExit(0, null);
    assert.equal(session.status, 'completed');
    assert.equal(session.error, undefined);
  });
});
