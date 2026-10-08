/**
 * @opengsd/mcp-server — durable session registry (INC-2026-09-29-02 fix 3
 * Option B).
 *
 * Unit tests for the persistence primitives: register/read/remove, corrupt
 * file tolerance, and pid-liveness gated by the start-time guard against pid
 * reuse. SessionManager's use of these primitives (the actual orphan-dedup
 * behavior across a simulated server restart) is covered separately in
 * session-orphan-dedup.test.ts.
 */

import { describe, test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

import {
  getSessionEntry,
  isOrphanEntryAlive,
  killOrphanSessionPid,
  readSessionRegistry,
  registerSessionEntry,
  removeSessionEntry,
  type SessionRegistryEntry,
} from './session-persist.js';

let tmp: string;
let registryPath: string;

beforeEach(() => {
  tmp = mkdtempSync(join(tmpdir(), 'mcp-session-persist-'));
  registryPath = join(tmp, 'session-instances.json');
});

afterEach(() => {
  rmSync(tmp, { recursive: true, force: true });
});

function makeEntry(overrides: Partial<SessionRegistryEntry> = {}): SessionRegistryEntry {
  return {
    sessionId: 'sess-001',
    projectDir: join(tmp, 'project'),
    pid: 12345,
    startTime: new Date().toISOString(),
    status: 'running',
    ...overrides,
  };
}

describe('readSessionRegistry', () => {
  test('returns empty object when file does not exist', () => {
    assert.deepEqual(readSessionRegistry(registryPath), {});
  });

  test('returns parsed content when file exists', () => {
    const entry = makeEntry();
    writeFileSync(registryPath, JSON.stringify({ [entry.projectDir]: entry }));
    const reg = readSessionRegistry(registryPath);
    assert.deepEqual(reg[entry.projectDir], entry);
  });

  test('returns empty object on corrupt JSON, preserving a backup', () => {
    writeFileSync(registryPath, 'not json');
    const reg = readSessionRegistry(registryPath);
    assert.deepEqual(reg, {});
    const backups = readdirSync(tmp).filter((f) => f.startsWith('session-instances.json.corrupt-'));
    assert.equal(backups.length, 1, 'expected a single .corrupt- backup');
    assert.equal(readFileSync(join(tmp, backups[0]), 'utf8'), 'not json');
  });

  test('returns empty object on a non-object JSON payload', () => {
    writeFileSync(registryPath, JSON.stringify([1, 2, 3]));
    assert.deepEqual(readSessionRegistry(registryPath), {});
  });
});

describe('registerSessionEntry / getSessionEntry / removeSessionEntry', () => {
  test('registers and reads back an entry keyed by resolved projectDir', () => {
    const entry = makeEntry();
    registerSessionEntry(entry, registryPath);
    const found = getSessionEntry(entry.projectDir, registryPath);
    assert.deepEqual(found, entry);
  });

  test('overwrites an existing entry for the same projectDir', () => {
    const entry = makeEntry({ pid: 111 });
    registerSessionEntry(entry, registryPath);
    registerSessionEntry({ ...entry, pid: 222 }, registryPath);
    assert.equal(getSessionEntry(entry.projectDir, registryPath)?.pid, 222);
  });

  test('preserves entries for other projects', () => {
    const entryA = makeEntry({ projectDir: join(tmp, 'a'), pid: 1 });
    const entryB = makeEntry({ projectDir: join(tmp, 'b'), pid: 2 });
    registerSessionEntry(entryA, registryPath);
    registerSessionEntry(entryB, registryPath);
    assert.equal(getSessionEntry(entryA.projectDir, registryPath)?.pid, 1);
    assert.equal(getSessionEntry(entryB.projectDir, registryPath)?.pid, 2);
  });

  test('getSessionEntry returns undefined for an unregistered projectDir', () => {
    assert.equal(getSessionEntry(join(tmp, 'nope'), registryPath), undefined);
  });

  test('removeSessionEntry deletes only the targeted projectDir entry', () => {
    const entryA = makeEntry({ projectDir: join(tmp, 'a'), pid: 1 });
    const entryB = makeEntry({ projectDir: join(tmp, 'b'), pid: 2 });
    registerSessionEntry(entryA, registryPath);
    registerSessionEntry(entryB, registryPath);

    removeSessionEntry(entryA.projectDir, registryPath);

    assert.equal(getSessionEntry(entryA.projectDir, registryPath), undefined);
    assert.equal(getSessionEntry(entryB.projectDir, registryPath)?.pid, 2);
  });

  test('removeSessionEntry on an absent entry is a safe no-op', () => {
    assert.doesNotThrow(() => removeSessionEntry(join(tmp, 'nope'), registryPath));
  });

  test('writes are atomic (no leftover .tmp- file after registration)', () => {
    registerSessionEntry(makeEntry(), registryPath);
    const leftovers = readdirSync(tmp).filter((f) => f.includes('.tmp-'));
    assert.deepEqual(leftovers, []);
  });
});

describe('Phase 41 canonical registry key (SC3)', () => {
  function makeAlias(): { real: string; link: string } {
    const real = join(tmp, 'real-worktree');
    const link = join(tmp, 'link-worktree');
    mkdirSync(real);
    symlinkSync(real, link);
    return { real, link };
  }

  test('canonical key: a symlink alias and its target share one registry row', () => {
    const { real, link } = makeAlias();
    registerSessionEntry(makeEntry({ projectDir: link, pid: 4001 }), registryPath);

    const viaTarget = getSessionEntry(real, registryPath);
    assert.ok(viaTarget, 'target spelling must find the alias-registered row');
    assert.equal(viaTarget.pid, 4001);

    const keys = Object.keys(readSessionRegistry(registryPath));
    assert.deepEqual(keys, [realpathSync.native(real)]);
    assert.equal(viaTarget.projectDir, keys[0]);
  });

  test('legacy resolve-keyed row is still found, migrated on register, and removed', () => {
    const { real, link } = makeAlias();
    const legacyKey = resolve(link);
    const legacy = makeEntry({ projectDir: legacyKey, pid: 4002 });

    // Found: hand-written pre-phase row keyed by resolve(link).
    writeFileSync(registryPath, JSON.stringify({ [legacyKey]: legacy }));
    assert.equal(getSessionEntry(link, registryPath)?.pid, 4002);
    assert.equal(getSessionEntry(real, registryPath), undefined, 'target spelling has a different legacy key');

    // Migrated: registering replaces the legacy key with the canonical one.
    registerSessionEntry(makeEntry({ projectDir: link, pid: 4003 }), registryPath);
    assert.deepEqual(Object.keys(readSessionRegistry(registryPath)), [realpathSync.native(real)]);
    assert.equal(getSessionEntry(real, registryPath)?.pid, 4003);

    // Removed: a re-written legacy row is deleted by removeSessionEntry.
    writeFileSync(registryPath, JSON.stringify({ [legacyKey]: legacy }));
    removeSessionEntry(link, registryPath);
    assert.deepEqual(readSessionRegistry(registryPath), {});
  });
});

describe('isOrphanEntryAlive — pid-liveness with start-time guard', () => {
  test('returns false for an invalid pid (0)', () => {
    assert.equal(isOrphanEntryAlive(makeEntry({ pid: 0 })), false);
  });

  test('returns false when the signal reports the pid is dead (ESRCH)', () => {
    const entry = makeEntry({ pid: 99999 });
    const alive = isOrphanEntryAlive(entry, {
      kill() {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
    });
    assert.equal(alive, false);
  });

  test('returns true when the pid is alive and start times align (genuine orphan)', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const entry = makeEntry({ pid: 4242, startTime: recordedAt.toISOString() });
    const alive = isOrphanEntryAlive(entry, {
      kill() {
        /* alive — no throw */
      },
      getProcessStartTime() {
        // Actual process started a few seconds before we recorded the entry —
        // well within tolerance.
        return recordedAt.getTime() - 5_000;
      },
    });
    assert.equal(alive, true);
  });

  test('returns false when the live pid started materially AFTER the recorded time (pid reuse)', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const entry = makeEntry({ pid: 4242, startTime: recordedAt.toISOString() });
    const alive = isOrphanEntryAlive(entry, {
      kill() {
        /* alive — no throw */
      },
      getProcessStartTime() {
        // A different process claimed this recycled pid two minutes later.
        return recordedAt.getTime() + 120_000;
      },
    });
    assert.equal(alive, false);
  });

  test('tolerates a small clock-skew gap between recorded and actual start time', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const entry = makeEntry({ pid: 4242, startTime: recordedAt.toISOString() });
    const alive = isOrphanEntryAlive(entry, {
      kill() {},
      getProcessStartTime() {
        // 30s after recorded time — within the 60s skew tolerance.
        return recordedAt.getTime() + 30_000;
      },
    });
    assert.equal(alive, true);
  });

  test('treats an unknown actual start time (null) as tolerant — alive pid stays a candidate orphan', () => {
    const entry = makeEntry({ pid: 4242 });
    const alive = isOrphanEntryAlive(entry, {
      kill() {},
      getProcessStartTime() {
        return null;
      },
    });
    assert.equal(alive, true);
  });
});

