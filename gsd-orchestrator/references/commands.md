# GSD Commands Reference

All commands run as subprocesses via `gsd headless [flags] [command] [args...]`.

## Global Flags

These flags apply to any `gsd headless` invocation:

| Flag | Description |
|------|-------------|
| `--output-format <fmt>` | `text` (default), `json` (structured result), `stream-json` (JSONL) |
| `--json` | Alias for `--output-format stream-json` |
| `--bare` | Minimal context: skip CLAUDE.md, AGENTS.md, user settings, user skills |
| `--resume <id>` | Resume a prior headless session by ID |
| `--timeout N` | Overall timeout in ms (default: 300000) |
| `--model ID` | Override LLM model |
| `--supervised` | Forward interactive UI requests to orchestrator via stdout/stdin |
| `--response-timeout N` | Timeout for orchestrator response in supervised mode (default: 30000ms) |
| `--answers <path>` | Pre-supply answers and secrets from JSON file |
| `--events <types>` | Filter JSONL output to specific event types (comma-separated, implies `--json`) |
| `--verbose` | Show tool calls in progress output |

## Exit Codes

| Code | Meaning | When |
|------|---------|------|
| `0` | Success | Unit/milestone completed normally |
| `1` | Error or timeout | Runtime error, LLM failure, or `--timeout` exceeded |
| `10` | Blocked | Execution hit a blocker requiring human intervention |
| `11` | Cancelled | User or orchestrator cancelled the operation |

## Workflow Commands

### `auto` (default)

Autonomous mode — loop through all pending units until milestone complete or blocked.

```bash
gsd headless --output-format json auto
```

### `next`

Step mode — execute exactly one unit (task/slice/milestone step), then exit. Recommended for orchestrators that need decision points between steps.

```bash
gsd headless --output-format json next
```

### `quick <task>`

Execute a lightweight task with GSD branch, artifact, and commit guarantees. The
short form `gsd quick` is an alias for the headless command.

```bash
gsd quick --output-format json "fix the login button on mobile"
gsd headless --output-format json quick "update the setup instructions"
```

The JSON result includes `task`, `branch`, `artifacts`, and `commits`. Quick
tasks are not automatically retried because replaying a repository mutation
could duplicate work.

### `new-milestone`

Create a milestone from a specification document.

```bash
gsd headless new-milestone --context spec.md
gsd headless new-milestone --context spec.md --auto
gsd headless new-milestone --context-text "Build a REST API" --auto
cat spec.md | gsd headless new-milestone --context - --auto
```

Extra flags:
- `--context <path>` — path to spec/PRD file (use `-` for stdin)
- `--context-text <text>` — inline specification text
- `--auto` — start auto-mode after milestone creation

### `dispatch <phase>`

Force-route to a specific phase, bypassing normal state-machine routing.

```bash
gsd headless dispatch research
gsd headless dispatch plan
gsd headless dispatch execute
gsd headless dispatch complete
gsd headless dispatch reassess
gsd headless dispatch uat
gsd headless dispatch replan
```

### `discuss`

Start guided milestone/slice discussion.

```bash
gsd headless discuss
```

### `stop`

Stop auto-mode gracefully.

```bash
gsd headless stop
```

### `pause`

Pause auto-mode (preserves state, resumable).

```bash
gsd headless pause
```

## State Inspection

### `query`

**Instant JSON snapshot** — state, next dispatch, parallel costs. No LLM, ~50ms. The recommended way for orchestrators to inspect state.

```bash
gsd headless query
gsd headless query | jq '.state.phase'
gsd headless query | jq '.next'
gsd headless query | jq '.cost.total'
```

### `status`

Progress dashboard (TUI overlay — useful interactively, not for parsing).

```bash
gsd headless status
```

### `history`

Execution history. Supports `--cost`, `--phase`, `--model`, and `limit` arguments.

```bash
gsd headless history
```

## Unit Control

### `skip`

Prevent a unit from auto-mode dispatch.

```bash
gsd headless skip
```

### `undo`

Revert last completed unit. Use `--force` to bypass confirmation.

```bash
gsd headless undo
gsd headless undo --force
```

### `steer <description>`

Hard-steer plan documents during execution. Useful for mid-course corrections.

```bash
gsd headless steer "Skip the blocked dependency, use mock instead"
```

### `queue`

Queue and reorder future milestones.

```bash
gsd headless queue
```

## Configuration & Health

### `doctor`

Runtime health checks with auto-fix.

```bash
gsd headless doctor
```

### `prefs`

Manage preferences (global/project/status/wizard/setup).

```bash
gsd headless prefs
```

### `knowledge <rule|pattern|lesson>`

Add persistent project knowledge. Rules append to `KNOWLEDGE.md`; patterns and lessons are captured as memories and projected back into `KNOWLEDGE.md`.

```bash
gsd headless knowledge "Always use UTC timestamps in API responses"
```

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
| `code-review` | Review changed source for bugs, security, and quality |
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

```
pre-planning → needs-discussion → discussing → researching → planning →
executing → verifying → summarizing → advancing → validating-milestone →
completing-milestone → complete
```

Special phases: `paused`, `blocked`, `replanning-slice`

## Hierarchy

- **Milestone**: Shippable version (4–10 slices, 1–4 weeks)
- **Slice**: One demoable vertical capability (1–7 tasks, 1–3 days)
- **Task**: One context-window-sized unit of work (one session)
