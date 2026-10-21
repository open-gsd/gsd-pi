# Preferences

GSD preferences live in YAML frontmatter markdown files. You can configure them globally or per-project.

## Managing Preferences

```
/gsd prefs              # open the global preferences wizard
/gsd prefs project      # open the project preferences wizard
/gsd prefs status       # show current values and where they come from
```

## Preference Files

| Scope | Path | Applies To |
|-------|------|-----------|
| Global | `~/.gsd/PREFERENCES.md` | All projects |
| Project | `.gsd/PREFERENCES.md` | Current project only |

**How they merge:**
- **Scalar fields** (`budget_ceiling`, `token_profile`): project wins if defined
- **Array fields** (`always_use_skills`, etc.): concatenated (global first, then project)
- **Object fields** (`models`, `git`, `auto_supervisor`): shallow-merged, project overrides per-key

## Quick Example

```yaml
---
version: 1

# Model selection
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-8
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6

# Token optimization
token_profile: balanced

# Project discovery
planning_depth: deep

# Budget
budget_ceiling: 25.00
budget_enforcement: pause

# Supervision
auto_supervisor:
  soft_timeout_minutes: 15
  hard_timeout_minutes: 25

# Git
git:
  auto_push: true
  merge_strategy: squash
  isolation: none
  collapse_cadence: milestone   # or "slice" — see Git & Worktrees docs
  # milestone_resquash applies only when collapse_cadence: "slice"
  # milestone_resquash: true    # collapse slice commits into one at milestone end

# Verification
verification_commands:
  - npm run lint
  - npm run test

# Notifications
notifications:
  on_milestone: true
  on_attention: true
  local_bell: false
---
```

## All Settings

### `models`

Per-phase model selection. See [Choosing a Model](../getting-started/choosing-a-model.md).

```yaml
models:
  research: claude-sonnet-4-6
  planning:
    model: claude-opus-4-8
    fallbacks:
      - openrouter/z-ai/glm-5
  execution: claude-sonnet-4-6
  execution_simple: claude-haiku-4-5
  completion: claude-sonnet-4-6
  subagent: claude-sonnet-4-6
```

### `token_profile`

Coordinates model selection, phase skipping, and context compression. Values: `budget`, `balanced` (default), `quality`. See [Token Optimization](../features/token-optimization.md).

### `planning_depth`

Controls how much discovery runs before milestone-level planning.

```yaml
planning_depth: deep
```

| Value | Behavior |
|-------|----------|
| `light` | Default. Uses the normal milestone discussion flow. |
| `deep` | Runs workflow preferences, `.gsd/PROJECT.md`, `.gsd/REQUIREMENTS.md`, a research decision, and optional project research before milestone planning. |

Enable deep mode with `/gsd new-project --deep`, `/gsd new-milestone --deep`, or by adding the setting to `.gsd/PREFERENCES.md`. The research decision is recorded in `.gsd/runtime/research-decision.json`; choosing research writes `.gsd/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, and `PITFALLS.md`.

### `planning_subagents`

Project-local allowlists for controlled read-only subagent dispatch during planning:

```yaml
planning_subagent_registry:
  my-custom-planner:
    read_only_specialist: true

planning_subagents:
  plan-milestone:
    allowed: [scout, planner, my-custom-planner, security]
  plan-slice:
    allowed: [scout, planner, my-custom-planner, reviewer, security]
```

Only `plan-milestone` and `plan-slice` are configurable. Agents must be built-in read-only planning specialists (`mnemo`, `scout`, `planner`, `reviewer`, `security`, or `tester`) or registered in `planning_subagent_registry` with `read_only_specialist: true`. The write gate still blocks unsafe or unlisted agents.

### `budget_ceiling`

Maximum USD to spend during auto mode:

```yaml
budget_ceiling: 50.00
```

### `budget_enforcement`

What happens when the ceiling is reached:

| Value | Behavior |
|-------|----------|
| `warn` | Log a warning, continue |
| `pause` | Pause auto mode (default) |
| `halt` | Stop auto mode entirely |

### `auto_supervisor`

Timeout thresholds for auto mode:

```yaml
auto_supervisor:
  soft_timeout_minutes: 20    # warn AI to wrap up
  idle_timeout_minutes: 10    # detect stalls
  hard_timeout_minutes: 30    # pause auto mode
```

### `min_request_interval_ms`

Minimum milliseconds between auto-mode LLM request dispatches. Use this to proactively slow auto-mode on rate-limited providers and reduce 429 errors. Set to `0` to disable.

```yaml
min_request_interval_ms: 1000   # wait at least 1 second between LLM requests
```

Default: `0` (disabled)

### `verification_commands`

Shell commands that run after every task execution:

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true       # auto-retry runnable failures (default)
verification_max_retries: 2       # max attempts (default: 2)
verification_timeout_ms: 120000   # host verification and verification-oriented gsd_exec default (default: 120000)
```

`verification_timeout_ms` also supplies the default timeout for verification-oriented `gsd_exec` workloads such as builds, tests, linting, type checks, and verification commands. An explicit `context_mode.exec_timeout_ms` takes precedence; unrelated `gsd_exec` workloads keep the sandbox's 30-second default when `context_mode.exec_timeout_ms` is unset.

