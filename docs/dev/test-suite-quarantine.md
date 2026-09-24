# Test suite quarantine and runtime expectations

This document makes a green unit-suite number auditable. A pass count alone means nothing without
a bounded scope and a known skip set — this file is the scope and the skip set, plus what to expect
from the two files historically mistaken for hangs. It closes INC-2026-08-26-02.

## 1. Scope

The unit suite is defined by `test:unit:compiled`'s explicit glob list in `package.json`, plus
`test:live-workflow:unit`'s glob. Anything not named by one of these globs is out of scope for "the
unit suite is green" — most notably everything under `tests/integration/` subdirectories, which is
covered by `test:integration` instead (a separate, unrelated gate).

`test:unit:compiled` runs against **compiled** `dist-test/` output (see `test:compile`) and globs
exactly these directories, non-recursively (`*.test.js` / `*.test.mjs`, no `**`, so nested
`integration/` subfolders are excluded by construction, not by an explicit exclude rule):

- `dist-test/src/tests/*.test.js`
- `dist-test/src/resources/extensions/gsd/tests/*.test.js`
- `dist-test/src/resources/extensions/gsd/tests/*.test.mjs`
- `dist-test/src/resources/extensions/shared/tests/*.test.js`
- `dist-test/src/resources/extensions/subagent/tests/*.test.js`
- `dist-test/src/resources/extensions/claude-code-cli/tests/*.test.js`
- `dist-test/src/resources/extensions/cursor-cli/tests/*.test.js`
- `dist-test/src/resources/extensions/github-sync/tests/*.test.js`
- `dist-test/src/resources/extensions/universal-config/tests/*.test.js`
- `dist-test/src/resources/extensions/visual-brief/tests/*.test.js`
- `dist-test/src/resources/extensions/voice/tests/*.test.js`
- `dist-test/src/resources/extensions/mcp-client/tests/*.test.js`
- `dist-test/src/resources/extensions/remote-questions/tests/*.test.js`

`test:live-workflow:unit` adds one more, run directly against source (no compile step, `tsx`):

- `tests/live-workflow/*.unit.test.ts`

**Out of scope for this document / for GREEN-06:** `test:integration`, `test:packages`,
`test:e2e`, and `test:live-workflow` (the non-`:unit` live-workflow run). A green unit suite is not
a green repository — it is a bounded claim about exactly the globs above.

## 2. Gate command

The gate for GREEN-06 is:

```bash
pnpm run test:unit:native
```

**Not** `pnpm run test:unit`. `test:unit` expands to `test:compile && test:unit:compiled &&
test:live-workflow:unit` — it performs none of the native fault-injection steps, so
`migrate-safety-audit.test.ts`'s ~47 fault-injection cases stay red under it (the real Rust
`set_mutation_boundary_fault_for_test` capability is never built or wired in). Historically CI only
passed because `ci.yml` ran those steps inline as separate workflow steps that no local command
reproduced.

`test:unit:native` is `test:unit` plus three native steps, in the required order, followed by the
same trailing `test:live-workflow:unit` run:

1. `build:native:test` — builds the native addon from source with the `test-fault-injection` Cargo
   feature enabled (`native/scripts/build.js --dev --test-fault-injection`).
2. `native:addon:mirror` — mirrors the built `native/addon/*.node` into `dist-test/native/addon/`
   (a fail-loud, idempotent script; `test:compile`'s stale-artifact prune runs before this, never
   after, or the mirrored file would be deleted).
3. The compiled suite runs with `GSD_NATIVE_PREFER_LOCAL=1`, which makes the loader resolve the
   freshly-built local addon instead of the pinned npm binary that ships without fault-injection
   hooks.

`test:unit:native`'s coverage is a **superset** of `test:unit`, not a subset — everything `test:unit`
covers, plus the real fault-injection path.

## 3. Skip inventory

A fresh scan (`grep -rn 'skip: true\|test\.skip\|it\.skip\|describe\.skip\|todo: true'` across every
directory named in Scope above, including `tests/live-workflow/*.unit.test.ts`) found exactly **one**
in-scope skip and one adjacent-but-out-of-scope skip. No `test.skip`, `it.skip`, `describe.skip`, or
`{ todo: true }` forms exist anywhere in scope — both hits use the `{ skip: true }` options-object
form.

