# Design — Agentic Tester Port (milestone v2, pilot migration)

**Date:** 2026-09-20
**Status:** Draft (design; pending user review → implementation plan)
**Milestone:** v2 — Agentic Tester Port
**Approach:** B — brains-first pilot (step 1 toward full native integration)

## Why this exists (the big picture)

Yahir is migrating his agentic-coding harness **from Claude Code (running the heavily-customized
control-plane GSD, `@opengsd/gsd-core` / the `yahir-gsd` fork) to gsd-pi (`@opengsd/gsd-pi`)** as the
go-forward harness. Over time, every custom capability built into the control-plane GSD
(agentic tester, milestone orchestrators, and more) gets brought across to pi-gsd's own bundled GSD.

**The agentic tester is the first of these ports.** It is:
- **Additive** — the control-plane GSD keeps its agentic tester; Claude Code stays usable.
- **A pilot** — it establishes the repeatable pattern for migrating a control-plane GSD capability
  into pi-gsd's (architecturally different) bundled GSD, on a capability Yahir knows deeply, so the
  harder ports that follow are de-risked.
- **Personal-use scope** — no public release concerns yet.

## The architectural gap this port crosses

The two GSDs are different runtimes, so this is reimplementation, not a file copy:

| | Control-plane GSD (`gsd-core`) | pi-gsd bundled GSD (`@opengsd/gsd-pi`) |
|---|---|---|
| Authority | File-authoritative (`.planning/*.md`) | **DB-backed**; `.gsd/*` files are projections, tools commit to a DB first |
| Workflow form | Large markdown workflow files (`verify-work-agentic.md`, 38 KB) an orchestrator reads & follows | TypeScript extension (`src/resources/extensions/gsd/`); `GSD-WORKFLOW.md` is a manual-bootstrap doc, not authority |
| Subagents | Claude Code `Agent`/`Task` spawns (`gsd-agentic-tester`) | Own `planning-subagent-registry.ts` + `delegation-policy.ts` |

**Favorable hosting points already exist in pi-gsd** (verified in this repo):
- `src/resources/extensions/gsd/planning-subagent-registry.ts` already registers a
  `tester: { readOnlySpecialist: true }` role — read-only matches the tester's DIAGNOSE-ONLY stance.
- `src/resources/extensions/gsd/gate-registry.ts` exists — the eventual home for auto-gating (deferred).

## What the control-plane tester actually is (the "brains" to port)

Source of truth on the control-plane side:
- `~/.claude/agents/gsd-agentic-tester.md` — the adversarial, DIAGNOSE-ONLY tester role.
- `~/.claude/gsd-core/workflows/verify-work-agentic.md` — the procedure (spine).
- `~/.claude/gsd-core/templates/self-uat.md` — the SELF-UAT log template.

Its value is a **platform-agnostic verification spine + a swappable driver playbook**:
`resolve_driver → bootstrap_driver → environment_preflight → build_install → fixture_integrity_check
→ drive_and_verify_each_criterion (cheapest sufficient layer per claim; visual captures only for
visual claims) → handle_findings → write_self_uat_log → report`. It never edits code; a real
behavior FAIL is reported with a tight root cause and routed to gap-closure.

## Scope

### In scope (this pilot / milestone v2)

1. **Tester role/persona** ported onto pi-gsd's existing `tester` readOnlySpecialist subagent —
   adversarial, falsify-don't-confirm, DIAGNOSE-ONLY (never edits source).
2. **Verification spine** ported as a pi-gsd skill the `tester` subagent runs (the step ladder above),
   adapted to pi-gsd's tools and `.gsd/` projection layout.
3. **Driver-playbook abstraction** preserved (agnostic spine + swappable per-surface driver doc),
   shipping **three drivers**: CLI/bash, browser (via the `browser-tools` extension), and
   **Android device/adb**.
4. **SELF-UAT log** output, written into pi-gsd's `.gsd/` area (projection-appropriate).
5. **Diagnose-only → gap-closure routing** adapted to pi-gsd's task/gap model.
6. **Manual invocation** via a `/gsd` subcommand that dispatches the tester subagent (light wiring).

