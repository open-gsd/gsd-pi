# Commands Reference

## Session Commands

| Command | Description |
|---------|-------------|
| `/gsd` | Step mode — execute one unit at a time, pause between each |
| `/gsd next` | Explicit step mode (same as `/gsd`) |
| `/gsd auto` | Autonomous mode — research, plan, execute, commit, repeat |
| `/gsd auto --resume-wedge <id>` | Resume the currently open liveness wedge; its originating guard must be clear before auto mode re-enters |
| `/gsd quick [--discuss] [--research] [--validate] [--full] <task>` | Execute a quick task with GSD guarantees; optionally add discussion, research, plan checking, and post-execution verification (`--full` enables all three stages) |
| `/gsd do <text>` | Route freeform text to the right GSD command |
| `/gsd stop` | Stop auto mode gracefully |
| `/gsd pause` | Pause auto-mode (preserves state, `/gsd auto` to resume) |
| `/gsd steer` | Hard-steer plan documents during execution |
| `/gsd discuss` | Discuss architecture and decisions (stop auto-mode first with `/gsd stop`) |
| `/gsd status` | Open the status dashboard |
| `/gsd widget` | Cycle dashboard widget: full / small / min / off |
| `/gsd notifications` | View, filter, and clear persistent notification history |
| `/gsd queue` | Queue and reorder future milestones (`pending`, `queued`, and legacy `planned`; safe during auto mode) |
| `/gsd capture` | Fire-and-forget thought capture (works during auto mode) |
| `/gsd triage` | Manually trigger triage of pending captures |
| `/gsd debug` | Create and inspect persistent /gsd debug sessions |
| `/gsd debug list` | List persisted debug sessions |
| `/gsd debug status <slug>` | Show status for one debug session slug |
| `/gsd debug continue <slug>` | Resume an existing debug session slug |
| `/gsd debug --diagnose` | Inspect malformed artifacts and session health (`--diagnose [<slug> \| <issue text>]`) |
| `/gsd dispatch` | Dispatch a specific phase directly (research, plan, execute, complete, validate, reassess, uat, replan) |
| `/gsd verdict <pass\|needs-attention\|needs-remediation>` | Override an unadopted compatibility milestone's recorded validation verdict with an explicit rationale; adopted milestones must rerun canonical validation with current evidence |
| `/gsd history` | View execution history (supports `--cost`, `--phase`, `--model` filters) |
| `/gsd usage` | Show current LLM context-window usage and session token totals |
| `/gsd session-report` | Show session cost, tokens, and work summary (`--json`, `--save`) |
| `/gsd forensics` | Full-access GSD debugger — structured anomaly detection, unit traces, and LLM-guided root-cause analysis for auto-mode failures |
| `/gsd cleanup` | Clean up GSD state files and stale worktrees |
| `/gsd closeout` | Recover failed git closeout actions (`status`, `retry`, `resolve`) |
| `/gsd worktree` (`/gsd wt`) | Manage GSD worktrees from the TUI |
| `/gsd visualize` | Open workflow visualizer (progress, timeline, deps, metrics, health, agent, changes, knowledge, memories, captures, export) |
| `/gsd brief <mode> [topic] [--slides]` | Generate a self-contained visual HTML brief. Modes: `diagram`, `plan`, `diff`, `recap`, `table`, `slides`. |
| `/gsd report` | Generate HTML reports for all milestones and open the reports index in a browser |
| `/gsd report --html` | Generate self-contained HTML report for current or completed milestone |
| `/gsd report --html --all` | Generate retrospective reports for all milestones at once |
| `/gsd update` | Update GSD in-session; `--models` refreshes models and pricing without a restart |
| `/gsd upgrade` | Alias for `/gsd update` |
| `/gsd knowledge` | Add persistent project knowledge. Rules remain manually maintained in `KNOWLEDGE.md`; patterns and lessons are memory-backed and projected into the file on the next session start. |
| `/gsd memory` | Query and forget project memories |
| `/gsd eval-review <sliceId>` | Audit a slice's AI evaluation strategy and write a scored `<sliceId>-EVAL-REVIEW.md`. Flags: `--force` overwrites; `--show` prints the existing audit. See [eval-review](eval-review.md). |
| `/gsd extract-learnings <MID>` | Extract structured Decisions, Lessons, Patterns, and Surprises from a completed milestone — writes `<MID>-LEARNINGS.md` audit trail, persists durable knowledge through the memory/decision stores, and projects reviewable knowledge into `.gsd/KNOWLEDGE.md` on the next session start. Runs automatically at milestone completion. |
| `/gsd fast` | Toggle service tier for supported models (prioritized API routing) |
| `/gsd rate` | Rate last unit's model tier (over/ok/under) — improves adaptive routing |
| `/gsd changelog` | Show categorized release notes |
| `/gsd logs` | Browse activity logs, debug logs, and metrics |
| `/gsd remote` | Control remote auto-mode |
| `/gsd help` | Categorized command reference with descriptions for all GSD subcommands |