Auto-fix retries apply to runnable checks that fail. A missing executable—including exit code 127, `command not found`, or the Windows `is not recognized as an internal or external command` error—is classified as `command-not-found` and recorded as inconclusive verification evidence. Auto mode pauses for manual correction without consuming `verification_max_retries`; install the executable or update the command, then resume.

Verification commands must be simple executable commands. Shell piping (`|`) is supported, but logical OR (`||`) is rejected. GSD also rejects redirects (`>` and `<`), semicolons, backticks, and command substitution (`$(...)`) because verification is run as a controlled command list, not as an arbitrary shell program.

For task-level `verify` commands (`taskPlanVerify`), GSD splits checks on newlines. `&&` chains stay within a single shell invocation, so commands such as `cd path && npm test` preserve directory context.

For the authoritative project-check discovery order and package-manager command forms, see [Configuration — Verification](../../docs/user-docs/configuration.md#verification).

### `workspace`

Multi-repository workspace configuration for parent projects:

```yaml
workspace:
  mode: parent
  repositories:
    frontend:
      path: apps/frontend
      role: web
      verification:
        - pnpm -C apps/frontend test
      commit_policy: auto
    backend:
      path: services/backend
      role: api
      verification:
        - pnpm -C services/backend test
      commit_policy: skip
```

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `workspace.mode` | `"project" \| "parent"` | `"project"` | Workspace operating mode. |
| `workspace.repositories` | object | `{}` | Mapping of repository IDs to repository config. |
| `workspace.repositories.<id>.path` | string | required | Child repository path, resolved relative to project root. Must stay inside the project root. |
| `workspace.repositories.<id>.role` | string | optional | Human-oriented role label used in prompts/reporting. |
| `workspace.repositories.<id>.verification` | string[] | optional | Default verification commands for that repository. |
| `workspace.repositories.<id>.commit_policy` | `"auto" \| "skip"` | optional | Per-repository auto-mode turn-commit policy. |

Validation rules:

- Repository IDs must match `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
- Repository paths are normalized and must be unique (case-insensitive).
- Paths resolving outside the project root are rejected.
- Unknown `workspace` keys are ignored with warnings.

When `workspace.mode` is `parent` and child repositories are declared, `/gsd codebase generate` and automatic `CODEBASE.md` refreshes enumerate the implicit `project` repository plus each child repository. The generated `.gsd/CODEBASE.md` uses workspace-relative paths, groups files under `## [repo-id]` sections, and records the repository IDs in its metadata so changes to the workspace registry refresh the map.

### `phases`

Fine-grained control over which phases run:

```yaml
phases:
  skip_research: false
  skip_reassess: false
  skip_slice_research: true
  reassess_after_slice: true
  require_slice_discussion: false
```

### `reactive_execution`

Automatic parallel task dispatch inside a slice. Reactive execution is enabled by default and only dispatches when task-plan IO annotations produce a non-ambiguous graph with enough ready, non-conflicting tasks.

```yaml
reactive_execution:
  enabled: false    # opt out
```

When omitted, GSD uses the default-on threshold of three ready tasks. Set `enabled: true` explicitly to use the lower two-ready-task threshold. Optional fields: `max_parallel` (default `2`, range `1`-`8`), `isolation_mode: same-tree`, and `subagent_model`.

### `skill_discovery`

| Value | Behavior |
|-------|----------|
| `auto` | Skills found and applied automatically |
| `suggest` | Skills identified but not auto-applied (default) |
| `off` | Skill discovery disabled |

### `dynamic_routing`

Automatic model selection by task complexity. See [Dynamic Model Routing](../features/dynamic-model-routing.md).

```yaml
dynamic_routing:
  enabled: true
  escalate_on_failure: true
  budget_pressure: true
```

### `git`

Git behavior. See [Git & Worktrees](git-settings.md).

```yaml
git:
  auto_push: false
  merge_strategy: squash
  isolation: none
  commit_docs: true
  auto_pr: false
```

Set `isolation: worktree` when you need milestone file isolation. Worktree mode requires a committed `HEAD`; in a zero-commit repo, GSD temporarily behaves as `none` until the first commit exists.

### `notifications`

See [Notifications](notifications.md).

```yaml
notifications:
  enabled: true
  local_bell: false
  on_complete: true
  on_error: true
  on_milestone: true
  on_attention: true
```

### `remote_questions`

Route questions to Slack, Discord, or Telegram. See [Remote Questions](../features/remote-questions.md).

```yaml
remote_questions:
  channel: discord
  channel_id: "1234567890123456789"
  timeout_minutes: 5
```

### `parallel`

Run multiple milestones simultaneously. See [Parallel Orchestration](../features/parallel.md).

```yaml
parallel:
  enabled: false
  max_workers: 2
  budget_ceiling: 50.00
```

### `custom_instructions`

Durable instructions appended to every session:

```yaml
custom_instructions:
  - "Always use TypeScript strict mode"
  - "Prefer functional patterns over classes"
```

For project-specific durable guidance, use `.gsd/KNOWLEDGE.md` instead. Rules are read from the file; patterns and lessons are persisted to the `memories` table and projected back into `KNOWLEDGE.md` on the next session start.

### `context_pause_threshold`

Context window usage percentage at which auto mode pauses:

```yaml
context_pause_threshold: 80   # pause at 80%
```

### `show_token_cost`

Show per-prompt and cumulative session token cost in the footer:

```yaml
show_token_cost: true
```
