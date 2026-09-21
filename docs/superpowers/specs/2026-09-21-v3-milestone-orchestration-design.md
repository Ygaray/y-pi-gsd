# v3 — Tester Auto-Gate + Milestone Orchestration (close lifecycle + driver ergonomics)

**Date:** 2026-09-21
**Status:** Design — approved shape, seeds the v3 milestone
**Companion:** `docs/superpowers/specs/2026-09-21-agentic-tester-autogate-design.md` (Group A — the auto-gate, detailed there)
**Follows:** v2 "Agentic Tester Port" (shipped 2026-09-20)

---

## 1. What v3 is

v3 makes the ported agentic tester run **automatically inside pi-gsd's milestone lifecycle** (Gate-1
blocking gate + Gate-2 human ledger), and ports the parts of control-plane GSD's **milestone
orchestration** that pi-gsd genuinely lacks — the **close lifecycle** (certify / independent audit /
ship-archive) and a few **driver-ergonomics** gaps. It deliberately does **not** rebuild the milestone
*driver*, because pi-gsd already has one.

Scope = **Groups A + B + C**. Group **D** (per-slice orchestrator-Agent + stage-JSON contract) is
explicitly **deferred to the backlog** (`ROADMAP.md` 999.1).

## 2. Reframe: pi-gsd's native engine already covers most of "orchestration"

Reconnaissance (2026-09-21) established that pi-gsd's auto-loop **already is** the milestone driver:

- **Nested subagent orchestration already exists.** Unit prompts fan out `subagent` children
  mid-turn — the `subagent` core tool (`bootstrap/core-session-tools.ts:17,25`) resolves to native
  Agent classes (`subagent-role-resolver.ts`), write-gate-enforced against per-unit allowlists
  (`write-gate.ts:1356-1398`, `planning-subagent-registry.ts`). Units already do this:
  `gate-evaluate`→tester, `validate-milestone`→parallel reviewers, `research-project`→4 scouts
  (`unit-context-composer.ts:226-232`, `unit-registry.ts:{187,206,302,409,493}`).
- **Sequencing is owned by the DB-derived unit loop** (`deriveState`, `next-unit`, `auto-post-unit`)
  — the role control-plane gives to its "master loop."
- **Completion is already rigorous** — event-sourced, forgery-resistant, DB-trigger-enforced
  transition to `completed` (`milestone-lifecycle-domain-operation.ts:568`,
  `db-milestone-completion-schema.ts:8-72`, readiness re-derived from durable events
  `db/milestone-closeout-readiness.ts:576-865`).
- **Native subjective human-UAT already exists** (`gsd_prepare/answer_milestone_subjective_uat`,
  requires a `user` actor) — a partial Gate-2 analog to build on, not around.

So "port the whole orchestration" is **not** a wholesale rebuild. The genuine gap:

| Capability | pi-gsd today | v3 |
|-----------|--------------|-----|
| Nested subagent dispatch | HAS (`subagent` tool + write-gate) | reuse |
| Milestone sequencing / driver | HAS (DB-derived auto-loop) | reuse |
| Milestone completion transition | HAS (event-sourced → `completed`) | reuse/extend |
| Self-fixing **certify** loop | MISSING (skill-only in control-plane) | **build** (Group B) |
| Independent **cross-slice audit** | PARTIAL (reviewer fan-out, no integration-checker stage) | **adapt** (Group B) |
| **shipped/archived** status + archive | MISSING (stops at `completed`) | **build** (Group B) |
| **Human-UAT (Gate-2) ledger + close guard** | MISSING | **build** — Group A / P4 |
| Milestone **run-log** + `--from N`/resume | PARTIAL (JSONL journal exists) | **adapt** (Group C) |
| **Headless pause-resumer** | MISSING — pause is effectively terminal in `gsd headless auto` | **build** (Group C) |
| UAT/criteria **data model** | inconsistent across tables | **reconcile first** (R7) |
| Per-slice orchestrator-Agent + stage-JSON (D) | PARTIAL (fan-out works; no return contract) | **deferred (backlog 999.1)** |

## 3. Foundational: R7 — UAT/criteria data-model reconciliation

UAT/success-criteria are modeled inconsistently: `milestones.success_criteria` (JSON) vs.
`slices.success_criteria` (free TEXT), milestone UAT in `verification_uat` (plan-time) vs. slice UAT
in `full_uat_md` (completion-time), tasks have no UAT column. Both the DB-derived gate criteria
(Group A P3) and the human-UAT ledger (P4) depend on a coherent shape. **Reconcile this first**
(v3 phase 2) so the gate and ledger build on one representation, not three.

## 4. Group B — Close lifecycle

The stages control-plane runs at milestone close (certify → verify/Gate-2 → audit → complete →
archive), adapted to pi-gsd's DB-authoritative, event-sourced model.

- **Self-fixing certify stage** *(build)* — a milestone-scoped stage that audits every slice's gate
  results (Gate-1 verdicts, quality gates), runs a cross-slice integration check, and self-fixes
  fixable gaps by re-dispatching the owning gate (cap 3, then escalate). Mirrors control-plane
  `certify-milestone`, but reads DB gate state rather than markdown artifacts. Non-auto-fixable gaps
  (behavioral Gate-1 FAIL, integration findings) escalate to the human Gate-2 ledger.
