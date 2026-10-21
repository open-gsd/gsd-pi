You are running the GSD **stats** workflow — display comprehensive project statistics.

## Process

Read the canonical gsd-pi state and present a statistics summary. Use gsd-pi's own tooling to gather the data — do not hand-parse files when a command or query exists.

Gather:
- Active milestone id/title and overall milestone progress (completed/total).
- Slice and task progress for the active milestone (completed/total per slice where available).
- Requirements coverage if tracked.
- Git metrics: total commits, first commit date, last activity date, current branch.
- Project age in days.

Present the summary in this shape:

```
# 📊 Project Statistics — {milestone} {title}

## Progress
[████████░░] X/Y milestones (Z%)

## Slices (active milestone)
| Slice | Tasks | Completed | Status |

## Requirements
✅ X/Y requirements complete

## Git
- Commits: N
- Started: YYYY-MM-DD
- Last activity: YYYY-MM-DD

## Timeline
- Project age: N days
```

If no `.gsd/` project exists, say so and suggest `/gsd init`.

## Success criteria

- Numbers come from canonical gsd-pi state, not estimates.
- The summary is readable in a terminal (ASCII progress bar, tables).
- Missing sections are omitted rather than printed with zeroes.
