// Project/App: gsd-pi
// File Purpose: Real acquire+detect round-trip coverage (16-driver-ergonomics
// gap-closure cycle 1/3, ROADMAP SC2b). `session-lock-milestone-scoped.test.ts`
// (16-03's own coverage) proves `detectActiveMilestoneRun` correctly reads a
// well-formed milestone-scoped lock file, but its `writeMilestoneLock` helper
// explicitly bypasses acquisition (see that file's own source comment) -- so
// no shipped test ever drove the REAL `acquireSessionLock` and the REAL
// `detectActiveMilestoneRun` together. That gap is exactly why a lock-path
// mismatch between the two (acquisition writes the generic `.gsd/auto.lock`
// in the default non-parallel-worker case; detection only ever read the
// milestone-scoped `auto-<milestoneId>.lock`) shipped undetected: Gate-1
// SELF-UAT found it (`.planning/phases/16-driver-ergonomics/16-SELF-UAT.md`
// criterion 2b) by driving both real functions end to end.
//
// This suite closes that gap. It spawns the real `acquireSessionLock` in a
// genuinely separate OS process (`fixtures/session-lock-acquire-hold-worker.ts`)
// so the held lock's PID is never the test runner's own `process.pid` --
// `isPidAlive`'s documented self-PID guard (treats `pid === process.pid` as
// "not alive", relied on elsewhere: `guided-flow.ts:1590`,
// `session-lock-milestone-scoped.test.ts`'s ALIVE_PID=1 convention) would
// otherwise make a same-process round trip report a live lock as dead,
// which is a pre-existing, deliberate, and out-of-scope behavior this gap
// does not touch -- a genuinely colliding second invocation is, in real
// production, always a distinct OS process (a second CLI invocation, a
// background headless run) rather than the same process re-entering itself.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";

import {
  closeDatabase,
  insertMilestone,
  openDatabase,
} from "../gsd-db.ts";
import { recordMilestoneRunLifecycle } from "../milestone-run-log-domain-operation.ts";
import type { ExecutionInvocation } from "../execution-invocation.ts";
import {
  detectActiveMilestoneRun,
  readSessionLockData,
} from "../session-lock.ts";

const workerPath = join(
  process.cwd(),
  "src/resources/extensions/gsd/tests/fixtures/session-lock-acquire-hold-worker.ts",
);
const resolverPath = join(
  process.cwd(),
  "src/resources/extensions/gsd/tests/resolve-ts.mjs",
);

const tempDirs = new Set<string>();

function invocation(idempotencyKey: string): ExecutionInvocation {
  return { idempotencyKey, sourceTransport: "internal", actorType: "test" };
}

function makeBase(milestoneId: string): string {
  const basePath = mkdtempSync(join(tmpdir(), "gsd-session-lock-roundtrip-"));
  tempDirs.add(basePath);
  mkdirSync(join(basePath, ".gsd"), { recursive: true });
  assert.equal(openDatabase(join(basePath, ".gsd", "gsd.db")), true);
  insertMilestone({ id: milestoneId, title: "Round-trip lock test", status: "active" });
  return basePath;
}

function insertRunningRow(milestoneId: string, runId: string): void {
  const receipt = recordMilestoneRunLifecycle({
    invocation: invocation(`fixture/session-lock-roundtrip/${milestoneId}/${runId}`),
    milestoneId,
    runId,
    attempt: 1,
    status: "running",
  });
  assert.ok(receipt.entryId);
}

interface HeldLock {
  pid: number;
  kill(): Promise<void>;
}

/**
 * Spawn the real `acquireSessionLock` in its own process, waiting for the
 * "LOCK_ACQUIRED" marker before returning the child's PID. `extraEnv` is
 * merged over the current process env (used for GSD_PARALLEL_WORKER cases).
 */
