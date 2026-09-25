---
phase: 21-residual-high-disposition-execute-enforcement
plan: 03
subsystem: workflow-orchestration
tags: [tracker, plan-review-convergence, milestone-completion, sqlite, node-test]

requires:
  - phase: 21-residual-high-disposition-execute-enforcement
    provides: "plan-review-residual-disposition.ts's summarizeResidualHighForMilestone (authored by plan 21-01)"
provides:
  - "residualHighSummary derived field on MilestoneCompletionReceipt, computed post-commit beside residualCapture"
  - "residualHighSummary threaded from the canonical receipt onto CompleteMilestoneResult"
  - "The conditional run-end residual-HIGH suffix on executeCompleteMilestone's genuine-completion message"
  - "summarizeResidualHighForMilestone status-exclusion fix: resolved/closed/wont-fix rows no longer count as residual"
affects: []

actuals:
  tokens: 7410
  tasks: 2
  commits: 5

tech-stack:
  added: []
  patterns:
    - "Read-only, in-memory reduce over the tracker table, run post-commit strictly outside executeDomainOperation's callback — mirrors GREEN-05/D-05's residualCapture placement exactly, so a summary computation can never roll back a committed milestone."
    - "Conditional message-arm suffix (empty string unless count>0) appended to exactly one arm of an existing ternary ladder, leaving sibling arms and the details object untouched — proven by dedicated regression tests seeding the same fixture data against the other arms."

key-files:
  created: []
  modified:
    - src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts
    - src/resources/extensions/gsd/tools/complete-milestone.ts
    - src/resources/extensions/gsd/tools/workflow-tool-executors.ts
    - src/resources/extensions/gsd/plan-review-residual-disposition.ts
    - src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts
    - src/resources/extensions/gsd/tests/plan-review-residual-disposition.test.ts
    - src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts

key-decisions:
  - "Fixed summarizeResidualHighForMilestone (owned by plan 21-01) to exclude resolved/closed/wont-fix tracker rows — 'residual' means still outstanding, and the plan's own recompute-not-cache truth requires a resolution between two completion attempts to be reflected on the second. The plan text explicitly authorized this narrowing when a behaviour required it; re-ran 21-01's and 21-02's own suites (54 tests) to confirm no regression."
  - "workflow-tool-executors.test.ts's four pre-existing completion fixtures (2970/3011/3043/3087) all complete through the LEGACY (non-adopted) path, so canonicalReceipt — and therefore residualHighSummary — is always undefined there regardless of tracker contents. Built a new adopted-milestone fixture (makeAdoptedCompletableMilestone + seedCompletedTaskAuthority + a real validate_milestone call) to get genuine positive suffix coverage, and reused the existing legacy fixtures only for the already-complete/stale regression checks (where residualHighSummary being undefined either way is the correct, unaffected behavior)."
  - "Did not edit REQUIREMENTS.md to mark CONV-05 complete: .planning/ lives only in the main checkout (gitignored, not part of this git worktree), is shared across this wave's parallel plans, and plan 21-02 is concurrently writing to the same file's CONV-04 row. Editing it here risked a Read-then-Write race with a sibling worktree agent. CONV-05 is fully implemented and proven (see Coverage below); the orchestrator should run requirements mark-complete CONV-05 after the wave merges, following the same reconciliation precedent already established for DATA-01/GATE-04/CERT-01/etc. in this project's history (the tool returns not_found against this project's 'Roadmapped' not-started literal, requiring a direct edit)."

patterns-established:
  - "A message-arm suffix that must not leak into sibling arms is proven by seeding the SAME triggering fixture data (residual-HIGH tracker rows) against copies of those sibling arms' existing tests and asserting byte-for-byte equality with their pre-change text — not just by omission in the new positive tests."

requirements-completed: [CONV-05]

