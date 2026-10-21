# GSD Commands Reference

All commands can be run via `gsd headless [command]`.

Session startup flags such as `--model ID` and `--thinking LEVEL` can be supplied for headless runs. `--thinking` accepts `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, or `max`.

## Workflow Commands

| Command | Description |
|---------|-------------|
| `auto` | Autonomous mode — loop until milestone complete (default) |
| `next` | Step mode — execute one unit, then exit |
| `stop` | Stop auto-mode gracefully |
| `pause` | Pause auto-mode (preserves state, resumable) |
| `new-milestone` | Create milestone from specification (requires `--context`) |
| `dispatch <phase>` | Force-dispatch: research, plan, execute, complete, reassess, uat, replan |
| `discuss` | Start guided milestone/slice discussion |
| `discard-milestone <ids...> --orphan-only` | Atomically discard DB-only orphan reservations after fail-closed preflight; emits before/after JSON |

## State Inspection

| Command | Description |
|---------|-------------|
| `query` | **Instant JSON snapshot** — state, next dispatch, parallel costs. No LLM, ~50ms. Recommended for orchestrators. |
| `status` | Progress dashboard (TUI overlay — useful interactively, not for parsing) |
| `visualize` | Workflow visualizer (deps, metrics, timeline) |
| `history` | Execution history (supports --cost, --phase, --model, limit) |
| `codebase` | Manage `.gsd/CODEBASE.md`; parent workspaces include declared child repositories under repo-labeled sections |

## Unit Control

| Command | Description |
|---------|-------------|
| `skip` | Prevent a unit from auto-mode dispatch |
| `undo` | Revert last completed unit (--force flag) |
| `steer <desc>` | Hard-steer plan documents during execution |
| `queue` | Queue and reorder future milestones |
| `capture` | Fire-and-forget thought capture |
| `triage` | Manually trigger triage of pending captures |

## Configuration & Health

| Command | Description |
|---------|-------------|
| `prefs` | Manage preferences (global/project/status/wizard/setup) |
| `config` | Set API keys for external tools |
| `doctor` | Runtime health checks with auto-fix |
| `hooks` | Show configured post-unit and pre-dispatch hooks |
| `knowledge <rule\|pattern\|lesson>` | Add persistent project knowledge |
| `cleanup` | Remove merged branches or snapshots |
| `export` | Export results (--json, --markdown) |
| `migrate` | Migrate v1 .planning directory to DB-backed .gsd with backup and audit |
| `remote` | Control remote auto-mode (slack, discord, status, disconnect) |
| `inspect` | Show SQLite DB diagnostics (schema, row counts) |
| `forensics` | Post-mortem investigation of auto-mode failures |

## Additional Prompt-Driven Workflows

These commands dispatch native GSD prompts adapted to the milestone, slice, and `.gsd/` model. Use them as `gsd headless <command> [args...]`.

| Command | Description |
|---------|-------------|
| `explore` | Socratic ideation before committing an idea |
| `spike` | Focused throwaway experiment (`--quick`, `--text`, or frontier mode) |
| `sketch` | UI/design exploration with throwaway HTML mockups |
| `map-codebase` | Generate structured codebase docs under `.gsd/codebase/` |
| `docs-update` | Generate, update, or verify docs against live code |
| `graphify` | Build, query, inspect, or diff `.gsd/knowledge/` |
| `stats` | Show project statistics, milestone state, git metrics, and timeline |
| `progress` | Summarize recent work; can route `--next` or `--do "..."` |
| `health` | Check `.gsd/` integrity (`--repair`, `--context`) |
| `surface` | Manage surfaced skills and extensions |
| `code-review` | Review changed source diff-first for bugs, security, and quality |
| `review` | Peer-review recent work across reviewer perspectives |
| `audit-milestone` | Verify a milestone met its definition of done |
| `audit-uat` | Audit outstanding UAT/verification items |
| `audit-fix` | Classify and remediate audit findings |
| `ui-review` | Run a six-pillar frontend visual audit |
| `secure-phase` | Verify threat mitigations |
| `validate-phase` | Fill validation and test coverage gaps |
| `verify-work` | Run conversational UAT |
| `plan-review-convergence` | Iterate a plan through review cycles |
| `discuss-phase` | Gather milestone or slice context through questions |
| `plan-phase` | Create a detailed slice plan |
| `execute-phase` | Execute slice tasks with wave support |
| `spec-phase` | Clarify what a milestone delivers |
| `mvp-phase` | Plan a vertical MVP milestone |
| `ui-phase` | Produce a `UI-SPEC` |
| `ai-integration-phase` | Produce an `AI-SPEC` |
| `ultraplan-phase` | Run extended planning and review |
| `autonomous` | Run remaining lifecycle work continuously |
| `pause-work` | Create a pause handoff |
| `resume-work` | Resume work with restored context |
| `manager` | Manage multiple milestones from a command-center workflow |
| `phase` | Manage milestone queue ordering |
| `thread` | Manage persistent context threads |
| `workstreams` | Route workstream actions through `parallel` |
| `workspace` | Route workspace actions through `worktree` |
| `milestone-summary` | Generate a project or milestone summary |
| `review-backlog` | Review and promote backlog items |
| `inbox` | Triage GitHub issues and PRs |
| `import` | Ingest external plans with conflict detection |
| `ingest-docs` | Bootstrap or merge `.gsd/` state from docs |
| `profile-user` | Generate and persist a developer profile |
| `settings` | Configure workflow toggles and model profile |
| `ns-context`, `ns-ideate`, `ns-manage`, `ns-project`, `ns-review`, `ns-workflow` | Namespace-grouping names that redirect to `help` |

## Phases

GSD workflows progress through these phases:
`pre-planning` → `needs-discussion` → `discussing` → `researching` → `planning` → `executing` → `verifying` → `summarizing` → `advancing` → `validating-milestone` → `completing-milestone` → `complete`

Special phases: `paused`, `blocked`, `replanning-slice`

## Hierarchy

- **Milestone**: Shippable version (4-10 slices, 1-4 weeks)
- **Slice**: One demoable vertical capability (1-7 tasks, 1-3 days)
- **Task**: One context-window-sized unit of work (one session)
