// GSD MCP Server — GSD-alert-bot needs_input producer tests

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { emitNeedsInputAlert, resolveAlertEmitBin } from './alert-bot.js';
import { askUserQuestionsHandler } from './server.js';

type Spawned = { bin: string; argv: string[]; opts: unknown; unrefed: boolean };

function recorder() {
  const calls: Spawned[] = [];
  const spawnFn = (bin: string, argv: string[], opts: unknown) => {
    const rec: Spawned = { bin, argv, opts, unrefed: false };
    calls.push(rec);
    return { unref: () => { rec.unrefed = true; }, on: () => undefined };
  };
  return { calls, spawnFn };
}

const QUESTIONS = [{ question: 'Ship the M002 plan?' }];

describe('emitNeedsInputAlert', () => {
  it('emits needs_input with the host-provided project when the query is unattended', () => {
    const { calls, spawnFn } = recorder();
    emitNeedsInputAlert(QUESTIONS, {
      env: { GSD_UNATTENDED: '1', GSD_ALERT_PROJECT: 'blackjack' },
      resolveBin: () => '/bin/gsd-alert-emit',
      spawnFn,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0].bin, '/bin/gsd-alert-emit');
    assert.deepEqual(calls[0].argv, [
      '--source', 'y-pi-gsd',
      '--project', 'blackjack',
      '--event', 'needs_input',
      '--severity', 'loud',
      '--title', 'Ship the M002 plan?',
      '--dedup-key', 'needs_input:Ship the M002 plan?',
    ]);
    assert.deepEqual(calls[0].opts, { detached: true, stdio: 'ignore' });
    assert.equal(calls[0].unrefed, true);
  });

  it('stays silent when the host did not mark the query unattended (e.g. Claude Code sessions)', () => {
    const { calls, spawnFn } = recorder();
    emitNeedsInputAlert(QUESTIONS, { env: {}, resolveBin: () => '/bin/x', spawnFn });
    emitNeedsInputAlert(QUESTIONS, { env: { GSD_UNATTENDED: '0' }, resolveBin: () => '/bin/x', spawnFn });
    assert.equal(calls.length, 0);
  });

  it('honours the operator opt-out (GSD_ALERT_BOT=0)', () => {
    const { calls, spawnFn } = recorder();
    emitNeedsInputAlert(QUESTIONS, {
      env: { GSD_UNATTENDED: '1', GSD_ALERT_BOT: '0' },
      resolveBin: () => '/bin/x',
      spawnFn,
    });
    assert.equal(calls.length, 0);
  });

  it('is a no-op when gsd-alert-emit is not installed', () => {
    const { calls, spawnFn } = recorder();
    emitNeedsInputAlert(QUESTIONS, { env: { GSD_UNATTENDED: '1' }, resolveBin: () => null, spawnFn });
    assert.equal(calls.length, 0);
  });

  it('falls back to the workflow project root basename when no project is injected', () => {
    const { calls, spawnFn } = recorder();
    emitNeedsInputAlert([], {
      env: { GSD_UNATTENDED: '1', GSD_WORKFLOW_PROJECT_ROOT: '/home/u/Projects/my-app' },
      resolveBin: () => '/bin/x',
      spawnFn,
    });
    assert.equal(calls[0].argv[3], 'my-app');
    assert.equal(calls[0].argv[9], 'Question waiting for an answer');
  });

  it('swallows spawn failures', () => {
    assert.doesNotThrow(() => emitNeedsInputAlert(QUESTIONS, {
      env: { GSD_UNATTENDED: '1' },
      resolveBin: () => '/bin/x',
      spawnFn: () => { throw new Error('ENOENT'); },
    }));
  });
});

describe('resolveAlertEmitBin', () => {
  it('finds an executable gsd-alert-emit on PATH, and never under a test runner or GSD_ALERT_DISABLE=1', () => {
    const dir = mkdtempSync(join(tmpdir(), 'alert-emit-'));
    try {
      const bin = join(dir, 'gsd-alert-emit');
      writeFileSync(bin, '#!/bin/sh\nexit 0\n');
      chmodSync(bin, 0o755);
      assert.equal(resolveAlertEmitBin({ PATH: dir }), bin);
      assert.equal(resolveAlertEmitBin({ PATH: dir, NODE_TEST_CONTEXT: 'child' }), null);
      assert.equal(resolveAlertEmitBin({ PATH: dir, VITEST: 'true' }), null);
      assert.equal(resolveAlertEmitBin({ PATH: dir, GSD_ALERT_DISABLE: '1' }), null);
      assert.equal(resolveAlertEmitBin({ PATH: '' }), null);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('askUserQuestionsHandler alert-bot wiring', () => {
  const questions = [
    {
      id: 'q1',
      header: 'Plan',
      question: 'Ship the M002 plan?',
      options: [
        { label: 'Yes', description: 'Go.' },
        { label: 'No', description: 'Stop.' },
      ],
    },
  ];
  const baseDeps = {
    isRemoteConfigured: () => false,
    tryRemoteQuestions: async () => null,
    writeGate: null,
  };

  it('tees the question exactly once, before elicitation', async () => {
    const order: string[] = [];
    await askUserQuestionsHandler(questions, undefined, {
      ...baseDeps,
      alertNeedsInput: (qs) => { order.push(`alert:${qs[0].question}`); },
      async elicitInput() {
        order.push('elicit');
        return { action: 'accept', content: { q1: 'Yes' } };
      },
    });
    assert.deepEqual(order, ['alert:Ship the M002 plan?', 'elicit']);
  });

  it('still answers the question when the alert emitter throws', async () => {
    const result = await askUserQuestionsHandler(questions, undefined, {
      ...baseDeps,
      alertNeedsInput: () => { throw new Error('boom'); },
      async elicitInput() {
        return { action: 'accept', content: { q1: 'Yes' } };
      },
    });
    assert.match(result.content[0]?.text ?? '', /"q1"/);
  });

  it('does not alert for an invalid payload', async () => {
    let alerts = 0;
    await askUserQuestionsHandler([{ ...questions[0], options: [] }], undefined, {
      ...baseDeps,
      alertNeedsInput: () => { alerts++; },
      async elicitInput() {
        return { action: 'accept', content: {} };
      },
    });
    assert.equal(alerts, 0);
  });
});