async function acquireLockInChildProcess(
  basePath: string,
  extraEnv: Record<string, string> = {},
): Promise<HeldLock> {
  const env = { ...process.env, ...extraEnv };
  delete env.NODE_TEST_CONTEXT;
  const child = spawn(process.execPath, [
    "--import",
    resolverPath,
    "--experimental-strip-types",
    workerPath,
    basePath,
  ], { cwd: process.cwd(), env, stdio: ["ignore", "pipe", "pipe"] });

  const pid = await new Promise<number>((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    const timeout = setTimeout(() => {
      child.kill("SIGKILL");
      reject(new Error(`worker did not report LOCK_ACQUIRED within 10s. stdout=${stdout} stderr=${stderr}`));
    }, 10_000);
    child.stdout!.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
      if (stdout.includes("LOCK_ACQUIRED")) {
        clearTimeout(timeout);
        if (child.pid === undefined) {
          reject(new Error("worker process has no pid"));
        } else {
          resolve(child.pid);
        }
      } else if (stdout.includes("LOCK_FAILED")) {
        clearTimeout(timeout);
        reject(new Error(`worker failed to acquire lock: ${stdout}`));
      }
    });
    child.stderr!.on("data", (chunk: Buffer) => { stderr += chunk.toString("utf8"); });
    child.on("error", (err) => { clearTimeout(timeout); reject(err); });
    child.on("exit", (code, signal) => {
      if (!stdout.includes("LOCK_ACQUIRED")) {
        clearTimeout(timeout);
        reject(new Error(`worker exited early (code=${code}, signal=${signal}). stdout=${stdout} stderr=${stderr}`));
      }
    });
  });

  return {
    pid,
    async kill(): Promise<void> {
      await new Promise<void>((resolve) => {
        child.once("exit", () => resolve());
        child.kill("SIGTERM");
      });
    },
  };
}

afterEach(() => {
  closeDatabase();
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

test("(a) a genuinely live lock from the REAL acquireSessionLock is detected, not treated as absent", async () => {
  const base = makeBase("M-RT-A");
  insertRunningRow("M-RT-A", "run-rt-a");

  const held = await acquireLockInChildProcess(base);
  try {
    // Confirms the documented mismatch this gap closes: real acquisition in
    // the default (non-parallel-worker) case writes the GENERIC lock file,
    // never the milestone-scoped one.
    assert.equal(existsSync(join(base, ".gsd", "auto.lock")), true);
    assert.equal(existsSync(join(base, ".gsd", "auto-M-RT-A.lock")), false);

    const lockData = readSessionLockData(base, "M-RT-A");
    assert.ok(lockData, "readSessionLockData must fall back to the generic lock file");
    assert.equal(lockData!.pid, held.pid);

    const detection = detectActiveMilestoneRun(base, "M-RT-A");
    assert.equal(detection.active, true, `expected active detection, got ${JSON.stringify(detection)}`);
    assert.equal(detection.pid, held.pid);
  } finally {
    await held.kill();
  }
});

test("(a2) once the real lock owner is genuinely dead, detection reports stale-lock-dead-owner (not active)", async () => {
  const base = makeBase("M-RT-A2");
  insertRunningRow("M-RT-A2", "run-rt-a2");

  const held = await acquireLockInChildProcess(base);
  await held.kill();

  const detection = detectActiveMilestoneRun(base, "M-RT-A2");
  assert.equal(detection.active, false);
  assert.equal(detection.reason, "stale-lock-dead-owner");
  assert.equal(detection.pid, held.pid);
});

test("(c) GSD_PARALLEL_WORKER mode: two milestones' real acquisitions isolate into separate lock files, never falling back to the generic file", async () => {
  const base = makeBase("M-RT-PARA");
  insertMilestone({ id: "M-RT-PARB", title: "Round-trip lock test B", status: "active" });
  insertRunningRow("M-RT-PARA", "run-rt-para");
  insertRunningRow("M-RT-PARB", "run-rt-parb");

  const heldA = await acquireLockInChildProcess(base, {
    GSD_PARALLEL_WORKER: "1",
    GSD_MILESTONE_LOCK: "M-RT-PARA",
  });
  const heldB = await acquireLockInChildProcess(base, {
    GSD_PARALLEL_WORKER: "1",
    GSD_MILESTONE_LOCK: "M-RT-PARB",
  });
  try {
    assert.equal(existsSync(join(base, ".gsd", "auto-M-RT-PARA.lock")), true);
    assert.equal(existsSync(join(base, ".gsd", "auto-M-RT-PARB.lock")), true);
    // Neither parallel-worker acquisition ever touches the generic lock file.
    assert.equal(existsSync(join(base, ".gsd", "auto.lock")), false);

    const detectionA = detectActiveMilestoneRun(base, "M-RT-PARA");
    assert.equal(detectionA.active, true);
    assert.equal(detectionA.pid, heldA.pid);

    const detectionB = detectActiveMilestoneRun(base, "M-RT-PARB");
    assert.equal(detectionB.active, true);
    assert.equal(detectionB.pid, heldB.pid);

    // Cross-check: A's detection must never report B's pid, and vice versa
    // -- isolation, not coincidental agreement.
    assert.notEqual(detectionA.pid, detectionB.pid);
  } finally {
    await heldA.kill();
    await heldB.kill();
  }
});
