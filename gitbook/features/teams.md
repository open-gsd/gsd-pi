# Working in Teams

GSD supports multi-user workflows where several developers work on the same repository concurrently.

## Quick Setup

The simplest way: set team mode in your project preferences.

```yaml
# .gsd/PREFERENCES.md (committed to git)
---
version: 1
mode: team
---
```

This enables unique milestone IDs, push branches, pre-merge checks, and other team-appropriate defaults in one setting.

## What Team Mode Does

| Setting | Effect |
|---------|--------|
| `unique_milestone_ids` | IDs like `M001-eh88as` instead of `M001` — no collisions |
| `git.push_branches` | Milestone branches are pushed to remote |
| `git.pre_merge_check` | Validation runs before merging |

You can override individual settings on top of `mode: team`.

## Know What Is Shared

The workflow database is never committed, and every checkout has its own. Committed `.gsd/` markdown is an export for review, not shared authority: it enters a database only through an explicit `/gsd recover` import. GSD keeps its runtime files out of git for you. See the [authoritative team guide](../../docs/user-docs/working-in-teams.md#2-know-what-is-shared) for the bound-checkout rules and the import flow after a clone or pull.

## Commit the Config

```bash
git add .gsd/PREFERENCES.md
git commit -m "chore: enable GSD team workflow"
```

## Parallel Development

Multiple developers can run auto mode simultaneously on different milestones. Each developer:

- Gets their own worktree (`.gsd/worktrees/<MID>/`)
- Works on a unique `milestone/<MID>` branch
- Squash-merges to main independently

Milestone dependencies can be declared in the phase context frontmatter:

```yaml
---
depends_on: [M001-eh88as]
---
```

GSD enforces that dependent milestones complete before starting downstream work.
