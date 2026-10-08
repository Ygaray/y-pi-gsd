/**
 * Phase 41 / DRIVER-02 - driver registry lifecycle tests.
 *
 * Drives the REAL SessionManager.startSession() through its seams
 * (createClient, getSessionRegistryPath, getSessionLivenessOptions) with a
 * duck-typed MockRpcClient and fake pid signalling. Registry I/O always goes
 * to a temp file - never the real ~/.gsd/session-instances.json (REGISTRY_PATH
 * is a module-load constant, so every manager here overrides
 * getSessionRegistryPath()).
 *
 * MockRpcClient / TestableSessionManager are copied from
 * session-orphan-dedup.test.ts (the classes are intentionally not exported;
 * copying keeps test helpers out of the shipped dist) and extended with
 * consume-once failure/gate injection.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdirSync, mkdtempSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionDeclinedError, SessionManager, type OrphanReapOutcome } from './session-manager.js';
import {
  getSessionEntry,
  readSessionRegistry,
  registerSessionEntry,
  type SessionLivenessOptions,
  type SessionRegistryEntry,
} from './session-persist.js';
import type { OrphanReconcileResult } from './orphan-reconcile.js';
import type { RpcClient } from '@opengsd/rpc-client';
import type { ManagedSession } from './types.js';
import { createMcpServer } from './server.js';

// ---------------------------------------------------------------------------
// Mock RpcClient
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
  /** When set, init() awaits it before returning/throwing. */
  initGate: Promise<void> | null = null;
  /** When set, prompt() throws it before recording. */
  promptError: Error | null = null;
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

  /** When set, stop() awaits it before recording the stop. */
  stopGate: Promise<void> | null = null;
  /** When set, stop() appends `stopped:<pid>` after the gate. */
  orderLog: string[] | null = null;

  async stop(): Promise<void> {
    if (this.stopGate) await this.stopGate;
    this.stopped = true;
    this.orderLog?.push(`stopped:${this.pid}`);
  }

  async init(): Promise<{ sessionId: string; version: string }> {
    if (this.initGate) await this.initGate;
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

  exitListeners: Array<(info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void> = [];

  onExit(listener: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): () => void {
    this.exitListeners.push(listener);
    return () => {
      const idx = this.exitListeners.indexOf(listener);
      if (idx >= 0) this.exitListeners.splice(idx, 1);
    };
  }

  emitEvent(event: Record<string, unknown>): void {
    for (const listener of this.eventListeners) {
      listener(event);
    }
  }

  async prompt(message: string): Promise<void> {
    if (this.promptError) throw this.promptError;
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
// TestableSessionManager
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

  reconcileResults: OrphanReconcileResult[] = [];
  reconcileCalls: Array<{ pid: number; resolvedDir: string }> = [];

  /** Consume-once injections applied to the NEXT client createClient() builds. */
  nextInitGate: Promise<void> | null = null;
  nextInitError: Error | null = null;
  nextPromptError: Error | null = null;
  nextPidUndefined = false;

  /** Ordered log of `create:<pid>` / `stopped:<pid>` / `settle:<pid>` / `<signal>:<pid>` events. */
  order: string[] = [];

  /** D-02: legacy auto.lock last-resort seam. */
  lockFallbackCalls: string[] = [];
  lockFallbackResult = false;
  /** D-02: when set, invokeOrphanReconcile awaits it first. */
  reconcileGate: Promise<void> | null = null;
  /** D-02: when set, the fake kill throws an Error with this errno code on SIGTERM. */
  killErrorOnSigterm: string | null = null;
  /** WR-03: the fake OS start time / cwd of every pid (default: verified start, cwd unknown). */
  procStartTime: number | null = 1;
  procCwd: string | null = null;

  constructor(registryPath: string) {
    super();
    this.registryPath = registryPath;
  }

  protected override createClient(options: { cliPath: string; cwd: string; args: string[] }): RpcClient {
    this.sessionCounter++;
    const client = new MockRpcClient(options);
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    if (this.nextPidUndefined) {
      client.pid = undefined;
      this.nextPidUndefined = false;
    } else {
      client.pid = this.nextPid++;
    }
    client.initGate = this.nextInitGate;
    client.initError = this.nextInitError;
    client.promptError = this.nextPromptError;
    this.nextInitGate = null;
    this.nextInitError = null;
    this.nextPromptError = null;
    client.orderLog = this.order;
    this.order.push(`create:${client.pid}`);
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
        if (signal !== 0 && signal !== undefined) this.order.push(`${signal}:${pid}`);
        if (signal === 'SIGTERM' && this.killErrorOnSigterm) {
          const err = new Error(`kill ${this.killErrorOnSigterm}`) as NodeJS.ErrnoException;
          err.code = this.killErrorOnSigterm;
          throw err;
        }
        if (signal === 0 || signal === undefined) {
          if (!this.alivePids.has(pid)) {
            const err = new Error('no such process') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
          return;
        }
        this.alivePids.delete(pid);
      },
      // A verified (long-ago) start time keeps the WR-03 identity gate out of
      // the way; getProcessCwd is stubbed so no real lsof/pwdx runs for fake pids.
      getProcessStartTime: () => this.procStartTime,
      getProcessCwd: () => this.procCwd,
      waitForExit: () => {},
    };
  }

  getInternalSession(projectDir: string): ManagedSession | undefined {
    return this.getSessionByDir(projectDir);
  }

  protected override async invokeOrphanReconcile(
    entry: SessionRegistryEntry,
    resolvedDir: string,
  ): Promise<OrphanReconcileResult> {
    this.reconcileCalls.push({ pid: entry.pid, resolvedDir });
    if (this.reconcileGate) await this.reconcileGate;
    this.order.push(`settle:${entry.pid}`);
    return this.reconcileResults.shift() ?? 'no-attempt';
  }

  protected override async stopDetachedAutoProcess(projectDir: string): Promise<boolean> {
    this.lockFallbackCalls.push(projectDir);
    return this.lockFallbackResult;
  }

  async reapOrphanForTest(resolvedDir: string): Promise<OrphanReapOutcome> {
    return this.reapPersistedOrphanSession(resolvedDir);
  }
}

// Referenced so the copied harness keeps the helpers later Phase 41 plans use.
void registerSessionEntry;
void readSessionRegistry;
void resolve;

let tmp: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-registry-lifecycle-'));
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function createManager(): TestableSessionManager {
  return new TestableSessionManager(join(tmp, 'session-instances.json'));
}

// ---------------------------------------------------------------------------
// D-01 register-ordering (SC1)
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - D-01 register-ordering (SC1)', () => {
  it('D-01 registers the driver before init resolves and before dispatch', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-d01');

    let release!: () => void;
    sm.nextInitGate = new Promise<void>((r) => {
      release = r;
    });

    const startPromise = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    // start() resolves on a microtask; setImmediate drains them.
    await new Promise((r) => setImmediate(r));

    const client = sm.lastClient!;
    const starting = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(starting, 'row must exist while init() is still pending');
    assert.equal(starting.pid, client.pid);
    assert.equal(starting.status, 'starting');
    assert.equal(starting.sessionId, '');
    assert.equal(starting.ownerPid, process.pid);
    assert.equal(client.prompted.length, 0, 'no prompt may be dispatched before registration/init');

    release();
    const sessionId = await startPromise;

    const running = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(running);
    assert.equal(running.sessionId, sessionId);
    assert.equal(running.status, 'running');
    assert.equal(running.startTime, starting.startTime);
    assert.equal(running.ownerPid, starting.ownerPid);
    assert.equal(running.pid, client.pid);
  });

  it('D-01 a failed init or prompt removes the registry row after stopping the client', async () => {
    const sm = createManager();

    // init() rejection
    const initDir = join(tmp, 'proj-init-fail');
    sm.nextInitError = new Error('init boom');
    await assert.rejects(
      () => sm.startSession(initDir, { cliPath: '/usr/bin/gsd' }),
      /Failed to start session/,
    );
    assert.equal(sm.lastClient!.stopped, true);
    assert.equal(getSessionEntry(initDir, sm.registryPath), undefined);

    // prompt() rejection on a fresh dir
    const promptDir = join(tmp, 'proj-prompt-fail');
    sm.nextPromptError = new Error('prompt boom');
    await assert.rejects(
      () => sm.startSession(promptDir, { cliPath: '/usr/bin/gsd' }),
      /Failed to start session/,
    );
    assert.equal(sm.lastClient!.stopped, true);
    assert.equal(getSessionEntry(promptDir, sm.registryPath), undefined);
  });

  it('D-01 refuses to dispatch when the driver pid is unavailable after start', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-no-pid');
    sm.nextPidUndefined = true;

    await assert.rejects(
      () => sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' }),
      (err: Error) => {
        assert.ok(
          err.message.includes('driver pid unavailable after start(); refusing to dispatch an unregistered driver'),
          `unexpected message: ${err.message}`,
        );
        return true;
      },
    );

    const client = sm.lastClient!;
    assert.equal(client.stopped, true);
    assert.equal(client.prompted.length, 0);
    assert.deepEqual(readSessionRegistry(sm.registryPath), {});
  });
});

