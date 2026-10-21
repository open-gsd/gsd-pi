# Commands

## Session Commands

| Command | Description |
|---------|-------------|
| `/gsd` | Step mode — execute one unit at a time |
| `/gsd auto` | Autonomous mode — research, plan, execute, commit, repeat |
| `/gsd quick` | Quick task with GSD guarantees but no full planning |
| `/gsd stop` | Stop auto mode gracefully |
| `/gsd pause` | Pause auto mode (preserves state) |
| `/gsd steer` | Modify plan documents during execution |
| `/gsd discuss` | Discuss architecture and decisions |
| `/gsd status` | Progress dashboard |
| `/gsd widget` | Cycle dashboard widget: full / small / min / off |
| `/gsd queue` | Queue and reorder future milestones |
| `/gsd capture` | Fire-and-forget thought capture |
| `/gsd triage` | Manually trigger capture triage |
| `/gsd debug` | Create and inspect persistent /gsd debug sessions |
| `/gsd debug list` | List persisted debug sessions |
| `/gsd debug status <slug>` | Show status for one debug session slug |
| `/gsd debug continue <slug>` | Resume an existing debug session slug |
| `/gsd debug --diagnose` | Inspect malformed artifacts and session health (`--diagnose [<slug> | <issue text>]`) |
| `/gsd dispatch` | Dispatch a specific phase directly |
| `/gsd history` | View execution history (supports `--cost`, `--phase`, `--model` filters) |
| `/gsd forensics` | Full debugger for auto-mode failures (includes worktree lifecycle telemetry) |
| `/gsd cleanup` | Clean up state files and stale worktrees |
| `/gsd worktree` (`/gsd wt`) | Manage GSD worktrees from the TUI |
| `/gsd visualize` | Open workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, memories, captures, export) |
| `/gsd export --html` | Generate HTML report for current milestone |
| `/gsd export --html --all` | Generate reports for all milestones |
| `/gsd update` | Update GSD to the latest version |
| `/gsd knowledge` | Add persistent project knowledge. Rules append to `KNOWLEDGE.md`; patterns and lessons are captured as memories and projected back into `KNOWLEDGE.md`. |
| `/gsd fast` | Toggle service tier for supported models |
| `/gsd rate` | Rate last unit's model tier (over/ok/under) |
| `/gsd changelog` | Show release notes |
| `/gsd logs` | Browse activity and debug logs |
| `/gsd remote` | Control remote auto-mode |
| `/gsd help` | Show all available commands |

## Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Preferences wizard |
| `/gsd mode` | Switch workflow mode (solo/team) |
| `/gsd config` | Re-run provider setup wizard |
| `/gsd keys` | API key manager |
| `/gsd doctor` | Runtime health checks with auto-fix |
| `/gsd inspect` | Show database diagnostics |
| `/gsd init` | Project init wizard |
| `/gsd setup` | Global setup status |
| `/gsd skill-health` | Skill lifecycle dashboard |
| `/gsd hooks` | Show configured hooks |
| `/gsd migrate` | Migrate v1 `.planning` to DB-backed `.gsd` with backup and audit |
| `/gsd recover` | See the [authoritative commands reference](../../docs/user-docs/commands.md) for the evidence-bound Preview, verified Import Application, and recovery contract |
| `/gsd rebuild markdown` | Rebuild markdown projections from the canonical database; stale completion projections are quarantined, not imported |
| `/gsd rebuild database` | Reserved for DB-native rebuilds; does not import markdown projections |
| `/gsd codebase [generate\|update\|stats]` | Manage `.gsd/CODEBASE.md`; parent workspaces include declared child repositories under repo-labeled sections |

## Milestone Management

