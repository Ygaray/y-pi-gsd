# Agentic Tester Port Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Port the control-plane GSD agentic tester (the autonomous, DIAGNOSE-ONLY Gate-1 behavioral self-UAT) onto pi-gsd's own bundled GSD as a working, manually-invocable capability.

**Architecture:** Approach B (brains-first pilot). The tester's *intelligence* — an adversarial verification spine plus a swappable per-surface driver playbook — is carried across as a pi-gsd **skill** run by pi-gsd's existing `tester` read-only-specialist subagent, invoked via a new `/gsd` subcommand. It writes a SELF-UAT log under `.gsd/` and routes behavior FAILs to gap-closure. Auto-gating (gate-registry) and the Gate-2 human-UAT ledger are explicitly deferred to a follow-on (Approach A).

**Tech Stack:** TypeScript (pi-gsd `gsd` extension under `src/resources/extensions/gsd/`), Markdown skills (`SKILL.md`), pi-gsd command dispatcher (`commands/`), Node built-in test runner (`node --test`) / vitest for TS units, `adb` (wired) for Android, the `browser-tools` extension for browser, bash for CLI.

**Spec:** `docs/superpowers/specs/2026-09-20-agentic-tester-port-design.md`

## Global Constraints

- **DIAGNOSE-ONLY:** the tester NEVER edits source code. A behavior FAIL is reported with a root cause and routed to gap-closure. Enforce via the `tester` role's read-only classification; the skill must not use Edit/Write except for the SELF-UAT log and driver-playbook bootstrap.
- **Additive:** do not modify or remove the control-plane GSD tester. This port only adds to `@opengsd/gsd-pi`.
- **pnpm via corepack only** (no global npm installs); Node `>=22.18.0` (host 24.20.0).
- **Android = wired tester only (`…-s22-ultra-2`).** Always `adb -s <usb-serial|ip:port>`; never an unscoped `adb`. Airplane mode is allowed on the wired tester but drops wifi → the driver must re-activate tailscale + wireless adb over wired adb afterward. Never target the personal phone (`…-s22-ultra`).
- **`.planning/` is gitignored in this repo; `docs/` is tracked.** Skill/extension source lives under `src/resources/` (tracked). The SELF-UAT log is a runtime artifact under a project's `.gsd/`, not committed here.
- **Follow existing pi-gsd patterns** for skills (`SKILL.md`), commands (`commands/catalog.ts` + `handlers/`), and subagent classification (`planning-subagent-registry.ts`).

---

### Task 1: Pin the pi-gsd integration contract (discovery)

Porting into pi-gsd's runtime requires the exact, verified signatures for four extension points. This task reads the real code and records the contract the later tasks build on — no signatures are invented downstream.

**Files:**
- Create: `docs/superpowers/plans/agentic-tester-INTEGRATION-CONTRACT.md`

**Interfaces:**
- Produces: `INTEGRATION-CONTRACT.md` documenting, with real file:line refs and signatures —
  1. **Subagent dispatch:** how a `tester` subagent is spawned with a prompt (the spawn call/MCP tool, its parameters, how a persona/system-prompt is supplied). Start from `delegation-policy.ts`, the `subagent` extension, and any `dispatch`/`spawn` in `commands/handlers/`.
  2. **Command registration:** the shape a new `/gsd` subcommand takes — the `catalog.ts` entry, the `dispatcher.ts` routing, and a `handlers/*.ts` handler signature (use `handlers/workflow.ts` and `handlers/core.ts` as models).
  3. **Skill loading:** where bundled skills live and how they're discovered (confirm `src/resources/skills/` vs `src/resources/extensions/gsd/skills/`; read `resource-loader.ts` / `extension-discovery.ts` referenced by `src/cli.ts`).
  4. **`.gsd/` projection write:** the sanctioned way to write a runtime artifact/projection under a project's `.gsd/` (DB-first if a lifecycle record; plain projection file if advisory). Read `state/derive/` and `db/writers/`.