// ---------------------------------------------------------------------------
// SC3 duplicate drivers
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - SC3 duplicate drivers', () => {
  it('SC3 a symlink alias of a worktree maps to one registry row and one driver', async () => {
    const sm = createManager();
    const real = join(tmp, 'real-worktree');
    const link = join(tmp, 'link-worktree');
    mkdirSync(real);
    symlinkSync(real, link);

    await sm.startSession(link, { cliPath: '/usr/bin/gsd' });

    await assert.rejects(
      () => sm.startSession(real, { cliPath: '/usr/bin/gsd' }),
      (err: unknown) => {
        assert.ok(err instanceof SessionDeclinedError);
        assert.equal(err.reason, 'active');
        return true;
      },
    );
    assert.equal(sm.allClients.length, 1, 'no second client may be created');

    assert.deepEqual(Object.keys(readSessionRegistry(sm.registryPath)), [realpathSync.native(real)]);
    const pid = sm.lastClient!.pid;
    assert.equal(getSessionEntry(link, sm.registryPath)?.pid, pid);
    assert.equal(getSessionEntry(real, sm.registryPath)?.pid, pid);

    await sm.cancelSessionByDir(real);
    assert.deepEqual(readSessionRegistry(sm.registryPath), {});
  });

  it('SC3 eviction awaits the old driver stop before spawning the replacement', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-evict');

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const oldClient = sm.lastClient!;
    oldClient.emitEvent({ type: 'extension_ui_request', method: 'notify', message: 'Auto-mode paused (Escape).' });
    assert.equal(sm.getInternalSession(projectDir)?.status, 'paused');

    let openGate!: () => void;
    oldClient.stopGate = new Promise<void>((r) => {
      openGate = r;
    });

    const restart = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    await new Promise((r) => setImmediate(r));

    assert.equal(sm.allClients.length, 1, 'replacement must not be created while stop() is pending');
    await assert.rejects(
      () => sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' }),
      (err: unknown) => {
        assert.ok(err instanceof SessionDeclinedError);
        assert.equal(err.reason, 'reap-in-progress');
        return true;
      },
    );
    assert.equal(sm.allClients.length, 1, 'declined racing start must create no client');

    openGate();
    await restart;

    assert.equal(sm.allClients.length, 2);
    const newClient = sm.lastClient!;
    assert.deepEqual(sm.order, [
      `create:${oldClient.pid}`,
      `stopped:${oldClient.pid}`,
      `create:${newClient.pid}`,
    ]);
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, newClient.pid);
  });

  it('SC3 the start-time reap never probes or signals an exit tombstone pid', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-tombstone');
    const tombPid = 40999;
    sm.alivePids.add(tombPid); // models pid recycling: the dead driver's pid is now someone else's live process

    registerSessionEntry(
      {
        sessionId: 'dead-session',
        projectDir,
        pid: tombPid,
        startTime: new Date().toISOString(),
        status: 'exited',
        exit: { reason: 'driver exited code=1', code: 1, signal: null, at: new Date().toISOString() },
      },
      sm.registryPath,
    );

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.deepEqual(
      sm.killedPids.filter((k) => k.pid === tombPid),
      [],
      'tombstone pid must not be probed (not even signal 0) or signalled',
    );
    assert.equal(sm.alivePids.has(tombPid), true);
    const row = getSessionEntry(projectDir, sm.registryPath);
    assert.equal(row?.pid, sm.lastClient!.pid);
    assert.equal(row?.exit, undefined);
  });
});

