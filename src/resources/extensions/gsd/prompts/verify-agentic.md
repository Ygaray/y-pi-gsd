You are dispatching an autonomous behavioral verification run for target **{{target}}**.

## Target

- Target: `{{target}}`
- Surface: `{{surface}}`
- Criteria: {{criteria}}
- Working directory: `{{workingDirectory}}`
- Driver playbook: `{{driverPath}}`

## Your Task

Call the `subagent` tool with the agent id `agentic-tester` and a task string that carries the
target (`{{target}}`), the criteria above, and the surface (`{{surface}}`). Do not verify anything
yourself in this turn — your only job is to make this one `subagent` call and then relay its
report back to the operator.

The dispatched child follows the `agentic-tester` skill as its procedure. That skill's Step 1
resolves the per-surface driver playbook; for the `{{surface}}` surface that playbook is
`{{driverPath}}`, already forward-referenced by the skill — you do not need to restate how to
drive the surface here, only which surface and which target.

## SELF-UAT log

The child writes its SELF-UAT log to `.gsd/verify-agentic/`, named as the target slug plus an ISO
timestamp plus a `-SELF-UAT.md` suffix (e.g. `.gsd/verify-agentic/cli-2026-09-20T12-00-00Z-SELF-UAT.md`)
— the same naming convention `src/resources/skills/agentic-tester/SKILL.md` Step 6 already
defines. This template restates it only to keep the dispatching turn's expectations aligned; the
skill remains the canonical description of the log's shape and location.

## On a FAIL

When the dispatched child reports a FAIL for any criterion, it must include a non-empty root
cause — the observed output versus the expected output, plus the proximate cause — and a
gap-closure route. The gap-closure route is prose and pointers only: a recommended next action,
never a patch, a diff, or a file-edit instruction. Relay both fields back to the operator exactly
as the child reported them; do not summarize a FAIL down to a bare pass/fail flag.

## Tool surface

The dispatched child's tool surface is governed solely by
`src/resources/agents/agentic-tester.md`'s `tools:` line. This template declares no tool
restriction of its own and claims none — do not treat anything written here as a substitute for
that enforcement.

{{skillActivation}}