- [ ] **Step 1: Read the four extension points** — `delegation-policy.ts`, the `subagent` extension dispatch path, `commands/{catalog,dispatcher,index}.ts` + two `handlers/*.ts`, the skill loader, and `state/derive` + `db/writers`.
- [ ] **Step 2: Write `INTEGRATION-CONTRACT.md`** capturing each of the four with real signatures + file:line and a one-line "how the tester port uses it".
- [ ] **Step 3: Verify** each documented signature against the source (grep the exact symbol names exist).

Run: `grep -rnE "<each symbol from the contract>" src/resources/extensions/gsd | head`
Expected: every referenced symbol resolves to a real definition.

- [ ] **Step 4: Commit**

```bash
git add docs/superpowers/plans/agentic-tester-INTEGRATION-CONTRACT.md
git commit -m "docs(v2): pin pi-gsd integration contract for agentic tester port"
```

---

### Task 2: Tester persona

Port the adversarial, diagnose-only tester mindset into a pi-gsd persona the `tester` subagent uses.

**Files:**
- Create: `src/resources/extensions/gsd/prompts/agentic-tester-persona.md`
- Reference (source of brains): `~/.claude/agents/gsd-agentic-tester.md`

**Interfaces:**
- Consumes: subagent-dispatch persona mechanism from Task 1 (how a persona/system-prompt is attached to a `tester` dispatch).
- Produces: `agentic-tester-persona.md` — the persona text the dispatch supplies for a tester run.

- [ ] **Step 1: Author the persona** — adapt `gsd-agentic-tester.md`'s role: adversarial "falsify each criterion", DIAGNOSE-ONLY (never edits source), cheapest-sufficient-evidence-layer, route FAIL→gap-closure. Strip control-plane-specific paths; point at the pi-gsd procedure skill (Task 3).
- [ ] **Step 2: Verify** it references only pi-gsd tools and the Task-3 skill (no `.planning/`, no gsd-core workflow paths).

Run: `grep -nE "\.planning/|gsd-core/workflows" src/resources/extensions/gsd/prompts/agentic-tester-persona.md`
Expected: no matches.

- [ ] **Step 3: Commit**

```bash
git add src/resources/extensions/gsd/prompts/agentic-tester-persona.md
git commit -m "feat(v2): agentic tester persona for pi-gsd tester subagent"
```

---

### Task 3: Verification-spine procedure skill

The portable "brains": the platform-agnostic verification spine as a pi-gsd skill.

**Files:**
- Create: `src/resources/skills/agentic-tester/SKILL.md`
- Reference: `~/.claude/gsd-core/workflows/verify-work-agentic.md` (spine), `~/.claude/gsd-core/templates/self-uat.md` (log template)

**Interfaces:**
- Consumes: skill-loading path from Task 1; persona from Task 2.
- Produces: `agentic-tester/SKILL.md` — YAML frontmatter (`name: agentic-tester`, `description`, `allowed-tools`) + a body implementing the spine: `resolve_driver → preflight → build/install → drive_and_verify_each_criterion (cheapest sufficient layer; visual capture only for visual claims) → handle_findings → write_self_uat_log → report`. It selects a driver playbook (Task 4) by surface and reads it at runtime.

