// Project/App: gsd-pi
// File Purpose: Real-process fault, restart, and contention proof for live legacy import restore.

import assert from "node:assert/strict";
import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  cpSync,
  existsSync,
  lstatSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Readable, Writable } from "node:stream";
import { afterEach, test } from "node:test";
import { fileURLToPath } from "node:url";

import { prepareLegacyImportBackup } from "../legacy-import-backup.ts";
import {
  applyLegacyImport,
  createLegacyImportApplicationIdentity,
  type LegacyImportApplicationInput,
} from "../legacy-import-application.ts";
import {
  _restoreLegacyImportLiveForTest,
  restoreLegacyImportLive,
  type LegacyImportLiveRestoreInput,
} from "../legacy-import-live-restore.ts";
import { createLegacyImportPreview } from "../legacy-import-preview.ts";
import { captureCurrentLegacyImportBaseSnapshot } from "../legacy-import-preview-base.ts";
import {
  assessLegacyImportRestore,
  LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
} from "../legacy-import-restore-assessment.ts";
import {
  _setMaintenanceLockHooksForTest,
  checkpointDatabase,
  getDatabaseReplacementPaths,
  openIsolatedDatabase,
  probeDbWritable,
  vacuumDatabase,
} from "../db/engine.ts";
import { _getAdapter, closeDatabase, insertDecision, openDatabase } from "../gsd-db.ts";
import { createLegacyImportCorpusSourceRoots } from "./helpers/legacy-import-corpus.ts";
import { openSqliteReadOnly } from "../sqlite-readonly.ts";

const CORPUS_ROOT = fileURLToPath(new URL("./__fixtures__/legacy-import-corpus/v1/", import.meta.url));
const CHILD_PATH = fileURLToPath(new URL("./legacy-import-live-restore-child.ts", import.meta.url));
const RESOLVER_PATH = fileURLToPath(new URL("./resolve-ts.mjs", import.meta.url));
const CHILD_DEADLINE_MS = 30_000;
// The four boundary-matrix tests below each iterate a 43-entry boundary matrix, spawning up to
// three real OS child processes per boundary. Measured standalone on 2026-09-24, before
// optimisation, this file took 373,551 ms end-to-end with 21 passing / 0 failing test cases.
// If this file goes quiet for a minute or more, that is expected:
// a busy worker process sustaining 20%+ CPU with no TAP output growth is real work in flight, not
// a hang. Only treat it as a hang if the worker process is near-0% CPU with no live child process
// — that combination is the actual deadlock signature; CPU-idle-with-no-child is the only thing
// that should motivate killing the run.
const BOUNDARY_TEST_TIMEOUT_MS = 300_000;
// Concurrency cap for the two boundary matrices that are safe to overlap (see
// prepareBoundaryCases/runBounded below): at most this many lanes run in flight, so at most this
// many child processes are spawned simultaneously. Lower this (never raise CHILD_DEADLINE_MS) if
// contention ever causes a child to hit its deadline under load.
const BOUNDARY_CONCURRENCY = 4;
const tempDirectories = new Set<string>();
const managedChildren = new Set<ManagedChild>();
let sequence = 0;
let childSequence = 0;

const CRASH_BOUNDARIES = [
  "after-claim-write",
  "after-claim-file-sync",
  "after-claim-publish",
  "after-claim-directory-sync",
  "after-intent",
  "after-candidate-copy",
  "after-candidate-sync",
  "after-candidate-verify",
  "after-stage",
  "before-final-assessment",
  "after-final-assessment",
  "after-checkpoint",
  "after-journal-mode",
  "after-active-close",
  "after-detach",
  "after-wal-removal",
  "after-shm-removal",
  "after-journal-removal",
  "before-database-publish",
  "after-database-publish",
  "after-live-parent-sync",
  "after-published-file-verify",
  "after-publish",
  "before-reopen-open",
  "after-reopen-open",
  "after-reopen-proof",
  "after-reopen",
  "after-quick-check",
  "after-integrity-check",
  "after-foreign-key-check",
  "after-base-verification",
  "before-receipt-commit",
  "after-receipt",
  "after-receipt-intent",
  "after-receipt-checkpoint",
  "after-database-sync",
  "after-terminal-assessment",
  "after-cleanup-claim-link",
  "after-cleanup-claim-verify",
  "after-cleanup-entries",
  "after-cleanup-intent",
  "after-cleanup-claim-unlink",
  "after-cleanup-directory",
  "after-cleanup",
] as const;

const RECOVERY_BOUNDARIES = [
  "after-recovery-copy",
  "after-recovery-sync",
  "after-recovery-intent",
  "after-checkpoint",
  "after-journal-mode",
  "after-active-close",
  "after-detach",
  "after-wal-removal",
  "after-shm-removal",
  "after-journal-removal",
  "before-database-publish",
  "after-recovery-publish",
  "after-live-parent-sync",
  "after-published-file-verify",
  "after-publish",
  "before-reopen-open",
  "after-reopen-open",
  "after-reopen-proof",
  "after-reopen",
  "after-quick-check",
  "after-integrity-check",
  "after-foreign-key-check",
  "after-base-verification",
  "before-receipt-commit",
  "after-receipt",
  "after-receipt-intent",
  "after-receipt-checkpoint",
  "after-database-sync",
  "after-terminal-assessment",
  "after-cleanup-claim-link",
  "after-cleanup-claim-verify",
  "after-cleanup-entries",
  "after-cleanup-intent",
  "after-cleanup-claim-unlink",
  "after-cleanup-directory",
  "after-cleanup",
] as const;

