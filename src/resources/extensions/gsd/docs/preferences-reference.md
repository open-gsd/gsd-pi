# GSD Preferences Reference

Full documentation for `~/.gsd/PREFERENCES.md` (global) and `.gsd/PREFERENCES.md` (project).

---

## Notes

- Keep this skill-first.
- Prefer explicit skill names or absolute paths.
- Use absolute paths for personal/local skills when you want zero ambiguity.
- These preferences guide which skills GSD should load and follow; they do not override higher-priority instructions in the current conversation.
- For Claude marketplace/plugin import behavior, see `~/.gsd/agent/extensions/gsd/docs/claude-marketplace-import.md`.

---

## Semantics

### Empty Arrays vs Omitted Fields

**Empty arrays (`[]`) are equivalent to omitting the field entirely.** During validation, GSD deletes empty arrays from the preferences object (see `validatePreferences()` in `preferences.ts`):

```typescript
for (const key of [
  "always_use_skills",
  "prefer_skills",
  "avoid_skills",
  "custom_instructions",
] as const) {
  if (validated[key] && validated[key]!.length === 0) {
    delete validated[key];
  }
}
```

These are functionally identical:

```yaml
# Explicit empty arrays — will be normalized away
prefer_skills: []
avoid_skills: []
skill_rules: []

# Omitted entirely — same result
# (just don't write these fields)
```

**Recommendation:** Omit fields you don't need. Empty arrays add noise with no effect.

### Global vs Project Preferences

Preferences are loaded from two locations and merged:

1. **Global:** `~/.gsd/PREFERENCES.md` — applies to all projects
2. **Project:** `.gsd/PREFERENCES.md` — applies to the current project only

**Merge behavior** (see `mergePreferences()` in `preferences.ts`):

- **Scalar fields** (`skill_discovery`, `budget_ceiling`, etc.): Project wins if defined, otherwise global. Uses nullish coalescing (`??`).
- **Array fields** (`always_use_skills`, `prefer_skills`, etc.): Concatenated via `mergeStringLists()` (global first, then project).
- **Object fields** (`models`, `git`, `auto_supervisor`): Shallow merge via spread operator `{ ...base, ...override }`.

For `models`, project settings override global at the phase level. If global has `planning: opus` and project has `planning: sonnet`, the project wins. But if project omits `research`, global's `research` setting is preserved.

### Skill Discovery vs Skill Preferences

These are **separate concerns**:

| Field                                                | What it controls                                          | Code reference                                           |
| ---------------------------------------------------- | --------------------------------------------------------- | -------------------------------------------------------- |
| `skill_discovery`                                    | **Whether** GSD looks for relevant skills during research | `resolveSkillDiscoveryMode()` in `preferences.ts`        |
| `always_use_skills`, `prefer_skills`, `avoid_skills` | **Which** skills to use when they're found relevant       | `renderPreferencesForSystemPrompt()` in `preferences.ts` |

Setting `prefer_skills: []` does **not** disable skill discovery — it just means you have no preference overrides. Use `skill_discovery: off` to disable discovery entirely.

### Parse & Validation Diagnostics

Preference loading never throws. When a file is malformed or contains invalid settings, GSD falls back to safe defaults but attaches structured diagnostics (see `collectPreferenceDiagnostics()` in `preferences-diagnostics.ts`) so the problem is reported instead of silently ignored:

- **Parse failures** (missing closing `---` delimiter, YAML syntax error, or an unrecognized file format) cause the whole file to be ignored. Loading continues to the next candidate and a valid global or legacy preferences file is still used. The safety exception is a malformed project file that attempts to configure `runtime.contract`: GSD preserves an invalid-contract marker so runtime operations fail closed instead of falling back to a different contract.
- **Validation problems** (unknown keys, type mismatches) are sanitized or dropped per-field; the remaining valid settings in the file still apply.

Diagnostics record the file path, scope (global/project), severity (error/warning), kind (parse/validation), and — for YAML parse errors — the line and column. They surface through session-start notifications, `/gsd doctor`, and auto-mode preflight, with each surface deduping repeated diagnostics.

---

## Field Guide

- `version`: schema version. Start at `1`.

- `mode`: workflow mode — `"solo"` or `"team"`. Sets sensible defaults for git and project settings based on your workflow. Mode defaults are the lowest priority layer — any explicit preference overrides them. Omit to configure everything manually.

  | Setting                | `solo`       | `team`       |
  | ---------------------- | ------------ | ------------ |
  | `git.auto_push`        | `true`       | `false`      |
  | `git.push_branches`    | `false`      | `true`       |
  | `git.pre_merge_check`  | `false`      | `true`       |
  | `git.merge_strategy`   | `"squash"`   | `"squash"`   |
  | `git.isolation`        | `"none"`     | `"none"`     |
  | `unique_milestone_ids` | `false`      | `true`       |

  Quick setup: `/gsd mode` (global) or `/gsd mode project` (project-level).

- `always_use_skills`: skills GSD should use whenever they are relevant.

- `prefer_skills`: soft defaults GSD should prefer when relevant.

- `avoid_skills`: skills GSD should avoid unless clearly needed.

- `skill_rules`: situational rules with a human-readable `when` trigger and one or more of `use`, `prefer`, or `avoid`.

- `custom_instructions`: extra durable instructions related to skill use. For operational project knowledge, use `.gsd/KNOWLEDGE.md` instead. Rules are file-canonical; patterns and lessons are persisted to the `memories` table and projected back into `KNOWLEDGE.md` on the next session start.

