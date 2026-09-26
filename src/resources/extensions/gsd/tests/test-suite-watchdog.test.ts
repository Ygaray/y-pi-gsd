// Project/App: gsd-pi
// File Purpose: GREEN-01's stall-detection drill — the reason the watchdog's liveness
// decision lives in a pure `classifyLiveness` function rather than inline CLI logic. Tests
// 1-8 drive that function directly (no spawning, no timers); Tests 9-10 spawn the real CLI
// once each for the two behaviors no pure-function test can prove on its own: a genuinely
// hung child gets stall-killed, and a real non-zero child exit code is never masked.

import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, test } from "node:test";
import { pathToFileURL } from "node:url";

// Resolved through process.cwd() (the session-lock-acquire-detect-roundtrip.test.ts idiom) so
// the identical import works from src/ under --experimental-strip-types AND from compiled
// dist-test/ — the two run at different directory depths, so a relative specifier would break
// one of them.
const corePath = pathToFileURL(
  join(process.cwd(), "scripts/lib/test-suite-watchdog-core.mjs"),
).href;
const { DEFAULTS, classifyLiveness } = await import(corePath);

const watchdogPath = join(process.cwd(), "scripts/test-suite-watchdog.mjs");

// Roughly 20x the 3 s stall cap Tests 9 and 10 configure below — generous headroom for this
// contended host, matching the `{ timeout: BOUNDARY_TEST_TIMEOUT_MS }` convention in
// legacy-import-live-restore-fault.test.ts.
const DRILL_TIMEOUT_MS = 60_000;

const tempDirs = new Set<string>();

afterEach(() => {
  for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
  tempDirs.clear();
});

// ─── Pure classifier tests (1-8): no spawning, no timers ────────────────────

test("Test 1: both deltas positive -> progressing", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 50, outputBytesDelta: 20, descendantCount: 0, quietMsElapsed: 0, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999 },
  );
  assert.equal(verdict, "progressing");
});

test("Test 2: CPU alone, quiet far past cap -> progressing, never stalled (263.5s slow-file shape)", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 50, outputBytesDelta: 0, descendantCount: 0, quietMsElapsed: 999999, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999999 },
  );
  assert.equal(verdict, "progressing");
});

test("Test 3: output alone, quiet far past cap -> progressing", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 0, outputBytesDelta: 20, descendantCount: 0, quietMsElapsed: 999999, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999999 },
  );
  assert.equal(verdict, "progressing");
});

test("Test 4: both deltas 0, live descendant blocks a stall verdict -> quiet-but-live", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 0, outputBytesDelta: 0, descendantCount: 1, quietMsElapsed: 999999, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999999 },
  );
  assert.equal(verdict, "quiet-but-live");
});

test("Test 5: both deltas 0, no descendant, quiet exactly at cap -> stalled (boundary)", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 0, outputBytesDelta: 0, descendantCount: 0, quietMsElapsed: 1000, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999999 },
  );
  assert.equal(verdict, "stalled");
});

test("Test 6: same sample one ms below the cap -> NOT stalled (boundary)", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 0, outputBytesDelta: 0, descendantCount: 0, quietMsElapsed: 999, totalMsElapsed: 1000 },
    { stallCapMs: 1000, hardCapMs: 999999999 },
  );
  assert.notEqual(verdict, "stalled");
});

test("Test 7: hard cap wins even over a simultaneously-progressing sample", () => {
  const verdict = classifyLiveness(
    { cpuMsDelta: 50, outputBytesDelta: 20, descendantCount: 1, quietMsElapsed: 0, totalMsElapsed: 999999 },
    { stallCapMs: 1000, hardCapMs: 999999 },
  );
  assert.equal(verdict, "hard-cap");
});

test("Test 8: DEFAULTS caps clear the measured legitimate quiet windows (docs/dev/test-suite-quarantine.md §5)", () => {
  // 263528 ms = legacy-import-live-restore-fault.test.ts's measured standalone quiet window;
  // 953000 ms = the full test:unit:native chain's measured wall clock. Tightening either cap
  // below these numbers would turn this watchdog into something that kills real work (T-22-02).
  assert.ok(DEFAULTS.stallCapMs > 263528, `stallCapMs=${DEFAULTS.stallCapMs} must exceed 263528`);
  assert.ok(DEFAULTS.hardCapMs > 953000, `hardCapMs=${DEFAULTS.hardCapMs} must exceed 953000`);
});

// ─── Real round-trip tests (9-10): spawn the actual CLI ─────────────────────

test(
  "Test 9: a genuinely hung child is stall-killed and the verdict records it",
  { timeout: DRILL_TIMEOUT_MS },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-watchdog-drill-"));
    tempDirs.add(dir);
    const verdictPath = join(dir, "verdict.json");
    const logPath = join(dir, "run.log");

    const child = spawn(process.execPath, [
      watchdogPath,
      "--verdict", verdictPath,
      "--log", logPath,
      "--poll-ms", "250",
      "--stall-cap-ms", "3000",
      "--",
      process.execPath,
      "-e",
      // Whole body is a long-interval timer: burns no CPU, writes no output — the exact
      // "stalled" precondition.
      "setInterval(() => {}, 1e9)",
    ]);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    assert.equal(exitCode, DEFAULTS.stallExitCode);
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
    assert.equal(verdict.stalled, true);
    assert.equal(verdict.verdict, "stalled");
  },
);

test(
  "Test 10: the wrapper propagates a real non-zero child exit code (anti-masking)",
  { timeout: DRILL_TIMEOUT_MS },
  async () => {
    const dir = mkdtempSync(join(tmpdir(), "gsd-watchdog-drill-"));
    tempDirs.add(dir);
    const verdictPath = join(dir, "verdict.json");
    const logPath = join(dir, "run.log");
    // Arbitrary, distinct from DEFAULTS.stallExitCode (87) / DEFAULTS.hardCapExitCode (88) —
    // a pass on this code cannot be a coincidence with either watchdog-owned code.
    const DISTINCTIVE_EXIT_CODE = 47;

    const child = spawn(process.execPath, [
      watchdogPath,
      "--verdict", verdictPath,
      "--log", logPath,
      "--poll-ms", "250",
      "--stall-cap-ms", "3000",
      "--",
      process.execPath,
      "-e",
      `process.exit(${DISTINCTIVE_EXIT_CODE})`,
    ]);

    const exitCode = await new Promise<number | null>((resolve) => {
      child.on("exit", (code) => resolve(code));
    });

    assert.equal(exitCode, DISTINCTIVE_EXIT_CODE);
    const verdict = JSON.parse(readFileSync(verdictPath, "utf8"));
    assert.equal(verdict.exitCode, DISTINCTIVE_EXIT_CODE);
  },
);