const MAINTENANCE_CLAIM_BOUNDARIES = [
  "after-maintenance-claim-write",
  "after-maintenance-claim-file-sync",
  "after-maintenance-claim-publish",
  "after-maintenance-claim-directory-sync",
  "after-maintenance-claim-temporary-unlink",
  "after-maintenance-claim-cleanup-directory-sync",
  "before-maintenance-claim-identity-proof",
] as const;

interface PreparedRestoreCase {
  workspace: string;
  databasePath: string;
  input: LegacyImportLiveRestoreInput;
}

interface ChildError {
  code: string;
  message: string;
  stage?: string;
  retryable?: boolean;
}

type ChildOutcome = { result: Record<string, unknown> } | { error: ChildError };

interface ChildClose {
  code: number | null;
  signal: NodeJS.Signals | null;
  outcome: ChildOutcome | null;
  stderr: string;
}

interface ManagedChild {
  process: ChildProcessByStdio<Writable, Readable, Readable>;
  ready: Promise<string>;
  closed: Promise<ChildClose>;
  release(): void;
}

function database(): NonNullable<ReturnType<typeof _getAdapter>> {
  const adapter = _getAdapter();
  assert.ok(adapter);
  return adapter;
}

function sha256(path: string): string {
  return `sha256:${createHash("sha256").update(readFileSync(path)).digest("hex")}`;
}

function assertRawDatabaseIsValid(databasePath: string): void {
  for (const suffix of ["-wal", "-shm", "-journal"]) {
    const sidecar = `${databasePath}${suffix}`;
    if (!existsSync(sidecar)) continue;
    const stat = lstatSync(sidecar);
    assert.equal(stat.isFile(), true);
    assert.equal(stat.isSymbolicLink(), false);
  }
  const connection = openSqliteReadOnly(databasePath);
  try {
    assert.deepEqual(connection.db.prepare("PRAGMA quick_check").all(), [{ quick_check: "ok" }]);
    assert.deepEqual(connection.db.prepare("PRAGMA integrity_check").all(), [{ integrity_check: "ok" }]);
    assert.deepEqual(connection.db.prepare("PRAGMA foreign_key_check").all(), []);
    const counts = connection.db.prepare(`
      SELECT
        (SELECT COUNT(*) FROM workflow_import_applications) AS applications,
        (SELECT COUNT(*) FROM workflow_import_restores) AS restores
    `).get();
    assert.ok(
      counts?.["applications"] === 1 && counts["restores"] === 0
      || counts?.["applications"] === 0 && counts["restores"] === 0
      || counts?.["applications"] === 0 && counts["restores"] === 1,
    );
  } finally {
    connection.db.close();
  }
}

function assertBaseDatabaseIsSelfContained(databasePath: string): void {
  const proofPath = `${databasePath}.base-proof-${childSequence}`;
  cpSync(databasePath, proofPath);
  const connection = openSqliteReadOnly(proofPath);
  try {
    assert.deepEqual(connection.db.prepare("PRAGMA quick_check").all(), [{ quick_check: "ok" }]);
    assert.deepEqual(connection.db.prepare(`
      SELECT COUNT(*) AS count FROM workflow_import_restores
    `).get(), { count: 1 });
  } finally {
    connection.db.close();
    rmSync(proofPath, { force: true });
  }
}

function prepareRestoreCase(): PreparedRestoreCase {
  sequence += 1;
  const workspace = realpathSync(mkdtempSync(join(tmpdir(), "gsd-live-restore-fault-")));
  tempDirectories.add(workspace);
  const source = join(workspace, "source");
  const backupDirectory = join(workspace, "backups");
  const databasePath = join(workspace, "canonical.sqlite");
  cpSync(join(CORPUS_ROOT, "gsd-nested", "source"), source, {
    recursive: true,
    dereference: false,
    verbatimSymlinks: true,
  });
  mkdirSync(backupDirectory);
  assert.equal(openDatabase(databasePath), true);
  const roots = createLegacyImportCorpusSourceRoots(source);
  const previewInput = { roots };
  const base = captureCurrentLegacyImportBaseSnapshot();
  const preview = createLegacyImportPreview(previewInput);
  const backup = prepareLegacyImportBackup({
    preview,
    base,
    roots,
    destination_directory: backupDirectory,
    label: "before-live-restore-fault",
  });
  const applicationInput: LegacyImportApplicationInput = {
    invocation: {
      idempotencyKey: `legacy-import/live-restore-fault-application-${sequence}`,
      sourceTransport: "internal",
      actorType: "agent",
      actorId: "live-restore-fault-test",
    },
    previewInput,
    preview,
    backup,
  };
  const applicationIdentityHash = createLegacyImportApplicationIdentity(
    applicationInput,
  ).applicationIdentityHash;
  applyLegacyImport(applicationInput);
  const consentRequired = assessLegacyImportRestore({ applicationIdentityHash, backup });
  assert.equal(consentRequired.decision, "restore-consent-required");
  const consent = {
    consentSchemaVersion: LEGACY_IMPORT_RESTORE_ASSESSMENT_CONSENT_SCHEMA_VERSION,
    decision: "proceed" as const,
    destructiveDatabaseRestore: true as const,
    evidenceHash: consentRequired.evidenceHash,
  };
  const assessment = assessLegacyImportRestore({ applicationIdentityHash, backup, consent });
  assert.equal(assessment.decision, "restore-eligible");
  return {
    workspace,
    databasePath,
    input: {
      invocation: {
        idempotencyKey: `legacy-import/live-restore-fault-${sequence}`,
        sourceTransport: "internal",
        actorType: "agent",
        actorId: "live-restore-fault-test",
      },
      applicationIdentityHash,
      backup,
      assessment,
      consent,
    },
  };
}

