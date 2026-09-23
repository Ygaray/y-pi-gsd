// Project/App: gsd-pi
// File Purpose: Real-process worker for the acquire+detect round-trip test
// (16-driver-ergonomics gap-closure, SC2b). Calls the REAL `acquireSessionLock`
// in its OWN OS process (a genuinely different PID from the test runner) so
// the liveness check downstream (`isPidAlive`) exercises its normal
// cross-process path rather than the documented self-PID guard that treats
// `process.pid === process.pid` as "not alive" (see
// `session-lock-milestone-scoped.test.ts`'s ALIVE_PID convention -- this
// worker is the general-purpose version of that same idea, but through the
// real acquisition function instead of a hand-written lock file). Inherits
// GSD_PARALLEL_WORKER / GSD_MILESTONE_LOCK from its spawn env unchanged, so
// the same worker script covers both the default single-milestone lock
// target and the parallel-worker-scoped lock target.
//
// Protocol: prints "LOCK_ACQUIRED\n" to stdout once the real lock is held,
// then idles until the parent sends a termination signal (default Node
// SIGTERM handling exits the process immediately -- no handler needed).
// Prints "LOCK_FAILED:<reason>\n" and exits 1 if acquisition fails.

import { acquireSessionLock } from "../../session-lock.ts";

function main(): void {
  const basePath = process.argv[2];
  if (!basePath) throw new Error("session-lock-acquire-hold-worker requires a basePath argument");

  const result = acquireSessionLock(basePath);
  if (!result.acquired) {
    process.stdout.write(`LOCK_FAILED:${result.reason}\n`);
    process.exit(1);
  }

  process.stdout.write("LOCK_ACQUIRED\n");
  // Idle indefinitely; the parent kills this process to release the lock.
  setInterval(() => {}, 60_000);
}

main();