`/gsd discuss` supports optional direct targets: `/gsd discuss M014`, `/gsd discuss M014/S03`, `/gsd discuss --milestone M014`, and `/gsd discuss --slice M014/S03`.

Quick-task right-sizing flags are composable. Use `--discuss` to surface design choices before planning, `--research` to investigate approaches first, and `--validate` to add plan checking and independent post-execution verification. Passing all three is equivalent to `--full`; passing none preserves the lightweight quick-task flow.

## Visual Briefs

`/gsd brief` asks the agent to gather evidence and write a single responsive HTML artifact for visual review, planning, recap, or presentation. Usage:

```text
/gsd brief <diagram|plan|diff|recap|table|slides> [topic] [--slides]
```

Modes:

| Mode | Use it for |
|------|------------|
| `diagram` | System, architecture, flow, state, data, or process diagrams. If the first argument is not a known mode, GSD treats the whole request as a diagram topic. |
| `plan` | Visual implementation plans with scope, likely files, edge cases, risks, and tests. |
| `diff` | Visual reviews of current staged and unstaged repository changes. If no topic is supplied, it reviews the current repository changes. |
| `recap` | Context-switching project recaps. If no topic is supplied, it recaps the current project. |
| `table` | Dense comparisons, audits, matrices, and status reports as readable HTML tables. |
| `slides` | A concise visual deck. Passing `--slides` with another mode also requests slide-deck output. |

Artifacts are written under the GSD agent directory's `diagrams/` folder with a descriptive kebab-case `.html` filename. The generated file is self-contained with embedded CSS and minimal JavaScript; it may use CDN libraries such as Mermaid for diagrams, but must keep useful written context if a CDN fails.

After writing the file, GSD attempts to open it in a browser using the local platform opener (`open` on macOS, `xdg-open` on Linux, or `cmd /c start` on Windows). If browser opening is unavailable or fails, the command reports the absolute file path.

## Configuration & Diagnostics

| Command | Description |
|---------|-------------|
| `/gsd prefs` | Model selection, timeouts, budget ceiling |
| `/gsd model` | Switch the active session model or open a picker |
| `/gsd mode` | Switch workflow mode (solo/team) with coordinated defaults for milestone IDs, git commit behavior, and documentation |
| `/gsd config` | (deprecated) Set tool API keys — use `/gsd keys` (tool keys) or `/gsd setup` (provider wizard) instead |
| `/gsd keys` | API key manager — list, add, remove, test, rotate, doctor |
| `/gsd doctor` | Runtime health checks with auto-fix — issues surface in real time across widget, visualizer, and HTML reports |
| `/gsd doctor resolve-evidence <evidence-id> --action=<discard\|preserve\|restore> --consent=<printed-consent>` | Resolve retained projection evidence using the exact ID and action-specific consent printed by `/gsd doctor` |
| `/gsd inspect` | Show SQLite DB diagnostics |
| `/gsd show-config` | Show effective configuration, including models, routing, and toggles |
| `/gsd init` | Project init wizard — detect, configure, bootstrap `.gsd/`; if `.gsd/` already exists, opens an "Already Initialized" menu with `Re-configure preferences`, `Suggest & install skills`, or `Cancel` |
| `/gsd setup` | Global setup status and configuration |
| `/gsd onboarding` | Re-run the setup wizard (`--resume`, `--reset`, `--step <name>`) |
| `/gsd mcp` | Manage MCP servers (`status`, `check`, `discover`, `test`, `enable`, `disable`, `import`, `delete`, `init`) |
| `/gsd context` | Show a context breakdown chart for skills, injections, history, and MCP tool schema usage |
| `/gsd skill-health` | Skill lifecycle dashboard — usage stats, success rates, token trends, staleness warnings |
| `/gsd skill-health <name>` | Detailed view for a single skill |
| `/gsd skill-health --declining` | Show only skills flagged for declining performance |
| `/gsd skill-health --stale N` | Show skills unused for N+ days |
| `/gsd hooks` | Show configured post-unit and pre-dispatch hooks |
| `/gsd run-hook` | Manually trigger a specific hook |
| `/gsd migrate` | Migrate a v1 `.planning` directory to `.gsd` format |
| `/gsd recover` | Preview an explicit legacy markdown import, then approve the exact hash shown with `/gsd recover --preview=<sha256>` |
| `/gsd recover <recoveryActionId>` | Resume one repaired Task recovery abort or remediation after supplying repair and verification evidence |
| `/gsd rebuild markdown` | Preserve externally edited modeled projections under `.gsd/quarantine/projections/`, then rebuild from the canonical database without importing markdown |
| `/gsd rebuild database` | Reserved for DB-native rebuilds; does not import markdown projections |
| `/gsd language <language\|off\|clear>` | Set or clear the global response language |

Use `/gsd run-hook <hook-name> <unit-type> <unit-id>` to trigger a configured hook. Run `/gsd run-hook` without arguments for the supported unit types. The ID must match the selected type's scope: for example, `review complete-milestone M001`, `review plan-slice M001/S01`, or `review execute-task M001/S01/T01` after `/gsd run-hook`. Unique milestone IDs such as `M001-abc123` also work, including within slice and task IDs. Unsupported unit types are rejected with the supported-type list; an invalid ID reports the expected format for its type before the hook is triggered.

