You are running ONE replan turn of the GSD **plan-review-convergence** workflow — revise a plan to
address the concerns a prior review cycle recorded, then hand the result back for review. You are
NOT running a loop: do not review your own revision, do not decide whether the plan now converges,
and do not announce an outcome. The host decides what happens next after this turn ends, from the
CYCLE_SUMMARY document you write below — never from anything you say in this conversation.

## Target

{{target}}

## Prior cycle's concerns

Read the prior cycle's review at `{{priorSummaryPath}}` — this document records, per reviewer lane,
how many HIGH-severity and actionable-but-non-blocking concerns were found.

## Cycle

{{cycle}} of a maximum {{maxCycles}}

## Process

1. **Load the plan and the prior review.** Read the target milestone/slice plan (and its
   requirements/CONTEXT) and the CYCLE_SUMMARY at `{{priorSummaryPath}}`.

2. **Revise the plan.** Address the concerns the prior cycle recorded. Record what changed and why
   directly in the plan artifact you are revising (not in this conversation).

3. **Re-review the revised plan.** For each reviewer lane the prior cycle reported, produce an
   independent review of the REVISED plan covering: correctness vs. intent, missed requirements,
   risk/regression, and verification gaps. When a reviewer is an external AI CLI not available in
   this runtime, perform that reviewer's perspective yourself using its documented focus, and mark
   that lane's `status` as `reviewed` regardless.

4. **Count concerns per lane.** For each reviewer lane, count how many concerns you found at HIGH
   severity (`high`) and how many are actionable-but-non-blocking (`actionable`), against the
   REVISED plan — not a re-statement of the prior cycle's counts.

5. **Write the next CYCLE_SUMMARY document.** Write the following to `{{summaryPath}}` (create
   parent directories if needed) — this exact line format, nothing more, nothing less:

   ```
   target: {{target}}
   cycle: {{cycle}}

   ### 1. <reviewer lane name>
   status: reviewed
   high: <integer count of HIGH-severity concerns>
   actionable: <integer count of actionable-but-non-blocking concerns>

   ### 2. <next reviewer lane name, if more than one reviewer>
   status: reviewed
   high: <integer>
   actionable: <integer>
   ```

   `status` is one of `reviewed`, `stubbed` (you could not perform the review at all), or `failed`
   (the review turn hit an unrecoverable error for that lane). Emit one `### N. <lane>` block per
   reviewer lane, numbered starting at 1.

6. **Do not announce an outcome.** Do not write `CONVERGED`, `PARTIAL`, `BLOCKED`, or any similar
   verdict in your reply. The host reads the CYCLE_SUMMARY document you just wrote, parses it, and
   decides mechanically what happens next — never from your prose.

## Success criteria

- The plan artifact at `{{target}}` is actually revised to address the prior cycle's concerns, with
  the change and its rationale recorded in that artifact.
- Each reviewer lane produces its own `### N. <lane>` block in the new CYCLE_SUMMARY document,
  reflecting an independent re-review of the revised plan.
- Every lane's `status`/`high`/`actionable` fields are present and accurately reflect the review
  actually performed.
- No prose in this turn claims an outcome or decides what happens next — that decision belongs to
  the host.