- `language`: preferred response language for all GSD interactions. Accepts any language name or code — `"Chinese"`, `"zh"`, `"German"`, `"de"`, `"日本語"`, etc. When set, GSD injects "Always respond in \<language\>" into every agent's system prompt, including after `/clear`. Quickest way to set it: `/gsd language <name>`. To clear: `/gsd language off`.

- `models`: per-stage model selection (applies to both auto-mode and guided-flow dispatches). Keys: `research`, `planning`, `discuss`, `execution`, `execution_simple`, `completion`, `validation`, `subagent`, `uat`. Values can be:
  - Simple string: `"claude-sonnet-4-6"` — single model, no fallbacks
  - Provider-qualified string: `"bedrock/claude-sonnet-4-6"` — targets a specific provider when the same model ID exists across multiple providers
  - Object with fallbacks: `{ model: "claude-opus-4-6", fallbacks: ["glm-5", "minimax-m2.5"] }` — tries fallbacks in order if primary fails
  - Object with provider: `{ model: "claude-opus-4-6", provider: "bedrock" }` — explicit provider targeting in object format
  - Object with thinking: `{ model: "claude-opus-4-6", thinking: "xhigh" }` — pins the reasoning effort for that phase (see `thinking` below)
  - Omit a key to use whatever model is currently active (except `discuss` and `validation` which fall back to `planning` when unset). Fallbacks are tried when model switching fails (provider unavailable, rate limited, etc.).
  - `discuss` — used for milestone/slice discussion (interactive context gathering). Falls back to `planning` if unset.
  - `validation` — used for gate evaluation, roadmap reassessment, milestone validation, and doc rewrites. Falls back to `planning` if unset.
  - `uat` — used for UAT runs. Falls back to `completion` if unset.

- `thinking`: per-phase reasoning effort (ADR-026), separate from `models`. Same phase keys as `models`. Values: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. Thinking travels with the model — model choice and reasoning effort are independent controls, so you can run one model across phases at different reasoning levels.
  - Two equivalent ways to set it: inline as `models.<phase>.thinking`, or as a separate `thinking:` block keyed by phase. For the same phase, the inline value wins over the block; project preferences win over global; a phase that's unset inherits via the same sibling chain as `models` (e.g. `discuss → planning`).
  - If no thinking is configured for a phase, the session level (set via `/model`) is used, exactly as before — this is fully backward-compatible.
  - `execute-task` (code-writing) has a measured reasoning floor of `medium`: at lower levels models stop planning edits and thrash on file re-reads. The floor applies to the session/default path. An **explicit** `execution` thinking level bypasses the floor and is honored verbatim (with a one-time advisory) — set `execution: low` deliberately if you want it.
  - Levels a model can't support are clamped to the nearest supported level at dispatch and never sent to the provider, so a model/level mismatch never fails a unit mid-run. `xhigh` and `max` support are model-dependent; current examples include `gpt-5.6-sol`, `gpt-5.6-terra`, and `gpt-5.6-luna`, which advertise both.

- `skill_staleness_days`: number — skills unused for this many days get deprioritized during discovery. Set to `0` to disable staleness tracking. Default: `60`.

- `skill_discovery`: controls how GSD discovers and applies skills during auto-mode. Valid values:
  - `auto` — skills are found and applied automatically without prompting.
  - `suggest` — (default) skills are identified during research but not installed automatically.
  - `off` — skill discovery is disabled entirely.

- `auto_supervisor`: configures the auto-mode supervisor that monitors agent progress and enforces timeouts. Keys:
  - `model`: model to use for the supervisor process (defaults to the currently active model). Accepts a bare model ID **or** the same `{ model, provider?, fallbacks? }` object form as `models.<phase>`, so it honors `fallbacks[]` on a transient provider trip.
  - `soft_timeout_minutes`: minutes before the supervisor issues a soft warning (default: 20).
  - `idle_timeout_minutes`: minutes of inactivity before the supervisor intervenes (default: 10).
  - `hard_timeout_minutes`: minutes before the supervisor forces termination (default: 30).

- `min_request_interval_ms`: number — minimum integer milliseconds between auto-mode LLM request dispatches. Non-integer values are rounded down (e.g., `1000.9 → 1000`). Use this to proactively slow auto-mode on rate-limited providers and reduce 429 errors. Set to `0` to disable. Default: `0` (disabled).