| Command | Description |
|---------|-------------|
| `/gsd new-project [--deep]` | Bootstrap a new project; `--deep` enables staged project-level discovery |
| `/gsd new-milestone [--deep]` | Create a new milestone; `--deep` opts the project into deep planning mode |
| `/gsd skip` | Prevent a unit from auto-mode dispatch |
| `/gsd undo` | Revert last completed unit |
| `/gsd undo-task` | Reopen a terminal task through canonical DB recovery authority |
| `/gsd reset-slice` | Set a slice active and reopen eligible terminal tasks through guarded DB operations |
| `/gsd park` | Park a milestone (skip without deleting) |
| `/gsd unpark` | Reactivate a parked milestone |

## Additional Prompt-Driven Workflows

These top-level commands dispatch native GSD workflows against the milestone, slice, and `.gsd/` model. Run `/gsd help full` for the generated command list.

| Command | Description |
|---------|-------------|
| `/gsd explore` | Socratic ideation before committing an idea |
| `/gsd spike` | Focused throwaway experiment (`--quick`, `--text`, or frontier mode) |
| `/gsd sketch` | UI/design exploration with throwaway HTML mockups |
| `/gsd map-codebase` | Generate structured codebase docs under `.gsd/codebase/` |
| `/gsd docs-update` | Generate, update, or verify docs against live code |
| `/gsd graphify` | Build, query, inspect, or diff `.gsd/knowledge/` |
| `/gsd stats` | Show project statistics, milestone state, git metrics, and timeline |
| `/gsd progress` | Summarize recent work; can route `--next` or `--do "..."` |
| `/gsd health` | Check `.gsd/` integrity (`--repair`, `--context`) |
| `/gsd surface` | Manage surfaced skills and extensions |
| `/gsd code-review` | Review changed source diff-first for bugs, security, and quality |
| `/gsd review` | Peer-review recent work across reviewer perspectives |
| `/gsd audit-milestone` | Verify a milestone met its definition of done |
| `/gsd audit-uat` | Audit outstanding UAT/verification items |
| `/gsd audit-fix` | Classify and remediate audit findings |
| `/gsd ui-review` | Run a six-pillar frontend visual audit |
| `/gsd secure-phase` | Verify threat mitigations |
| `/gsd validate-phase` | Fill validation and test coverage gaps |
| `/gsd verify-work` | Run conversational UAT |
| `/gsd plan-review-convergence` | Iterate a plan through review cycles |
| `/gsd discuss-phase` | Gather milestone or slice context through questions |
| `/gsd plan-phase` | Create a detailed slice plan |
| `/gsd execute-phase` | Execute slice tasks with wave support |
| `/gsd spec-phase` | Clarify what a milestone delivers |
| `/gsd mvp-phase` | Plan a vertical MVP milestone |
| `/gsd ui-phase` | Produce a `UI-SPEC` |
| `/gsd ai-integration-phase` | Produce an `AI-SPEC` |
| `/gsd ultraplan-phase` | Run extended planning and review |
| `/gsd autonomous` | Run remaining lifecycle work continuously |
| `/gsd pause-work` | Create a pause handoff |
| `/gsd resume-work` | Resume work with restored context |
| `/gsd manager` | Manage multiple milestones from a command-center workflow |
| `/gsd phase` | Manage milestone queue ordering |
| `/gsd thread` | Manage persistent context threads |
| `/gsd workstreams` | Route workstream actions through `/gsd parallel` |
| `/gsd workspace` | Route workspace actions through `/gsd worktree` |
| `/gsd milestone-summary` | Generate a project or milestone summary |
| `/gsd review-backlog` | Review and promote backlog items |
| `/gsd inbox` | Triage GitHub issues and PRs |
| `/gsd import` | Ingest external plans with conflict detection |
| `/gsd ingest-docs` | Bootstrap or merge `.gsd/` state from docs |
| `/gsd profile-user` | Generate and persist a developer profile |
| `/gsd settings` | Configure workflow toggles and model profile |
| `/gsd ns-context`, `/gsd ns-ideate`, `/gsd ns-manage`, `/gsd ns-project`, `/gsd ns-review`, `/gsd ns-workflow` | Namespace-grouping names that redirect to `/gsd help` |

