You are running the GSD **plan-phase** workflow — create a detailed plan for a milestone/slice with a verification loop.

## Target

{{target}}

## Flags

- `--auto` — {{autoFlag}}
- `--research` / `--skip-research` — {{researchFlag}}
- `--tdd` — {{tddFlag}} (plan test-first)

## Process

1. **Load authoritative context.** Read the milestone ROADMAP entry, CONTEXT, RESEARCH, the Decisions Register, and the discuss outcomes. Take a bounded codebase snapshot to ground the plan in current code reality.

2. **Research (unless skipped).** If open questions remain and `--skip-research` is off, run a bounded research pass (grounded in the snapshot, not an open-ended survey). Before writing the plan, call `gsd_summary_save` with `artifact_type: "RESEARCH"` and the applicable `milestone_id` / `slice_id` so the durable RESEARCH artifact exists.

3. **Decompose into slices/tasks.** Break the milestone into ordered, independently-verifiable slices; break each slice into concrete tasks. Each task has a clear definition of done and a verification method.

4. **Plan test-first** (when `--tdd`): for each task, specify the test that proves it before specifying the implementation.

5. **Verification loop.** Self-review the plan for gaps: missing tasks, unclear acceptance, orphaned requirements, unrealistic ordering. Revise until the plan is internally consistent.

6. **Write the plan** to the milestone/slice's plan artifact in `.gsd/` only after required RESEARCH/UI-SPEC inputs are saved or explicitly skipped. Record durable decisions via `/gsd knowledge rule`.

7. **Route.** Recommend `/gsd dispatch execute` (or `/gsd next`).

## Success criteria

- Every requirement maps to at least one task.
- Each task has a definition of done and a verification method.
- The plan is grounded in current code (snapshot), not assumptions.
- Durable decisions are persisted, not lost in the plan body.
