# Agentic Tester — Auto-Gate Integration (Approach-A follow-on)

**Date:** 2026-09-21
**Status:** Design — approved shape, pending spec review
**Follows:** `docs/superpowers/specs/2026-09-20-agentic-tester-port-design.md` (v2 "Agentic Tester Port", Approach B — brains-first pilot)
**Milestone framing:** this is the deferred "Approach-A follow-on" the v2 design named as out of scope (`2026-09-20-…-design.md:65-69`).

---

## 1. Context & motivation

v2 shipped the agentic tester as a **manually-invocable** capability only: the `agentic-tester`
persona + verification-spine skill + three driver playbooks + the `/gsd verify-agentic` command +
the `.gsd/verify-agentic/` SELF-UAT writer. It is reachable via that command or by hand-dispatch —
there is **no automatic lifecycle gating**.

This design adds the deferred auto-gate: the tester runs **automatically as a blocking Gate-1
self-UAT** inside pi-gsd's own DB-backed execute lifecycle, and feeds a **Gate-2 human-UAT ledger**
that blocks milestone completion until a human signs off. The behavioral target is parity with the
control-plane GSD pattern (`gsd-agentic-tester` at `verify:post` + `HUMAN-UAT-PENDING.md`), adapted
to pi-gsd's DB-authoritative model.

### Correction to the v2 design's premise

The v2 design named `src/resources/extensions/gsd/gate-registry.ts` as "the eventual home for
auto-gating." Reconnaissance shows that is the **wrong seam**: `gate-registry.ts` is a static,
prompt-driven declaration of the Nyquist quality gates (`Q3–Q8`, `MV01–MV04`) — pure lookups, no
code execution, no subagent dispatch. It is evaluated *inside* a workflow turn's prompt and persisted
to the `quality_gates` DB table; it is unrelated to running a subagent.

The correct seam is pi-gsd's **post-unit hook engine** — the structural twin of control-plane's
`verify:post` step:
- fires between units in the execute loop at `auto-post-unit.ts:2870` (`checkPostUnitHooks(...)`),
- dispatched/queued by `rule-registry.ts` (`evaluatePostUnit` `:368`, `_startHook` `:536`) via
  `post-unit-hooks.ts` (`checkPostUnitHooks` `:26`),
- configured by **preferences** (`preferences.ts` `resolvePostUnitHooks` `:1203`, reading
  `prefs.preferences.post_unit_hooks`), not by code,
- with a config contract (`PostUnitHookConfig`, `types.ts:304-332`) that already carries every field
  an auto-gate needs: `after: string[]`, `criticality: "advisory"|"blocking"`, `agent`, `prompt`,
  `artifact`, `on_block.action`, `max_cycles`, `retry_on`, `model`, `enabled`.

This design targets the post-unit hook engine. `gate-registry.ts` is left untouched.

---

## 2. Goals / Non-goals

**Goals**
- The tester runs automatically as a **blocking** Gate-1 self-UAT after each `complete-slice`.
- Its verdict is **machine-readable** so the hook engine can route on it.
- A behavior **FAIL** auto-routes to a bounded gap-closure loop (cap 3), then escalates.
- A **PARTIAL** registers a deferred **Gate-2 human-UAT** item and does not block the slice.
- Milestone completion is **blocked** while any Gate-2 item is still `pending`.

**Non-goals**
- Porting the remaining control-plane GSD capabilities (milestone orchestrators, etc.) — future ports.
- Changing the manual `/gsd verify-agentic` command surface (it stays; it shares the prompt template).
- Touching `gate-registry.ts` / the Nyquist `quality_gates` path.
- Gating at `execute-task` granularity (rejected: too many live dispatches, most tasks aren't
  independently user-verifiable).

---

## 3. Decisions (locked)

| # | Decision | Choice |
|---|----------|--------|
| D1 | Gate fires on which unit | **`complete-slice`** (phase-equivalent), one Gate-1 per slice |
| D2 | FAIL behavior | **Auto gap-closure loop, cap 3**, then escalate/pause (control-plane parity) |
| D3 | Gate-2 ledger home | **New DB table + `.gsd/` projection** (pi-gsd is DB-authoritative) |
| D4 | Rollout | **Opt-in preference toggle, default-OFF** for the pilot; flip on once proven |
| D5 | Who writes the Gate-2 row | **Host-side gate-completion logic** — the subagent stays strictly diagnose-only |
| D6 | Sequencing | **Slice A** (P1+P2+P3+P5, the working blocking gate) → **Slice B** (P4, the Gate-2 ledger) |

---

## 4. Architecture & data flow