## Parallel Orchestration

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze and start parallel workers |
| `/gsd parallel status` | Show worker state and progress |
| `/gsd parallel stop [MID]` | Stop workers |
| `/gsd parallel pause [MID]` | Pause workers |
| `/gsd parallel resume [MID]` | Resume workers |
| `/gsd parallel merge [MID]` | Merge completed milestones |

## Workflow Templates

| Command | Description |
|---------|-------------|
| `/gsd start` | Start a workflow template |
| `/gsd start resume` | Resume an in-progress workflow |
| `/gsd templates` | List available templates |
| `/gsd templates info <name>` | Show template details |

## Custom Workflows

| Command | Description |
|---------|-------------|
| `/gsd workflow new` | Create a workflow definition |
| `/gsd workflow run <name>` | Start a workflow run |
| `/gsd workflow list` | List workflow runs |
| `/gsd workflow validate <name>` | Validate a workflow YAML |
| `/gsd workflow pause` | Pause workflow auto-mode |
| `/gsd workflow resume` | Resume paused workflow |

## Extensions

| Command | Description |
|---------|-------------|
| `/gsd extensions list` | List extensions and status; package-managed entries show `[user]` or `[project]` (current project only) |
| `/gsd extensions enable <id>` | Enable an extension |
| `/gsd extensions disable <id>` | Disable an extension |
| `/gsd extensions info <id>` | Show extension details |
| `/gsd extensions install <spec>` | Install a user extension from npm, git, or a local path |
| `/gsd extensions uninstall <id>` | Remove a user or current-project extension; package-managed entries remove their shell package |
| `/gsd extensions update [id]` | Update user and current-project npm extensions; git/local entries must be reinstalled |
| `/gsd extensions validate <path>` | Validate an extension package directory |

Shell installs and removals synchronize the extension registry. `gsd install <source>` creates user entries, while `gsd install <source> --local` creates `[project]` entries for the current project; use the same scope with `gsd remove`. `gsd list` reports packages and separate user/project extension sections.

## GitHub Sync

| Command | Description |
|---------|-------------|
| `/github-sync bootstrap` | Initial GitHub sync setup |
| `/github-sync status` | Show sync mapping counts |

## Session Management

| Command | Description |
|---------|-------------|
| `/clear` | Start a new session |
| `/exit` | Graceful shutdown |
| `/model` | Switch the active model |
| `/login` | Log in to an LLM provider |
| `/thinking` | Toggle thinking level |
| `/voice` | Toggle speech-to-text |
| `/worktree` (`/wt`) | Git worktree management |

## GSD Worktree Commands

Use `/gsd worktree` from an active TUI session to inspect and clean up GSD-managed worktrees without leaving the conversation. `/gsd wt` is an alias.

| Command | Description |
|---------|-------------|
| `/gsd worktree list` | Show each worktree, branch, path, clean/unmerged/uncommitted status, diff stats, and commit count. Alias: `/gsd worktree ls`. |
| `/gsd worktree merge [name]` | Merge a worktree into the detected main branch, then remove the worktree and its branch. The name is optional only when exactly one worktree exists. |
| `/gsd worktree clean` | Remove only merged or empty worktrees. Worktrees with unmerged diffs or uncommitted changes are kept. |
| `/gsd worktree remove <name> [--force]` | Remove a named worktree and delete its branch. Refuses unmerged or uncommitted work unless `--force` is supplied. Alias: `/gsd worktree rm`. |

Safety behavior:

- `merge` auto-commits dirty worktree changes before merging when possible.
- `merge` refuses to continue if the project root is not on the detected main branch; check out the main branch and rerun it.
- `clean` never deletes worktrees with pending file changes.
- `remove` requires `--force` to discard unmerged or uncommitted work.

## In-Session Update

```
/gsd update
```

Checks npm for a newer version and installs it without leaving the session.
