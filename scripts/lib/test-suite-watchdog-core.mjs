// Project/App: gsd-pi
// File Purpose: Pure liveness-classification core for the test-suite watchdog (GREEN-01,
// D-03). No I/O, no clock reads — every value the classifier needs arrives as a plain
// argument so it is unit-testable without real timers or real processes (the
// `workflow-worker-heartbeat.ts` Deps-object DI shape, applied to a pure decision fn
// instead of an injected-deps object since there is nothing here to inject).

/**
 * Tuned constants for `scripts/test-suite-watchdog.mjs`. Each value is justified against a
 * measured number from `docs/dev/test-suite-quarantine.md` §5 ("Runtime expectations") — do
 * not tighten `stallCapMs`/`hardCapMs` without re-reading that section; a watchdog that kills
 * legitimate work is worse than no watchdog (T-22-02).
 */
export const DEFAULTS = Object.freeze({
  // 5 s sampling cadence — frequent enough to catch a stall inside the cap without adding
  // meaningful `ps -eo` overhead to a contended host.
  pollMs: 5000,
  // 7 min. Clears the 263,528 ms (263.5 s) legacy-import-live-restore-fault.test.ts quiet
  // window documented in docs/dev/test-suite-quarantine.md §5 with roughly 1.6x headroom.
  stallCapMs: 420000,
  // 45 min. Roughly 2.8x the measured 953 s (15 m 53 s) full `test:unit:native` chain wall
  // clock from docs/dev/test-suite-quarantine.md §5 — sized against THIS contended host, not
  // a quiet CI box.
  hardCapMs: 2700000,
  // Distinct non-zero exit code reserved for a stall kill, so it is never mistaken for a
  // normal child failure (the anti-masking guard this plan exists to ship — GREEN-01).
  stallExitCode: 87,
  // Distinct non-zero exit code reserved for a hard-cap kill, same rationale as above.
  hardCapExitCode: 88,
});

/**
 * Classify one liveness sample into exactly one of four verdicts. Pure function: no I/O, no
 * clock reads — `sample` and `thresholds` carry every number this decision needs.
 *
 * `descendantCount === 0` is required for `"stalled"` because a live descendant means the
 * supervised tree is still structurally doing something even when the parent process itself
 * is idle — this is the precise docs/dev/test-suite-quarantine.md §5 rule: "near-zero CPU
 * with no live child process" is the actual hang signature, not near-zero CPU alone.
 *
 * @param {{cpuMsDelta: number, outputBytesDelta: number, descendantCount: number, quietMsElapsed: number, totalMsElapsed: number}} sample
 * @param {{stallCapMs: number, hardCapMs: number}} thresholds
 * @returns {"progressing" | "quiet-but-live" | "stalled" | "hard-cap"}
 */
export function classifyLiveness(sample, thresholds) {
  const { cpuMsDelta, outputBytesDelta, descendantCount, quietMsElapsed, totalMsElapsed } = sample;
  const { stallCapMs, hardCapMs } = thresholds;

  // Hard cap wins unconditionally, even over a currently-progressing sample — an absolute
  // wall-clock ceiling regardless of the other signals.
  if (totalMsElapsed >= hardCapMs) return "hard-cap";

  // Either CPU time or output bytes growing resets the caller's quiet timer. A CPU-burning,
  // silent child (the 263.5 s slow-file shape) is never stalled.
  if (cpuMsDelta > 0 || outputBytesDelta > 0) return "progressing";

  // Both deltas are 0 past this point. Only a quiet AND childless tree is a stall — any live
  // descendant, at any quiet duration, keeps the verdict at "quiet-but-live".
  if (quietMsElapsed >= stallCapMs && descendantCount === 0) return "stalled";

  return "quiet-but-live";
}
