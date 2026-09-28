/**
 * TRACK-005 / RELY-04 (Phase 32, D-01/D-02): stale-dist two-signal guard.
 *
 * ensureExistingWorkflowDbOpen's rethrowing "schema-too-new" branch must
 * distinguish a stale dist/ build (checked-out source already supports this
 * schema -- warn to stderr and degrade instead of throwing) from a genuinely
 * newer-than-supported schema (still throw the unchanged SchemaTooNewError,
 * SC-3). The second signal is a freshly loaded source-tree SCHEMA_VERSION,
 * independent of the SCHEMA_VERSION this process itself was compiled from --
 * exercised here through the injectable `loadSourceSchemaVersion` seam, the
 * same injection style read-cli.ts's ReadCliSchemaPreflight established for
 * the analogous "read seam vs compiled binary" divergence problem.
 *
 * All fixture DB versions are derived from the real SCHEMA_VERSION export
 * (never a bare integer literal) so this file passes
 * schema-version-literal-drift.test.ts's standing anti-drift guards once
 * registered there (D-02).
 */

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ensureExistingWorkflowDbOpen } from "../resources/extensions/gsd/state/derive/db-open.ts";
import { closeDatabase, openDatabase, _getAdapter } from "../resources/extensions/gsd/gsd-db.ts";
import { recordSchemaVersion } from "../resources/extensions/gsd/db-schema-metadata.ts";
import { SCHEMA_VERSION, SchemaTooNewError } from "../resources/extensions/gsd/db/engine.ts";

const STALE_DB_VERSION = SCHEMA_VERSION + 1;
const STALE_SOURCE_VERSION = SCHEMA_VERSION + 2;
const BOUNDARY_VERSION = SCHEMA_VERSION + 1;
const GENUINELY_NEWER_DB_VERSION = SCHEMA_VERSION + 2;
const GENUINELY_NEWER_SOURCE_VERSION = SCHEMA_VERSION + 1;
const PROBE_FAILURE_DB_VERSION = SCHEMA_VERSION + 1;

const EXPECTED_HARD_BLOCK_MESSAGE = new SchemaTooNewError(GENUINELY_NEWER_DB_VERSION, SCHEMA_VERSION).message;

function makeProject(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-stale-dist-guard-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  writeFileSync(
    join(base, ".gsd", "STATE.md"),
    "# Project State\n\n**Phase:** planning\n",
  );
  return base;
}

function stampDbVersion(base: string, version: number): void {
  assert.equal(openDatabase(join(base, ".gsd", "gsd.db")), true);
  const db = _getAdapter();
  assert.ok(db);
  recordSchemaVersion(db, version);
  closeDatabase();
}

async function captureStderr<T>(fn: () => Promise<T>): Promise<{ result: T; stderr: string }> {
  let stderr = "";
  const original = process.stderr.write;
  process.stderr.write = ((chunk: unknown) => {
    stderr += String(chunk);
    return true;
  }) as typeof process.stderr.write;
  try {
    const result = await fn();
    return { result, stderr };
  } finally {
    process.stderr.write = original;
  }
}

test("stale dist (dbVersion between distVersion and sourceVersion): warns and degrades instead of throwing", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, STALE_DB_VERSION);

    const { result, stderr } = await captureStderr(() =>
      ensureExistingWorkflowDbOpen(base, {
        loadSourceSchemaVersion: async () => STALE_SOURCE_VERSION,
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.staleDist, "expected a staleDist descriptor on ok:false");
    if (!result.ok && result.staleDist) {
      assert.equal(result.staleDist.currentVersion, STALE_DB_VERSION);
      assert.equal(result.staleDist.supportedVersion, SCHEMA_VERSION);
    }
    assert.ok(
      stderr.includes("dist/ is stale -- the checked-out source already supports this schema"),
      `stderr should carry the rebuild diagnosis, got: ${stderr}`,
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("boundary case dbVersion === sourceVersion: still stale, not hard-blocked (<=, not <)", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, BOUNDARY_VERSION);

    const { result, stderr } = await captureStderr(() =>
      ensureExistingWorkflowDbOpen(base, {
        loadSourceSchemaVersion: async () => BOUNDARY_VERSION,
      }),
    );

    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.staleDist, "expected a staleDist descriptor at the exact dbVersion===sourceVersion boundary");
    assert.ok(stderr.includes("dist/ is stale"));
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("genuinely newer than source too (dbVersion > sourceVersion): still throws the unchanged SchemaTooNewError", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, GENUINELY_NEWER_DB_VERSION);

    await assert.rejects(
      () =>
        ensureExistingWorkflowDbOpen(base, {
          loadSourceSchemaVersion: async () => GENUINELY_NEWER_SOURCE_VERSION,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).name, "GSDSchemaTooNewError");
        assert.equal((err as Error).message, EXPECTED_HARD_BLOCK_MESSAGE);
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("source-version probe throws: fails safe to the existing hard block, never treated as stale", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, PROBE_FAILURE_DB_VERSION);

    await assert.rejects(
      () =>
        ensureExistingWorkflowDbOpen(base, {
          loadSourceSchemaVersion: async () => {
            throw new Error("source-tree probe unavailable for this test");
          },
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).name, "GSDSchemaTooNewError");
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("source-version probe resolves to a non-number: fails safe to the existing hard block", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, PROBE_FAILURE_DB_VERSION);

    await assert.rejects(
      () =>
        ensureExistingWorkflowDbOpen(base, {
          // Injected seam is typed as () => Promise<number>; a misbehaving
          // real-world probe resolving to NaN must still fail closed.
          loadSourceSchemaVersion: async () => Number.NaN,
        }),
      (err: unknown) => {
        assert.ok(err instanceof Error);
        assert.equal((err as Error).name, "GSDSchemaTooNewError");
        return true;
      },
    );
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("current schema (dbVersion === distVersion): normal open, probe never invoked", async () => {
  const base = makeProject();
  try {
    stampDbVersion(base, SCHEMA_VERSION);

    let probeInvoked = false;
    const { result, stderr } = await captureStderr(() =>
      ensureExistingWorkflowDbOpen(base, {
        loadSourceSchemaVersion: async () => {
          probeInvoked = true;
          return SCHEMA_VERSION;
        },
      }),
    );

    assert.deepEqual(result, { ok: true });
    assert.equal(stderr, "");
    assert.equal(probeInvoked, false, "the source-version probe must never run on the common/hot path");
  } finally {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  }
});
