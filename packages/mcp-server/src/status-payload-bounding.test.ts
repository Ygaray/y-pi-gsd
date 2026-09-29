/**
 * Regression test for RELY-07 / INC-2026-09-29-02 (Phase 34 security audit).
 *
 * Defect: the status-flood guard (`projectRecentEvents` — drops streaming
 * `toolcall_delta`/`text_delta`/`thinking_delta` fragments and caps each
 * event's serialized payload size via `boundEventPayload`) was wired into
 * `SessionManager.getResult()` only, which backs the `gsd_result` tool. The
 * `gsd_status` tool — the one actually polled during the original
 * status-flood incident — is served by `getSessionStatusPayload()` in
 * server.ts, which returned the raw, unbounded `session.events.slice(-10)`.
 * So the original flood (one session's status re-emitted 3.7 KB -> 47 KB
 * payloads across repeated polls) could still occur through `gsd_status`.
 *
 * This test exercises `getSessionStatusPayload` directly — the `gsd_status`
 * path — with a `ManagedSession` whose events contain raw streaming deltas
 * and an oversized tool-call payload, and asserts both are bounded exactly
 * like the existing `gsd_result` regression test in mcp-server.test.ts.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getSessionStatusPayload } from './server.js';
import type { ManagedSession } from './types.js';

function makeSession(events: ManagedSession['events']): ManagedSession {
  return {
    sessionId: 'status-flood-session',
    projectDir: '/tmp/status-flood-session',
    status: 'running',
    client: {} as ManagedSession['client'],
    events,
    pendingBlocker: null,
    cost: { totalCost: 0, tokens: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } },
    startTime: Date.now(),
  };
}

describe('getSessionStatusPayload (gsd_status path) — RELY-07 / INC-2026-09-29-02', () => {
  it('excludes raw toolcall_delta streaming fragments from recentEvents', () => {
    const session = makeSession([
      { type: 'toolcall_start', contentIndex: 1 } as unknown as ManagedSession['events'][number],
      ...Array.from({ length: 5 }, (_, i) => (
        { type: 'toolcall_delta', contentIndex: 1, delta: `/yahir/blackj${i}` } as unknown as ManagedSession['events'][number]
      )),
      {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: { id: 'call-1', name: 'read_file', arguments: '{"path":"/yahir/blackjack.ts"}' },
      } as unknown as ManagedSession['events'][number],
    ]);

    const payload = getSessionStatusPayload(session);
    const types = (payload.recentEvents as Array<Record<string, unknown>>).map((e) => e.type);

    assert.ok(
      !types.includes('toolcall_delta'),
      `expected no raw toolcall_delta fragments in recentEvents, got: ${JSON.stringify(types)}`,
    );
    assert.ok(types.includes('toolcall_end'));
  });

  it('bounds oversized event payloads with an elided-bytes marker', () => {
    const hugeArgs = 'x'.repeat(50_000);
    const session = makeSession([
      {
        type: 'toolcall_end',
        contentIndex: 0,
        toolCall: { id: 'call-huge', name: 'write_file', arguments: hugeArgs },
      } as unknown as ManagedSession['events'][number],
    ]);

    const payload = getSessionStatusPayload(session);
    const serialized = JSON.stringify(payload.recentEvents);

    assert.ok(
      serialized.length < 10_000,
      `expected recentEvents payload to be bounded, got ${serialized.length} bytes`,
    );
    assert.match(serialized, /elided/);
  });
});