function spawnChild(
  prepared: PreparedRestoreCase,
  config: Record<string, unknown>,
  input: LegacyImportLiveRestoreInput = prepared.input,
): ManagedChild {
  childSequence += 1;
  const suffix = `${sequence}-${childSequence}`;
  const inputPath = join(prepared.workspace, `restore-input-${suffix}.json`);
  const configPath = join(prepared.workspace, `child-config-${suffix}.json`);
  writeFileSync(inputPath, JSON.stringify(input), "utf8");
  writeFileSync(configPath, JSON.stringify({
    databasePath: prepared.databasePath,
    inputPath,
    ...config,
  }), "utf8");
  const env = { ...process.env };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    "--import",
    RESOLVER_PATH,
    "--experimental-strip-types",
    CHILD_PATH,
    configPath,
  ], {
    cwd: process.cwd(),
    env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let resolveReady!: (boundary: string) => void;
  let rejectReady!: (error: Error) => void;
  let readyResolved = false;
  const ready = new Promise<string>((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  void ready.catch(() => {});
  child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
    stdout += chunk;
    const match = /^READY=(\{[^\n]+\})$/mu.exec(stdout);
    if (match && !readyResolved) {
      readyResolved = true;
      resolveReady(String((JSON.parse(match[1]!) as { boundary: unknown }).boundary));
    }
  });
  child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
    stderr += chunk;
  });
  const closed = new Promise<ChildClose>((resolve, reject) => {
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`live restore child timed out after ${CHILD_DEADLINE_MS}ms`));
    }, CHILD_DEADLINE_MS);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (!readyResolved) rejectReady(new Error(`child closed before READY: ${stderr || stdout}`));
      try {
        const finalLine = stdout.trim().split("\n").filter((line) => !line.startsWith("READY=")).at(-1);
        const outcome = finalLine ? JSON.parse(finalLine) as ChildOutcome : null;
        resolve({ code, signal, outcome, stderr });
      } catch (error) {
        reject(error);
      }
    });
  });
  const managedChild: ManagedChild = {
    process: child,
    ready,
    closed,
    release() {
      child.stdin.end("release\n");
    },
  };
  managedChildren.add(managedChild);
  void closed.catch(() => {});
  return managedChild;
}

async function leaveTamperedPublication(prepared: PreparedRestoreCase): Promise<void> {
  closeDatabase();
  const tampered = spawnChild(prepared, {
    action: "restore",
    tamperPublishedDatabase: true,
  });
  const close = await tampered.closed;
  assert.equal(close.code, 0, JSON.stringify(close));
  assert.equal(close.signal, null);
  assert.equal(close.outcome && "error" in close.outcome
    ? close.outcome.error.code
    : null, "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED");
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).activeIntentPath), true);
  assertRawDatabaseIsValid(prepared.databasePath);
}

interface PreparedBoundaryCase<Boundary extends string> {
  boundary: Boundary;
  prepared: PreparedRestoreCase;
}

// Phase A of the two-phase boundary-matrix shape: strictly sequential and synchronous (no
// `async`, no `await` anywhere in this function or the functions it calls). prepareRestoreCase()
// opens the process-global SQLite adapter via openDatabase(); running it across concurrent async
// lanes would let one boundary's openDatabase() clobber another's in-flight handle. Synchronicity
// is what makes a plain `for` loop here safe on a single-threaded runtime — an `async` keyword
// would silently reintroduce that race. Releases the global handle after each boundary so Phase B
// never touches it.
function prepareBoundaryCases<Boundary extends string>(
  boundaries: readonly Boundary[],
): Array<PreparedBoundaryCase<Boundary>> {
  const cases: Array<PreparedBoundaryCase<Boundary>> = [];
  for (const boundary of boundaries) {
    const prepared = prepareRestoreCase();
    closeDatabase();
    cases.push({ boundary, prepared });
  }
  return cases;
}

// Phase B of the two-phase boundary-matrix shape: runs `thunks` with at most
// BOUNDARY_CONCURRENCY in flight at once. Each thunk touches only its own prepared case's temp
// workspace, its own child processes, and read-only SQLite handles — never the process-global
// adapter — so overlapping lanes cannot interleave on shared state. Rejects on the first thunk
// failure (via lane() propagating the throw into the array Promise.all awaits), so a boundary
// failure still surfaces as a test failure instead of an unhandled rejection.
async function runBounded(thunks: Array<() => Promise<void>>): Promise<void> {
  let nextIndex = 0;
  async function lane(): Promise<void> {
    while (nextIndex < thunks.length) {
      const index = nextIndex;
      nextIndex += 1;
      await thunks[index]!();
    }
  }
  const lanes = Array.from(
    { length: Math.min(BOUNDARY_CONCURRENCY, thunks.length) },
    () => lane(),
  );
  await Promise.all(lanes);
}

afterEach(async () => {
  _setMaintenanceLockHooksForTest(null);
  closeDatabase();
  const children = [...managedChildren];
  for (const child of children) {
    if (child.process.exitCode === null && child.process.signalCode === null) {
      child.process.kill("SIGKILL");
    }
  }
  await Promise.allSettled(children.map((child) => child.closed));
  managedChildren.clear();
  for (const directory of tempDirectories) rmSync(directory, { recursive: true, force: true });
  tempDirectories.clear();
});

