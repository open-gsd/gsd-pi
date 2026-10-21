# Switching between gsd-core and gsd-pi

Both `@opengsd/gsd-core` and `@opengsd/gsd-pi` use the same `.gsd/` directory, but they do not share an authority model. Switching requires an explicit handoff when modeled markdown changes. This doc explains that workflow and what to do when the two tools disagree.

## The shared contract

gsd-core treats `.gsd/*.md` files as the source of truth. gsd-pi treats its SQLite database as canonical and uses those files only as projections. It never imports modeled markdown implicitly during startup or `/gsd sync`; use gsd-pi's planning and reopen tools for ordinary changes, or the verified `/gsd recover` Preview/Application flow when markdown is intentionally replacing missing or damaged database state.

## Recommended workflow: commit before switching

Git is the integration layer. Before switching tools, commit:

```bash
git add .gsd/
git commit -m "wip: switching to gsd-pi"
```

Then open the other tool. The commit preserves reviewable markdown edits, but it does not back up gsd-pi's gitignored database. Do not use `git reset --hard` as database recovery; use the verified backup and recovery action printed by `/gsd recover` when database recovery is required.

## What gsd-pi does on startup

When you open a project in gsd-pi, it runs a reconciliation pass that:

1. Compares every `.gsd/*.md` file against its recorded baseline in `.gsd/.compat.json`.
2. Preserves externally edited modeled files under `.gsd/quarantine/projections/` instead of importing or overwriting their bytes.
3. Re-projects markdown from the DB while valid database-backed work continues.
4. Updates `.gsd/.compat.json` after a successful projection.

This is automatic. Projection drift does not become workflow authority or block otherwise valid work; review the preserved copy if you need to recover an external edit.

## `/gsd sync` — mid-session switch

If you switch tools while gsd-pi is running (e.g., a teammate edits `.gsd/plan.md` via gsd-core and pushes), run:

```
/gsd sync
```

This checks projections against the database. Modeled drift is preserved under `.gsd/quarantine/projections/` without being imported, then sync re-projects from the database. Safe `.planning/` passthrough changes only refresh their checksums. Workflow-state blockers can still stop sync. Use `--dry-run` to list projection edits that would be preserved without repairs, projection, or marker writes:

```
/gsd sync --dry-run
```

## `/gsd doctor` — check compat health

`/gsd doctor` includes a compat-health line that tells you whether the marker is present and whether any files have drifted:

```
Compat health:      OK
```

or

```
Compat health:      2 file(s) drifted — run /gsd sync
```

## What gsd-core sees

gsd-core is unaware of gsd-pi. It sees `.gsd/*.md` as ordinary markdown and edits them directly. gsd-pi's `.gsd/.compat.json` and `gsd.db` files are ignored by gsd-core (it preserves unknown files, so they won't be deleted).

## `.planning/` projects

If your project uses gsd-core's `.planning/` layout (flat `phases/NN-name/` directories, root `ROADMAP.md` / `STATE.md`), import it explicitly with `/gsd migrate`. After migration, gsd-pi can project canonical DB state back to the recorded layout.

- `/gsd migrate` previews and imports the hierarchy through a verified Import Application, then records the layout in `.gsd/.compat.json` only after publication succeeds.
- On every projection, gsd-pi writes back to `.planning/` using that recorded layout. Cancelled slices and tasks are omitted, and obsolete tracked phase plan files are removed.
- `/gsd sync` preserves modeled gsd-core `.planning/` edits before restoring the database-backed projection; `/gsd doctor` reports `.planning/` drift separately from `.gsd/` drift.

**Un-modeled docs** (phase `DISCUSSION-LOG.md`, `PATTERNS.md`, `REVIEWS.md`, `codebase/`, `research/`) are pass-through: gsd-pi detects edits to them but never overwrites them. They are gsd-core-owned.

**v1 limitation:** only the `flat-phases` layout is supported for round-trip projection. `multi-milestone` and `legacy-milestone-dir` layouts will be supported after fixtures validate the reverse-mapping. For those layouts today, run `/gsd migrate` once to move to `.gsd/`.

## Conflicts: same entity edited in both

If both tools edit the *same* entity, gsd-pi does not choose a last writer: `/gsd sync` keeps the database authoritative, preserves the edited modeled file under `.gsd/quarantine/projections/`, and restores the database-backed projection. Use the matching gsd-pi planning or reopen tool when the database is correct. If markdown intentionally contains state missing from a damaged database, use the evidence-bound `/gsd recover` flow; use `/gsd migrate` for `.planning/`. Git review remains the final safety net — that's why the "commit before switching" workflow matters.

## Troubleshooting

**`gsd doctor` says "no baseline"**: run `/gsd sync` once to establish the marker.

**`.gsd/.compat.json.bad-*` files appear**: gsd-pi quarantined a malformed marker and started fresh. Safe to delete the `.bad-*` file after reviewing it.

**`/gsd sync` reports drift every time you open the project**: this means gsd-pi's projection isn't idempotent — a real bug. The round-trip property test suite in CI catches most of these; report the fixture if you hit one in the wild.