The two `/gsd recover` forms serve different recovery domains. Use the no-argument command (and its `--preview`, `--application`, and related flags) only for the evidence-bound legacy markdown/database import flow. When auto mode reports a terminal Task recovery abort or a settled Task with a current `remediate` Recovery Action, repair the underlying defect and run `/gsd recover <recoveryActionId>`. GSD checks that the action is still eligible, prompts for a nonblank repair summary and concrete verification evidence, and authorizes exactly one fresh lineage-linked retry; it does not run that retry itself, so rerun `/gsd auto` after the command succeeds. Stale actions, duplicate authorizations, open blockers, and actions superseded by later Attempts remain rejected.

## Milestone Management

| Command | Description |
|---------|-------------|
| `/gsd new-project [--deep]` | Bootstrap a new project; `--deep` enables staged project-level discovery |
| `/gsd new-milestone [--deep]` | Create a new milestone; `--deep` opts the project into deep planning mode |
| `/gsd skip` | Prevent a unit from auto-mode dispatch |
| `/gsd undo` | Revert last completed unit |
| `/gsd undo-task` | Reopen a terminal task through canonical DB recovery authority, then refresh projections |
| `/gsd reset-slice` | Reopen the full terminal slice and every terminal task in one guarded database operation, preserve prior execution history, then refresh readable status |
| `/gsd park` | Park a milestone — skip without deleting |
| `/gsd unpark` | Reactivate a parked milestone |
| `/gsd discard <milestone-id>` | Confirm and permanently discard one milestone without entering the smart-entry flow |
| `/gsd rethink` | Conversational project reorganization — reorder, park, discard unadopted work, or add milestones |
| Discard milestone | Available via `/gsd` wizard → "Milestone actions" → "Discard"; milestones with adopted canonical lifecycle history must be parked instead |

Milestone and slice titles created during planning must not contain forward slash (`/`), en dash, or em dash characters. GSD reserves those characters as state-document delimiters, so `plan-milestone` rejects titles that include them.

### Lifecycle safety

Slice completion succeeds only after every Task has durable proof. Skip preserves
completed work, safely stops unfinished work, and records the decision to treat
the skipped Slice as a satisfied dependency. Reset revokes that decision, is
intentionally all-or-nothing, and keeps prior
Attempts, verification, and dispatch history. If later Slices have already
started or completed, reset those downstream Slices first.

If GSD says the readable status update is pending repair, the database change
succeeded but a SUMMARY, UAT, PLAN, ROADMAP, or STATE file could not be
refreshed. Repair the filesystem obstruction, then run `/gsd doctor fix` or
`/gsd rebuild markdown`; do not edit Markdown to change status. Hosts that
preserve the original private invocation identity may instead perform an exact
retry. Adopted Milestone validation, completion, and full-redo reopen use the
same atomic receipt contract. An exact retry can repair projection delivery
only while its operation still owns the current lifecycle head; a historical
receipt reports `duplicate` and `superseded` and cannot overwrite newer status.

## Parallel Orchestration

| Command | Description |
|---------|-------------|
| `/gsd parallel start` | Analyze eligibility, confirm, and start workers |
| `/gsd parallel status` | Show all workers with state, progress, and cost |
| `/gsd parallel stop [MID]` | Stop all workers or a specific milestone's worker |
| `/gsd parallel pause [MID]` | Pause all workers or a specific one |
| `/gsd parallel resume [MID]` | Resume paused workers |
| `/gsd parallel merge [MID]` | Merge completed milestones back to main |

See [Parallel Orchestration](./parallel-orchestration.md) for full documentation.

## Shipping, Backlog, And Codebase Helpers

| Command | Description |
|---------|-------------|
| `/gsd ship` | Create a PR from milestone artifacts and open it for review (`--dry-run`, `--draft`, `--base`, `--force`) |
| `/gsd pr-branch` | Create a clean PR branch filtering `.gsd/` commits (`--dry-run`, `--name`) |
| `/gsd backlog` | Manage backlog items (`add`, `promote`, `remove`, `list`) |
| `/gsd add-tests` | Generate tests for completed slices |
| `/gsd scan` | Run a rapid codebase assessment (`--focus tech`, `arch`, `quality`, `concerns`, `tech+arch`) |
| `/gsd codebase` | Generate, refresh, and inspect the `.gsd/CODEBASE.md` cache (`generate`, `update`, `stats`); parent workspaces include declared child repositories under repo-labeled sections |

## Additional Prompt-Driven Workflows

These commands are native GSD workflows surfaced in `/gsd help full`. They dispatch purpose-built prompts against the milestone, slice, and `.gsd/` model instead of acting as aliases.