test("a writer already holding the SQLite lock wins and forces Forward Repair", async () => {
  const prepared = prepareRestoreCase();
  const revision = prepared.input.assessment.facts.currentProjectRevision;
  const epoch = prepared.input.assessment.facts.currentAuthorityEpoch;
  closeDatabase();

  const writer = spawnChild(prepared, {
    action: "writer",
    expectedRevision: revision,
    expectedAuthorityEpoch: epoch,
    idempotencyKey: `live-restore/fault-writer-wins-${sequence}`,
    pauseAfterBegin: true,
  });
  assert.equal(await writer.ready, "writer-lock");
  const restore = spawnChild(prepared, {
    action: "restore",
    busyTimeoutMs: 0,
  });
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.code, 0);
  assert.equal(restoreClose.signal, null);
  assert.equal(restoreClose.outcome && "error" in restoreClose.outcome
    ? restoreClose.outcome.error.code
    : null, "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT");

  writer.release();
  const writerClose = await writer.closed;
  assert.equal(writerClose.code, 0);
  assert.equal(writerClose.outcome && "result" in writerClose.outcome
    ? writerClose.outcome.result["status"]
    : null, "committed", JSON.stringify(writerClose));

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE idempotency_key = :key
  `).get({ ":key": `live-restore/fault-writer-wins-${sequence}` })?.["count"], 1);
  assert.throws(
    () => restoreLegacyImportLive(prepared.input),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_NOT_ELIGIBLE",
  );
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("a WAL reader snapshot forces a retryable contention at the detach checkpoint", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();

  const reader = spawnChild(prepared, { action: "wal-reader" });
  assert.equal(await reader.ready, "reader-snapshot");

  // The reader does not hold the write lock, so the restore claims its
  // intent; the detach checkpoint then observes busy WAL contention, which
  // must classify as retryable exactly like claim-time contention.
  const restore = spawnChild(prepared, {
    action: "restore",
    busyTimeoutMs: 0,
  });
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.code, 0);
  assert.equal(restoreClose.signal, null);
  assert.deepEqual(restoreClose.outcome && "error" in restoreClose.outcome
    ? {
        code: restoreClose.outcome.error.code,
        stage: restoreClose.outcome.error.stage,
        retryable: restoreClose.outcome.error.retryable,
      }
    : null, {
    code: "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
    stage: "stage",
    retryable: true,
  }, JSON.stringify(restoreClose.outcome));

  reader.release();
  const readerClose = await reader.closed;
  assert.equal(readerClose.code, 0);

  const retry = spawnChild(prepared, { action: "restore" });
  const retryClose = await retry.closed;
  assert.equal(retryClose.outcome && "result" in retryClose.outcome
    ? retryClose.outcome.result["status"]
    : null, "committed", JSON.stringify(retryClose.outcome));

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
});

test("a typed cutover already holding the SQLite lock advances epoch and forces Forward Repair", async () => {
  const prepared = prepareRestoreCase();
  const priorEpoch = prepared.input.assessment.facts.currentAuthorityEpoch;
  closeDatabase();

  const cutover = spawnChild(prepared, {
    action: "cutover",
    idempotencyKey: `live-restore/fault-cutover-wins-${sequence}`,
    pauseAfterBegin: true,
  });
  assert.equal(await cutover.ready, "writer-lock");
  const restore = spawnChild(prepared, {
    action: "restore",
    busyTimeoutMs: 0,
  });
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.outcome && "error" in restoreClose.outcome
    ? restoreClose.outcome.error.code
    : null, "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT");

  cutover.release();
  const cutoverClose = await cutover.closed;
  assert.equal(cutoverClose.outcome && "result" in cutoverClose.outcome
    ? cutoverClose.outcome.result["status"]
    : null, "committed", JSON.stringify(cutoverClose));

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.deepEqual(database().prepare(`
    SELECT authority_epoch FROM project_authority WHERE singleton = 1
  `).get(), { authority_epoch: priorEpoch + 1 });
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_authority_cutovers").get()?.["count"], 1);
  const assessment = assessLegacyImportRestore({
    applicationIdentityHash: prepared.input.applicationIdentityHash,
    backup: prepared.input.backup,
  });
  assert.equal(assessment.decision, "forward-repair-required");
  assert.equal(assessment.reasonCode, "AUTHORITY_CUTOVER_COMMITTED");
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("a writer queued before intent creation rechecks the fence after acquiring its lock", async () => {
  const prepared = prepareRestoreCase();
  const revision = prepared.input.assessment.facts.currentProjectRevision;
  const epoch = prepared.input.assessment.facts.currentAuthorityEpoch;
  closeDatabase();

  const writer = spawnChild(prepared, {
    action: "writer",
    expectedRevision: revision,
    expectedAuthorityEpoch: epoch,
    idempotencyKey: `live-restore/fault-queued-writer-${sequence}`,
    pauseBeforeBegin: true,
  });
  assert.equal(await writer.ready, "before-writer-lock");
  const restore = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await restore.ready, "after-intent");

  writer.release();
  const writerClose = await writer.closed;
  assert.equal(writerClose.code, 0);
  assert.equal(writerClose.signal, null);
  assert.equal(writerClose.outcome && "error" in writerClose.outcome
    ? writerClose.outcome.error.code
    : null, "GSD_STALE_STATE");

  restore.process.kill("SIGKILL");
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.signal, "SIGKILL");
  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare(`
    SELECT COUNT(*) AS count FROM workflow_operations
    WHERE idempotency_key = :key
  `).get({ ":key": `live-restore/fault-queued-writer-${sequence}` })?.["count"], 0);
  assert.equal(
    restoreLegacyImportLive(prepared.input).status,
    "committed",
  );
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
});

test("maintenance claim blocks restore until maintenance completes", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const maintenance = spawnChild(prepared, {
    action: "maintenance",
    pauseAfterClaim: true,
  });
  assert.equal(await maintenance.ready, "maintenance-claim");

  const restore = spawnChild(prepared, {
    action: "restore",
    busyTimeoutMs: 0,
  });
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.outcome && "error" in restoreClose.outcome
    ? restoreClose.outcome.error.code
    : null, "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT");

  maintenance.release();
  const maintenanceClose = await maintenance.closed;
  assert.equal(maintenanceClose.outcome && "result" in maintenanceClose.outcome
    ? maintenanceClose.outcome.result["status"]
    : null, "completed");

  const retry = spawnChild(prepared, { action: "restore" });
  const retryClose = await retry.closed;
  assert.equal(retryClose.outcome && "result" in retryClose.outcome
    ? retryClose.outcome.result["status"]
    : null, "committed");
});

test("maintenance queued before intent creation rechecks the fence after locking", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const maintenance = spawnChild(prepared, {
    action: "maintenance",
    pauseBeforeLock: true,
  });
  assert.equal(await maintenance.ready, "before-maintenance-lock");

  const restore = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await restore.ready, "after-intent");

  maintenance.release();
  const maintenanceClose = await maintenance.closed;
  assert.equal(maintenanceClose.outcome && "error" in maintenanceClose.outcome
    ? maintenanceClose.outcome.error.code
    : null, "GSD_STALE_STATE");

  restore.release();
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.outcome && "result" in restoreClose.outcome
    ? restoreClose.outcome.result["status"]
    : null, "committed");
});

test("restore reclaims a crashed maintenance owner by process identity", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const maintenance = spawnChild(prepared, {
    action: "maintenance",
    pauseAfterClaim: true,
  });
  assert.equal(await maintenance.ready, "maintenance-claim");
  maintenance.process.kill("SIGKILL");
  assert.equal((await maintenance.closed).signal, "SIGKILL");
  assert.equal(existsSync(`${prepared.databasePath}.maintenance.json`), true);

  const restore = spawnChild(prepared, { action: "restore" });
  const restoreClose = await restore.closed;
  assert.equal(restoreClose.outcome && "result" in restoreClose.outcome
    ? restoreClose.outcome.result["status"]
    : null, "committed");
  assert.equal(existsSync(`${prepared.databasePath}.maintenance.json`), false);
});

test("restart reclaims a crashed maintenance owner before ordinary writes", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const maintenance = spawnChild(prepared, {
    action: "maintenance",
    pauseAfterClaim: true,
  });
  assert.equal(await maintenance.ready, "maintenance-claim");
  maintenance.process.kill("SIGKILL");
  assert.equal((await maintenance.closed).signal, "SIGKILL");
  assert.equal(existsSync(`${prepared.databasePath}.maintenance.json`), true);

  assert.equal(openDatabase(prepared.databasePath), true);
  insertDecision({
    id: "D-restart-after-maintenance",
    when_context: "after restart",
    scope: "maintenance recovery",
    decision: "write succeeds",
    choice: "reclaim stale owner",
    rationale: "startup proved the previous maintenance process exited",
    revisable: "no",
    made_by: "agent",
    source: "discussion",
    superseded_by: null,
  });
  assert.equal(existsSync(`${prepared.databasePath}.maintenance.json`), false);
});

test("maintenance publication failures remove only the marker they published", () => {
  for (const boundary of MAINTENANCE_CLAIM_BOUNDARIES) {
    const prepared = prepareRestoreCase();
    const maintenancePath = `${prepared.databasePath}.maintenance.json`;
    const injected = new Error(`injected maintenance publication failure at ${boundary}`);
    let reached = false;
    _setMaintenanceLockHooksForTest({
      claimBoundary(point) {
        if (point !== boundary || reached) return;
        reached = true;
        throw injected;
      },
    });

    assert.throws(() => checkpointDatabase(), (error: unknown) => error === injected, boundary);
    _setMaintenanceLockHooksForTest(null);
    assert.equal(reached, true, boundary);
    assert.equal(existsSync(maintenancePath), false, boundary);
    assert.equal(restoreLegacyImportLive(prepared.input).status, "committed", boundary);
  }
});

test("maintenance publication fails closed when its public path changes before identity proof", () => {
  const prepared = prepareRestoreCase();
  const maintenancePath = `${prepared.databasePath}.maintenance.json`;
  const replacement = Buffer.from("replacement maintenance owner", "utf8");
  let substituted = false;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point !== "before-maintenance-claim-identity-proof" || substituted) return;
      unlinkSync(maintenancePath);
      writeFileSync(maintenancePath, replacement);
      substituted = true;
    },
  });

  assert.throws(
    () => checkpointDatabase(),
    /Database maintenance intent changed before publication completed/,
  );
  assert.equal(substituted, true);
  assert.deepEqual(readFileSync(maintenancePath), replacement);
});

test("maintenance publication preserves its original failure when exact cleanup is unsafe", () => {
  const prepared = prepareRestoreCase();
  const maintenancePath = `${prepared.databasePath}.maintenance.json`;
  const replacement = Buffer.from("replacement maintenance owner", "utf8");
  const injected = new Error("injected failure after maintenance publication");
  let substituted = false;
  _setMaintenanceLockHooksForTest({
    claimBoundary(point) {
      if (point !== "after-maintenance-claim-publish" || substituted) return;
      unlinkSync(maintenancePath);
      writeFileSync(maintenancePath, replacement);
      substituted = true;
      throw injected;
    },
  });

  assert.throws(() => checkpointDatabase(), (error: unknown) => error === injected);
  assert.equal(substituted, true);
  assert.deepEqual(readFileSync(maintenancePath), replacement);
});

test("restart and maintenance remain non-writing while replacement intent is active", () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const paths = getDatabaseReplacementPaths(prepared.databasePath);
  mkdirSync(paths.recoveryDirectory, { recursive: true });
  writeFileSync(paths.activeIntentPath, "{}", "utf8");
  const sidecarPaths = ["-wal", "-shm"].map((suffix) => `${prepared.databasePath}${suffix}`);
  const sidecarsBefore = sidecarPaths.map((path) => existsSync(path) ? readFileSync(path) : null);

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.deepEqual(
    sidecarPaths.map((path) => existsSync(path) ? readFileSync(path) : null),
    sidecarsBefore,
    "replacement observation must not create or change SQLite sidecars",
  );
  assert.equal(openIsolatedDatabase(prepared.databasePath), null);
  assert.throws(() => checkpointDatabase(), /writes are fenced/);
  assert.throws(() => vacuumDatabase(), /writes are fenced/);
  assert.deepEqual(probeDbWritable(), {
    ok: false,
    detail: `gsd-db: Database writes are fenced while replacement intent exists at ${paths.activeIntentPath}`,
  });
});

test("every durable live restore boundary converges after real SIGKILL", { timeout: BOUNDARY_TEST_TIMEOUT_MS }, async () => {
  const cases = prepareBoundaryCases(CRASH_BOUNDARIES);
  await runBounded(cases.map(({ boundary, prepared }) => async () => {
    const backupHash = sha256(prepared.input.backup.backup_ref);

    const crashed = spawnChild(prepared, {
      action: "restore",
      crashBoundary: boundary,
    });
    const crashClose = await crashed.closed;
    assert.equal(crashClose.code, null, boundary);
    assert.equal(crashClose.signal, "SIGKILL", boundary);
    assert.equal(existsSync(prepared.databasePath), true, boundary);
    assertRawDatabaseIsValid(prepared.databasePath);
    assert.equal(sha256(prepared.input.backup.backup_ref), backupHash, boundary);

    const retry = spawnChild(prepared, { action: "restore" });
    const retryClose = await retry.closed;
    assert.equal(retryClose.code, 0, `${boundary}: ${JSON.stringify(retryClose)}`);
    assert.equal(retryClose.signal, null, boundary);
    assert.ok(retryClose.outcome && "result" in retryClose.outcome, boundary);
    assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false, boundary);

    const replay = spawnChild(prepared, { action: "restore" });
    const replayClose = await replay.closed;
    assert.equal(replayClose.code, 0, `${boundary}: ${JSON.stringify(replayClose)}`);
    assert.equal(replayClose.outcome && "result" in replayClose.outcome
      ? replayClose.outcome.result["status"]
      : null, "replayed", boundary);

    assertRawDatabaseIsValid(prepared.databasePath);
    assertBaseDatabaseIsSelfContained(prepared.databasePath);
    const final = openSqliteReadOnly(prepared.databasePath);
    try {
      assert.deepEqual(final.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'import.restore') AS operations,
          (SELECT COUNT(*) FROM workflow_import_restores) AS receipts,
          (SELECT COUNT(*) FROM workflow_domain_events WHERE event_type = 'legacy-import.restored') AS events,
          (SELECT COUNT(*) FROM workflow_outbox WHERE event_id IN (
            SELECT event_id FROM workflow_domain_events WHERE event_type = 'legacy-import.restored'
          )) AS outbox
      `).get(), { operations: 1, receipts: 1, events: 1, outbox: 1 });
    } finally {
      final.db.close();
    }
    assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false, boundary);
    assert.equal(sha256(prepared.input.backup.backup_ref), backupHash, boundary);
  }));
});

