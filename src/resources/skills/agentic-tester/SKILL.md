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
restricted by its agent frontmatter to `read, bash, write, grep, find, ls`, plus the `browser_*`
tool set the browser driver calls — it excludes source editing entirely; nothing in this skill
relies on a skill-level tool restriction, because none is enforced by the runtime.

Invocation points:
- The Phase 7 `/gsd verify-agentic` command, once wired — the eventual, routine entry point.
- Hand-invocation by dispatching `{ agent: "agentic-tester", task: "..." }` directly — the entry
  point through Phase 5 and Phase 6, before the command exists.

Note: Step 1's driver playbooks (`drivers/{cli,browser,android}.md`) landed in Phase 6. A
hand-invocation of this skill now resolves a real playbook for each of the three supported
surfaces. A Step 1 halt therefore now means a genuinely missing playbook or an unsupported
surface — a real condition to report rather than the expected default.
</context>

<core_principle>
**FALSIFY, NEVER CONFIRM.** The default posture toward every criterion is to prove it broken, not
to confirm it works. This run is judging work the same system produced — exactly the setup where
an evaluator drifts toward confirming what it expected instead of challenging it. Reading the
implementation and reasoning that it should work is not verification; only a fresh,
criterion-specific observation captured in this run counts.

**Tool enforcement lives in the agent frontmatter `tools:` line at
`src/resources/agents/agentic-tester.md`, not in anything this skill declares.** A skill-level
tool field is decorative and not enforced by pi-gsd's runtime, so nothing here may rely on one.
</core_principle>

<process>

## Step 1: Resolve driver

Identify the target surface (CLI, browser, or Android) for the criteria you were dispatched
against, then load that surface's driver playbook by reading it from
`src/resources/skills/agentic-tester/drivers/cli.md`,
`src/resources/skills/agentic-tester/drivers/browser.md`, or
`src/resources/skills/agentic-tester/drivers/android.md`, selected by surface.
All three playbooks exist as of Phase 6. Fold in
the `bootstrap_driver` rung here: if the resolved playbook is absent, halt and report rather than
improvising a driver or inventing platform mechanics from memory. That halt rung still binds when
a resolved playbook is absent because it was deleted or renamed, or when the dispatched target
names a surface none of the three playbooks covers.

**Exit condition:** a named driver playbook is loaded, or the run has halted and reported the
missing playbook — a halt here still executes Step 6 to persist the halt (see "Halt persistence"
below).

## Step 2: Preflight

Verify the environment the driver needs is actually present, and that the fixtures under test are
intact, before driving anything. This step folds in two rungs from the control-plane ladder:
`environment_preflight` (is the target reachable and in a known, ready state) and
`fixture_integrity_check` (is the test fixture/seed data intact, so a fixture-desync can never
masquerade as a behavior failure). Never substitute a different environment or target for one that
is unavailable — report and halt instead.

**Exit condition:** every precondition the driver names is confirmed present, or the run has
halted with the missing precondition named — a halt here still executes Step 6 to persist the halt
(see "Halt persistence" below).

## Step 3: Build

Build or install the target using the driver's build recipe (this folds in the control-plane
`build_install` rung), against the CURRENT tree, and read the build's output rather than assuming
success.

**Exit condition:** the build completed and its output was read, or the run reports a build
blocker and stops — a halt here still executes Step 6 to persist the halt (see "Halt persistence"
below).

**Halt persistence (Steps 1-3):** "halt and report" always means "halt, persist why, and report" —
never just the latter. A halt at Step 1, 2, or 3 does not skip Step 6: Step 6 still executes and
writes the same `.gsd/verify-agentic/<slug>-<timestamp>-SELF-UAT.md` path (per Step 6's naming
rule), but with a single top-level `halted: true` plus `reason:` block naming the step that halted
and why, in place of the full per-criterion log. An unreachable target, a missing playbook, or a
build blocker is evidence the surface itself is broken — losing that as a durable artifact if the
dispatching turn's context is later lost or summarized would defeat this spine's own core
principle of resisting rubber-stamping via a durable, fresh-evidence trail.

## Step 4: Drive and falsify each criterion

This is the adversarial core of the spine. No criterion may be marked PASS or FAIL without
evidence captured in THIS run.

Match the evidence layer to the claim type — this is a claim-type-to-evidence-layer pairing, not a
passive aside:
- Exit-code and stdout claims are evidenced by captured command output.
- DOM or state claims are evidenced by a DOM or console read.
- Rendered or visual claims are evidenced by a screenshot, and only those.

Screenshots for non-visual claims are waste; a DOM dump for a visual claim misses the regression.
The cheapest sufficient layer is never zero layers — every verdict needs an evidence layer, even
the cheapest one. Evidence from a previous step, a previous run, or a previous code state is stale
and does not count; only an observation produced in this run, against this build, counts.