```
complete-slice
   └─▶ post-unit hook "agentic-gate1"  (criticality: blocking; enabled iff toggle on)
        1. derive {target, criteria, surface} from the completed slice's DB row
        2. dispatch agentic-tester subagent (diagnose-only) via the hook engine's
           synthetic hook/<name> unit  →  writes .gsd/verify-agentic/…-SELF-UAT.md
                                          (now WITH machine-readable frontmatter)
        3. host reads the artifact frontmatter verdict:
             all_pass    → verdict: pass          → clear block, continue
             has_partial → verdict: advisory      → clear block + write Gate-2 ledger row (Slice B)
             has_fail    → verdict: needs-rework  → on_block: gap-closure loop (cap 3)
                                                     ├─ route to pi-gsd rework/task model
                                                     ├─ re-run gate
                                                     └─ at cap 3 → pause for human (_pauseForGate)
milestone completion (validate-milestone path)
   └─▶ close guard: refuse while any human_uat_pending row is `pending`  (Slice B)
```

---

## 5. Components

### P1 — Machine-readable verdict channel *(prerequisite; foundational — nothing gates without it)*
The ported `renderSelfUat` (`verify-agentic-log.ts:130-165`) writes plain markdown with **no
frontmatter and no aggregate verdict**; `SelfUatCriterionResult.verdict` is `"PASS"|"FAIL"` only.
pi-gsd's hook engine reads verdicts from artifact **frontmatter** via `extractFrontmatterVerdict`
(`verdict-parser.ts:37`), expecting the enum `pass|advisory|needs-rework|needs-remediation|needs-attention`
(`types.ts:283-288`).

Changes:
- Extend `write-self-uat.mjs` + `verify-agentic-log.ts` to emit YAML frontmatter on the SELF-UAT log:
  - `result: all_pass | has_fail | has_partial` — aggregate, derived from per-criterion verdicts
    (parity with control-plane's `result` field, human/telemetry facing);
  - `verdict: pass | needs-rework | advisory` — the hook-enum value the engine reads directly (so
    `extractFrontmatterVerdict` needs no change). Mapping: `all_pass→pass`, `has_fail→needs-rework`,
    `has_partial→advisory`.
- Add `PARTIAL` to `SelfUatCriterionResult.verdict` (today `PASS|FAIL`) so a criterion can be
  genuinely deferred/infra without a fake pass; the aggregate `result` becomes `has_partial` when any
  criterion is `PARTIAL` and none is `FAIL`.
- Preserve the existing markdown body verbatim (backward compatible with the manual command + the
  four rejection guards in `renderSelfUat`).

### P2 — The gate (post-unit hook registration)
Register a `PostUnitHookConfig` in preferences (`post_unit_hooks`):
```
{ name: "agentic-gate1",
  after: ["complete-slice"],
  criticality: "blocking",
  enabled: <toggle>,               # D4 — default off
  agent: "agentic-tester",
  prompt: <the verify-agentic prompt template, parameterized>,
  artifact: ".gsd/verify-agentic/<slug>-<ts>-SELF-UAT.md",
  on_block: { action: "queue-slice" },   # D2
  max_cycles: 3 }
```
Dispatch flows through the hook engine's synthetic `hook/<name>` unit (`_startHook`
`rule-registry.ts:536`), which carries its own `agent`+`prompt`+`model` — so the manual command's
`pi.sendMessage(triggerTurn)` primitive is **not** reused; only the prompt template and the
`agentic-tester` agent id carry over. Self-gates on the toggle (D4) and on the slice actually having
acceptance criteria (P3).

### P3 — Target/criteria derivation from the DB
Today `resolveTarget` (`commands-verify-agentic.ts:180`) infers a slice from the filesystem and
criteria default to a generic note. For the auto-gate, derive `{target, criteria, surface}` from the
completed slice's DB row — `slices.success_criteria` / `slices.full_uat_md`
(`db-base-schema.ts:166-168`, currently unused by the tester). Surface defaults per project/slice
metadata (fallback `cli`). If a slice has no acceptance criteria, the gate self-skips (advisory
no-op), never a false FAIL.

### P4 — Gate-2 human-UAT ledger *(Slice B; DB table + projection)*
Greenfield — pi-gsd has no ledger table and no `HUMAN-UAT-PENDING.md` equivalent.
- New table `human_uat_pending` (migration in `db-base-schema.ts`): one row per slice/phase, columns
  `{ milestone_id, slice_id, slug, status, gate1_verdict, self_uat_path, registered_at, signed_off_at, signed_off_by }`,
  `status ∈ pending | signed-off | signed-off-with-gap`.
- Read projection: `.gsd/HUMAN-UAT-PENDING.md`, regenerated from the table (parity with the
  control-plane read surface; DB stays authoritative).
- Writer (D5): on `has_partial` (and on `has_fail` that escalates at cap), the **host-side
  gate-completion logic** (`_assessConfiguredHookCompletion`, `rule-registry.ts:645`) inserts/updates
  the row — the subagent never writes it, staying diagnose-only.
