/**
 * DB-reconciling read path for `gsd_result` / `gsd_status`
 * (INC-2026-09-29-02, fix 3, Option A).
 *
 * Bug: when the in-memory session registry has no entry for a session
 * (e.g. after an MCP-server restart wiped it, or the session was simply
 * never tracked by this process instance), `gsd_result` / `gsd_status`
 * returned a fatal "Session not found" even though the canonical
 * Task/Attempt progress is durably recorded in `.gsd/gsd.db`. This left an
 * operator polling a restarted server with a dead end instead of real
 * progress.
 *
 * Fix: when `resolveStatusSession` misses AND a `projectDir` is given, fall
 * back to reconciling against the workflow database via the same bridge
 * `gsd_progress` already uses (`readProjectProgressViaBridge`). The
 * reconciled payload is unmistakably NOT a live session — `status:
 * 'untracked'`, `reconciledFromDb: true`, and a human-readable note — never
 * fabricated liveness.
 *
 * These tests seed a real `.gsd/gsd.db` via the actual mcp-bridge fixture
 * (same pattern as the `gsd_progress` DB-authoritative tests in
 * mcp-server.test.ts) so the reconciliation path is exercised against real
 * data, not a mock.
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { SessionManager } from './session-manager.js';
import { createMcpServer } from './server.js';

interface WorkflowBridgeFixtureModule {
  closeDatabase(): void;
  insertMilestone(milestone: { id: string; title: string; status: string }): boolean;
  insertSlice(slice: {
    id: string;
    milestoneId: string;
    title: string;
    status: string;
    risk: string;
    depends: string[];
    sequence: number;
  }): void;
  openDatabase(path: string): boolean;
}

async function importWorkflowBridgeFixture(): Promise<WorkflowBridgeFixtureModule> {
  const candidates = [
    '../../../src/resources/extensions/gsd/mcp-bridge.js',
    '../../../src/resources/extensions/gsd/mcp-bridge.ts',
    '../../../dist/resources/extensions/gsd/mcp-bridge.js',
  ];
  let lastError: unknown;
  for (const candidate of candidates) {
    try {
      return await import(new URL(candidate, import.meta.url).href) as WorkflowBridgeFixtureModule;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}

function restoreEnvironmentValue(name: string, value: string | undefined): void {
  if (value === undefined) delete process.env[name];
  else process.env[name] = value;
}

const workflowBridgeFixture = fileURLToPath(
  new URL('../test-fixtures/workflow-bridge.mjs', import.meta.url),
);

describe('gsd_result / gsd_status DB reconciliation (INC-2026-09-29-02 fix 3)', () => {
  let previousExecutorsModule: string | undefined;
  let previousWriteGateModule: string | undefined;

  beforeEach(() => {
    previousExecutorsModule = process.env.GSD_WORKFLOW_EXECUTORS_MODULE;
    previousWriteGateModule = process.env.GSD_WORKFLOW_WRITE_GATE_MODULE;
    process.env.GSD_WORKFLOW_EXECUTORS_MODULE = workflowBridgeFixture;
    process.env.GSD_WORKFLOW_WRITE_GATE_MODULE = workflowBridgeFixture;
  });

  afterEach(() => {
    restoreEnvironmentValue('GSD_WORKFLOW_EXECUTORS_MODULE', previousExecutorsModule);
    restoreEnvironmentValue('GSD_WORKFLOW_WRITE_GATE_MODULE', previousWriteGateModule);
  });

  it('gsd_result reconciles from the DB with a clear untracked marker when no in-memory session exists', async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-result-db-reconcile-'));
    const bridge = await importWorkflowBridgeFixture();
    t.after(() => {
      bridge.closeDatabase();
      rmSync(projectDir, { recursive: true, force: true });
    });
    mkdirSync(join(projectDir, '.gsd'));
    assert.equal(bridge.openDatabase(join(projectDir, '.gsd', 'gsd.db')), true);
    assert.equal(
      bridge.insertMilestone({ id: 'M001', title: 'Restart Survives Progress', status: 'active' }),
      true,
    );
    bridge.insertSlice({
      id: 'S01',
      milestoneId: 'M001',
      title: 'Reconciled Slice',
      status: 'pending',
      risk: 'low',
      depends: [],
      sequence: 1,
    });
    bridge.closeDatabase();

    const sm = new SessionManager(); // no session ever registered — the restart case
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;
    assert.ok(resultTool, 'gsd_result should be registered');

    const result = await resultTool.handler({ sessionId: 'session-lost-on-restart', projectDir });

    assert.ok(!result.isError, `expected DB-reconciled success, got error: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);

    // Unmistakable marker — never fabricated liveness.
    assert.equal(payload.status, 'untracked');
    assert.equal(payload.reconciledFromDb, true);
    assert.match(payload.note, /not.*live session|reconciled/i);

    // Echoes input identity, does not invent a live sessionId.
    assert.equal(payload.projectDir, projectDir);

    // Real progress, reconciled from the DB (same shape gsd_progress serves).
    assert.deepEqual(payload.progress.activeMilestone, { id: 'M001', title: 'Restart Survives Progress' });
    assert.equal(payload.progress.milestones.total, 1);
  });

  it('gsd_status reconciles from the DB with the same untracked marker when no in-memory session exists', async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-status-db-reconcile-'));
    const bridge = await importWorkflowBridgeFixture();
    t.after(() => {
      bridge.closeDatabase();
      rmSync(projectDir, { recursive: true, force: true });
    });
    mkdirSync(join(projectDir, '.gsd'));
    assert.equal(bridge.openDatabase(join(projectDir, '.gsd', 'gsd.db')), true);
    assert.equal(
      bridge.insertMilestone({ id: 'M002', title: 'Status Reconciled', status: 'active' }),
      true,
    );
    bridge.closeDatabase();

    const sm = new SessionManager();
    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const statusTool = (server as any)._registeredTools?.gsd_status;
    assert.ok(statusTool, 'gsd_status should be registered');

    const result = await statusTool.handler({ projectDir });

    assert.ok(!result.isError, `expected DB-reconciled success, got error: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);

    assert.equal(payload.status, 'untracked');
    assert.equal(payload.reconciledFromDb, true);
    assert.deepEqual(payload.progress.activeMilestone, { id: 'M002', title: 'Status Reconciled' });
  });

  it('falls through to the existing "Session not found" error when there is no DB either', async () => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-result-no-db-'));
    try {
      const sm = new SessionManager();
      const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
      const resultTool = (server as any)._registeredTools?.gsd_result;

      const result = await resultTool.handler({ sessionId: 'no-session-no-db', projectDir });

      assert.ok(result.isError);
      assert.match(result.content[0].text, /Session not found/);
    } finally {
      rmSync(projectDir, { recursive: true, force: true });
    }
  });

  it('a live in-memory session is still returned exactly as before (no DB fallback triggered)', async (t) => {
    const projectDir = mkdtempSync(join(tmpdir(), 'gsd-result-live-session-still-wins-'));
    const bridge = await importWorkflowBridgeFixture();
    t.after(() => {
      bridge.closeDatabase();
      rmSync(projectDir, { recursive: true, force: true });
    });
    mkdirSync(join(projectDir, '.gsd'));
    // Seed a DB too, to prove the live session takes priority over it.
    assert.equal(bridge.openDatabase(join(projectDir, '.gsd', 'gsd.db')), true);
    bridge.insertMilestone({ id: 'M003', title: 'Should Not Win', status: 'active' });
    bridge.closeDatabase();

    class FakeSessionManager extends SessionManager {
      putSession(dir: string, session: import('./types.js').ManagedSession): void {
        (this as unknown as { sessions: Map<string, import('./types.js').ManagedSession> }).sessions.set(
          dir,
          session,
        );
      }
    }

    const sm = new FakeSessionManager();
    const tracked: import('./types.js').ManagedSession = {
      sessionId: 'real-live-session',
      projectDir: resolve(projectDir),
      status: 'running',
      client: {} as import('./types.js').ManagedSession['client'],
      events: [],
      pendingBlocker: null,
      cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
      startTime: Date.now(),
    };
    sm.putSession(resolve(projectDir), tracked);

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;

    const result = await resultTool.handler({ sessionId: 'real-live-session', projectDir });

    assert.ok(!result.isError);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.sessionId, 'real-live-session');
    assert.equal(payload.reconciledFromDb, undefined);
    assert.equal(payload.status, 'running');
  });
});
