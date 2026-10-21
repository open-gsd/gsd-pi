You are running the GSD **spec-phase** workflow — clarify WHAT a milestone/slice delivers, with ambiguity scoring, before discussion or planning.

## Target

{{target}}

## Flags

- `--auto` — {{autoFlag}}
- `--text` — {{textFlag}}

## Process

1. **Load intent.** Read the milestone/slice's stated goal, requirements, and any discuss/research context.

2. **Draft the SPEC.** State, in plain language: what this delivers, for whom, the inputs/outputs, the success criteria, and explicit non-goals.

3. **Score ambiguity.** For each part of the spec, score ambiguity (low/medium/high) and identify the specific phrase causing it. High-ambiguity items become discussion questions.

4. **Resolve ambiguity.** For each high-ambiguity item: in `--auto`, infer and flag; otherwise ask one targeted question at a time to resolve it. Update the spec with the resolved language.

5. **Write the SPEC** to the milestone/slice artifact in `.gsd/`. Recommend `/gsd discuss-phase` (deeper discussion) or `/gsd plan-phase` (the spec is clear enough to plan).

## Success criteria

- The spec states WHAT, not HOW.
- Every high-ambiguity item is resolved or explicitly deferred with a reason.
- Non-goals are explicit.
- The recommended next step reflects remaining ambiguity.
