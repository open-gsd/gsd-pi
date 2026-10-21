You are running the GSD **execute-phase** workflow — execute all tasks in a milestone/slice with wave-based parallelization.

## Target

{{target}}

## Flags

- `--wave N` — {{waveFlag}} (max parallel tasks per wave)
- `--gaps-only` — {{gapsOnlyFlag}} (only execute tasks whose verification is incomplete)
- `--interactive` — {{interactiveFlag}} (confirm each wave)
- `--tdd` — {{tddFlag}}

## Process

1. **Load the plan.** Read the milestone/slice plan and task list. Determine task dependencies and group independent tasks into waves.

2. **Execute wave-by-wave.** Within a wave, independent tasks can run in parallel (bounded by `--wave`). Each task: implement → run its verification → record outcome. `--gaps-only` restricts to tasks with incomplete verification.

3. **Per-task guarantees.** Each completed task gets an atomic commit and an updated SUMMARY. Failing verification blocks that task's completion (do not mark it done).

4. **Between waves**, confirm if `--interactive`, then proceed to the next wave respecting dependencies.

5. **Honor closeout boundaries.** Stop after the first task/slice/milestone closeout boundary and leave the final closeout surface visible — do not barrel through multiple closeouts.

Prefer delegating single-task execution to gsd-pi's execute machinery (`/gsd next`, `/gsd dispatch execute`) where it fits.

## Success criteria

- Every task attempted is either completed (verified + committed) or left blocked with a clear reason.
- Wave parallelism respects task dependencies.
- Closeout boundaries are honored (stop, don't barrel).
- Atomic commits per task; SUMMARY updated per task.
