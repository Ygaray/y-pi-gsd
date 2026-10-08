/**
 * Regression tests for `resolveStatusSession` (INC-2026-09-29-02, part 1).
 *
 * Bug: when a `sessionId` is provided but doesn't match any tracked session
 * (e.g. stale after an MCP-server reconnect, or simply mismatched), the
 * function returned "Session not found" immediately — it never tried the
 * `getSessionByDir(projectDir)` / `getOnlySession()` fallbacks that the SAME
 * function already applies on the no-sessionId path. That made a perfectly
 * recoverable session look fatally lost.
 *
 * These tests exercise `resolveStatusSession` directly against a fake
 * SessionManager so they don't depend on spawning a real RpcClient.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import { mkdtempSync, rmSync } from 'node:fs';
import { SessionManager } from './session-manager.js';
import { registerSessionEntry } from './session-persist.js';
import { createMcpServer, resolveStatusSession } from './server.js';
import type { ManagedSession } from './types.js';

// ---------------------------------------------------------------------------
// Fake SessionManager — direct map insertion, no real RpcClient/process.
// ---------------------------------------------------------------------------

class FakeSessionManager extends SessionManager {
  /** Never read the operator's real ~/.gsd registry from a unit test. */
  protected override getSessionRegistryPath(): string | undefined {
    return join(tmpdir(), 'resolve-status-session-no-such-registry', 'session-instances.json');
  }

  /** Insert a session directly into the private sessions map for test setup. */
  putSession(projectDir: string, session: ManagedSession): void {
    (this as unknown as { sessions: Map<string, ManagedSession> }).sessions.set(
      resolve(projectDir),
      session,
    );
  }
}

function makeSession(overrides: Partial<ManagedSession> & { sessionId: string; projectDir: string }): ManagedSession {
  return {
    status: 'running',
    client: {} as ManagedSession['client'],
    events: [],
    pendingBlocker: null,
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    startTime: Date.now(),
    ...overrides,
  };
}