- Read/drain surface: a `verify-agentic`/`uat-ledger`-style command or DB query for
  `read | drain(signed-off|signed-off-with-gap)`.
- **Close guard:** the `validate-milestone`/complete path refuses milestone completion while any
  `pending` row remains (the guard pi-gsd lacks today; control-plane analog `milestone.cjs:715-730`).

### P5 — FAIL → gap-closure routing
On `has_fail` → `needs-rework` → `on_block.action` drives a bounded loop through pi-gsd's existing
rework/task model (`rework_briefs` + `rework_brief_findings` `db-base-schema.ts:251,262`; re-queue
via `queue-slice`). Re-run the gate after each closure cycle; count cycles; at `max_cycles: 3` pause
for human recovery (`_pauseForGate`). This resolves the v2 design's open question
(`2026-09-20-…-design.md:132`, "how gap-closure routing maps onto pi-gsd's DB-backed task model") by
mapping the tester's markdown gap-closure route onto `rework_briefs`.

---

## 6. Data model changes (summary)
- SELF-UAT artifact: **+ YAML frontmatter** (`result`, `verdict`); `SelfUatCriterionResult.verdict`
  **+ `PARTIAL`**.
- New DB table **`human_uat_pending`** (+ migration) and a `.gsd/HUMAN-UAT-PENDING.md` projection.
- New preference entry under `post_unit_hooks` + one toggle key (D4).
- No changes to `gate-registry.ts`, `quality_gates`, or `gate_runs`.

---

## 7. Testing strategy (TDD)
- **P1**: unit tests that `renderSelfUat` emits the correct frontmatter `result`/`verdict` for
  all-pass / has-fail / has-partial inputs, incl. the new `PARTIAL` criterion; the four rejection
  guards still fire; markdown body unchanged.
- **P2/P3**: hook-engine test — a `complete-slice` with criteria queues the blocking `agentic-gate1`
  hook, derives target/criteria from the slice row, and routes on a stubbed artifact verdict
  (pass→clear, needs-rework→on_block, advisory→clear+register); a slice without criteria self-skips.
- **P5**: gap-closure loop drives ≤3 cycles then pauses; each cycle writes a `rework_brief`.
- **P4**: `human_uat_pending` insert on has_partial; projection regen matches table; drain flips
  status; **close guard blocks** while a `pending` row exists and allows once drained.
- All headless; no live LLM dispatch required in the suite (verdict artifacts are stubbed).

---

## 8. Scope & sequencing
- **Slice A** — P1 + P2 + P3 + P5: the working blocking Gate-1 (verdict channel, hook registration,
  DB-derived criteria, FAIL→gap-closure). Delivers the auto-gate end-to-end. Also lands this doc's
  seam correction in the codebase's own docs if any reference the old premise.
- **Slice B** — P4: the Gate-2 ledger table + projection + drain surface + milestone-close guard.

Slice A is independently valuable (auto Gate-1 with FAIL routing); Slice B adds the human Gate-2
backstop. Build A, prove it with the toggle off→on, then B.

---

## 9. Open questions
Resolved by decisions above (D1–D6). Remaining, to settle in planning:
- Exact preference-schema key names + where the toggle is surfaced (config wizard vs. bare pref).
- Whether the read/drain surface is a new `/gsd` subcommand or reuses a `verify-agentic` subcommand
  namespace.
- `surface` auto-derivation heuristic when a slice doesn't declare one (default `cli` vs. infer).

---

## 10. Key integration-surface references
- Hook engine: `auto-post-unit.ts:2870`, `rule-registry.ts:{368,536,645}`, `post-unit-hooks.ts:26`,
  `preferences.ts:1203`, contract `types.ts:{283-332}`, verdict parse `verdict-parser.ts:37`.
- Tester write path: `commands-verify-agentic.ts:{180,223,318}`, `verify-agentic-log.ts:{23,130,193}`,
  `src/resources/skills/agentic-tester/write-self-uat.mjs`, `prompts/verify-agentic.md`.
- DB: `db-base-schema.ts:{132,155,166,183,251,262,293,321}`, `gsd-db.ts`, `db-gate-rows.ts`.
- Wrong seam (left untouched): `gate-registry.ts` (Nyquist prompt gates only).
- Control-plane reference pattern: `~/.claude/gsd-core/bin/lib/capability-registry.cjs:86-100`
  (`verify:post` hook), `workflows/execute-phase.md:1291-1397`,
  `workflows/verify-work-agentic.md:248-289` (verdict + `register_gate2`),
  `bin/lib/milestone.cjs:{3142,3408,3489,3583,3644,715-730}` (ledger + close guard).