### Out of scope (deferred to the Approach-A follow-on)

- **Auto-dispatch as a blocking gate** in pi-gsd's DB-backed execute lifecycle (`gate-registry.ts`).
- **Gate-2 human-UAT ledger** integration (`HUMAN-UAT-PENDING.md` equivalent).
- Removing or changing the control-plane tester (this is additive).
- Any public/user-facing product surface.

## Android driver — device model & invariants (load-bearing)

**Updated device model (2026-09-20):** the tester (`…-s22-ultra-2`) is now on **wired adb, always
plugged in** — a robust, always-available USB transport. This supersedes the old wireless-adb-only
setup and its constraints:
- **Airplane mode is now ALLOWED.** Wired adb survives it, so the old "never airplane-mode (severs
  adb irreversibly)" rule no longer applies to this wired tester. Toggling airplane mode is a
  legitimate test action (e.g. verifying offline / no-network behavior).
- **The catch is the network side:** airplane mode drops wifi, which kills **tailscale and wireless
  adb**. So the Android driver MUST, when those are needed again, **re-activate tailscale and
  wireless adb over the wired adb connection** (wired adb is the recovery channel that brings the
  network transports back up). Any test that toggles airplane mode owns restoring tailscale +
  wireless adb afterward via the wired link.

Still load-bearing:
- **Always address the device explicitly** — `adb -s <usb-serial>` for the wired transport (or
  `-s <ip:port>` when driving over reactivated wireless adb). Never issue an unscoped `adb` command.
- Target the **TESTER** device (`…-s22-ultra-2`), never the personal phone (`…-s22-ultra`); treat the
  retired rig (`…-s22-ultra-1`) as offline.
- Resolve device availability before acting; report if down, never silently substitute another device.

> Note: this updates the standing operator guidance in `~/.claude/context/devices/common.md` /
> CLAUDE.md, whose "never airplane-mode" tripwire predates the wired-adb setup. See the
> reconciliation note raised alongside this spec.

## Design shape (Approach B)

- **Persona:** a ported tester persona file for pi-gsd's `tester` subagent (adversarial mindset,
  diagnose-only, tool restrictions mirroring the control-plane `disallowedTools: Edit`).
- **Procedure skill:** a pi-gsd skill carrying the verification spine + the driver-playbook
  resolution logic; the `tester` subagent reads and follows it.
- **Driver playbooks:** three driver docs (CLI, browser, Android) selected at runtime by surface,
  same swap mechanism as the control-plane `<resolve_driver>` step.
- **Output + routing:** SELF-UAT log to `.gsd/`; FAIL → structured finding + gap-closure recommendation
  in pi-gsd's task model.
- **Invocation:** `/gsd` subcommand → dispatch `tester` subagent with the procedure skill + resolved
  driver; results surfaced to the user. No automatic lifecycle gating yet.

## How this sets the migration pattern

This pilot yields a reusable template for the remaining control-plane→pi-gsd ports:
1. Identify the capability's "brains" (role + procedure + templates) vs. its host-specific wiring.
2. Map the brains onto an existing pi-gsd extension point (here: the `tester` subagent + a skill).
3. Adapt host-specific concerns (state authority, subagent dispatch, tool set, output location).
4. Ship a manually-invocable working version first; defer deep lifecycle/gate automation.
Milestone orchestrators and later ports follow the same four steps.

## Testing approach

- The tester itself is verified by pointing it at a **known-good and a known-bad** success criterion
  on a small target on each surface, and confirming: PASS on good, FAIL-with-root-cause on bad, and
  that it never edits source (diagnose-only guard holds).
- Driver selection: confirm the correct driver is resolved per surface, and that the Android driver
  refuses to act without an explicit `-s <ip:port>` and honors the safety invariants.

## Open questions (resolve during planning)

- Exact pi-gsd extension-point file(s) for registering the persona + skill (needs a read of the
  `tester` role's current dispatch path in `planning-subagent-registry.ts` / `delegation-policy.ts`).
- pi-gsd's canonical location for a SELF-UAT projection artifact under `.gsd/`.
- How gap-closure routing maps onto pi-gsd's DB-backed task model.