test("reopen rejects a handle bound to a swapped database inode before recording a receipt", () => {
  const prepared = prepareRestoreCase();
  const rogueSource = join(prepared.workspace, "pre-restore.sqlite");
  const expectedHolding = join(prepared.workspace, "expected-published.sqlite");
  const rogueHolding = join(prepared.workspace, "rogue-opened.sqlite");
  cpSync(prepared.databasePath, rogueSource);
  let swapped = false;

  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "before-reopen-open" && !swapped) {
          renameSync(prepared.databasePath, expectedHolding);
          cpSync(rogueSource, prepared.databasePath);
          return;
        }
        if (point === "after-reopen-open" && !swapped) {
          renameSync(prepared.databasePath, rogueHolding);
          renameSync(expectedHolding, prepared.databasePath);
          swapped = true;
        }
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_CONVERGENCE_FAILED"
      && String((error as { cause?: unknown }).cause).includes("reopened SQLite handle does not match"),
  );
  assert.equal(swapped, true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_applications").get()?.["count"], 0);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 0);
});

test("reopen rejects in-place database content drift before the reopen proof boundary", () => {
  const prepared = prepareRestoreCase();
  const expectedSource = join(prepared.workspace, "expected-reopen-content.sqlite");
  let expectedSaved = false;
  let tampered = false;
  let inodePreserved = false;
  let afterProofReached = false;

  assert.throws(
    () => _restoreLegacyImportLiveForTest(prepared.input, {
      boundary(point) {
        if (point === "before-reopen-open" && !expectedSaved) {
          cpSync(prepared.databasePath, expectedSource);
          expectedSaved = true;
          return;
        }
        if (point === "after-reopen-open" && !tampered) {
          const before = lstatSync(prepared.databasePath);
          appendFileSync(prepared.databasePath, Buffer.alloc(4096));
          const after = lstatSync(prepared.databasePath);
          inodePreserved = before.dev === after.dev && before.ino === after.ino;
          tampered = true;
          return;
        }
        if (point === "after-reopen-proof" && !afterProofReached) {
          afterProofReached = true;
          writeFileSync(prepared.databasePath, readFileSync(expectedSource));
        }
      },
    }),
    (error: unknown) => (error as { code?: unknown }).code
      === "LEGACY_IMPORT_LIVE_RESTORE_REOPEN_FAILED",
  );
  assert.equal(tampered, true);
  assert.equal(inodePreserved, true);
  assert.equal(afterProofReached, false);

  closeDatabase();
  assert.equal(openDatabase(prepared.databasePath), true);
  const retry = restoreLegacyImportLive(prepared.input);
  assert.ok(retry.status === "committed" || retry.status === "replayed");
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
});

