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
- Creates and verifies a retained `.gsd-backups/migrate-YYYYMMDD-HHMMSS/` snapshot before applying the migration; failures do not replace database authority, and any committed Import Application is retained for an exact retry
- Keeps `.gsd-backups/` as local runtime data: GSD adds it to baseline `.gitignore` and runtime exclusions, and stale `.gsd-backups/migrate-*` snapshots are pruned after 30 days once the project has completed the flat-phase `.gsd/phases/` migration
- Writes the imported hierarchy into the GSD database, then renders markdown projections from that database
- Preserves completion state (`[x]` phases stay done, summaries carry over)
- Consolidates research files into the new structure and archives the full legacy `.planning` source under `.gsd/migration/legacy/`
- Records `.gsd/migration/MIGRATION.md` and `.gsd/migration/manifest.json` audit artifacts
- Shows a preview before writing anything, including requirement status totals (validated, active, deferred, out of scope) and legacy-input counts (milestone phase dirs, decision files, seed files)
- Optionally runs a read-only review of the output for quality assurance

If migration reports a Forward Repair overlap, review each target and rerun the exact `--forward-choice` command it prints. The evidence-bound flags preserve later canonical work unless you explicitly choose the displayed backup value.

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

After migrating, verify the output with:

```
/gsd doctor
```

This checks database and projection integrity and flags any structural issues. Use `/gsd inspect` when you need database diagnostics.

If an existing project has legacy markdown artifacts that you explicitly want to import into a missing or damaged database, start GSD once so the database opens, then run:

```
/gsd recover
# Then re-run with the exact --preview=<sha256> printed by the command.
```

`/gsd recover` fingerprints the legacy source and current database and prints an exact Preview hash. Re-run it with `--preview=<sha256>` to create and independently verify a retained backup, apply that unchanged preview through one atomic Import Application, and assess the safe next action. It updates only modeled preview targets; database rows absent from markdown are not cleared. The command prints the Application ID and retained backup path.

If assessment recommends restoring the pre-import database, rerun the command with the exact `--application`, `--restore`, and evidence-bound `--consent` values it printed. Restore is available only while that Import Application remains the canonical operation head. Any later canonical write or Authority Epoch cutover closes the restore window permanently; use the printed `--forward-repair` route instead. Forward Repair preserves later accepted work and asks for explicit `--choice` evidence only when imported and later canonical changes genuinely overlap.

Normal runtime never derives authority from markdown implicitly. Use `/gsd rebuild markdown` for ordinary database-to-markdown realignment.