- `git`: configures GSD's git behavior. All fields are optional — omit any to use defaults. Keys:
  - `auto_push`: boolean — automatically push commits to the remote after committing. Default: `false`.
  - `push_branches`: boolean — push the milestone branch to the remote after commits. Default: `false`.
  - `remote`: string — git remote name to push to. Default: `"origin"`.
  - `snapshots`: boolean — create WIP snapshot commits (e.g. pre-dispatch and stale-uncommitted-changes safety commits emitted by the doctor). Set to `false` to suppress all doctor-initiated `gsd snapshot:` commits. Default: `true`.
  - `pre_merge_check`: boolean or `"auto"` — run pre-merge checks before merging a worktree back to the integration branch. `true` always runs, `false` never runs, `"auto"` runs when CI is detected. Default: `"auto"`.
  - `commit_type`: string — override the conventional commit type prefix. Must be one of: `feat`, `fix`, `refactor`, `docs`, `test`, `chore`, `perf`, `ci`, `build`, `style`. Default: inferred from diff content.
  - `main_branch`: string — the primary branch name for new git repos (e.g., `"main"`, `"master"`, `"trunk"`). Also used by `getMainBranch()` as the preferred branch when auto-detection is ambiguous. Default: `"main"`.
  - `merge_strategy`: `"squash"` or `"merge"` — controls how worktree branches are merged back. `"squash"` combines all commits into one; `"merge"` preserves individual commits. Default: `"squash"`.
  - `isolation`: `"none"`, `"worktree"`, or `"branch"` — controls auto-mode git isolation strategy. `"none"` works directly on the current branch with no worktree or milestone branch (default, ideal for step-mode with hot reloads); `"worktree"` creates a milestone worktree for isolated work; `"branch"` works directly in the project root but creates a milestone branch (useful for submodule-heavy repos). `worktree` requires a committed `HEAD`; in a zero-commit repo, GSD temporarily treats it as `none` until the first commit exists. Default: `"none"`.
  - `manage_gitignore`: boolean — when `false`, GSD will not touch `.gitignore` at all. Useful when your project has a strictly managed `.gitignore` and you don't want GSD adding entries. Default: `true`.
  - `worktree_post_create`: string — script to run after a worktree is created (both auto-mode and manual `/worktree`). Receives `SOURCE_DIR` and `WORKTREE_DIR` as environment variables. Can be absolute or relative to project root. Runs with 30-second timeout. Failure is non-fatal (logged as warning). Default: none.
  - `auto_pr`: boolean — automatically create a GitHub pull request after a milestone branch is merged. Requires `gh` CLI to be installed. Default: `false`.
  - `pr_target_branch`: string — branch to target when `auto_pr` is enabled. Defaults to `main_branch` when omitted.
  - **Deprecated:** `commit_docs` — no longer valid; `.gsd/` is always gitignored. Remove this setting.
  - **Deprecated:** `merge_to_main` — no longer valid; milestone-level merge is always used. Remove this setting.

- `workspace`: configures multi-repository parent workspaces. Keys:
  - `mode`: `"project"` (default single-repo behavior) or `"parent"` (one `.gsd` controlling child repos). In `"parent"` mode at least one child repository must be declared under `repositories`, otherwise the setting is rejected at validation time.
  - `repositories`: object map of repository IDs to config.
    - Repository ID format: `^[A-Za-z0-9][A-Za-z0-9._-]*$`.
    - Reserved ID: `project` is implicit and always maps to the project root; user-defined `workspace.repositories.project` is rejected.
    - `path`: required relative path that must resolve within the project root (paths escaping via `..` are rejected).
    - `role`: optional short description of what the repo owns.
    - `verification`: optional array of verification commands for that repo.
    - `commit_policy`: optional `"auto"` or `"skip"` to include or skip commit actions per repo.
  - Planning tools consume repository IDs through `targetRepositories`: `gsd_plan_slice.targetRepositories` sets a slice-wide default, and `gsd_plan_task.targetRepositories` records the repositories an individual task touches. Values must be declared IDs or the implicit `project`; omit these fields in single-repo projects.
  - In parent mode with declared child repositories, `/gsd codebase generate` and automatic `.gsd/CODEBASE.md` refreshes enumerate `project` plus each child repository, render repo-labeled sections, and store repository IDs in map metadata.

- `runtime.contract`: nominates a project-local runtime contract. When omitted, GSD discovers `script/local-runtime/AGENT.md`, `README.md`, and the first available `runtime.mjs`, `runtime.js`, `runtime.ts`, or `runtime.sh`. Keys:
  - `path`: optional contract directory relative to the active project or worktree root. Default: `script/local-runtime`.
  - `entry`: optional canonical entry point relative to the contract directory. When set, the nominated file must exist and validate.
  - Both paths must remain inside the project. See [Project-local runtime contract](../../../../../docs/user-docs/local-runtime-contract.md).
  - Configure this only in project preferences; global preferences do not activate or override runtime contracts. An invalid project override fails closed instead of falling back to the default convention.

## Workspace Example

```yaml
---
version: 1
workspace:
  mode: parent
  repositories:
    frontend:
      path: frontend
      role: web UI
      verification:
        - npm test
        - npm run lint
      commit_policy: auto
    backend:
      path: ./backend
      role: API server
      verification:
        - go test ./...
      commit_policy: auto
---
```

This config sets a parent workspace with two child repositories. The implicit `project` repository is always created for the project root and cannot be user-defined.

In `"parent"` mode, slice/task `targetRepositories` default to the declared child repositories (here `frontend` and `backend`) rather than the root `project` repo. In `"project"` mode (the default), `targetRepositories` defaults to `["project"]`.

- `unique_milestone_ids`: boolean — when `true`, generates milestone IDs in `M{seq}-{rand6}` format (e.g. `M001-eh88as`) instead of plain sequential `M001`. Prevents ID collisions in team workflows where multiple contributors create milestones concurrently. Both formats coexist — existing `M001`-style milestones remain valid. Default: `false`.

- `budget_ceiling`: number — maximum dollar amount to spend on auto-mode. When reached, behavior is controlled by `budget_enforcement`. Default: no limit.

- `budget_enforcement`: `"warn"`, `"pause"`, or `"halt"` — action taken when `budget_ceiling` is reached.
  - `warn` — log a warning but continue execution.
  - `pause` — pause auto-mode and wait for user confirmation.
  - `halt` — stop auto-mode immediately.
  - Default: `"pause"`.

- `context_pause_threshold`: number (`0` or `1-100`) — live context window usage percentage at which auto-mode should pause to suggest checkpointing. Set to `0` to disable. Use whole percentages like `75`, not fractional ratios like `0.75`. Default: `0` (disabled).