**Exit condition:** every criterion has a verdict AND an observation captured in this run.

## Step 5: Findings

Every FAIL requires a non-empty root cause: the observed output versus the expected output, plus
the proximate cause.

Two concrete acceptable shapes: an exit code with its stderr line (e.g. "exit 1, stderr:
`ENOENT: no such file`"); an interaction that produced no state change, with the console error
that explains it (e.g. "clicking Save produced no DOM change, console error: `TypeError:
undefined is not a function`"). One unacceptable shape: a root cause that merely restates the
criterion (e.g. "criterion failed" or "the button did not work as expected").

The gap-closure route is prose only: never a patch, diff, or file-edit instruction. A
ready-to-apply patch defeats the diagnose-only boundary even though this agent never calls an
editing tool, because of how the next stage may consume it — an auto-apply or one-click-apply
consumer would turn this agent's prose into a de facto edit.

**Exit condition:** every FAIL has a specific root cause.

## Step 6: SELF-UAT log

This step folds in the control-plane `report` rung: write the SELF-UAT log, then report back to
the dispatching turn.

Write the log to `.gsd/verify-agentic/`, named as the target slug plus an ISO timestamp plus a
`-SELF-UAT.md` suffix (e.g. `.gsd/verify-agentic/cli-2026-09-20T12-00-00Z-SELF-UAT.md`).

Four facts about this write:
1. It is resolved under the project's own `.gsd/` directory, not the global agent home.
2. The first path segment (`verify-agentic`) classifies as unmanaged, so this is a plain file
   write with no DB-projection guard.
3. The managed-directory alternative (e.g. `.gsd/verification/`) is explicitly rejected because a
   derive cycle can clobber a managed projection.
4. The write happens from inside this spawned child using its own `write` tool, because the
   parent process has no callback into an already-exited child.

The rendering helper that turns this log into a nicer surface lands in Phase 7; until then, this
skill's prose is the canonical description of the log's shape and location.

**Write-scope boundary:** the SELF-UAT log path is the ONLY location this run may write to.
Scratch files, helper scripts, and configuration tweaks anywhere in the repository are prohibited,
including outside the source tree — the diagnose-only guard is about the whole working tree, not
only application source.

Log template — a mandatory per-criterion evidence field alongside the verdict, so a verdict with
an empty evidence field is visibly a defect rather than a silent one:

```markdown
### {N}. {criterion text}
verdict: PASS | FAIL
evidence: {what you actually observed this run — command output, DOM state, device output; never empty}
root_cause: {FAIL only — observed vs expected, plus proximate cause}
```

**Exit condition:** the log path is written and reported back to the dispatching turn.

</process>

<anti_patterns>
- **Reading the implementation and asserting it should work.** Reasoning from code you read
  instead of output you captured is a rubber stamp wearing a tester's badge.
- **Reusing a prior step's or prior run's observation.** Evidence from a previous step, a previous
  run, or a previous code state is stale and does not count — capture it fresh, in this run.
- **Screenshotting a non-visual claim.** An exit-code or stdout claim is settled by captured
  command output; a screenshot is expensive, lossy, and harder to grep.
- **Eyeballing a visual claim from a DOM dump.** A DOM dump proves structure, not what is actually
  rendered — a genuinely visual claim needs a screenshot you actually read.
- **A FAIL whose root cause restates the criterion.** "Criterion failed" is not a root cause — it
  names nothing a follow-up fix could act on.
- **Attaching a patch to a gap-closure route.** The route is prose only; a ready-to-apply patch
  defeats the diagnose-only boundary even though you never called an editing tool.
- **Fixing the bug it just found.** The one legitimate write is the SELF-UAT log — a real behavior
  failure is reported with its root cause and routed to gap-closure, never patched.
</anti_patterns>

<success_criteria>
- [ ] Step 1: a named driver playbook is loaded, or the run halted and reported the missing playbook.
- [ ] Step 2: every precondition the driver names is confirmed present, or the run halted with the missing precondition named.
- [ ] Step 3: the build completed and its output was read, or the run reports a build blocker and stops.
- [ ] Step 4: every criterion has a verdict AND an observation captured in this run.
- [ ] Step 5: every FAIL has a specific root cause.
- [ ] Step 6: the log path is written and reported back to the dispatching turn.
- [ ] Core principle states FALSIFY, NEVER CONFIRM as the default posture toward every criterion.
- [ ] No criterion may be marked PASS or FAIL without evidence captured in THIS run.
- [ ] Every FAIL requires a non-empty root cause: the observed output versus the expected output, plus the proximate cause.
- [ ] The gap-closure route is prose only: never a patch, diff, or file-edit instruction.
- [ ] The SELF-UAT log write target is `.gsd/verify-agentic/`, the only location this run may write to.
</success_criteria>