| Command | Description |
|---------|-------------|
| `/gsd explore [topic]` | Socratic ideation before committing an idea to backlog, knowledge, research, spike, sketch, or a milestone |
| `/gsd spike [idea]` | Focused throwaway experiment; supports `--quick`, `--text`, and frontier mode |
| `/gsd sketch [idea]` | UI/design exploration with throwaway HTML mockups; supports `--quick`, `--text`, and frontier mode |
| `/gsd map-codebase` | Generate structured codebase reference docs under `.gsd/codebase/`; supports `--paths` and `--focus` |
| `/gsd docs-update` | Generate, update, or verify project docs against live code; supports `--force` and `--verify-only` |
| `/gsd graphify` | Build, query, inspect, or diff a lightweight knowledge graph under `.gsd/knowledge/` |
| `/gsd stats` | Display project statistics, milestones, slices, git metrics, and timeline |
| `/gsd progress` | Summarize recent work and next steps; `--next` dispatches `/gsd next`, and `--do "..."` routes through `/gsd do` |
| `/gsd health` | Check `.gsd/` integrity; supports `--repair` and `--context` |
| `/gsd surface` | Manage which skills and extensions are surfaced in the session |
| `/gsd code-review` | Review changed source diff-first for bugs, security, and quality; supports `--depth`, `--files`, and `--fix` |
| `/gsd review` | Peer-review recent work across reviewer perspectives; external reviewer flags are simulated in-prompt when unavailable |
| `/gsd audit-milestone` | Verify a milestone met its definition of done |
| `/gsd audit-uat` | Audit outstanding UAT/verification items; supports `--verify` |
| `/gsd audit-fix` | Classify and remediate audit findings; supports `--source`, `--severity`, `--max`, and `--dry-run` |
| `/gsd ui-review` | Run a retroactive six-pillar visual audit for frontend work |
| `/gsd secure-phase` | Verify threat mitigations for completed work |
| `/gsd validate-phase` | Audit and fill validation or test coverage gaps |
| `/gsd verify-work` | Run conversational UAT of built features |
| `/gsd plan-review-convergence` | Iterate a plan through review cycles until concerns resolve |
| `/gsd discuss-phase` | Gather milestone or slice context through adaptive questioning |
| `/gsd plan-phase` | Create a detailed slice plan with a verification loop |
| `/gsd execute-phase` | Execute slice tasks with wave-based parallelization |
| `/gsd spec-phase` | Clarify what a milestone delivers, with ambiguity scoring |
| `/gsd mvp-phase` | Plan a milestone as a vertical MVP slice |
| `/gsd ui-phase` | Produce a UI design contract (`UI-SPEC`) for frontend milestones |
| `/gsd ai-integration-phase` | Produce an AI design contract (`AI-SPEC`) for AI milestones |
| `/gsd ultraplan-phase` | Run an extended-reasoning planning pass, review, then import |
| `/gsd autonomous` | Continuously run the remaining lifecycle work with explicit phase ceremony |
| `/gsd pause-work` | Create a context handoff when pausing mid-stream |
| `/gsd resume-work` | Resume work with full context restoration |
| `/gsd manager` | Open a command-center workflow for multiple milestones |
| `/gsd phase` | Manage milestone queue ordering; structural actions route to existing GSD commands |
| `/gsd thread` | Manage persistent context threads for cross-session work |
| `/gsd workstreams` | Manage parallel workstreams through `/gsd parallel` |
| `/gsd workspace` | Manage isolated workspaces through `/gsd worktree` |
| `/gsd milestone-summary` | Generate a project or milestone summary for onboarding |
| `/gsd review-backlog` | Review and promote backlog items to milestones |
| `/gsd inbox` | Triage GitHub issues and PRs against project conventions |
| `/gsd import` | Ingest external plans with conflict detection |
| `/gsd ingest-docs` | Bootstrap or merge `.gsd/` state from existing ADRs, PRDs, specs, or docs |
| `/gsd profile-user` | Generate and persist a developer behavior profile |
| `/gsd settings` | Configure workflow toggles and model profile |
| `/gsd ns-context`, `/gsd ns-ideate`, `/gsd ns-manage`, `/gsd ns-project`, `/gsd ns-review`, `/gsd ns-workflow` | Namespace grouping commands from older command sets; each redirects to `/gsd help` because GSD uses a flat command list |

## Workflow Templates

| Command | Description |
|---------|-------------|
| `/gsd start` | Start a workflow template (bugfix, spike, feature, hotfix, refactor, security-audit, dep-upgrade, full-project) |
| `/gsd start resume` | Resume an in-progress workflow |
| `/gsd templates` | List available workflow templates |
| `/gsd templates info <name>` | Show detailed template info |

## Custom Workflows

The unified plugin system. Every workflow — bundled, user-authored, or
remotely installed — is discoverable via `/gsd workflow <name>` and declares
one of four execution modes:

| Mode              | What it does                                                                              |
|-------------------|-------------------------------------------------------------------------------------------|
| `oneshot`         | Prompt-only, no state, no branch. For reviews, triage, changelog generation.              |
| `yaml-step`       | Full engine with GRAPH.yaml, iterate, and shell-verify. For fan-out batch work.           |
| `markdown-phase`  | Multi-phase with STATE.json + phase-approval gates. For release, performance audit.       |
| `auto-milestone`  | Hooks into the full `/gsd auto` pipeline. Reserved for `full-project`.                    |