coverage:
  - id: D1
    description: "completeMilestone()'s receipt carries a residualHighSummary {count, phases} field derived from tracker rows tagged plan-review-residual-high AND milestone:{id}, counting every disposition (must-fix-in-execute, rescope-requirement, deferred-to-phase-N) and de-duplicating phases in first-seen order."
    requirement: "CONV-05"
    verification:
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone's residualHighSummary counts every disposition and lists distinct phases in first-seen order"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone's residualHighSummary de-dups the phase list: two rows on one phase count as 2 rows, 1 phase"
        status: pass
    human_judgment: false
  - id: D2
    description: "The Phase 19 closeout-residual class and other milestones' rows are excluded from the count; a milestone with zero residual-HIGH rows yields {count:0, phases:[]}."
    requirement: "CONV-05"
    verification:
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone's residualHighSummary excludes Phase 19 closeout-residual rows even at severity HIGH"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone's residualHighSummary excludes rows scoped to a different milestone"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone's residualHighSummary is {count:0, phases:[]} for a milestone with zero residual-HIGH rows"
        status: pass
    human_judgment: false
  - id: D3
    description: "The summary is recomputed from the tracker on every completion call rather than cached: a residual HIGH resolved between two completion attempts is reflected on the next call. Fixed summarizeResidualHighForMilestone to exclude resolved/closed/wont-fix rows to make this true."
    requirement: "CONV-05"
    verification:
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts#completeMilestone recomputes residualHighSummary on each call rather than caching it: a resolution between two completions is reflected on the second"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/plan-review-residual-disposition.test.ts#summarizeResidualHighForMilestone > excludes a resolved row from the count: 'residual' means still outstanding"
        status: pass
    human_judgment: false
  - id: D4
    description: "executeCompleteMilestone's genuine-completion message ends with ' — shipped with N residual HIGH across phases X, Y.' only when count>0; the zero case is byte-identical to the pre-change message; the historical, stale, and alreadyComplete arms and the details object are untouched even with residual-HIGH rows present."
    requirement: "CONV-05"
    verification:
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's genuine-completion message ends with the residual-HIGH suffix when the tracker holds 2 rows across 2 phases"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's genuine-completion message renders the singular '1 residual HIGH' for one row"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's genuine-completion message is byte-identical to its pre-change form when there are zero residual-HIGH rows"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's details object gains no key between the zero-residual and two-residual genuine-completion cases"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's already-complete arm is unaffected by residual-HIGH rows seeded for the same milestone"
        status: pass
      - kind: unit
        ref: "src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts#executeCompleteMilestone's stale arm is unaffected by residual-HIGH rows seeded for the same milestone"
        status: pass
    human_judgment: false

duration: ~55min
completed: 2026-09-24
status: complete
---

# Phase 21 Plan 3: Run-End Residual-HIGH Visibility Summary

**`completeMilestone()`'s receipt now carries a tracker-sourced `residualHighSummary` and `executeCompleteMilestone`'s genuine-completion message appends " — shipped with N residual HIGH across phases X, Y." whenever a milestone closes with outstanding plan-review residual HIGH concerns.**

## Performance

- **Duration:** ~55 min
- **Tasks:** 2 (both TDD: RED → GREEN)
- **Files modified:** 7 (3 production files touched beyond the plan's declared scope on `plan-review-residual-disposition.ts`, explicitly authorized by the plan text; 3 test files)

## Accomplishments

- `MilestoneCompletionReceipt` gained a required `residualHighSummary: { count, phases }` field, computed via `summarizeResidualHighForMilestone(milestoneId)` immediately after `captureMilestoneCloseoutResiduals` and before `storedCompletionPayload` — read-only, in-memory, never throws, never cached.
- `CompleteMilestoneResult` gained an optional `residualHighSummary`, threaded from the canonical receipt in `handleCompleteMilestone`'s final return spread, alongside `operationId`/`resultingRevision`. The earlier `!isCurrent` historical early return deliberately does not carry it.
- Fixed a genuine bug in `summarizeResidualHighForMilestone` (owned by plan 21-01): it counted ALL rows carrying the class marker + milestone scope tag regardless of `status`, so a *resolved* residual HIGH would still inflate the run-end count. Added the same status exclusion `findBlockingMustFixInExecuteItems` already uses (`status !== resolved/closed/wont-fix`) — "residual" means still outstanding. Re-ran 21-01's and 21-02's own suites (54 tests) to confirm zero regression.
- `executeCompleteMilestone`'s genuine-completion message arm (the last branch of the existing four-arm ternary) now appends the conditional suffix; the `historical`, `stale`, and `alreadyComplete` arms and the `details` object are provably untouched — proven by seeding the exact same residual-HIGH fixture data against copies of the pre-existing already-complete and stale tests and asserting byte-for-byte equality with their original text.
- Discovered and worked around a real test-fixture gap: `workflow-tool-executors.test.ts`'s four pre-existing completion tests all use the LEGACY (non-adopted) completion path, where `canonicalReceipt` — and therefore `residualHighSummary` — is always `undefined`. Built a new adopted-milestone fixture (`makeAdoptedCompletableMilestone`, reusing `seedCompletedTaskAuthority`'s real claim/settle/verify chain plus a real `validate_milestone` call) so the positive suffix assertions exercise the actual mechanism rather than a fixture that could never produce it.