- **Independent cross-slice audit stage** *(adapt)* — extend the existing `validate-milestone`
  reviewer fan-out with a dedicated integration/requirements-coverage pass (the control-plane
  `gsd-integration-checker` analog): verifies cross-slice wiring + that every requirement mapped to a
  slice is satisfied. Reviewer fan-out exists (`unit-context-composer.ts:231`); the integration-checker
  *stage* does not.
- **shipped/archived status + archive close-out** *(build)* — extend the milestone lifecycle beyond
  `completed` with a terminal `shipped`/`archived` state and an archive projection (roadmap/requirements
  snapshot + phase archival), gated by the certify + Gate-2 + audit stages passing. pi-gsd stops at
  `completed` today with no ship/archive.

Human Gate-2 sits in Group A (P4: `human_uat_pending` table + `.gsd` projection + close guard); the
certify/verify stages here are what *populate and drain* it, and the close guard is what blocks
`shipped` while any `pending` row remains.

## 5. Group C — Driver ergonomics

- **Milestone run-log + `--from N`/run-active resume** *(adapt)* — pi-gsd has a structured JSONL
  journal (`journal.ts`, `.gsd/journal/*.jsonl`) but no milestone-scoped run-log with lifecycle-status
  semantics and no `--from N`/`_milestone_run_active` resume. Add milestone-run semantics over the
  existing journal.
- **Headless pause-resumer** *(build — the highest-value driver gap)* — in `gsd headless auto`, a
  needs-human pause is **effectively terminal**: `pauseAuto` sets `paused`, persists
  `runtime_kv:paused_session`, and exits (`auto.ts:2252`, `auto-post-unit.ts:{1712,1726}`,
  `stop-notice.ts:103-119` → exit 10), with no resumer. For unattended milestone runs with
  needs-human handshakes (which the certify escalation and Gate-1 FAIL-at-cap both produce) to work,
  a resumer must detect `paused_session` + a satisfied resume condition and re-enter the loop.

## 6. v3 phase roadmap (seeds `/gsd-new-milestone`)

| # | Phase | Group | Covers |
|---|-------|-------|--------|
| 1 | Verdict channel | A | P1 — machine-readable SELF-UAT frontmatter + `PARTIAL` (prereq) |
| 2 | UAT/criteria data-model reconcile | A/B | R7 (foundational) |
| 3 | Blocking `complete-slice` gate | A | P2+P3 — post-unit hook + DB-derived criteria |
| 4 | FAIL → gap-closure loop | A | P5 — rework routing, cap 3, escalate |
| 5 | Gate-2 human-UAT ledger + close guard | A | P4 |
| 6 | Self-fixing certify + independent audit | B | certify loop + cross-slice integration/requirements audit |
| 7 | Ship/archive close-out | B | shipped/archived status + archive projection |
| 8 | Driver ergonomics | C | run-log + `--from N`/resume + headless pause-resumer |

GSD's roadmap step may split/merge (6 and 8 are each plausibly two phases). Detailed per-phase design
is done by GSD `discuss-phase`/`plan-phase`; Group A's detail lives in the companion auto-gate spec.

## 7. Decisions & non-goals

- **Decisions carried from the auto-gate spec:** gate on `complete-slice`; FAIL → auto gap-closure cap
  3; Gate-2 ledger = DB table + `.gsd` projection; rollout behind an opt-in preference toggle
  (default-off for the pilot); host-side (not subagent) writes the ledger row.
- **Reuse, don't rebuild:** pi-gsd's auto-loop (driver), `subagent` fan-out (nesting), and
  event-sourced completion are reused as-is.
- **Non-goals:** Group D (orchestrator-Agent + stage-JSON) — backlog 999.1; porting other
  control-plane capabilities; a parallel state machine (engage the DB-derived phase model, not a new
  one — the `state-transition-matrix` is advisory-only, `state-transition-matrix.ts:145`).

## 8. Testing
TDD throughout; every stage is exercisable headlessly with stubbed verdict/gate artifacts (no live
LLM dispatch needed in the suite). The headless pause-resumer gets an explicit
pause→persist→resume→re-enter integration test.

## 9. Key integration-surface references
- Driver/loop: `auto.ts:2252`, `auto-post-unit.ts:{1712,1726,2870}`, `unit-registry.ts:107-506`,
  `deriveState`/`next-unit`, `journal.ts`, `run-manager.ts`.
- Nesting: `bootstrap/core-session-tools.ts:{17,25}`, `subagent-role-resolver.ts`,
  `write-gate.ts:1356-1398`, `planning-subagent-registry.ts`, `unit-context-composer.ts:226-232`.
- Completion/close: `milestone-lifecycle-domain-operation.ts:568`,
  `db-milestone-completion-schema.ts:8-72`, `db/milestone-closeout-readiness.ts:576-865`,
  `milestone-subjective-uat-domain-operation.ts:206,296`.
- Auto-gate surface: see the companion spec §10.
- Control-plane reference: `~/.claude/gsd-core/workflows/{execute-milestone,certify-milestone,verify-milestone,audit-milestone,complete-milestone}.md`, `bin/lib/milestone.cjs`.