### Discovery order (project > global > bundled)

1. `.gsd/workflows/<name>.{yaml,md}` — project-local, checked into the repo.
2. `~/.gsd/workflows/<name>.{yaml,md}` — global, private to the machine.
3. Bundled — ships with GSD (see the full list with `/gsd workflow`).

Legacy `.gsd/workflow-defs/` YAML definitions are still picked up for
backwards compatibility.

### Commands

| Command | Description |
|---------|-------------|
| `/gsd workflow` | List all discoverable plugins, grouped by mode |
| `/gsd workflow <name> [args]` | Run a plugin directly (resolved via precedence chain) |
| `/gsd workflow info <name>` | Show plugin metadata — source, mode, phases, path |
| `/gsd workflow new` | Create a new workflow definition (via the `create-workflow` skill) |
| `/gsd workflow install <source>` | Install a plugin from `https://...`, `gist:<id>`, or `gh:owner/repo/path[@ref]` |
| `/gsd workflow uninstall <name>` | Remove an installed plugin and its provenance record |
| `/gsd workflow run <name> [k=v]` | Explicit YAML run form (same as `/gsd workflow <name>` for yaml-step plugins) |
| `/gsd workflow list` | List YAML workflow runs (history) |
| `/gsd workflow validate <name>` | Validate a YAML definition |
| `/gsd workflow pause` | Pause custom workflow auto-mode |
| `/gsd workflow resume` | Resume paused custom workflow auto-mode |

### Bundled plugins

- **Phased (`markdown-phase`)**: `bugfix`, `small-feature`, `spike`, `hotfix`,
  `refactor`, `security-audit`, `dep-upgrade`, `release`, `api-breaking-change`,
  `performance-audit`, `observability-setup`, `ci-bootstrap`.
- **Oneshot**: `pr-review`, `changelog-gen`, `issue-triage`, `pr-triage`,
  `onboarding-check`, `dead-code`, `accessibility-audit`.
- **YAML engine (`yaml-step`)**: `test-backfill`, `docs-sync`, `rename-symbol`,
  `env-audit`.
- **Auto-milestone**: `full-project` (reached via `/gsd start full-project` or
  `/gsd auto`).

### Authoring a custom plugin

Run `/gsd workflow new <name>` to scaffold via the `create-workflow` skill.
Plugins are plain YAML (`.yaml`) or markdown (`.md`) files. See
`src/resources/extensions/gsd/workflow-templates/` for bundled examples.

## Extensions

| Command | Description |
|---------|-------------|
| `/gsd extensions list` | List all extensions and their status. Installed entries show `[user]` or `[project]` plus the install source; project entries are limited to the current project. |
| `/gsd extensions enable <id>` | Enable a disabled extension |
| `/gsd extensions disable <id>` | Disable an extension |
| `/gsd extensions info <id>` | Show extension details |
| `/gsd extensions install <spec>` | Install a user extension. `<spec>` is an npm package, a git URL, or a local path. Restart GSD to activate. |
| `/gsd extensions uninstall <id>` | Remove a user or current-project extension. Package-managed entries remove the underlying shell package; direct installs warn if other extensions depend on them. |
| `/gsd extensions update [id]` | Update a single user or current-project npm extension to its latest version, or all applicable entries when `id` is omitted. Package-managed entries update through the shell package manager. Git/local installs are skipped — reinstall to update. |
| `/gsd extensions validate <path>` | Validate an extension package directory against the manifest schema before publishing or installing. |

Install sources are auto-detected: starts with `http(s)://` or ends with `.git` → git clone; contains `/` or `.` and exists on disk → local copy; otherwise → `npm pack`. Installed extensions land in `~/.gsd/extensions/<id>/` and the registry records the source so `update` can re-fetch.

Shell package commands use the same extension registry. A successful `gsd install <source>` registers extension manifests from that package as user entries; adding `--local` registers them as project entries for the current project. `gsd remove` unregisters the matching entries from the same scope. This keeps `gsd list` and `/gsd extensions list` in sync regardless of which install route you use.

## cmux Integration

| Command | Description |
|---------|-------------|
| `/gsd cmux status` | Show cmux detection, prefs, and capabilities |
| `/gsd cmux on` | Enable cmux integration |
| `/gsd cmux off` | Disable cmux integration |
| `/gsd cmux notifications on/off` | Toggle cmux desktop notifications |
| `/gsd cmux sidebar on/off` | Toggle cmux sidebar metadata |
| `/gsd cmux splits on/off` | Toggle cmux visual subagent splits |

## Subagents

| Command | Description |
|---------|-------------|
| `/subagent` | List available user and project subagents. Run records, status checks, and follow-up resume are handled through the `subagent` tool; see [Subagents](./subagents.md). |

## GitHub Sync

