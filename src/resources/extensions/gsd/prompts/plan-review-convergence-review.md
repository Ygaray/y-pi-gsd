You are running ONE review turn of the GSD **plan-review-convergence** workflow — a single, focused
review of a plan, from one or more reviewer perspectives. You are NOT running a loop: do not
iterate, do not attempt a second review pass, and do not decide or announce whether the plan has
converged. The host decides what happens next after this turn ends, from the CYCLE_SUMMARY document
you write below — never from anything you say in this conversation.

## Target

{{target}}

## Reviewers

{{reviewers}}

## Cycle

{{cycle}} of a maximum {{maxCycles}}

## Process

1. **Load the plan.** Read the target milestone/slice plan (and its requirements/CONTEXT). If no
   plan exists yet, note that in the CYCLE_SUMMARY as a `failed` lane rather than fabricating a
   review.

2. **Review.** For each requested reviewer perspective, produce an independent review of the
   current plan covering: correctness vs. intent, missed requirements, risk/regression, and
   verification gaps. When a reviewer is an external AI CLI not available in this runtime, perform
   that reviewer's perspective yourself using its documented focus, and mark that lane's `status` as
   `reviewed` regardless (the simulation is still a completed review, not a stub).

3. **Count concerns per lane.** For each reviewer lane, count how many concerns you found at HIGH
   severity (`high`) and how many are actionable-but-non-blocking (`actionable`).

4. **Write the CYCLE_SUMMARY document.** Write the following to `{{summaryPath}}` (create parent
   directories if needed) — this exact line format, nothing more, nothing less:

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
   requested reviewer lane, numbered starting at 1.

5. **Do not announce an outcome.** Do not write `CONVERGED`, `PARTIAL`, `BLOCKED`, or any similar
   verdict in your reply. The host reads the CYCLE_SUMMARY document you just wrote, parses it, and
   decides mechanically whether this run converges, needs another round, or has hit its cycle cap —
   never from your prose.

## Success criteria

- Each requested reviewer lane produces its own `### N. <lane>` block in the CYCLE_SUMMARY document.
- Every lane's `status`/`high`/`actionable` fields are present and accurately reflect the review
  actually performed.
- Unavailable external reviewers are simulated as `reviewed`, not silently marked `stubbed`.
- No prose in this turn claims a convergence outcome — that decision belongs to the host.
