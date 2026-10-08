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
import { mkdtempSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { SessionManager, type OrphanReapOutcome } from './session-manager.js';
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

  async stop(): Promise<void> {
    this.stopped = true;
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

  onExit(_listener: (info: { code: number | null; signal: NodeJS.Signals | null; expected: boolean }) => void): () => void {
    return () => {};
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

  constructor(registryPath: string) {
    super();
    this.registryPath = registryPath;
  }

  protected override createClient(options: { cliPath: string; cwd: string; args: string[] }): RpcClient {
    this.sessionCounter++;
    const client = new MockRpcClient(options);
    client.initSessionId = `mock-session-${String(this.sessionCounter).padStart(3, '0')}`;
    client.pid = this.nextPid++;
    client.initGate = this.nextInitGate;
    client.initError = this.nextInitError;
    client.promptError = this.nextPromptError;
    this.nextInitGate = null;
    this.nextInitError = null;
    this.nextPromptError = null;
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
        this.alivePids.delete(pid);
      },
      getProcessStartTime: () => null,
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
    return this.reconcileResults.shift() ?? 'no-attempt';
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
});