| Command | Description |
|---------|-------------|
| `/github-sync bootstrap` | Initial setup — creates GitHub Milestones, Issues, and draft PRs from current `.gsd/` state |
| `/github-sync status` | Show sync mapping counts (milestones, slices, tasks) |

Enable with `github.enabled: true` in preferences. Requires `gh` CLI installed and authenticated. Sync mapping is persisted in `.gsd/github-sync.json`.

## Git Commands

| Command | Description |
|---------|-------------|
| `/worktree` (`/wt`) | Git worktree lifecycle — create, switch, merge, remove |

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

## Telegram Commands

The following commands are sent directly in your **Telegram chat** to a configured GSD bot — they are not GSD CLI commands. Telegram command polling runs every ~5 seconds while auto-mode is active. Each response is prefixed with the project name (e.g., `📁 MyProject`).

| Command | Description |
|---------|-------------|
| `/status` | Current milestone, active unit, and session cost |
| `/progress` | Roadmap overview — completed and open milestones |
| `/budget` | Token usage and cost for the current session |
| `/pause` | Pause auto-mode after the current unit finishes |
| `/resume` | Clear a pause directive and continue auto-mode |
| `/log [n]` | Last `n` activity log entries (default: 5) |
| `/help` | List all available Telegram commands |

**Requirements:** Telegram must be configured as your remote channel (`remote_questions.channel: telegram`). Commands are only processed while auto-mode is running. See [Remote Questions — Telegram Commands](./remote-questions.md#telegram-commands) for setup and details.

## Session Management

| Command | Description |
|---------|-------------|
| `/clear` | Start a new session (alias for `/new`) |
| `/exit` | Graceful shutdown — saves session state before exiting |
| `/kill` | Kill GSD process immediately |
| `/model` | Switch the active model |
| `/login` | Log in to an LLM provider |
| `/thinking` | Toggle thinking level during sessions |
| `/voice` | Toggle real-time speech-to-text (macOS, Linux) |

## Keyboard Shortcuts

| Shortcut | Action |
|----------|--------|
| `Ctrl+Alt+G` | Toggle dashboard overlay |
| `Ctrl+Alt+V` | Toggle voice transcription |
| `Ctrl+Alt+B` | Show background shell processes |
| `Ctrl+V` / `Alt+V` | Paste image from clipboard (screenshot → vision input) |
| `Escape` | Pause auto mode (preserves conversation) |

> **Note:** In terminals without Kitty keyboard protocol support (macOS Terminal.app, JetBrains IDEs), slash-command fallbacks are shown instead of `Ctrl+Alt` shortcuts.
>
> **Tip:** If `Ctrl+V` is intercepted by your terminal (e.g. Warp), use `Alt+V` instead for clipboard image paste.

### Claude Code selected-text Quick Action (macOS)

`scripts/claude-code-send-selection.sh` is an optional Automator Quick Action shim for Claude Code.app. It reads selected text from stdin (or the clipboard as a fallback), pastes it into Claude Code, submits it, and restores the previous clipboard. To use it, create an Automator **Quick Action** with **Run Shell Script**, point it at the script path, and bind your preferred macOS keyboard shortcut.

## CLI Flags

| Flag | Description |
|------|-------------|
| `gsd` | Start a new interactive session |
| `gsd --continue` (`-c`) | Resume the most recent session for the current directory |
| `gsd --session <path\|id>` | Resume a specific session file or session ID |
| `gsd --session-dir <dir>` | Store and look up sessions in a custom directory |
| `gsd --model <id>` | Override the default model for this session |
| `gsd --thinking <level>` | Override the thinking level for this session. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `gsd --print "msg"` (`-p`) | Single-shot prompt mode (no TUI) |
| `gsd --mode <text\|json\|rpc\|mcp>` | Output mode for non-interactive use |
| `gsd --list-models [search]` | List available models and exit |
| `gsd --web [path]` | Start browser-based web interface (optional project path) |
| `gsd --worktree` (`-w`) [name] | Start session in a git worktree (auto-generates name if omitted) |
| `gsd --no-session` | Disable session persistence |
| `gsd --extension <path>` | Load an additional extension (can be repeated) |
| `gsd --append-system-prompt <text>` | Append text to the system prompt |
| `gsd --tools <list>` | Comma-separated list of tools to enable |
| `gsd --version` (`-v`) | Print version and exit |
| `gsd --help` (`-h`) | Print help and exit |
| `gsd sessions` | Interactive session picker — list all saved sessions for the current directory and choose one to resume |
| `gsd config` | Set up global API keys for search and docs tools (saved to `~/.gsd/agent/auth.json`, applies to all projects). See [Global API Keys](./configuration.md#global-api-keys-gsd-config). |
| `gsd update` | Update GSD to the latest version (use `gsd update browser` to update the managed browser, or [`gsd update --models`](./custom-models.md#updating-the-model-catalog) to refresh the model catalog) |
| `gsd install <source> [-l\|--local]` | Install a package from npm, git, a URL, or a local path (e.g. `gsd install npm:@foo/bar`). The default scope is user-wide; `--local` installs into the current project and registers its extensions as project entries. |
| `gsd remove <source> [-l\|--local]` | Remove a package from the matching user or project scope and unregister its extensions. Use `--local` for a project-local install. |
| `gsd list` | List installed user/project packages, followed by separate user/project extension sections. |
| `gsd graph <subcommand>` | Build, query, status, or diff the project knowledge graph built from `.gsd/` artifacts |
| `gsd quick <task>` | Execute a quick task without a TUI (alias for `gsd headless quick <task>`) |
| `gsd headless --json` | Structured JSONL event stream to stdout for scripting, CI, and troubleshooting (alias: `--output-format stream-json`) |
| `gsd headless new-milestone` | Create a new milestone from a context file (headless — no TUI required) |

## Headless Mode

`gsd headless` runs `/gsd` commands without a TUI — designed for CI, cron jobs, and scripted automation. It spawns a child process in RPC mode, auto-responds to interactive prompts, detects completion, and exits with meaningful exit codes.

```bash
# Run auto mode (default)
gsd headless

# Run a single unit
gsd headless next

# Execute a quick task and return task, branch, artifact, commit, and exit details
gsd quick --output-format json "fix the login button on mobile"

# Instant JSON snapshot — no LLM, ~50ms
gsd headless query

# With timeout for CI
gsd headless --timeout 600000 auto

# Auto shorthand with session-level model and thinking overrides
gsd auto --model claude-code/sonnet --thinking medium

# Force a specific phase
gsd headless dispatch plan

# Create a new milestone from a context file and start auto mode
gsd headless new-milestone --context brief.md --auto

# Create a milestone from inline text
gsd headless new-milestone --context-text "Build a REST API with auth"

# Pipe context from stdin
echo "Build a CLI tool" | gsd headless new-milestone --context -
```

| Flag | Description |
|------|-------------|
| `--timeout N` | Overall timeout in milliseconds. The default is 300000 (5 min), except `auto`, whose overall timeout is disabled unless this flag is set. Use `0` to disable explicitly. |
| `--max-restarts N` | Auto-restart on crash with exponential backoff (default: 3). Set 0 to disable. Deterministic no-work failures are not restart-eligible. |
| `--json` | Stream all events as JSONL to stdout |
| `--model ID` | Override the model for the headless session |
| `--thinking LEVEL` | Override the thinking level for the headless session. Valid levels: `off`, `minimal`, `low`, `medium`, `high`, `xhigh`, `max`. |
| `--context <file>` | Context file for `new-milestone` (use `-` for stdin) |
| `--context-text <text>` | Inline context text for `new-milestone` |
| `--auto` | Chain into auto-mode after milestone creation |

**Exit codes:** `0` = complete, `1` = error or timeout, `10` = blocked, `11` = cancelled.

With `--json` or `--output-format stream-json`, the event stream ends with a
`headless_result` object. Its `status` and `exitCode` are the authoritative
terminal result for automation; human-readable output is diagnostic only.
Headless can return `status: "no-work-deterministic"` for repeatable no-progress
tails (for example select → input → cancelled). This status exits with code `1`
and suppresses automatic restart loops.

Any `/gsd` subcommand works as a positional argument — `gsd headless status`, `gsd headless doctor`, `gsd headless dispatch execute`, etc.

### `gsd headless discard-milestone`

Deletes one or more DB-only orphan milestone reservations without starting an RPC session or running projection reconciliation. The mandatory `--orphan-only` guard preflights the complete set and refuses if any target has hierarchy or artifact rows, planning content, a disk projection, queue/dependency references, a worktree or milestone branch, or an active lease/dispatch/worker. No target is deleted unless every target passes; successful deletion occurs in one transaction.

```bash
gsd headless discard-milestone M015 --orphan-only
gsd headless discard-milestone M015 M016 --orphan-only
```

The command always writes one structured JSON object with `before` and `after` snapshots. Exit `0` means every requested row was removed and the canonical post-delete query found none; exit `1` is a refusal or error.

### `gsd headless recover`

Non-TTY equivalent of the no-argument `/gsd recover` database-import preview and evidence-bound approval flow. It does not implement the interactive `/gsd recover <recoveryActionId>` Task-recovery resume form. It fingerprints legacy markdown and the current database, creates and verifies a retained backup only after the exact `--preview=<sha256>` approval, applies the unchanged preview through one atomic Import Application, and prints the recommended recovery action plus its exact evidence. Existing database rows absent from markdown are preserved. Designed for CI, cron, and any environment where the interactive database recovery prompt cannot run.

```bash
gsd headless recover
```

The first call prints the sealed Import Preview and exits without applying the import. Review that output, then rerun with the exact `--preview=<preview-hash>` value it prints. That approved run performs the Import Application and assessment.

If assessment recommends destructive restore, rerun with the printed `--application=<operation-id> --restore --consent=proceed:destructive-database-restore:<evidence-hash>` values. Restore is permanently unavailable after any later canonical write or Authority Epoch cutover; follow the printed `--application=<operation-id> --forward-repair` route instead. When Forward Repair reports genuine overlap, supply one printed evidence-bound `--choice` for each target.

Exit codes key on the assessment decision: `restore-consent-required`, `forward-repair-required`, and `already-restored` exit `0` (the printed next step is expected follow-up input, not a failure). A Forward Repair that still requires overlap choices exits `1`. Every other decision — `refused`, `transaction-rollback-only`, or `temporarily-unavailable` — fails closed: it exits non-zero and prints no `gsd-recover: recovered` marker, as do setup and action errors. Pair with `gsd headless query` afterwards to inspect canonical state.

### `gsd headless query`

Returns a single JSON object with the full project snapshot — no LLM session, no RPC child, instant response (~50ms). This is the recommended way for orchestrators and scripts to inspect GSD state.

```bash
gsd headless query | jq '.state.phase'
# "executing"

gsd headless query | jq '.next'
# {"action":"dispatch","unitType":"execute-task","unitId":"M001/S01/T03"}

gsd headless query | jq '.cost.total'
# 4.25
```

**Output schema:**

```json
{
  "state": {
    "phase": "executing",
    "activeMilestone": { "id": "M001", "title": "..." },
    "activeSlice": { "id": "S01", "title": "..." },
    "activeTask": { "id": "T01", "title": "..." },
    "registry": [{ "id": "M001", "status": "active" }, ...],
    "progress": { "milestones": { "done": 0, "total": 2 }, "slices": { "done": 1, "total": 3 } },
    "blockers": []
  },
  "next": {
    "action": "dispatch",
    "unitType": "execute-task",
    "unitId": "M001/S01/T01"
  },
  "cost": {
    "workers": [{ "milestoneId": "M001", "cost": 1.50, "state": "running", ... }],
    "total": 1.50
  }
}
```

## MCP Server Mode

`gsd --mode mcp` runs GSD as a [Model Context Protocol](https://modelcontextprotocol.io) server over stdin/stdout. This exposes all GSD tools (read, write, edit, bash, etc.) to external AI clients — Claude Desktop, VS Code Copilot, and any MCP-compatible host.

```bash
# Start GSD as an MCP server
gsd --mode mcp
```

The server registers all tools from the agent session and maps MCP `tools/list` and `tools/call` requests to GSD tool definitions. It runs until the transport closes.

MCP mode also exposes the GSD workflow adapter tools used by headless runtimes:

- Session control tools: `gsd_execute`, `gsd_status`, `gsd_result`, `gsd_cancel`, `gsd_resolve_blocker`
- Project state and read-only tools: `gsd_query`, `gsd_progress`, `gsd_roadmap`, `gsd_history`, `gsd_doctor`, `gsd_captures`, `gsd_knowledge`, `gsd_graph`
- Interactive form tool: `ask_user_questions`

For an auto-mode run, call `gsd_execute` first with an absolute `projectDir`. It returns a `sessionId`; poll `gsd_status` with that `sessionId` until the run finishes, then call `gsd_result` for accumulated output or `gsd_cancel` to stop it. If a client loses the `sessionId`, `gsd_status` can fall back to `projectDir`, or omit both fields only when this MCP server tracks exactly one session. Read-only project tools do not require an active session. With the GSD runtime bridge available, `gsd_progress` reads the project-root database and may run pending migrations and synchronize milestone queue order, matching `gsd headless status`. It uses the `STATE.md` projection only when the database is missing or cannot be opened; failures after a successful open are returned as errors. Without the bridge, the standalone MCP package keeps its projection-reader behavior. The other read-only project tools continue to read `.gsd/` projections directly.

The integration CLI `gsd read progress --json --project <path>` follows the same database-first and projection-fallback contract as `gsd_progress`.

## In-Session Update

`/gsd update` checks npm for a newer version of GSD and installs it without leaving the session.
When the `claude-code` provider is configured, update may also warn if the local Claude Code Runtime is below the GSD release's validated floor.

```bash
/gsd update
# Current version: 1.2.0
# Checking npm registry...
# Updated to 1.3.0. Restart GSD to use the new version.
```

If already up to date, it reports so and takes no action.

Use `/gsd update --models` to fetch the published all-provider model catalog, atomically replace `~/.gsd/agent/models-catalog.json`, and reload the model registry in the current session. New models and pricing become available without an npm upgrade or restart. The command does not require provider authentication, and `/gsd upgrade --models` is an alias. See [Updating the Model Catalog](./custom-models.md#updating-the-model-catalog) for validation, precedence, and failure behavior.

## Report

`/gsd report` generates HTML reports for all milestones and opens the reports index in a browser. `/gsd export` remains available as an alias.

```bash
# Generate all missing milestone reports and open the reports index
/gsd report

# Generate HTML report for the active milestone
/gsd report --html

# Generate retrospective reports for ALL milestones at once
/gsd report --html --all
```

Reports are saved to `.gsd/reports/` with a browseable `index.html` that links to all generated snapshots. Each report includes the active memory feed in its Knowledge section when memory rows are available.
