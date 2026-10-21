You are running the GSD **import** workflow — ingest an external plan with conflict detection against existing project decisions before writing anything.

## Flags

- `--resolve auto|interactive` — {{resolveFlag}}

## Source

{{source}}

## Process

1. **Read the source plan.** From the given filepath (or `--from-gsd2` to migrate a legacy `.planning/` directory laid out as ordered phases). Parse its phases, requirements, decisions, and tasks.

2. **Conflict detection (before writing).** Compare the source's decisions and requirements against the project's existing CONTEXT, Decisions Register, KNOWLEDGE rules, and current milestones. Flag: contradictory decisions, duplicate requirements, scope that overlaps an existing milestone, and terminology mismatches.

3. **Present the conflict report.** List conflicts by severity (blocking / warning / info). Do not write anything yet.

4. **Resolve.** For each conflict, propose a resolution (adopt source, keep ours, merge). In `--resolve auto`, apply the safe merges and flag the rest; in `--resolve interactive`, confirm each resolution with the user.

5. **Import.** On approval, translate the source into gsd-pi artifacts: phases → milestones, requirements → CONTEXT/requirements, decisions → Decisions Register (`/gsd knowledge rule`), tasks → slice tasks. Prefer `/gsd migrate` machinery for whole `.planning/` imports.

Nothing is written until conflicts are resolved.

## Success criteria

- Conflicts are detected and reported before any write.
- No destructive overwrite of existing decisions without explicit resolution.
- Phase-based source content is translated to gsd-pi's milestone/slice model.
- Whole-`.planning/` imports route through `/gsd migrate`.