// ---------------------------------------------------------------------------
// D-02 registry-first stop (SC2)
// ---------------------------------------------------------------------------

/** Run `fn` with GSD_WORKFLOW_PROJECT_ROOT unset (validateProjectDir enforces it when set). */
async function withoutProjectRoot<T>(fn: () => Promise<T>): Promise<T> {
  const saved = process.env.GSD_WORKFLOW_PROJECT_ROOT;
  delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
  try {
    return await fn();
  } finally {
    if (saved === undefined) delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
    else process.env.GSD_WORKFLOW_PROJECT_ROOT = saved;
  }
}

/** Build an mcp server around `sm` and call a registered tool handler. */
async function callTool(
  sm: SessionManager,
  name: string,
  args: Record<string, unknown>,
): Promise<{ isError: boolean; text: string }> {
  const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
  const result = await (server as any)._registeredTools[name].handler(args);
  return { isError: result.isError === true, text: result.content[0].text as string };
}

function liveRow(sm: TestableSessionManager, projectDir: string, pid: number, sessionId: string): void {
  sm.alivePids.add(pid);
  registerSessionEntry(
    {
      sessionId,
      projectDir,
      pid,
      startTime: new Date().toISOString(),
      status: 'running',
      ownerPid: 999999,
    },
    sm.registryPath,
  );
}