- `token_profile`: `"budget"`, `"balanced"`, `"quality"`, or `"burn-max"` — coordinates model selection, phase skipping, and context compression. `budget` skips research/reassessment and uses cheaper models; `balanced` (default) skips research/reassessment to reduce token burn; `quality` prefers higher-quality models; `burn-max` keeps full-context defaults, disables downgrade routing, and keeps phase skips off.

- `planning_depth`: `"light"` or `"deep"` — controls project-level discovery before milestone planning. `"light"` is the default milestone discussion flow. `"deep"` runs workflow preferences, project discussion, requirements discussion, a research-decision gate, and optional project research before milestone planning. Enable it with `/gsd new-project --deep`, `/gsd new-milestone --deep`, or by setting `planning_depth: deep` in project-local `.gsd/PREFERENCES.md`. Global `~/.gsd/PREFERENCES.md` does not opt every fresh repo into deep mode. Deep mode writes `.gsd/PROJECT.md`, `.gsd/REQUIREMENTS.md`, `.gsd/runtime/research-decision.json`, and, when research is approved, `.gsd/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, and `PITFALLS.md`.

- `phases`: fine-grained control over which phases run. Usually set by `token_profile`, but can be overridden. Keys:
  - `skip_research`: boolean — skip milestone-level research. Default: `false`.
  - `reassess_after_slice`: boolean — run a dedicated roadmap-reassessment unit after each completed slice. Default: `false` (per ADR-003 §4). The plan-slice agent for the next slice performs JIT reassessment via a prompt preamble at zero additional token cost; a dedicated reassess session is opt-in. Set to `true` (e.g. via the `burn-max` profile) if you want the explicit session.
  - `skip_reassess`: boolean — force-disable roadmap reassessment even if `reassess_after_slice` is enabled. Default: `false`.
  - `skip_slice_research`: boolean — skip per-slice research. Default: `false`.

- `reactive_execution`: controls automatic parallel task dispatch inside a slice. Reactive execution is enabled by default when omitted; set `enabled: false` to opt out. With default-on behavior, GSD only attempts a reactive batch when at least three ready tasks are available and the task-plan IO graph is non-ambiguous. If you set `enabled: true` explicitly, GSD uses the earlier opt-in threshold of two ready tasks. Keys:
  - `enabled`: boolean — set `false` to force sequential task execution. Default: `true`.
  - `max_parallel`: number — maximum tasks to dispatch in one batch, range `1`-`8`. Default: `2`.
  - `isolation_mode`: `"same-tree"` — currently the only supported value.
  - `subagent_model`: optional model override for reactive task subagents. Accepts a bare model ID **or** the `{ model, provider?, fallbacks? }` object form (parity with `models.<phase>`). Falls back to the `models.subagent` routing when omitted.

- `remote_questions`: route interactive questions to Slack/Discord for headless auto-mode. Keys:
  - `channel`: `"slack"` or `"discord"` — channel type.
  - `channel_id`: string or number — channel ID.
  - `timeout_minutes`: number — question timeout in minutes (clamped 1-30).
  - `poll_interval_seconds`: number — poll interval in seconds (clamped 2-30).

- `notifications`: configures desktop notification behavior during auto-mode. Keys:
  - `enabled`: boolean — master toggle for all notifications. Default: `true`.
  - `local_bell`: boolean — play a local terminal bell when a question needs an answer or auto-mode stops. Default: `false`.
  - `on_complete`: boolean — notify when a unit completes. Default: `true`.
  - `on_error`: boolean — notify on errors. Default: `true`.
  - `on_budget`: boolean — notify when budget thresholds are reached. Default: `true`.
  - `on_milestone`: boolean — notify when a milestone finishes. Default: `true`.
  - `on_attention`: boolean — notify when manual attention is needed. Default: `true`.
  - Terminal auto-loop errors persist an `activity/*-auto-crash-note.json` file with error/session metadata; when available, the error notification includes the crash-note path and instructs resuming with `/gsd auto`.

- `cmux`: configures cmux terminal integration when GSD is running inside a cmux workspace. Keys:
  - `enabled`: boolean — master toggle for cmux integration. Default: `false`.
  - `notifications`: boolean — route desktop notifications through cmux. Default: `true` when enabled.
  - `sidebar`: boolean — publish status, progress, and log metadata to the cmux sidebar. Default: `true` when enabled.
  - `splits`: boolean — run supported subagent work in visible cmux splits. Default: `false`.
  - `browser`: boolean — reserve the future browser integration flag. Default: `false`.

- `dynamic_routing`: configures the dynamic model router that adjusts model selection based on task complexity. Keys:
  - `enabled`: boolean — enable dynamic routing. Default: `false`.
  - `tier_models`: object — model overrides per complexity tier. Keys: `light`, `standard`, `heavy`. Values are model ID strings.
  - `escalate_on_failure`: boolean — escalate to a higher-tier model when the current one fails. Default: `true`.
  - `budget_pressure`: boolean — downgrade model tier when budget is under pressure. Default: `true`.
  - `cross_provider`: boolean — allow routing across different providers. Default: `true`.
  - `hooks`: boolean — enable routing hooks. Default: `true`.
  - `capability_routing`: boolean — enable capability-profile scoring for model selection within a tier. Requires `enabled: true`. Default: `false`.

- `disabled_model_providers`: string[] — provider IDs to hide from model selection and routing (for example `["google-gemini-cli"]`). This only affects model availability (`/model`, auto-model selection, routing); it does not disable tool auth flows like `google_search`.

- `uok`: Unified Orchestration Kernel controls. Keys:
  - `enabled`: boolean — enable kernel wrappers and contract observers. Default: `true`.
  - `legacy_fallback.enabled`: boolean — emergency release fallback that forces legacy orchestration behavior even when `uok.enabled` is `true`. Default: `false`.
    - Runtime override: set `GSD_UOK_FORCE_LEGACY=1` (or `GSD_UOK_LEGACY_FALLBACK=1`) to force legacy behavior for the current process.
  - `gates.enabled`: boolean — route checks through the unified gate runner and persist `gate_runs`. Default: `true`.
  - `model_policy.enabled`: boolean — enforce policy filtering before model capability scoring. Default: `true`.
  - `execution_graph.enabled`: boolean — enable DAG scheduler facade/adapters for execution. Default: `true`.
  - `gitops.enabled`: boolean — persist turn-level git transaction records. Default: `true`.
  - `gitops.turn_action`: `"commit"` | `"snapshot"` | `"status-only"` — turn transaction mode. Default: `"commit"` (per-task atomic commits).
  - `gitops.turn_push`: boolean — whether turn transactions should include push intent metadata. Default: `false`.
  - `audit_unified.enabled`: boolean — dual-write unified audit envelope events. Default: `true`.
  - `plan_v2.enabled`: boolean — enable bounded clarify/research/draft/compile planning flow. Default: `true`.

- `context_management`: configures context hygiene for auto-mode sessions. In step mode, the configurable threshold is a soft warning; automatic session re-rooting happens only at the fixed 90% hard context boundary. Keys:
  - `observation_masking`: boolean — mask old tool results to reduce context bloat. Default: `true`.
  - `observation_mask_turns`: number — keep this many recent turns verbatim (1-50). Default: `8`.
  - `compaction_threshold_percent`: number — show a soft context warning at this fraction of the context window (0.5-0.95). Lower values warn earlier so operators can compact manually before drift accumulates. Default: `0.60`.
  - `tool_result_max_chars`: number — max chars per tool result in GSD sessions (200-10000). Default: `800`.

- `auto_visualize`: boolean — show a visualizer hint after each milestone completion in auto-mode. Default: `false`.

- `auto_report`: boolean — generate an HTML report snapshot after each milestone completion. Default: `true`.

- `search_provider`: `"brave"`, `"tavily"`, `"ollama"`, `"native"`, or `"auto"` — selects the search backend for research phases. `"native"` forces Anthropic's built-in web search only; provider values force that backend and disable native search; `"auto"` uses the default heuristic. Default: `"auto"`.

- `context_selection`: `"full"` or `"smart"` — controls how files are inlined into context. `"full"` inlines entire files; `"smart"` uses semantic chunking to include only the most relevant sections. Default is derived from `token_profile`.

- `parallel`: configures parallel orchestration for running multiple slices concurrently. Keys:
  - `enabled`: boolean — enable parallel execution. Default: `false`.
  - `max_workers`: number — maximum concurrent workers (1-4). Default: `2`.
  - `budget_ceiling`: number — optional per-parallel-run budget ceiling.
  - `merge_strategy`: `"per-slice"` or `"per-milestone"` — when to merge worktree results back. Default: `"per-milestone"`.
  - `auto_merge`: `"auto"`, `"confirm"`, or `"manual"` — merge behavior after completion. `"auto"` merges immediately; `"confirm"` asks first; `"manual"` leaves branches for you. Default: `"confirm"`.
  - `worker_model`: string — optional model override for parallel milestone workers. When set, workers use this model (e.g. `"claude-haiku-4-5"`) instead of inheriting the coordinator's model. Useful for cost savings on execution-heavy milestones.

- `workspace`: repository-scoping for parent/multi-repo workspaces. Keys:
  - `mode`: `"project"` | `"parent"` — enables single-repo (default) or parent workspace behavior.
  - `repositories`: map of repository IDs to repository config:
    - `path`: string (required) — path relative to project root.
    - `role`: string (optional) — informational role label.
    - `verification`: string[] (optional) — repository-specific verification commands used when global `verification_commands` is not set.
    - `commit_policy`: `"auto"` | `"skip"` (optional) — per-repository closeout commit behavior.
  - `project` is always an implicit repository target mapped to the project root for backward compatibility.
  - `targetRepositories` on `gsd_plan_slice` sets the slice-wide default. `targetRepositories` on `gsd_plan_task` records or overrides the repository IDs for an individual task.
  - Values must match declared repository IDs or the implicit `project`; omitted plan/task `targetRepositories` defaults to `["project"]`.
  - `/gsd codebase` is workspace-aware in parent mode with declared child repositories: generated `.gsd/CODEBASE.md` uses workspace-relative paths, groups files under `## [repo-id]` headings, and refreshes when repository registry metadata changes.

- `verification_commands`: string[] — shell commands to run as host-owned verification after task execution (e.g., `["npm test", "npm run lint"]`). Commands run in order; if a runnable command fails, GSD records a failing Technical Verdict for the task Attempt and routes the task to retry or pause instead of publishing completion. A missing executable is handled as inconclusive evidence as described below.

- `verification_auto_fix`: boolean — when `true`, automatically attempt to fix runnable verification failures instead of just reporting them. Default: `true`; set to `false` to pause on the first failed or inconclusive host verdict. This setting does not make a missing executable retryable.

- `verification_max_retries`: number — maximum number of fix-and-retry cycles for runnable verification failures. Default: `2`.

  For missing-command handling and the task-evidence exception, see [Auto Mode — Verification Enforcement](../../../../../docs/user-docs/auto-mode.md#verification-enforcement).

- `per_unit_cost_cap_usd`: number — per-unit retry cost ceiling in USD for verification retries. Must be a positive finite number when set; invalid values are rejected during preference validation. Default: `5.0`. During auto-verification and artifact-retry flows, auto-mode pauses when the current unit reaches this cap or when current unit cost spikes to at least `3.0x` the rolling average.

- `uat_dispatch`: boolean — when `true`, dispatches routine artifact-driven UAT in addition to UAT that requires runtime or browser evidence. Runtime/browser-required UAT dispatches by default even when this is `false`. Deep planning sets it to `true` when the preference is absent and preserves an explicit `false`. Default: `false`.

  Recommended for long autonomous runs:

  ```yaml
  verification_auto_fix: true
  verification_max_retries: 2
  uat_dispatch: true
  ```

  These settings control how verification is attempted; they do not grant
  lifecycle authority. Runnable failures are repaired and retried within the
  configured limits. For missing executables, see [Verification Enforcement](../../../../../docs/user-docs/auto-mode.md#verification-enforcement);
  other pauses should mean the agent exhausted its available repair
  path, needs external access or a dependency, or genuinely needs a user decision.
  No preference or Markdown UAT result can bypass canonical Task proof or
  complete a Slice.

- `post_unit_hooks`: array — hooks that fire after a unit completes. Each entry has:
  - `name`: string — unique hook identifier.
  - `after`: string[] — unit types that trigger this hook (e.g., `["execute-task"]`).
  - `prompt`: string — prompt sent to the LLM. Supports `{milestoneId}`, `{sliceId}`, `{taskId}` substitutions.
  - `max_cycles`: number — max times this hook fires per trigger (default: 1, max: 10).
  - `model`: optional model override. Accepts a bare model ID **or** the same `{ model, provider?, fallbacks? }` object form as `models.<phase>`. With `fallbacks[]`, a transient trip of the primary provider falls back to the next entry instead of hard-failing the hook — which, for a `blocking` hook with `on_block: { action: pause }`, would otherwise pause the whole run.
  - `artifact`: string — expected output file name (relative to task/slice dir). Advisory hooks skip an existing artifact; blocking hooks assess its outcome before continuing.
  - `criticality`: `"advisory"` or `"blocking"` — advisory preserves best-effort behavior in auto mode and is skipped in step mode (`/gsd next`). Blocking hooks require clean completion plus a valid outcome verdict before either mode advances. Default: `"advisory"`.
  - `retry_on`: string — if this file is produced instead of the artifact, re-run the trigger unit then re-run hooks.
  - `on_block`: object — optional routing for blocking findings:
    - `action`: `"retry-unit"`, `"retry-task"`, `"queue-task"`, `"queue-slice"`, or `"pause"`.
    - `artifact`: string — optional compatibility artifact for retry routing.
  - `agent`: string — agent definition file to use for hook execution.
  - `enabled`: boolean — toggle without removing (default: `true`).

  Blocking hook artifacts must begin with YAML frontmatter containing either `verdict` or `outcome.verdict`.
  Supported verdicts are `pass`, `advisory`, `needs-rework`, `needs-remediation`, and `needs-attention`.
  `pass` and `advisory` continue; `needs-rework` retries the trigger unit when routed with `retry-unit`/`retry-task`; `needs-remediation` and `needs-attention` pause with recovery guidance.
  Pending gate blocks survive pause/resume, including queued sibling gates and
  the trigger's completion identity for retry routing. Resume reconciles these
  gates before selecting the next unit: a resolved gate releases its siblings;
  a sibling that still needs attention holds selection. Doctor's stale hook-state
  cleanup preserves pending gate blocks.
  Hook artifacts are compatibility inputs to hook routing, not lifecycle
  authority. Any resulting Task or Slice retry, cancellation, completion, or
  reopen still commits through the canonical database operation; editing a hook
  artifact cannot directly change lifecycle state.

- `pre_dispatch_hooks`: array — hooks that fire before a unit is dispatched. Each entry has:
  - `name`: string — unique hook identifier.
  - `before`: string[] — unit types to intercept.
  - `action`: `"modify"`, `"skip"`, or `"replace"` — what to do with the unit.
  - `prepend`: string — text prepended to unit prompt (for `"modify"` action).
  - `append`: string — text appended to unit prompt (for `"modify"` action).
  - `prompt`: string — replacement prompt (for `"replace"` action; required when action is `"replace"`).
  - `unit_type`: string — override unit type label (for `"replace"` action).
  - `skip_if`: string — for `"skip"` action: only skip if this file exists (relative to unit dir).
  - `model`: string — optional model override when this hook fires.
  - `enabled`: boolean — toggle without removing (default: `true`).

  **Action validation:**
  - `"modify"` requires at least one of `prepend` or `append`.
  - `"replace"` requires `prompt`.
  - `"skip"` is valid with no additional fields.

- `planning_subagent_registry`: object — optional classification for custom planning agents. Each key is an agent id and must set:
  - `read_only_specialist`: boolean — set to `true` to classify the custom agent as safe for planning dispatch.

- `planning_subagents`: object — project-local widening for read-only planning subagent dispatch. Supported unit keys are `plan-milestone` and `plan-slice`; each has:
  - `allowed`: string[] — additional planning-safe agents for that unit.

  Agents must be built-in read-only planning specialists (`mnemo`, `scout`, `planner`, `reviewer`, `security`, or `tester`) or registered in `planning_subagent_registry` with `read_only_specialist: true`. The write gate still blocks source writes outside `.gsd/**`, unrestricted bash, stale subagent calls without agent identities, agents outside the read-only registry, and agents not listed for the active unit.

  Example:

  ```yaml
  planning_subagent_registry:
    my-custom-planner:
      read_only_specialist: true

  planning_subagents:
    plan-milestone:
      allowed:
        - scout
        - planner
        - my-custom-planner
        - security
    plan-slice:
      allowed:
        - scout
        - planner
        - my-custom-planner
        - reviewer
        - security
  ```

  **Known unit types for `before`/`after`:** `research-milestone`, `plan-milestone`, `research-slice`, `plan-slice`, `execute-task`, `complete-slice`, `replan-slice`, `reassess-roadmap`, `run-uat`.

- `experimental`: opt-in experimental features. All features here are **off by default** — you must explicitly set each one to `true` to enable it. Features in this block may change or be removed without a deprecation cycle while in experimental status. Keys:
  - `rtk`: boolean — enable RTK (Real-Time Kompression) shell-command compression. When enabled, GSD wraps shell commands through the RTK binary to reduce token usage during command execution. RTK is downloaded automatically on first use if not already installed. **Default: `false`** (opt-in required). Set `GSD_RTK_DISABLED=1` in the environment to force-disable regardless of this preference.

---

## Best Practices

- Keep `always_use_skills` short.
- Use `skill_rules` for situational routing, not broad personality preferences.
- Prefer skill names for stable built-in skills.
- Prefer absolute paths for local personal skills.
- **Omit fields you don't need** — empty arrays add noise with no effect.

---

## Workflow Mode Examples

**Solo developer — auto-push, simple IDs:**

```yaml
---
version: 1
mode: solo
---
```

Equivalent to setting `git.auto_push: true`, `git.push_branches: false`, `git.pre_merge_check: false`, `git.merge_strategy: squash`, `git.isolation: none`, `unique_milestone_ids: false`.

**Team — unique IDs, push branches, pre-merge checks:**

```yaml
---
version: 1
mode: team
---
```

Equivalent to setting `git.auto_push: false`, `git.push_branches: true`, `git.pre_merge_check: true`, `git.merge_strategy: squash`, `git.isolation: none`, `unique_milestone_ids: true`.

**Mode with overrides — team mode but with auto-push:**

```yaml
---
version: 1
mode: team
git:
  auto_push: true
---
```

Gets all team defaults except `auto_push`, which is explicitly overridden to `true`. Any explicit setting always wins over the mode default.

---

## Minimal Example

The cleanest preferences file only specifies what you actually want:

```yaml
---
version: 1
always_use_skills:
  - debug-like-expert
skill_discovery: suggest
models:
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
---
```

Everything else uses defaults. No `prefer_skills: []`, no `avoid_skills: []`, no `auto_supervisor: {}` — those are just noise.

---

## Models Example

```yaml
---
version: 1
models:
  research: claude-sonnet-4-6
  planning: claude-opus-4-6
  execution: claude-sonnet-4-6
  completion: claude-sonnet-4-6
---
```

Opus for planning (where architectural decisions matter most), Sonnet for everything else (faster, cheaper). Omit any key to use the currently selected model.

## Models with Fallbacks Example

```yaml
---
version: 1
models:
  research:
    model: openrouter/deepseek/deepseek-r1
    fallbacks:
      - openrouter/minimax/minimax-m2.5
  planning:
    model: claude-opus-4-6
    fallbacks:
      - openrouter/z-ai/glm-5
      - openrouter/moonshotai/kimi-k2.5
  execution:
    model: openrouter/z-ai/glm-5
    fallbacks:
      - openrouter/minimax/minimax-m2.5
  completion: openrouter/minimax/minimax-m2.5
---
```

## Per-Phase Thinking Level Example

Model choice and reasoning effort are independent controls (ADR-026). You can use one model across phases at different reasoning levels, or mix per-phase models with per-phase thinking.

Inline form — thinking pinned alongside the model:

```yaml
---
version: 1
models:
  planning:
    model: bedrock/global.anthropic.claude-sonnet-5
    thinking: xhigh
  execution:
    model: bedrock/global.anthropic.claude-sonnet-5
    thinking: low      # explicit → bypasses the execute-task medium floor
  validation:
    model: bedrock/global.anthropic.claude-sonnet-5
    thinking: high
---
```

Separate-block form — set thinking without pinning a model (the session model is used):

```yaml
---
version: 1
thinking:
  research: medium
  planning: xhigh
  discuss: high
  execution: low
  execution_simple: low
  completion: medium
  validation: high
  uat: medium
---
```

For a single phase, an inline `models.<phase>.thinking` value wins over the same phase in the `thinking:` block; project preferences win over global. Unsupported levels are clamped to the nearest level the resolved model supports.

When a model fails to switch (provider unavailable, rate limited, credits exhausted), GSD automatically tries the next model in the `fallbacks` list. This ensures auto-mode continues even when your preferred provider hits limits.

## Provider Targeting

When the same model ID exists across multiple providers (e.g., `claude-sonnet-4-6` on both Anthropic and Bedrock), use the `provider/model` format or the `provider` field to target a specific one:

```yaml
---
version: 1
models:
  # String format: provider/model
  research: bedrock/claude-sonnet-4-6
  planning: anthropic/claude-opus-4-6

  # Object format: explicit provider field
  execution:
    model: claude-sonnet-4-6
    provider: bedrock
    fallbacks:
      - anthropic/claude-sonnet-4-6
---
```

If you use a bare model ID (no provider prefix) and it exists in multiple providers, GSD will warn you and resolve to the first available match. Use `provider/model` format to avoid ambiguity.

**Cost-optimized example** — use cheap models with expensive ones as fallback for critical phases:

```yaml
---
version: 1
models:
  research: openrouter/deepseek/deepseek-r1 # $0.28/$0.42 per 1M tokens
  planning:
    model: claude-opus-4-6 # $5/$25 — best for architecture
    fallbacks:
      - openrouter/z-ai/glm-5 # $1/$3.20 — strong alternative
  execution: openrouter/minimax/minimax-m2.5 # $0.30/$1.20 — cheapest quality
  completion: openrouter/minimax/minimax-m2.5
---
```

---

## Example Variations

**Minimal — always load a UAT skill and route Clerk tasks:**

```yaml
---
version: 1
always_use_skills:
  - /Users/you/.claude/skills/verify-uat
skill_rules:
  - when: finishing implementation and human judgment matters
    use:
      - /Users/you/.claude/skills/verify-uat
---
```

**Richer routing — prefer cleanup and authentication skills:**

```yaml
---
version: 1
prefer_skills:
  - commit-ignore
skill_rules:
  - when: task involves Clerk authentication
    use:
      - clerk
      - clerk-setup
  - when: the user is looking for installable capability rather than implementation
    prefer:
      - find-skills
---
```

---

## Git Preferences Example

```yaml
---
version: 1
git:
  auto_push: true
  push_branches: true
  remote: origin
  snapshots: true
  pre_merge_check: auto
  commit_type: feat
---
```

All git fields are optional. Omit any field to use the default behavior. Project-level preferences override global preferences on a per-field basis.

---

## Budget & Cost Control Example

```yaml
---
version: 1
budget_ceiling: 10.00
budget_enforcement: pause
context_pause_threshold: 80
---
```

Sets a $10 budget ceiling. Auto-mode pauses when the ceiling is reached. Context window pauses at 80% usage for checkpointing.

---

## Notifications Example

```yaml
---
version: 1
notifications:
  enabled: true
  local_bell: false
  on_complete: false
  on_error: true
  on_budget: true
  on_milestone: true
  on_attention: true
---
```

Disables per-unit completion notifications (noisy in long runs) while keeping error, budget, milestone, and attention notifications enabled.

---

## cmux Example

```yaml
---
version: 1
cmux:
  enabled: true
  notifications: true
  sidebar: true
  splits: true
  browser: false
---
```

Enables cmux-aware notifications, sidebar metadata, and visible subagent splits when GSD is running inside a cmux terminal.

---

## Post-Unit Hooks Example

```yaml
---
version: 1
post_unit_hooks:
  - name: code-review
    after:
      - execute-task
    prompt: "Review the code changes in {sliceId}/{taskId} for quality, security, and test coverage."
    max_cycles: 1
    artifact: REVIEW.md
---
```

Runs an automated code review after each task execution. Skips if `REVIEW.md` already exists (idempotent).

---

## Pre-Dispatch Hooks Examples

**Modify — inject instructions before every task:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: enforce-standards
    before:
      - execute-task
    action: modify
    prepend: "Follow our TypeScript coding standards and always run linting."
---
```

**Skip — skip per-slice research when a research file already exists:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: skip-existing-research
    before:
      - research-slice
    action: skip
    skip_if: RESEARCH.md
---
```

**Replace — substitute a custom prompt for task execution:**

```yaml
---
version: 1
pre_dispatch_hooks:
  - name: tdd-execute
    before:
      - execute-task
    action: replace
    prompt: "Implement the task using strict TDD. Write failing tests first, then implement, then refactor."
    model: claude-opus-4-6
---
```

---

## Token Profile & Phases Example

```yaml
---
version: 1
token_profile: budget
phases:
  skip_research: true
  skip_reassess: true
  skip_slice_research: false
---
```

Uses the `budget` profile to minimize token usage, with explicit override to keep slice-level research enabled.

---

## Remote Questions Example

```yaml
---
version: 1
remote_questions:
  channel: slack
  channel_id: "C0123456789"
  timeout_minutes: 15
  poll_interval_seconds: 10
---
```

Routes interactive questions to a Slack channel for headless auto-mode sessions. Questions time out after 15 minutes if unanswered.

---

## Dynamic Routing Example

```yaml
---
version: 1
dynamic_routing:
  enabled: true
  tier_models:
    light: openrouter/minimax/minimax-m2.5
    standard: claude-sonnet-4-6
    heavy: claude-opus-4-6
  escalate_on_failure: true
  budget_pressure: true
---
```

Automatically selects model tier based on task complexity. Simple tasks use the `light` model, complex tasks escalate to `heavy`. Under budget pressure, tasks are routed to cheaper tiers.

---

## Parallel Execution Example

```yaml
---
version: 1
parallel:
  enabled: true
  max_workers: 3
  merge_strategy: per-milestone
  auto_merge: confirm
---
```

Runs up to 3 slices concurrently in separate worktrees. Results are merged per-milestone with user confirmation.

---

## Verification Example

```yaml
---
version: 1
verification_commands:
  - npm test
  - npm run lint
  - npm run typecheck
verification_auto_fix: true
verification_max_retries: 2
---
```

Runs test, lint, and typecheck after each task. Runnable failures receive up to 2 auto-fix attempts. For missing-command handling, see [Verification Enforcement](../../../../../docs/user-docs/auto-mode.md#verification-enforcement).

## Experimental Features Example

```yaml
---
version: 1
experimental:
  rtk: true
---
```

Opts in to RTK shell-command compression. RTK is downloaded automatically on first use. Set `GSD_RTK_DISABLED=1` to force-disable at the environment level regardless of this setting.