test("every live restore boundary converges after a synchronous exception", { timeout: BOUNDARY_TEST_TIMEOUT_MS }, () => {
  for (const boundary of CRASH_BOUNDARIES) {
    const prepared = prepareRestoreCase();
    let injected = false;
    assert.throws(
      () => _restoreLegacyImportLiveForTest(prepared.input, {
        boundary(point) {
          if (point !== boundary || injected) return;
          injected = true;
          throw new Error(`injected exception at ${boundary}`);
        },
      }),
      (error: unknown) => error instanceof Error,
      boundary,
    );
    assert.equal(injected, true, boundary);
    assert.ok(_getAdapter(), boundary);
    assert.equal(database().prepare("SELECT 1 AS value").get()?.["value"], 1, boundary);

    closeDatabase();
    assertRawDatabaseIsValid(prepared.databasePath);
    assert.equal(openDatabase(prepared.databasePath), true, boundary);
    const result = restoreLegacyImportLive(prepared.input);
    assert.ok(result.status === "committed" || result.status === "replayed", boundary);
    assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1, boundary);
    assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false, boundary);
    closeDatabase();
  }
});

test("every recovery publication boundary converges after real SIGKILL", { timeout: BOUNDARY_TEST_TIMEOUT_MS }, async () => {
  const cases = prepareBoundaryCases(RECOVERY_BOUNDARIES);
  await runBounded(cases.map(({ boundary, prepared }) => async () => {
    const backupHash = sha256(prepared.input.backup.backup_ref);
    await leaveTamperedPublication(prepared);

    const crashed = spawnChild(prepared, {
      action: "restore",
      crashBoundary: boundary,
    });
    const crashClose = await crashed.closed;
    assert.equal(crashClose.code, null, boundary);
    assert.equal(crashClose.signal, "SIGKILL", boundary);
    assertRawDatabaseIsValid(prepared.databasePath);
    assert.equal(sha256(prepared.input.backup.backup_ref), backupHash, boundary);

    const retry = spawnChild(prepared, { action: "restore" });
    const retryClose = await retry.closed;
    assert.equal(retryClose.code, 0, `${boundary}: ${JSON.stringify(retryClose)}`);
    const retryStatus = retryClose.outcome && "result" in retryClose.outcome
      ? retryClose.outcome.result["status"]
      : null;
    assert.ok(retryStatus === "committed" || retryStatus === "replayed", boundary);

    const replay = spawnChild(prepared, { action: "restore" });
    const replayClose = await replay.closed;
    assert.equal(replayClose.outcome && "result" in replayClose.outcome
      ? replayClose.outcome.result["status"]
      : null, "replayed", boundary);

    assertRawDatabaseIsValid(prepared.databasePath);
    assertBaseDatabaseIsSelfContained(prepared.databasePath);
    const final = openSqliteReadOnly(prepared.databasePath);
    try {
      assert.deepEqual(final.db.prepare(`
        SELECT
          (SELECT COUNT(*) FROM workflow_operations WHERE operation_type = 'import.restore') AS operations,
          (SELECT COUNT(*) FROM workflow_import_restores) AS receipts,
          (SELECT COUNT(*) FROM workflow_domain_events WHERE event_type = 'legacy-import.restored') AS events
      `).get(), { operations: 1, receipts: 1, events: 1 }, boundary);
    } finally {
      final.db.close();
    }
    assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false, boundary);
    assert.equal(sha256(prepared.input.backup.backup_ref), backupHash, boundary);
  }));
});