describe('killOrphanSessionPid', () => {
  test('returns "invalid" for a non-safe pid', () => {
    assert.equal(killOrphanSessionPid(0, new Date().toISOString()), 'invalid');
  });

  test('returns "already-dead" when the initial liveness probe throws ESRCH', () => {
    const result = killOrphanSessionPid(555, new Date().toISOString(), {
      kill() {
        const err = new Error('no such process') as NodeJS.ErrnoException;
        err.code = 'ESRCH';
        throw err;
      },
    });
    assert.equal(result, 'already-dead');
  });

  test('refuses to signal a pid whose actual start time is materially after the recorded time (recycled pid)', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const result = killOrphanSessionPid(777, recordedAt.toISOString(), {
      kill(pid, signal) {
        signals.push({ pid, signal });
      },
      getProcessStartTime() {
        return recordedAt.getTime() + 120_000;
      },
    });
    assert.equal(result, 'invalid');
    // Only the initial liveness probe (signal 0) should have been sent — no
    // SIGTERM/SIGKILL against a process we never spawned.
    assert.deepEqual(signals, [{ pid: 777, signal: 0 }]);
  });

  test('sends SIGTERM then reports "killed" once the pid stops responding', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    let probeCount = 0;
    const result = killOrphanSessionPid(888, recordedAt.toISOString(), {
      kill(pid, signal) {
        signals.push({ pid, signal });
        if (signal === 0) {
          probeCount++;
          // First probe (pre-signal liveness check) succeeds; second probe
          // (post-SIGTERM liveness re-check inside isPidAlive) reports dead.
          if (probeCount > 1) {
            const err = new Error('no such process') as NodeJS.ErrnoException;
            err.code = 'ESRCH';
            throw err;
          }
        }
      },
      getProcessStartTime() {
        return recordedAt.getTime() - 1_000;
      },
      waitForExit() {
        /* no-op — skip the real timer wait in tests */
      },
    });
    assert.equal(result, 'killed');
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'));
    assert.ok(!signals.some((s) => s.signal === 'SIGKILL'));
  });

  test('escalates to SIGKILL and reports "force-killed" when SIGTERM does not stop the pid', () => {
    const recordedAt = new Date('2026-09-29T10:00:00.000Z');
    const signals: Array<{ pid: number; signal: NodeJS.Signals | 0 | undefined }> = [];
    const result = killOrphanSessionPid(999, recordedAt.toISOString(), {
      kill(pid, signal) {
        signals.push({ pid, signal });
        // Every probe/signal succeeds — pid never reports dead until SIGKILL,
        // which this mock also just records without throwing.
      },
      getProcessStartTime() {
        return recordedAt.getTime() - 1_000;
      },
      waitForExit() {},
    });
    assert.equal(result, 'force-killed');
    assert.ok(signals.some((s) => s.signal === 'SIGTERM'));
    assert.ok(signals.some((s) => s.signal === 'SIGKILL'));
  });
});
