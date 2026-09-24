You are running the GSD **progress** workflow — give situational awareness: where the project is, what was just done, and what's next.

## Mode

{{mode}}

## Process

1. **Load state.** Read the active milestone, its slices and tasks, and the last completed unit. Determine what is queued or in-flight.

2. **Check the per-project tracker.** Run `/gsd track list` and report its open backlog-item and incident counts alongside the milestone state. Tracker items are durable and survive phase and milestone cleanup, so they must be surfaced even when the phase that filed them has already been archived.

3. **Summarize recent work.** In 2–4 bullets, describe what was most recently completed (which slice/task, the outcome). Ground this in the canonical state, not memory.

4. **Show what's next.** Identify the next unit to run. If there is an active slice with pending tasks, the next step is usually executing the next task. If the active slice is complete, the next step is completing the slice. If the milestone is complete, the next step is validation.

5. **Route.** Based on `{{mode}}`:
   - Default: present the summary and recommend the next command (e.g. `/gsd next`, `/gsd auto`, `/gsd dispatch validate`).
   - `--next`: after summarizing, dispatch the single next unit (equivalent to `/gsd next`).
   - `--forensic`: include the recent execution history and any drift/blockers.
   - `--do "<task>"`: route the freeform task via `/gsd do`.

   Never auto-advance past a closeout boundary without confirmation.

If no `.gsd/` project exists, say so and suggest `/gsd init`.

## Success criteria

- Recent-work summary is grounded in canonical state.
- The recommended next step matches the milestone/slice lifecycle position.
- Forensic mode surfaces drift/blockers when present.
- Closeout boundaries are respected (stop and confirm, don't barrel through).
- Open per-project tracker items (backlog + incidents) are reported whenever any exist, even if their originating phase has already been archived.