test("every recovery publication boundary preserves a usable handle after an exception", { timeout: BOUNDARY_TEST_TIMEOUT_MS }, async () => {
  for (const boundary of RECOVERY_BOUNDARIES) {
    const prepared = prepareRestoreCase();
    await leaveTamperedPublication(prepared);
    assert.equal(openDatabase(prepared.databasePath), true, boundary);
    let injected = false;
    assert.throws(
      () => _restoreLegacyImportLiveForTest(prepared.input, {
        boundary(point) {
          if (point !== boundary || injected) return;
          injected = true;
          throw new Error(`injected exception at ${boundary}`);
        },
      }),
      (error: unknown) => error instanceof Error,
      boundary,
    );
    assert.equal(injected, true, boundary);
    assert.ok(_getAdapter(), boundary);
    assert.equal(database().prepare("SELECT 1 AS value").get()?.["value"], 1, boundary);

    closeDatabase();
    assertRawDatabaseIsValid(prepared.databasePath);
    assert.equal(openDatabase(prepared.databasePath), true, boundary);
    const converged = restoreLegacyImportLive(prepared.input);
    assert.ok(converged.status === "committed" || converged.status === "replayed", boundary);
    assert.equal(restoreLegacyImportLive(prepared.input).status, "replayed", boundary);
    assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1, boundary);
    assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false, boundary);
    closeDatabase();
    assertBaseDatabaseIsSelfContained(prepared.databasePath);
  }
});