describe('resolveStatusSession (INC-2026-09-29-02)', () => {
  it('recovers via getSessionByDir when sessionId is stale but projectDir matches a tracked session', () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/resolve-status-session-by-dir';
    const tracked = makeSession({ sessionId: 'real-session-abc', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const result = resolveStatusSession(sm, { sessionId: 'stale-session-id', projectDir: dir });

    assert.equal(result.error, undefined);
    assert.equal(result.session, tracked);
  });

  it('recovers via getOnlySession when sessionId is stale, no projectDir given, and exactly one session is tracked', () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/resolve-status-session-only';
    const tracked = makeSession({ sessionId: 'real-session-xyz', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const result = resolveStatusSession(sm, { sessionId: 'stale-session-id' });

    assert.equal(result.error, undefined);
    assert.equal(result.session, tracked);
  });

  it('does NOT fall back to the sole tracked session when the supplied projectDir does not match it', () => {
    // Behaviour deliberately changed in Phase 41 (Pitfall 3): the old fallback
    // returned ANOTHER project's session for a stale sessionId + non-matching
    // projectDir, which hid the driver-registry reconcile for the requested dir.
    const sm = new FakeSessionManager();
    const dir = '/tmp/resolve-status-session-only-mismatched-dir';
    const tracked = makeSession({ sessionId: 'real-session-def', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const result = resolveStatusSession(sm, {
      sessionId: 'stale-session-id',
      projectDir: '/tmp/some-other-project-dir',
    });

    assert.equal(result.session, undefined);
    assert.match(result.error ?? '', /Session not found: stale-session-id/);
    assert.ok((result.error ?? '').includes('/tmp/some-other-project-dir'), result.error);
  });

  it('does NOT recover a session for a different project when multiple sessions are tracked (safety)', () => {
    const sm = new FakeSessionManager();
    const dirA = '/tmp/resolve-status-session-multi-a';
    const dirB = '/tmp/resolve-status-session-multi-b';
    sm.putSession(dirA, makeSession({ sessionId: 'session-a', projectDir: resolve(dirA) }));
    sm.putSession(dirB, makeSession({ sessionId: 'session-b', projectDir: resolve(dirB) }));

    const result = resolveStatusSession(sm, {
      sessionId: 'stale-session-id',
      projectDir: '/tmp/resolve-status-session-multi-nonexistent',
    });

    assert.equal(result.session, undefined);
    assert.match(result.error ?? '', /Session not found: stale-session-id/);
  });

  it('WR-05 does NOT return the sole tracked session for a stale sessionId the registry knows under another worktree', () => {
    const tmp = mkdtempSync(join(tmpdir(), 'resolve-status-wr05-'));
    try {
      class RegistryBackedManager extends FakeSessionManager {
        protected override getSessionRegistryPath(): string | undefined {
          return join(tmp, 'session-instances.json');
        }
      }
      const sm = new RegistryBackedManager();
      const dirX = '/tmp/resolve-status-wr05-x';
      const dirY = '/tmp/resolve-status-wr05-y';
      const tracked = makeSession({ sessionId: 'session-x', projectDir: resolve(dirX) });
      sm.putSession(dirX, tracked);
      registerSessionEntry(
        {
          sessionId: 'pre-restart-y',
          projectDir: dirY,
          pid: 42500,
          startTime: new Date().toISOString(),
          status: 'running',
        },
        join(tmp, 'session-instances.json'),
      );

      const foreign = resolveStatusSession(sm, { sessionId: 'pre-restart-y' });
      assert.equal(foreign.session, undefined, 'must not answer for project Y with project X');
      assert.match(foreign.error ?? '', /Session not found: pre-restart-y/);

      // An id the registry does not know keeps the sole-session recovery.
      const unknown = resolveStatusSession(sm, { sessionId: 'unknown-id' });
      assert.equal(unknown.session, tracked);

      // An id the registry maps to the tracked session's own worktree still resolves it.
      registerSessionEntry(
        {
          sessionId: 'old-x',
          projectDir: dirX,
          pid: 42501,
          startTime: new Date().toISOString(),
          status: 'running',
        },
        join(tmp, 'session-instances.json'),
      );
      assert.equal(resolveStatusSession(sm, { sessionId: 'old-x' }).session, tracked);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('still errors when sessionId is stale and no sessions are tracked at all', () => {
    const sm = new FakeSessionManager();
    const result = resolveStatusSession(sm, { sessionId: 'stale-session-id' });

    assert.equal(result.session, undefined);
    assert.match(result.error ?? '', /Session not found: stale-session-id/);
  });

  // -------------------------------------------------------------------------
  // Existing (no-sessionId) behavior must be preserved exactly.
  // -------------------------------------------------------------------------

  it('preserves existing no-sessionId + no-projectDir + empty-manager behavior', () => {
    const sm = new FakeSessionManager();
    const result = resolveStatusSession(sm, {});

    assert.equal(result.session, undefined);
    assert.match(result.error ?? '', /No tracked GSD sessions\. Call gsd_execute first/);
  });

  it('preserves existing projectDir-only lookup behavior', () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/resolve-status-session-dir-only';
    const tracked = makeSession({ sessionId: 'session-dir-only', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const result = resolveStatusSession(sm, { projectDir: dir });

    assert.equal(result.error, undefined);
    assert.equal(result.session, tracked);
  });
});

// ---------------------------------------------------------------------------
// gsd_result handler — same incident, second call site (INC-2026-09-29-02).
//
// gsd_result previously called `sessionManager.getResult(sessionId)` DIRECTLY,
// bypassing resolveStatusSession entirely. A stale/mismatched sessionId threw
// a hard "Session not found" even when the session was still recoverable via
// projectDir or as the sole tracked session — the exact path the incident's
// evidence was captured against.
// ---------------------------------------------------------------------------

describe('gsd_result tool handler (INC-2026-09-29-02)', () => {
  it('recovers via projectDir fallback when sessionId is stale, instead of hard-failing', async () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/gsd-result-stale-session-by-dir';
    const tracked = makeSession({ sessionId: 'real-session-result-1', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;
    assert.ok(resultTool, 'gsd_result should be registered');

    const result = await resultTool.handler({ sessionId: 'stale-session-id', projectDir: dir });

    assert.ok(!result.isError, `expected recovery, got error: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.sessionId, 'real-session-result-1');
  });

  it('recovers via getOnlySession fallback when sessionId is stale and no projectDir is given', async () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/gsd-result-stale-session-only';
    const tracked = makeSession({ sessionId: 'real-session-result-2', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;

    const result = await resultTool.handler({ sessionId: 'stale-session-id' });

    assert.ok(!result.isError, `expected recovery, got error: ${result.content?.[0]?.text}`);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.sessionId, 'real-session-result-2');
  });

  it('still errors when sessionId is stale and no recoverable session exists', async () => {
    const sm = new FakeSessionManager();
    const dirA = '/tmp/gsd-result-multi-a';
    const dirB = '/tmp/gsd-result-multi-b';
    sm.putSession(dirA, makeSession({ sessionId: 'session-a', projectDir: resolve(dirA) }));
    sm.putSession(dirB, makeSession({ sessionId: 'session-b', projectDir: resolve(dirB) }));

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;

    const result = await resultTool.handler({ sessionId: 'stale-session-id' });

    assert.ok(result.isError);
    assert.match(result.content[0].text, /Session not found: stale-session-id/);
  });

  it('returns the matching session result directly when sessionId is valid (no regression)', async () => {
    const sm = new FakeSessionManager();
    const dir = '/tmp/gsd-result-valid-session';
    const tracked = makeSession({ sessionId: 'real-session-valid', projectDir: resolve(dir) });
    sm.putSession(dir, tracked);

    const { server } = await createMcpServer(sm, { includeWorkflowTools: false });
    const resultTool = (server as any)._registeredTools?.gsd_result;

    const result = await resultTool.handler({ sessionId: 'real-session-valid' });

    assert.ok(!result.isError);
    const payload = JSON.parse(result.content[0].text);
    assert.equal(payload.sessionId, 'real-session-valid');
  });
});