describe('Phase 41 driver registry lifecycle - D-02 registry-first stop (SC2)', () => {
  it('D-02 cancel stops an untracked registered driver by its registered pid', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-cancel');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41001, 'reg-sess-1');

    const out = await withoutProjectRoot(() => callTool(sm, 'gsd_cancel_by_project', { projectDir }));
    assert.equal(out.isError, false, out.text);
    assert.equal(JSON.parse(out.text).cancelled, true);

    const signals = sm.killedPids.filter((k) => k.signal !== 0 && k.signal !== undefined);
    assert.ok(signals.length > 0);
    for (const k of sm.killedPids) {
      assert.ok(k.pid > 0, `no process-group (negative/zero) pid may be signalled, saw ${k.pid}`);
      assert.equal(k.pid, 41001, 'only the registered pid may be touched');
    }
    assert.ok(signals.some((k) => k.signal === 'SIGTERM'));
    assert.ok(sm.order.indexOf('settle:41001') >= 0);
    assert.ok(sm.order.indexOf('settle:41001') < sm.order.indexOf('SIGTERM:41001'), 'settle runs before SIGTERM');
    assert.equal(getSessionEntry(projectDir, sm.registryPath), undefined);
    assert.deepEqual(sm.lockFallbackCalls, []);
  });

  it('D-02 a kill failure keeps the row and throws', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-kill-fail');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41002, 'reg-sess-2');
    sm.killErrorOnSigterm = 'EPERM';

    await assert.rejects(
      () => sm.cancelSessionByDir(projectDir),
      (err: Error) => {
        assert.match(err.message, /pid=41002 kill signal failed/);
        assert.match(err.message, /registry row preserved/);
        return true;
      },
    );

    const row = getSessionEntry(projectDir, sm.registryPath);
    assert.ok(row, 'row must be kept on an unconfirmed kill');
    assert.equal(row.pid, 41002);
    assert.equal(row.status, 'running');
    assert.equal(row.exit, undefined);
    assert.deepEqual(sm.lockFallbackCalls, []);
  });

  it('D-02 a dead registered driver is tombstoned, not signalled, and the cancel falls through', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-dead');
    mkdirSync(projectDir);
    registerSessionEntry(
      {
        sessionId: 'reg-sess-3',
        projectDir,
        pid: 41003, // not in alivePids -> probe reports ESRCH
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: 999999,
      },
      sm.registryPath,
    );

    await assert.rejects(
      () => sm.cancelSessionByDir(projectDir),
      (err: Error) => {
        assert.ok(err.message.startsWith('Session not found for projectDir: '), err.message);
        assert.ok(err.message.includes('was no longer running'), err.message);
        return true;
      },
    );

    assert.equal(sm.killedPids.filter((k) => k.signal === 'SIGTERM' || k.signal === 'SIGKILL').length, 0);
    const row = getSessionEntry(projectDir, sm.registryPath);
    assert.equal(row?.status, 'exited');
    assert.ok(row?.exit?.reason.includes('not running when reconciled'), row?.exit?.reason);
    assert.equal(sm.lockFallbackCalls.length, 1);
  });

  it('D-02 a registered driver never reaches the legacy lock path', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-no-lock');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41004, 'reg-sess-4');
    sm.lockFallbackResult = true;

    await sm.cancelSessionByDir(projectDir);

    assert.ok(sm.killedPids.some((k) => k.pid === 41004 && k.signal === 'SIGTERM'));
    assert.deepEqual(sm.lockFallbackCalls, []);
  });

  it('D-02 an unregistered driver still reaches the legacy lock path', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-unregistered');
    mkdirSync(projectDir);
    sm.lockFallbackResult = true;

    await sm.cancelSessionByDir(projectDir);

    assert.equal(sm.lockFallbackCalls.length, 1);
    assert.equal(sm.killedPids.filter((k) => k.signal !== 0 && k.signal !== undefined).length, 0);
  });

  it('D-02 explicit cancel kills even when the attempt settles', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-settled');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41005, 'reg-sess-5');
    sm.reconcileResults = ['settled'];

    await sm.cancelSessionByDir(projectDir);

    assert.equal(sm.reconcileCalls.length, 1);
    assert.ok(sm.killedPids.some((k) => k.pid === 41005 && k.signal === 'SIGTERM'), 'Q3: settled must not spare the pid');
    assert.equal(getSessionEntry(projectDir, sm.registryPath), undefined);
  });

  it('D-02 cancel holds the start lock so a concurrent start is declined', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-cancel-lock');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41006, 'reg-sess-6');

    let release!: () => void;
    sm.reconcileGate = new Promise<void>((r) => {
      release = r;
    });

    const cancel = sm.cancelSessionByDir(projectDir);
    await new Promise((r) => setImmediate(r));

    await assert.rejects(
      () => sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' }),
      (err: unknown) => {
        assert.ok(err instanceof SessionDeclinedError);
        assert.equal(err.reason, 'reap-in-progress');
        return true;
      },
    );
    assert.equal(sm.allClients.length, 0, 'declined start must create no client');

    release();
    await cancel;
    sm.reconcileGate = null;

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    assert.equal(sm.allClients.length, 1);
  });

  it('D-02 cancel during a start reap is refused instead of racing', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-start-reap');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41008, 'reg-sess-8');

    let release!: () => void;
    sm.reconcileGate = new Promise<void>((r) => {
      release = r;
    });

    const start = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    await new Promise((r) => setImmediate(r));
    assert.equal(sm.reconcileCalls.length, 1, 'the start reap must be inside its settle');

    await assert.rejects(
      () => sm.cancelSessionByDir(projectDir),
      (err: Error) => {
        assert.ok(err.message.includes('a session start or reap for this projectDir is in progress'), err.message);
        return true;
      },
    );
    assert.equal(sm.killedPids.filter((k) => k.signal === 'SIGTERM').length, 0, 'refused cancel must not signal');

    release();
    await start;
    assert.equal(sm.allClients.length, 1);
  });

  it('D-02 a second cancel sends no further signal', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-idempotent');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41009, 'reg-sess-9');

    await sm.cancelSessionByDir(projectDir);
    const signalsAfterFirst = sm.killedPids.filter((k) => k.signal !== 0 && k.signal !== undefined).length;
    assert.ok(signalsAfterFirst > 0);

    await assert.rejects(() => sm.cancelSessionByDir(projectDir), {
      message: `Session not found for projectDir: ${projectDir}`,
    });
    assert.equal(sm.killedPids.filter((k) => k.signal !== 0 && k.signal !== undefined).length, signalsAfterFirst);
  });

  it('D-02 gsd_cancel with only a stale sessionId stops the registered driver', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-session-only');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 41007, 'reg-sess-7');

    await withoutProjectRoot(async () => {
      const out = await callTool(sm, 'gsd_cancel', { sessionId: 'reg-sess-7' });
      assert.equal(out.isError, false, out.text);
      assert.equal(JSON.parse(out.text).cancelled, true);
      assert.ok(sm.killedPids.some((k) => k.pid === 41007 && k.signal === 'SIGTERM'));
      assert.equal(getSessionEntry(projectDir, sm.registryPath), undefined);

      const unknown = await callTool(sm, 'gsd_cancel', { sessionId: 'no-such-session' });
      assert.equal(unknown.isError, true);
      assert.ok(unknown.text.includes('Session not found: no-such-session'), unknown.text);
    });
  });
});