| File | Line | Test name | Reason | Un-skip condition |
|---|---|---|---|---|
| `src/resources/extensions/gsd/tests/markdown-renderer.test.ts` | 582 | `renderPlanFromDb creates parse-compatible slice plan + task plan files` | Skipped 2026-06-23 (commit `51c42bfcf`, "skip stale-render tests during flat-phase transition") as one of a batch of 9 stale-render/renderer tests disabled while `detectStaleRenders` was temporarily hardcoded to return `[]`. The test body has since been rewritten in place for the flat-phase model (asserts zero per-task plan files, reads the stored plan artifact directly instead of per-task files — see lines 640-664), but the `{ skip: true }` marker was never removed alongside that rewrite. | `detectStaleRenders` was reactivated via projection-drift detection in commit `1990a8b4` (2026-09-14, "Re-enable ADR-045 stale-render detection via projection drift"). Run this file standalone with `{ skip: true }` removed; if the flat-phase-rewritten body passes, delete the marker. **Flagged as needing owner confirmation** — this documentation pass verified the body reads as flat-phase-correct by inspection but did not remove the marker or re-run the test, per this plan's prohibition on touching skip state. |
| `src/resources/extensions/gsd/tests/integration/integration-proof.test.ts` | 434 | `recovery: DB loss → migrateFromMarkdown restores state, stale render detection` | **Out of unit-suite scope** — lives under `tests/integration/`, excluded by `test:unit:compiled`'s non-recursive glob (see Scope). Documented here so it is not mistaken for a gap in this inventory. Skipped 2026-06-23 (commit `a336f878c`, "Keep the stale-render integration test skipped, consistent with the full disable above") for the same root cause as the row above: `detectStaleRenders` was hardcoded to return `[]` because the per-project layout gate (`isLegacyMilestonesLayout`) was unreliable — `git-service.ts` creates `milestones/<mid>/` dirs for integration-branch metadata even in flat-phase projects, which was triggering a reconciliation failure loop. | Same reactivation as the row above (`1990a8b4`, 2026-09-14) may have resolved the underlying cause. Run this file standalone with `{ skip: true }` removed and confirm the R010 (DB-loss recovery)/R013 (stale-render detection) scenario passes under the reactivated implementation. Not gating for GREEN-06 since it is out of scope, but **flagged as needing owner confirmation** since the disabling condition may no longer hold. |

## 4. Phase 19 delta

**Skips before Phase 19: 2. Skips after Phase 19: 2.** Equal — Phase 19 added zero new skips to the
unit-suite scope (or to its out-of-scope adjacent file). Both rows above pre-date this phase by three
months (2026-06-23); Phase 19's plans (19-01 through 19-05) touched none of the files or lines
carrying a skip marker, confirmed by the fresh scan finding the same two hits documented here and
nothing else.

## 5. Runtime expectations

Two files in this scope are legitimately slow — long enough that a prior operator, without a written
baseline, mistook each for a hang and killed the run (Phase 11, Phase 12 Plan 2, Phase 16 Plan 5; see
`.planning/STATE.md` Blockers/Concerns). Their measured standalone durations, from the plans that
directly timed them:

| File | Measured standalone duration | Source | Why it's slow |
|---|---|---|---|
| `src/resources/extensions/gsd/tests/legacy-import-live-restore-fault.test.ts` | 263,528 ms (263.5 s) | 19-03-SUMMARY.md, post two-phase restructure (down from a 373,551 ms pre-optimization baseline) | 21 test cases spawn real OS child processes and SIGKILL them to exercise crash-recovery boundaries; two of the four boundary-matrix tests run a bounded-concurrency (4-lane) execute phase, the rest are sequential by correctness necessity (they hold a process-global SQLite adapter handle across awaits). |
| `src/resources/extensions/gsd/tests/migrate-safety-audit.test.ts` | 88,482 ms (88.5 s) | 19-04-SUMMARY.md | 155 test cases exercise the real Rust `set_mutation_boundary_fault_for_test` fault-injection capability against the native addon; many individual cases run 1-2.5 s each, and there is no shortcut — each case needs a genuine mutation-boundary crash simulation. |

**Diagnostic rule for telling real work from a deadlock:** watch the worker process's CPU usage,
not just wall-clock silence between TAP output lines.

- **Sustained CPU on the worker with no reporter output** → real work (spawning/waiting on child
  processes, running native fault-injection cases). This is expected and can legitimately run for
  1-5 minutes per file above without a line of new output.
- **Near-zero CPU with no live child process** (check `ps aux --sort=-%cpu` for the worker and any
  spawned children) → an actual hang. Both files above now carry explicit per-test timeouts
  (`BOUNDARY_TEST_TIMEOUT_MS` = 300 s in `legacy-import-live-restore-fault.test.ts`,
  `CHILD_DEADLINE_MS` for spawned children) so a genuine future deadlock fails loudly with a named
  timeout inside 5 minutes instead of parking the whole sweep indefinitely — this is the fix 19-03
  shipped for the "mistaken for a hang" defect itself, independent of the raw duration numbers above.

**Total expected wall clock for `pnpm run test:unit:native`:** budget at least 15 minutes. The two
files above alone account for roughly 5-6 minutes combined; the native build step
(`build:native:test`) adds another 1-2 minutes on a warm Cargo cache; the remainder of the
`test:unit:compiled` glob (well over a thousand additional test files) and the trailing
`test:live-workflow:unit` run add the rest. A future operator should size their patience against this
number, not against the historical instinct to kill anything running longer than a minute or two.

<!-- Runtime total below updated to the actual measured value from Task 2's run -->
**Measured total (this run):** *(filled in by Task 2 — see below)*