- [ ] **Step 1: Author `SKILL.md`** — frontmatter + spine body adapted to pi-gsd (`.gsd/` paths from Task 1's contract; pi-gsd tools; driver-playbook resolution referencing Task 4 files). Keep the adversarial ladder and diagnose-only routing verbatim in intent.
- [ ] **Step 2: Verify frontmatter parses** and `allowed-tools` excludes source Edit (only Write for the SELF-UAT log + driver bootstrap).

Run: `node -e "const m=require('fs').readFileSync('src/resources/skills/agentic-tester/SKILL.md','utf8'); if(!/^---[\s\S]*name:\s*agentic-tester[\s\S]*---/.test(m)) throw new Error('frontmatter'); console.log('ok')"`
Expected: `ok`.

- [ ] **Step 3: Commit**

```bash
git add src/resources/skills/agentic-tester/SKILL.md
git commit -m "feat(v2): agentic tester verification-spine skill"
```

---

### Task 4: Driver playbooks (CLI, browser, Android/wired-adb)

The swappable per-surface drivers the spine resolves at runtime.

**Files:**
- Create: `src/resources/skills/agentic-tester/drivers/cli.md`
- Create: `src/resources/skills/agentic-tester/drivers/browser.md`
- Create: `src/resources/skills/agentic-tester/drivers/android.md`

**Interfaces:**
- Consumes: the spine's `resolve_driver` contract from Task 3 (how a driver doc is named/selected).
- Produces: three driver playbooks, each documenting build/launch/drive/observe mechanics + gotchas for its surface, in the shape Task 3's `resolve_driver` expects.

- [ ] **Step 1: CLI driver** (`cli.md`) — build/run the app's CLI via bash; drive by invoking commands; observe via stdout/exit code; cheapest-layer guidance.
- [ ] **Step 2: Browser driver** (`browser.md`) — launch + drive via the `browser-tools` extension; observe via DOM/console/screenshot; reserve screenshots for visual claims.
- [ ] **Step 3: Android driver** (`android.md`) — **encode the Global Constraints device rules verbatim**: wired tester `…-s22-ultra-2` only; always `adb -s <serial|ip:port>`; airplane mode allowed but re-activate tailscale + wireless adb over wired adb afterward; never the personal phone; resolve availability before acting.
- [ ] **Step 4: Verify** the Android driver contains the safety invariants and no unscoped `adb`.

Run: `grep -cE "adb -s" src/resources/skills/agentic-tester/drivers/android.md && ! grep -nE "^\s*adb (?!-s)" src/resources/skills/agentic-tester/drivers/android.md && echo SAFE`
Expected: prints a count ≥1 then `SAFE`.

- [ ] **Step 5: Commit**

```bash
git add src/resources/skills/agentic-tester/drivers/
git commit -m "feat(v2): CLI, browser, and wired-adb Android driver playbooks"
```

---

### Task 5: `/gsd` subcommand invocation

Wire a manually-invocable command that dispatches the `tester` subagent with the persona + procedure skill.

**Files:**
- Modify: `src/resources/extensions/gsd/commands/catalog.ts` (register the subcommand — exact entry shape from Task 1)
- Create: `src/resources/extensions/gsd/commands/handlers/verify-agentic.ts` (handler — signature from Task 1's `handlers/*.ts` model)
- Modify: `src/resources/extensions/gsd/commands/dispatcher.ts` if handler routing is explicit there (per Task 1)
- Test: `src/resources/extensions/gsd/tests/verify-agentic-command.test.ts`

**Interfaces:**
- Consumes: command-registration contract (Task 1); persona (Task 2); skill (Task 3).
- Produces: a `/gsd verify-agentic <target> [--criteria …] [--surface cli|browser|android]` command that dispatches the `tester` subagent with the persona + `agentic-tester` skill + resolved driver, and surfaces the result.

- [ ] **Step 1: Write the failing test** — assert the catalog exposes `verify-agentic` and the handler dispatches the `tester` agent with the persona + `agentic-tester` skill (mock the dispatch per Task 1's seam).

```ts
// shape depends on Task 1's real dispatch seam; example against a mocked dispatcher:
import { test } from "node:test"; import assert from "node:assert";
import { handleVerifyAgentic } from "../commands/handlers/verify-agentic.js";
test("dispatches tester subagent with agentic-tester skill", async () => {
  const calls: any[] = [];
  await handleVerifyAgentic({ target: "demo", surface: "cli" }, { dispatch: (a:any)=>{calls.push(a); return {ok:true};} } as any);
  assert.equal(calls[0].agentId, "tester");
  assert.match(calls[0].skill ?? calls[0].prompt, /agentic-tester/);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/resources/extensions/gsd/tests/verify-agentic-command.test.ts` (or the repo's package-test path)
Expected: FAIL (`handleVerifyAgentic` not defined).

- [ ] **Step 3: Implement the handler + catalog entry** using Task 1's real signatures.
- [ ] **Step 4: Run test to verify it passes**

Run: same as Step 2. Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/commands/ src/resources/extensions/gsd/tests/verify-agentic-command.test.ts
git commit -m "feat(v2): /gsd verify-agentic command dispatches tester subagent"
```

---

### Task 6: SELF-UAT log output + gap-closure routing

Persist the tester's verdict and route FAILs.

**Files:**
- Create: `src/resources/extensions/gsd/agentic-tester-log.ts` (SELF-UAT log writer → `.gsd/` per Task 1's projection contract)
- Test: `src/resources/extensions/gsd/tests/agentic-tester-log.test.ts`

**Interfaces:**
- Consumes: `.gsd/` write contract (Task 1); the spine's `write_self_uat_log`/`handle_findings` steps (Task 3).
- Produces: `writeSelfUatLog(result): string` (returns the written path) and a gap-closure routing recommendation object `{ status: "PASS"|"FAIL", rootCause?: string, route?: string }`.

- [ ] **Step 1: Write the failing test** — a PASS result writes a log with per-criterion verdicts; a FAIL result includes a root cause and a gap-closure route string.

```ts
import { test } from "node:test"; import assert from "node:assert";
import { renderSelfUat } from "../agentic-tester-log.js";
test("FAIL renders root cause + gap-closure route", () => {
  const md = renderSelfUat({ target:"demo", surface:"cli", criteria:[{id:"C1",status:"FAIL",rootCause:"exit 1, expected 0"}] });
  assert.match(md, /FAIL/); assert.match(md, /exit 1/); assert.match(md, /gap-closure/i);
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `pnpm exec node --test src/resources/extensions/gsd/tests/agentic-tester-log.test.ts`
Expected: FAIL (`renderSelfUat` not defined).

- [ ] **Step 3: Implement `renderSelfUat` + `writeSelfUatLog`** (log format adapted from `self-uat.md`; path from Task 1).
- [ ] **Step 4: Run test to verify it passes** — Expected: PASS.
- [ ] **Step 5: Commit**

```bash
git add src/resources/extensions/gsd/agentic-tester-log.ts src/resources/extensions/gsd/tests/agentic-tester-log.test.ts
git commit -m "feat(v2): SELF-UAT log writer + gap-closure routing for agentic tester"
```

---

### Task 7: End-to-end pilot verification (per surface)

Prove the ported tester actually works — the spec's testing approach.

**Files:**
- Create: `docs/superpowers/plans/agentic-tester-PILOT-EVIDENCE.md` (evidence log; runtime artifact, not app source)

**Interfaces:**
- Consumes: everything above.

- [ ] **Step 1: Build** — `corepack pnpm build` (must be clean; native + web build already proven in v1).
- [ ] **Step 2: CLI surface** — run `/gsd verify-agentic` against a tiny target with one **known-good** and one **known-bad** success criterion. Confirm PASS-on-good, FAIL-with-root-cause-on-bad, SELF-UAT log written, and that no source file was edited (diagnose-only holds).
- [ ] **Step 3: Browser surface** — same good/bad check via the browser driver.
- [ ] **Step 4: Android surface** — same good/bad check via the wired tester (`adb -s <serial>`); explicitly verify the driver refuses an unscoped `adb` and honors the airplane-mode/tailscale-reactivation rule.
- [ ] **Step 5: Record evidence** in `PILOT-EVIDENCE.md` (commands + observed output per surface).

Run (diagnose-only guard): `git status --porcelain -- 'src/**'` after a FAIL run.
Expected: no app-source modifications from the tester run.

- [ ] **Step 6: Commit the evidence log**

```bash
git add docs/superpowers/plans/agentic-tester-PILOT-EVIDENCE.md
git commit -m "docs(v2): agentic tester pilot evidence across CLI/browser/Android"
```

---

## Self-Review

- **Spec coverage:** persona (T2), spine skill (T3), driver-playbook abstraction + 3 surfaces incl. wired-adb safety (T4), manual `/gsd` invocation (T5), SELF-UAT log + diagnose-only gap-closure routing (T6), `.gsd/` output (T1 contract + T6), migration-pattern (the T1→T6 shape). Deferred items (auto-gating, Gate-2 ledger) are correctly absent. Covered.
- **Placeholder scan:** the only deliberately deferred specifics (exact pi-gsd dispatch/command/writer signatures) are pinned by Task 1 before any task consumes them — later tasks reference "Task 1's contract", not invented symbols. Test snippets are marked as shaped by Task 1's real seam.
- **Type consistency:** `renderSelfUat`/`writeSelfUatLog` (T6), `handleVerifyAgentic` (T5), `agentic-tester` skill name and `tester` agentId (T2/T3/T5) are used consistently.