// ---------------------------------------------------------------------------
// D-04 reconnect reconcile (SC4)
// ---------------------------------------------------------------------------

/** Run `fn` with the DB bridge forced off and GSD_WORKFLOW_PROJECT_ROOT unset. */
async function withBridgeDisabled<T>(fn: () => Promise<T>): Promise<T> {
  const savedDisable = process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE;
  process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE = '1';
  try {
    return await withoutProjectRoot(fn);
  } finally {
    if (savedDisable === undefined) delete process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE;
    else process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE = savedDisable;
  }
}

function nonZeroSignals(sm: TestableSessionManager): Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> {
  return sm.killedPids.filter((k) => k.signal !== 0 && k.signal !== undefined);
}

describe('Phase 41 driver registry lifecycle - D-04 reconnect reconcile (SC4)', () => {
  it('D-04 reconcileRegisteredDriver never signals and tombstones a dead row', async () => {
    const sm = createManager();
    const deadDir = join(tmp, 'proj-recon-dead');
    const trackedDir = join(tmp, 'proj-recon-tracked');
    mkdirSync(deadDir);
    mkdirSync(trackedDir);
    registerSessionEntry(
      {
        sessionId: 'dead-sess',
        projectDir: deadDir,
        pid: 42001,
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: 999999,
      },
      sm.registryPath,
    );
    // An in-flight row (sessionId '') must never match an empty reference.
    registerSessionEntry(
      {
        sessionId: '',
        projectDir: join(tmp, 'proj-inflight'),
        pid: 42003,
        startTime: new Date().toISOString(),
        status: 'starting',
      },
      sm.registryPath,
    );

    const first = sm.reconcileRegisteredDriver({ projectDir: deadDir });
    assert.equal(first.outcome, 'dead-reconciled');
    const row = getSessionEntry(deadDir, sm.registryPath);
    assert.equal(row?.status, 'exited');
    assert.ok(row?.exit?.reason.includes('not running when reconciled'), row?.exit?.reason);
    assert.ok(row?.exit?.reason.includes('42001'), 'reason names the pid');

    const second = sm.reconcileRegisteredDriver({ projectDir: deadDir });
    assert.equal(second.outcome, 'dead-reconciled');
    assert.deepEqual(getSessionEntry(deadDir, sm.registryPath)?.exit, row?.exit, 'first exit record (incl. at) is kept');

    assert.equal(sm.reconcileRegisteredDriver({ sessionId: '' }).outcome, 'no-entry');
    assert.equal(sm.reconcileRegisteredDriver({}).outcome, 'no-entry');

    await sm.startSession(trackedDir, { cliPath: '/usr/bin/gsd' });
    const before = getSessionEntry(trackedDir, sm.registryPath);
    assert.equal(sm.reconcileRegisteredDriver({ projectDir: trackedDir }).outcome, 'tracked');
    assert.deepEqual(getSessionEntry(trackedDir, sm.registryPath), before);

    assert.deepEqual(nonZeroSignals(sm), [], 'a read path must never send a non-zero signal');
    assert.deepEqual(sm.reconcileCalls, [], 'no Attempt settle on a read path');
  });

  it('D-04 reconcileRegisteredDriver reports a live untracked driver without touching it', () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-recon-live');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 42002, 'live-sess');
    const before = structuredClone(getSessionEntry(projectDir, sm.registryPath));

    const result = sm.reconcileRegisteredDriver({ projectDir });

    assert.equal(result.outcome, 'orphan-alive');
    assert.equal(result.ownerAlive, false, 'ownerPid 999999 is not alive');
    assert.equal(result.entry?.pid, 42002);
    assert.deepEqual(getSessionEntry(projectDir, sm.registryPath), before);
    assert.deepEqual(nonZeroSignals(sm), []);
    assert.deepEqual(sm.reconcileCalls, []);

    const bySession = sm.reconcileRegisteredDriver({ sessionId: 'live-sess' });
    assert.equal(bySession.outcome, 'orphan-alive');
  });

  it('D-04 gsd_status and gsd_result return the same reconciled driver payload', async () => {
    const sm = createManager();
    const liveDir = join(tmp, 'proj-h-live');
    const deadDir = join(tmp, 'proj-h-dead');
    const noneDir = join(tmp, 'proj-h-none');
    mkdirSync(liveDir);
    mkdirSync(deadDir);
    mkdirSync(noneDir);
    liveRow(sm, liveDir, 42010, 'h-live-sess');
    registerSessionEntry(
      {
        sessionId: 'h-dead-sess',
        projectDir: deadDir,
        pid: 42011,
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: 999999,
      },
      sm.registryPath,
    );

    await withBridgeDisabled(async () => {
      const payloads: Record<string, Record<string, unknown>> = {};
      for (const dir of [liveDir, deadDir]) {
        const perTool: Array<Record<string, any>> = [];
        for (const tool of ['gsd_status', 'gsd_result']) {
          const out = await callTool(sm, tool, { sessionId: 'stale-x', projectDir: dir });
          assert.equal(out.isError, false, `${tool}: ${out.text}`);
          perTool.push(JSON.parse(out.text));
        }
        assert.deepEqual(perTool[0], perTool[1], `both tools must agree for ${dir}`);
        payloads[dir] = perTool[0];
      }

      const live = payloads[liveDir] as Record<string, any>;
      assert.equal(live.status, 'untracked');
      assert.equal(live.reconciledFromDb, false);
      assert.equal(live.driver.outcome, 'orphan-alive');
      assert.equal(live.driver.pid, 42010);
      assert.equal(live.driver.ownerAlive, false);

      const dead = payloads[deadDir] as Record<string, any>;
      assert.equal(dead.status, 'untracked');
      assert.equal(dead.driver.outcome, 'dead-reconciled');
      assert.ok(String(dead.driver.exit.reason).includes('not running'), dead.driver.exit.reason);

      for (const tool of ['gsd_status', 'gsd_result']) {
        const none = await callTool(sm, tool, { sessionId: 'stale-x', projectDir: noneDir });
        assert.equal(none.isError, true, tool);
        assert.match(none.text, /Session not found/);
      }
    });

    assert.deepEqual(nonZeroSignals(sm), [], 'status/result polls must never signal');
  });

  it('D-04 a stale sessionId for an untracked dir is reconciled for that dir, not the sole tracked session', async () => {
    const sm = createManager();
    const dirA = join(tmp, 'proj-stale-a');
    const dirB = join(tmp, 'proj-stale-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    const aSessionId = await sm.startSession(dirA, { cliPath: '/usr/bin/gsd' });
    liveRow(sm, dirB, 42020, 'reg-sess-b');

    await withBridgeDisabled(async () => {
      const out = await callTool(sm, 'gsd_status', { sessionId: 'stale-y', projectDir: dirB });
      assert.equal(out.isError, false, out.text);
      const payload = JSON.parse(out.text);
      assert.equal(payload.driver.outcome, 'orphan-alive');
      assert.equal(payload.driver.pid, 42020);
      assert.notEqual(payload.sessionId, aSessionId);
      assert.equal(payload.projectDir, dirB);
    });
    assert.deepEqual(nonZeroSignals(sm), []);
  });

  it('D-04 a registry-known sessionId alone is reconciled through gsd_result', async () => {
    const sm = createManager();
    const dirC = join(tmp, 'proj-sess-only');
    mkdirSync(dirC);
    liveRow(sm, dirC, 42021, 'reg-sess-9');

    await withBridgeDisabled(async () => {
      const out = await callTool(sm, 'gsd_result', { sessionId: 'reg-sess-9' });
      assert.equal(out.isError, false, out.text);
      const payload = JSON.parse(out.text);
      assert.equal(payload.driver.outcome, 'orphan-alive');
      assert.equal(payload.projectDir, getSessionEntry(dirC, sm.registryPath)?.projectDir);
      assert.equal(payload.sessionId, 'reg-sess-9');
    });
    assert.deepEqual(nonZeroSignals(sm), []);
  });
});

