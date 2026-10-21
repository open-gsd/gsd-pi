# Migration from v1

If you have projects with `.planning` directories from Git Ship Done v1 (now continued by the community as [gsd-core](https://github.com/open-gsd/gsd-core)), you can migrate them to gsd-pi's `.gsd` format.

## Running the Migration

```bash
# From within the project directory
/gsd migrate

# Or specify a path
/gsd migrate ~/projects/my-old-project
```

## What Gets Migrated

The migration tool:

- Parses your old `PROJECT.md`, `ROADMAP.md`, `REQUIREMENTS.md`, phase directories, plans, summaries, research, top-level `decisions/`, and top-level `seeds/`
- Maps phases → slices, plans → tasks, milestones → milestones
- Treats an explicit path as the target project root, so `/gsd migrate ~/projects/my-old-project` writes to `~/projects/my-old-project/.gsd`
- Blocks zero-slice migrations and refuses to run while active, paused, or worktree session state exists
- Uses the verified backup, retained Import Application, and retry behavior defined by the [authoritative migration contract](../../docs/user-docs/migration.md#what-gets-migrated)
- Writes the imported hierarchy into the GSD database, then renders markdown projections from that database
- Preserves completion state (`[x]` phases stay done, summaries carry over)
- Consolidates research files into the new structure and archives the full legacy `.planning` source under `.gsd/migration/legacy/`
- Records `.gsd/migration/MIGRATION.md` and `.gsd/migration/manifest.json` audit artifacts
- Shows a preview before writing anything, including requirement status totals (validated, active, deferred, out of scope) and legacy-input counts (milestone phase dirs, decision files, seed files)
- Optionally runs a read-only review for quality assurance

## Supported Formats

The migration handles various v1 format variations:

- Milestone-sectioned roadmaps with `<details>` blocks
- Bold phase entries
- Bullet-format requirements
- Emoji requirement markers (`✅`, `✓`, `⏳`, `✗`) with IDs like `R12` and `ABC-123`
- Decimal phase numbering
- Duplicate phase numbers across milestones
- Milestone-scoped legacy phase trees like `<milestone>-phases/01-.../`
- Legacy phase plan/summary files in both `NN-NN-PLAN.md` and short `NN-PLAN.md` styles

## Requirements

Migration works best with a `ROADMAP.md` file for milestone structure. Without one, milestones are inferred from the `phases/` directory.

## Post-Migration

After migrating, verify the output:

```
/gsd doctor
```

This checks `.gsd/` integrity and flags any structural issues.

Use `/gsd inspect` for database diagnostics. For recovery or explicit legacy import, follow the [authoritative migration contract](../../docs/user-docs/migration.md#post-migration).