## Task Commits

1. **Task 1: Derive residualHighSummary on the completion receipt** (TDD)
   - `28a6c43d` test(21-03): add failing tests for residualHighSummary + status-exclusion fix
   - `45a242df` feat(21-03): derive residualHighSummary on the completion receipt
   - `69ac1b7f` fix(21-03): reword comment so the acceptance grep counts exactly 2 call sites
2. **Task 2: Surface the run-end suffix on the completion message without touching the other three branches** (TDD)
   - `b345b7aa` test(21-03): add failing tests for the run-end residual-HIGH message suffix
   - `59eac3af` feat(21-03): surface the run-end residual-HIGH suffix on the completion message

## Files Created/Modified

- `src/resources/extensions/gsd/milestone-lifecycle-domain-operation.ts` — `residualHighSummary` field + call site
- `src/resources/extensions/gsd/tools/complete-milestone.ts` — `residualHighSummary` optional field + spread threading
- `src/resources/extensions/gsd/tools/workflow-tool-executors.ts` — conditional suffix on the genuine-completion arm
- `src/resources/extensions/gsd/plan-review-residual-disposition.ts` — status-exclusion fix in `summarizeResidualHighForMilestone`
- `src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts` — 7 new tests
- `src/resources/extensions/gsd/tests/plan-review-residual-disposition.test.ts` — 1 new test
- `src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts` — new adopted-milestone fixture + 6 new tests

## Decisions Made

- Fixed `summarizeResidualHighForMilestone`'s status-blindness (Rule 1 — bug: it violated the plan's own recompute-not-cache truth and the plain-language meaning of "residual"). Explicitly authorized by the plan's own action text for Task 1. Verified against 21-01's and 21-02's full suites.
- Built a new adopted-milestone fixture in `workflow-tool-executors.test.ts` rather than trying to force the plan's literal "reuse the existing completion fixtures" instruction, because the existing fixtures structurally cannot produce a populated `residualHighSummary` (LEGACY completion path, no `canonicalReceipt`). Flagged below as a planning-text inaccuracy, not a deviation from the required behavior.
- Did not edit `.planning/REQUIREMENTS.md` to mark CONV-05 complete — see key-decisions above for the race-safety rationale (shared file, sibling worktree agent 21-02 concurrently active). Coverage below fully documents CONV-05's completion for the orchestrator to reconcile post-merge.

## Deviations from Plan

### Auto-fixed Issues

**1. [Rule 1 - Bug fix] `summarizeResidualHighForMilestone` didn't exclude resolved/closed/wont-fix rows**
- **Found during:** Task 1 RED phase (writing the recompute-not-cache test)
- **Issue:** The function (authored by plan 21-01) filtered only on `dispositionTags`, never on `status` — a tracker row resolved between two `completeMilestone()` calls would still count as residual on the second call, contradicting the plan's own must_haves truth #9 and the plain meaning of "residual" (still outstanding).
- **Fix:** Added `item.status !== "resolved" && item.status !== "closed" && item.status !== "wont-fix"` to the filter, mirroring `findBlockingMustFixInExecuteItems`'s existing exclusion.
- **Files modified:** `src/resources/extensions/gsd/plan-review-residual-disposition.ts`
- **Verification:** New unit test in `plan-review-residual-disposition.test.ts`; re-ran 21-01's `plan-review-residual-disposition.test.ts` (19 tests) and 21-01/21-02's `plan-review-convergence.test.ts` + `dispatch-must-fix-in-execute-gate.test.ts` (54 tests total) — all green, zero regression.
- **Committed in:** `45a242df` (Task 1 GREEN commit)

---

**Total deviations:** 1 auto-fixed (1 bug fix, explicitly plan-authorized).
**Impact on plan:** Necessary for CONV-05's stated recompute-not-cache guarantee to actually hold. No scope creep — the plan text itself anticipated and authorized exactly this kind of change.

### Flagged (not a deviation, a planning-text inaccuracy)

