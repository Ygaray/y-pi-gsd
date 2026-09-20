---
name: agentic-tester
description: >-
  Adversarially verify a phase's user-visible behavior against the real running surface —
  autonomous behavioral verification, Gate-1 self-UAT, falsify acceptance criteria against a
  running surface, diagnose-only verification. Use when dispatched as the `agentic-tester` agent
  to drive a CLI, browser, or Android surface and prove or disprove each stated acceptance
  criterion with fresh evidence captured in this run — never by reading the implementation and
  reasoning that it should work.
---

<objective>
Define the six-step verification spine the `agentic-tester` agent follows when dispatched to
adversarially verify a phase's user-visible behavior against the REAL running surface (CLI,
browser, or Android device) — never by reading the implementation and reasoning that it should
work. The spine's structure is the only thing that prevents the two documented self-verification
failure modes — rubber-stamping a criterion it expected to pass, and asserting a PASS from reading
code instead of driving the surface. Both are resisted structurally, by making fresh
per-criterion evidence non-skippable, not by asking nicely.
</objective>

<context>
This skill runs inside a spawned `agentic-tester` child process with its own isolated context
window, dispatched by a foreground turn via the `subagent` tool. The child's tool surface is
restricted by its agent frontmatter to `read, bash, write, grep, find, ls` — it excludes source
editing entirely; nothing in this skill relies on a skill-level tool restriction, because none is
enforced by the runtime.

Invocation points:
- The Phase 7 `/gsd verify-agentic` command, once wired — the eventual, routine entry point.
- Hand-invocation by dispatching `{ agent: "agentic-tester", task: "..." }` directly — the entry
  point through Phase 5 and Phase 6, before the command exists.
</context>

<core_principle>
Task 2 of this plan fills this in.
</core_principle>

<process>

## Step 1: Resolve driver

Identify the target surface (CLI, browser, or Android) for the criteria you were dispatched
against, then load that surface's driver playbook by reading it from
`src/resources/skills/agentic-tester/drivers/cli.md`,
`src/resources/skills/agentic-tester/drivers/browser.md`, or
`src/resources/skills/agentic-tester/drivers/android.md`, selected by surface. These three paths
are Phase 6 forward references — they do not exist yet at the time this skill is authored. Fold in
the `bootstrap_driver` rung here: if the resolved playbook is absent, halt and report rather than
improvising a driver or inventing platform mechanics from memory.

**Exit condition:** a named driver playbook is loaded, or the run has halted and reported the
missing playbook.

## Step 2: Preflight

Verify the environment the driver needs is actually present, and that the fixtures under test are
intact, before driving anything. This step folds in two rungs from the control-plane ladder:
`environment_preflight` (is the target reachable and in a known, ready state) and
`fixture_integrity_check` (is the test fixture/seed data intact, so a fixture-desync can never
masquerade as a behavior failure). Never substitute a different environment or target for one that
is unavailable — report and halt instead.

**Exit condition:** every precondition the driver names is confirmed present, or the run has
halted with the missing precondition named.

## Step 3: Build

Build or install the target using the driver's build recipe (this folds in the control-plane
`build_install` rung), against the CURRENT tree, and read the build's output rather than assuming
success.

**Exit condition:** the build completed and its output was read, or the run reports a build
blocker and stops.

## Step 4: Drive and falsify each criterion

This is the adversarial core of the spine. Task 2 of this plan fills in its full discipline rules.

**Exit condition:** every criterion has a verdict AND an observation captured in this run.

## Step 5: Findings

Turn observations into findings for every FAIL. Task 2 of this plan fills in the root-cause
discipline.

**Exit condition:** every FAIL has a specific root cause.

## Step 6: SELF-UAT log

This step folds in the control-plane `report` rung: write the SELF-UAT log, then report back to
the dispatching turn. Task 2 of this plan fills in the write-target and log-template details.

**Exit condition:** the log path is written and reported back to the dispatching turn.

</process>

<anti_patterns>
Task 2 of this plan fills this in.
</anti_patterns>

<success_criteria>
- [ ] Step 1: a named driver playbook is loaded, or the run halted and reported the missing playbook.
- [ ] Step 2: every precondition the driver names is confirmed present, or the run halted with the missing precondition named.
- [ ] Step 3: the build completed and its output was read, or the run reports a build blocker and stops.
- [ ] Step 4: every criterion has a verdict AND an observation captured in this run.
- [ ] Step 5: every FAIL has a specific root cause.
- [ ] Step 6: the log path is written and reported back to the dispatching turn.
</success_criteria>