test("same-request processes converge on one receipt and the loser replays", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();
  const owner = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await owner.ready, "after-intent");

  const contender = spawnChild(prepared, { action: "restore" });
  const contenderClose = await contender.closed;
  assert.equal(contenderClose.code, 0);
  assert.deepEqual(contenderClose.outcome && "error" in contenderClose.outcome
    ? {
        code: contenderClose.outcome.error.code,
        retryable: contenderClose.outcome.error.retryable,
      }
    : null, {
    code: "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
    retryable: true,
  });

  owner.release();
  const ownerClose = await owner.closed;
  assert.equal(ownerClose.outcome && "result" in ownerClose.outcome
    ? ownerClose.outcome.result["status"]
    : null, "committed");
  const replay = spawnChild(prepared, { action: "restore" });
  const replayClose = await replay.closed;
  assert.equal(replayClose.outcome && "result" in replayClose.outcome
    ? replayClose.outcome.result["status"]
    : null, "replayed");

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_operations WHERE operation_type = 'import.restore'").get()?.["count"], 1);
});

test("concurrent abandoned-intent reclaimers cannot delete the replacement owner's intent", async () => {
  const prepared = prepareRestoreCase();
  closeDatabase();

  const abandoned = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await abandoned.ready, "after-intent");
  abandoned.process.kill("SIGKILL");
  assert.equal((await abandoned.closed).signal, "SIGKILL");

  const staleCleaner = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-cleanup-entries",
  });
  assert.equal(await staleCleaner.ready, "after-cleanup-entries");

  const replacementOwner = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await replacementOwner.ready, "after-intent");
  const intentPath = getDatabaseReplacementPaths(prepared.databasePath).activeIntentPath;
  const replacementIntent = readFileSync(intentPath);

  staleCleaner.release();
  const staleClose = await staleCleaner.closed;
  assert.ok(staleClose.outcome && "error" in staleClose.outcome);
  assert.deepEqual(
    readFileSync(intentPath),
    replacementIntent,
    "the stale cleaner must not unlink or replace the new owner's intent",
  );

  replacementOwner.release();
  const ownerClose = await replacementOwner.closed;
  assert.equal(ownerClose.outcome && "result" in ownerClose.outcome
    ? ownerClose.outcome.result["status"]
    : null, "committed");

  const replay = spawnChild(prepared, { action: "restore" });
  const replayClose = await replay.closed;
  assert.equal(replayClose.outcome && "result" in replayClose.outcome
    ? replayClose.outcome.result["status"]
    : null, "replayed");

  assert.equal(openDatabase(prepared.databasePath), true);
  assert.equal(database().prepare("SELECT COUNT(*) AS count FROM workflow_import_restores").get()?.["count"], 1);
  assert.equal(existsSync(getDatabaseReplacementPaths(prepared.databasePath).recoveryDirectory), false);
});

test("changed-request process cannot alter the active owner's intent", async () => {
  const prepared = prepareRestoreCase();
  const changed: LegacyImportLiveRestoreInput = {
    ...structuredClone(prepared.input),
    invocation: {
      ...prepared.input.invocation,
      idempotencyKey: `${prepared.input.invocation.idempotencyKey}/changed`,
    },
  };
  closeDatabase();
  const owner = spawnChild(prepared, {
    action: "restore",
    pauseBoundary: "after-intent",
  });
  assert.equal(await owner.ready, "after-intent");
  const intentPath = getDatabaseReplacementPaths(prepared.databasePath).activeIntentPath;
  const intentBefore = readFileSync(intentPath);

  const contender = spawnChild(prepared, { action: "restore" }, changed);
  const contenderClose = await contender.closed;
  assert.equal(contenderClose.code, 0);
  assert.deepEqual(contenderClose.outcome && "error" in contenderClose.outcome
    ? {
        code: contenderClose.outcome.error.code,
        retryable: contenderClose.outcome.error.retryable,
      }
    : null, {
    code: "LEGACY_IMPORT_LIVE_RESTORE_INTENT_CONFLICT",
    retryable: false,
  });
  assert.deepEqual(readFileSync(intentPath), intentBefore);

  owner.release();
  const ownerClose = await owner.closed;
  assert.equal(ownerClose.outcome && "result" in ownerClose.outcome
    ? ownerClose.outcome.result["status"]
    : null, "committed");
});