Task 2's action text says: "Seed the residual-HIGH rows with `createTrackerItem` against the same database the existing completion fixtures open... For the two regression arms (already-complete, stale), do not duplicate the existing fixtures." This assumes the existing genuine-completion fixture (line 2970) could produce a populated `residualHighSummary` if seeded. It cannot: all four pre-existing completion tests in this file use `seedMilestone`/`seedSlice` raw INSERTs with zero `workflow_item_lifecycles` adoption, so `isMilestoneLifecycleAdopted()` is false, `handleCompleteMilestone` takes the LEGACY branch, `canonicalReceipt` stays `undefined`, and `CompleteMilestoneResult.residualHighSummary` is `undefined` regardless of tracker contents (confirmed by seeding rows against M003 first and observing no change in behavior). The two REGRESSION arms (already-complete, stale) are unaffected by this gap — `residualHighSummary` being undefined either way IS the correct behavior to prove there. But the two POSITIVE suffix tests genuinely needed a milestone that exercises the adopted/canonical path, so a new fixture (`makeAdoptedCompletableMilestone`) was built reusing this file's own `seedCompletedTaskAuthority`/`seedSliceCompletionAuthority` machinery (already used elsewhere in this file for other adopted-path tests) plus a real `validate_milestone` call for authorization. The **substantive** requirement — the suffix appears exactly right on genuine completions, is absent when count is 0, and never leaks into the other three arms — is fully proven; only the specific fixture-reuse instruction needed adjusting.

## Issues Encountered

- The assigned worktree was created without `.planning`, `node_modules`, or `packages/*/dist` — none are part of the git worktree checkout (all gitignored). Per this dispatch's explicit instruction NOT to symlink these from the main checkout, resolved by: (a) reading all `.planning/` context files (PLAN.md, PROJECT.md, STATE.md, prior SUMMARY.md) via absolute path from the main checkout without symlinking; (b) running a real `pnpm install` + `pnpm run build:core` inside the worktree itself. The first `build:core` attempt failed with a TS2345 private-field nominal-typing conflict in `packages/pi-coding-agent` (a pre-existing, order-dependent circular-dependency artifact of the repo's `bootstrap-pi-coding-agent-build.cjs` self-reference workaround — reproducible on any from-scratch clean build, unrelated to this plan's files). Investigated and then discovered it was moot: this repo's `tests/resolve-ts.mjs`/`dist-redirect.mjs` test loader redirects all `@gsd/*`/`@opengsd/*` workspace imports directly to TypeScript SOURCE via `ts.transpileModule`, and `pnpm run typecheck:extensions` only checks `src/resources/extensions` — neither needs a full `packages/*/dist` build. All verification in this plan ran successfully without ever needing `build:core` to succeed. (c) `.planning/phases/21-.../21-03-SUMMARY.md` (this file) had to be created fresh inside the worktree, since the Write tool's sandbox refuses paths outside the worktree root and the main checkout's `.planning` is unreachable for writes; per this dispatch's explicit "SUMMARY.md MUST be committed... any uncommitted SUMMARY.md will be permanently lost" instruction, it is force-added past `.gitignore` in the metadata commit that follows this one. This is an environment-setup gap in the wave's worktree provisioning (missing `.planning` reachability for a project where `.planning` is gitignored and lives only in the main checkout) — flagging here, mirroring plan 21-01's identical finding, for the orchestrator/wave-setup step to address on future worktree-isolated runs of this project.

## Next Phase Readiness

- CONV-05 is fully implemented and proven end-to-end: the receipt, the result type, and the operator-facing message all carry the tracker-sourced residual-HIGH count and phase list, sourced exclusively from `summarizeResidualHighForMilestone` (single source of truth, shared with CONV-04's gate reader via the same module).
- `git diff --stat -- src/resources/extensions/gsd/milestone-summary-projection.ts` is empty — the durable `SUMMARY.md` renderer is deliberately untouched (design decision 5), matching ROADMAP's scope.
- REQUIREMENTS.md CONV-05 checkbox/traceability row still reads `Roadmapped` — needs a direct edit post-wave-merge (this project's established `not_found` reconciliation precedent), see key-decisions.
- No blockers for Phase 21's remaining plan(s) (TRIAGE-04, if not already covered by parallel plan 21-02/21-04).

---

*Phase: 21-residual-high-disposition-execute-enforcement*
*Completed: 2026-09-24*

## Self-Check: PASSED

All 5 commits verified present in `git log`; all 7 modified files verified present on disk with the described changes; all 185 tests in the plan's `<verification>` command block pass; `pnpm run typecheck:extensions` is clean.