// ---------------------------------------------------------------------------
// WR-02 (41-REVIEW.md): rows are bound to the driver pid
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - WR-02 pid-bound row ownership', () => {
  const PEER_PID = 70001;

  function seedPeerRow(sm: TestableSessionManager, projectDir: string): void {
    sm.alivePids.add(PEER_PID);
    registerSessionEntry(
      {
        sessionId: 'peer-session',
        projectDir,
        pid: PEER_PID,
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: 999999,
      },
      sm.registryPath,
    );
  }

  it('WR-02 a failed start never deletes a peer server\'s live row for the same worktree', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr02-fail');

    let release!: () => void;
    sm.nextInitGate = new Promise<void>((r) => {
      release = r;
    });
    sm.nextInitError = new Error('init boom');
    const startPromise = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const settled = assert.rejects(startPromise, /Failed to start session/);
    await new Promise((r) => setImmediate(r));

    // A peer MCP server wins the row while our init() is still pending.
    seedPeerRow(sm, projectDir);
    release();
    await settled;

    assert.equal(sm.lastClient!.stopped, true);
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, PEER_PID, 'peer row must survive our cleanup');
  });

  it('WR-02 refuses to register over a live peer row and stops its own driver', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr02-overwrite');

    let release!: () => void;
    sm.nextInitGate = new Promise<void>((r) => {
      release = r;
    });
    const startPromise = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const settled = assert.rejects(startPromise, /another live driver/);
    await new Promise((r) => setImmediate(r));

    // Overwrite the 'starting' row with the peer's (as a racing peer would).
    seedPeerRow(sm, projectDir);
    release();
    await settled;

    const ours = sm.lastClient!;
    assert.equal(ours.stopped, true, 'our un-registrable driver must be stopped');
    assert.equal(ours.prompted.length, 0, 'no prompt may be dispatched for it');
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, PEER_PID);
  });

  it('WR-02 a dead or tombstoned prior row is still superseded by a fresh registration', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr02-supersede');
    // Dead peer (not in alivePids) is reaped as stale on start, then superseded.
    registerSessionEntry(
      {
        sessionId: 'old',
        projectDir,
        pid: PEER_PID,
        startTime: new Date().toISOString(),
        status: 'running',
      },
      sm.registryPath,
    );

    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });

    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, sm.lastClient!.pid);
  });
});

