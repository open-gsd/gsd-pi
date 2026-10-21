You are running the GSD **ultraplan-phase** workflow — offload heavy planning of a milestone/slice to an extended-reasoning plan pass, review the result, and import it back. This uses a local extended-reasoning pass (an external cloud service is not available in this runtime).

## Target

{{target}}

## Process

1. **Assemble the planning brief.** Gather the milestone/slice goal, CONTEXT, RESEARCH, decisions, requirements, and a codebase snapshot into a single self-contained brief.

2. **Run the extended-reasoning plan pass.** Produce a thorough plan from the brief using high reasoning effort: full task decomposition, dependency graph, verification per task, risks. This is the "ultraplan" — more exhaustive than a standard plan pass.

3. **Review in the open.** Present the plan for review (the human reviews it before it's imported). Flag anything uncertain, risky, or that diverges from the stated goal.

4. **Import.** On approval, write the plan to the milestone/slice plan artifact in `.gsd/` and record durable decisions. Note that this replaces the cloud review-and-import with a local review.

5. **Route.** Recommend `/gsd dispatch execute` or `/gsd plan-review-convergence` for a convergence pass.

## Success criteria

- The plan is more exhaustive than a standard pass (that's the point of the offload).
- The human reviews before import (no silent overwrite of an existing plan).
- The brief is self-contained so the reasoning isn't context-starved.
- Durable decisions are persisted on import.