// ---------------------------------------------------------------------------
// WR-06 (41-REVIEW.md): consistent tombstone / stop-before-drop teardown
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - WR-06 teardown consistency', () => {
  it('WR-06 natural completion keeps the row until the child stop is confirmed', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr06-complete');
    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;

    let openGate!: () => void;
    client.stopGate = new Promise<void>((r) => {
      openGate = r;
    });
    client.emitEvent({ type: 'extension_ui_request', method: 'notify', message: 'auto-mode complete' });
    await new Promise((r) => setImmediate(r));

    assert.equal(client.stopped, false, 'stop is still pending');
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, client.pid, 'row must outlive the pending stop');

    openGate();
    await new Promise((r) => setImmediate(r));
    assert.equal(client.stopped, true);
    assert.equal(getSessionEntry(projectDir, sm.registryPath), undefined);
  });

  it('WR-06 gsd_cancel of an errored session keeps the exit tombstone and the error status', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr06-cancel');
    const sessionId = await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const session = sm.getInternalSession(projectDir)!;
    const client = sm.lastClient!;
    // Drive the real unexpected-exit path: a tombstone + 'error' status.
    (client as unknown as { exitListeners: Array<(i: unknown) => void> }).exitListeners.forEach((l) =>
      l({ code: 9, signal: null, expected: false }),
    );
    assert.equal(session.status, 'error');
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.status, 'exited');

    await sm.cancelSession(sessionId);

    assert.equal(session.status, 'error', 'the death status must not be rewritten to cancelled');
    const row = getSessionEntry(projectDir, sm.registryPath);
    assert.equal(row?.status, 'exited');
    assert.equal(row?.exit?.code, 9);
  });

  it('WR-06 evicting a dead session keeps the tombstone until the replacement registers', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr06-evict');
    await sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    const client = sm.lastClient!;
    (client as unknown as { exitListeners: Array<(i: unknown) => void> }).exitListeners.forEach((l) =>
      l({ code: 2, signal: null, expected: false }),
    );

    let release!: () => void;
    sm.nextInitGate = new Promise<void>((r) => {
      release = r;
    });
    const restart = sm.startSession(projectDir, { cliPath: '/usr/bin/gsd' });
    await new Promise((r) => setImmediate(r));
    // The replacement is registered ('starting') by now, superseding the tombstone.
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.status, 'starting');
    release();
    await restart;
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.status, 'running');
  });
});

// ---------------------------------------------------------------------------
// WR-01 (41-REVIEW.md): read-path reconcile is failure-isolated
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - WR-01 reconcile failure isolation', () => {
  it('WR-01 a throwing registry reconcile degrades to the pre-existing not-found result', async () => {
    class ThrowingManager extends TestableSessionManager {
      override reconcileRegisteredDriver(): never {
        throw new Error('EACCES: registry boom');
      }
    }
    const sm = new ThrowingManager(join(tmp, 'session-instances.json'));
    await withBridgeDisabled(async () => {
      for (const tool of ['gsd_status', 'gsd_result']) {
        const out = await callTool(sm, tool, { sessionId: 'stale-z', projectDir: join(tmp, 'nowhere') });
        assert.equal(out.isError, true, tool);
        assert.match(out.text, /Session not found/, `${tool} must fall through, not surface the registry fault`);
        assert.doesNotMatch(out.text, /registry boom/);
      }
    });
  });

  it('WR-01 a failed tombstone write still reports the dead driver', { skip: process.getuid?.() === 0 }, async () => {
    const sm = createManager();
    const deadDir = join(tmp, 'proj-wr01-dead');
    mkdirSync(deadDir);
    registerSessionEntry(
      {
        sessionId: 'wr01-dead',
        projectDir: deadDir,
        pid: 42030,
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: 999999,
      },
      sm.registryPath,
    );
    chmodSync(tmp, 0o500); // the temp-file write for the tombstone now fails
    try {
      const result = sm.reconcileRegisteredDriver({ projectDir: deadDir });
      assert.equal(result.outcome, 'dead-reconciled');
      assert.equal(result.entry?.pid, 42030);
    } finally {
      chmodSync(tmp, 0o700);
    }
  });
});

// ---------------------------------------------------------------------------
// WR-07 (41-REVIEW.md): read tools validate projectDir before touching the registry
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - WR-07 allowed-root validation on read tools', () => {
  async function withProjectRoot<T>(root: string, fn: () => Promise<T>): Promise<T> {
    const savedRoot = process.env.GSD_WORKFLOW_PROJECT_ROOT;
    const savedDisable = process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE;
    process.env.GSD_WORKFLOW_PROJECT_ROOT = root;
    process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE = '1';
    try {
      return await fn();
    } finally {
      if (savedRoot === undefined) delete process.env.GSD_WORKFLOW_PROJECT_ROOT;
      else process.env.GSD_WORKFLOW_PROJECT_ROOT = savedRoot;
      if (savedDisable === undefined) delete process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE;
      else process.env.GSD_WORKFLOW_BRIDGE_TEST_DISABLE = savedDisable;
    }
  }

  it('WR-07 an out-of-root projectDir is refused and its dead row is NOT rewritten', async () => {
    const sm = createManager();
    const allowed = join(tmp, 'allowed');
    const outside = join(tmp, 'outside');
    mkdirSync(allowed);
    mkdirSync(outside);
    registerSessionEntry(
      { sessionId: 'out-sess', projectDir: outside, pid: 42040, startTime: new Date().toISOString(), status: 'running' },
      sm.registryPath,
    );

    await withProjectRoot(allowed, async () => {
      for (const tool of ['gsd_status', 'gsd_result']) {
        const byDir = await callTool(sm, tool, { sessionId: 'stale', projectDir: outside });
        assert.equal(byDir.isError, true, tool);
        assert.match(byDir.text, /must stay within the configured workflow project root/);

        const bySession = await callTool(sm, tool, { sessionId: 'out-sess' });
        assert.equal(bySession.isError, true, tool);
        assert.match(bySession.text, /must stay within the configured workflow project root/);
      }
    });

    const row = getSessionEntry(outside, sm.registryPath);
    assert.equal(row?.exit, undefined, 'the read must not tombstone a row outside the allowed root');
    assert.equal(row?.status, 'running');
  });

  it('WR-07 an in-root projectDir still reconciles', async () => {
    const sm = createManager();
    const allowed = join(tmp, 'allowed-ok');
    const inside = join(allowed, 'proj');
    mkdirSync(inside, { recursive: true });
    liveRow(sm, inside, 42041, 'in-sess');

    await withProjectRoot(allowed, async () => {
      const out = await callTool(sm, 'gsd_status', { sessionId: 'stale', projectDir: inside });
      assert.equal(out.isError, false, out.text);
      assert.equal(JSON.parse(out.text).driver.outcome, 'orphan-alive');
    });
  });
});

// ---------------------------------------------------------------------------
// IN-01 (41-REVIEW.md): payload honesty
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - IN-01 reconciled payload honesty', () => {
  it('IN-01 reports the row\'s sessionId and the caller\'s id separately; a tracked row is not "untracked"', async () => {
    const sm = createManager();
    const dirA = join(tmp, 'proj-in01-a');
    const dirB = join(tmp, 'proj-in01-b');
    mkdirSync(dirA);
    mkdirSync(dirB);
    await sm.startSession(dirA, { cliPath: '/usr/bin/gsd' });
    const clientA = sm.lastClient!;
    await sm.startSession(dirB, { cliPath: '/usr/bin/gsd' });
    // The registry row for A carries an id this process's session does not.
    registerSessionEntry(
      {
        sessionId: 'registry-id-a',
        projectDir: dirA,
        pid: clientA.pid!,
        startTime: new Date().toISOString(),
        status: 'running',
        ownerPid: process.pid,
      },
      sm.registryPath,
    );

    await withBridgeDisabled(async () => {
      const out = await callTool(sm, 'gsd_status', { sessionId: 'registry-id-a' });
      assert.equal(out.isError, false, out.text);
      const payload = JSON.parse(out.text);
      assert.equal(payload.driver.outcome, 'tracked');
      assert.equal(payload.status, 'tracked');
      assert.equal(payload.sessionId, 'registry-id-a');
      assert.equal(payload.requestedSessionId, 'registry-id-a');
      assert.match(payload.note, /tracks a session for this projectDir/);
    });
  });

  it('IN-01 a stale caller sessionId is not echoed as the row\'s id', async () => {
    const sm = createManager();
    const dir = join(tmp, 'proj-in01-stale');
    mkdirSync(dir);
    liveRow(sm, dir, 42050, 'real-row-id');

    await withBridgeDisabled(async () => {
      const out = await callTool(sm, 'gsd_status', { sessionId: 'stale-caller-id', projectDir: dir });
      const payload = JSON.parse(out.text);
      assert.equal(payload.sessionId, 'real-row-id');
      assert.equal(payload.requestedSessionId, 'stale-caller-id');
      assert.equal(payload.status, 'untracked');
    });
  });
});

// ---------------------------------------------------------------------------
// WR-03 (41-REVIEW.md): registry-authorised kill needs verifiable identity
// ---------------------------------------------------------------------------

describe('Phase 41 driver registry lifecycle - WR-03 unverifiable-identity kill', () => {
  it('WR-03 cancel refuses to signal a pid it cannot identify and keeps the row', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr03');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 43001, 'wr03-sess');
    sm.procStartTime = null; // no `ps`: start-time guard cannot verify
    sm.procCwd = null; // and the cwd is unreadable

    await withoutProjectRoot(async () => {
      await assert.rejects(() => sm.cancelSessionByDir(projectDir), /cannot verify that pid 43001/);
    });

    assert.deepEqual(nonZeroSignals(sm), [], 'an unidentifiable pid must never be signalled');
    assert.equal(getSessionEntry(projectDir, sm.registryPath)?.pid, 43001, 'row kept for retry');
  });

  it('WR-03 cancel proceeds when an unverifiable start time is corroborated by the process cwd', async () => {
    const sm = createManager();
    const projectDir = join(tmp, 'proj-wr03-ok');
    mkdirSync(projectDir);
    liveRow(sm, projectDir, 43002, 'wr03-ok-sess');
    sm.procStartTime = null;
    sm.procCwd = realpathSync.native(projectDir);

    await withoutProjectRoot(async () => {
      await sm.cancelSessionByDir(projectDir);
    });

    assert.ok(sm.killedPids.some((k) => k.pid === 43002 && k.signal === 'SIGTERM'));
    assert.equal(getSessionEntry(projectDir, sm.registryPath), undefined);
  });
});
