# Auto Mode

Auto mode is GSD's autonomous execution engine. Run `/gsd auto`, walk away, come back to built software with clean git history.

## How It Works

Auto mode is a **state machine driven by the GSD database at the project root**. It derives the next unit of work from the authoritative SQLite state, creates a fresh agent session, injects a focused prompt with all relevant context pre-inlined, and lets the LLM execute. When the LLM finishes, auto mode persists the result to the database, refreshes markdown projections such as `STATE.md`, and dispatches the next unit.

### The Loop

Each slice flows through phases automatically:

```text
Plan (with integrated research) → Execute (per task) → Complete → Reassess Roadmap → Next Slice
                                                                                      ↓ (all slices done)
                                                                      UAT PASS → Validate Milestone → Complete Milestone
```

- **Plan** — scouts the codebase, researches relevant docs, and decomposes the slice into tasks with must-haves
- **Execute** — runs each task in a fresh context window
- **Complete** — writes summary, UAT script, marks roadmap, commits
- **Reassess** — checks if the roadmap still makes sense
- **Validate Milestone** — reconciliation gate after all slices complete; compares roadmap success criteria against actual results, catches gaps before sealing the milestone

When progressive planning is enabled, GSD fully plans the first slice and may leave later slices as sketches. Those slices render in the milestone roadmap projection (`NN-ROADMAP.md` under `.gsd/phases/<NN-slug>/` for flat-phase projects) with a `` `[sketch]` `` badge, meaning the slice has an approved scope boundary but has not yet been expanded into task plans. Auto mode runs `refine-slice` just before execution to convert the sketch into a full slice plan using the current codebase and prior slice summaries.

### Idempotent Milestone Completion

Milestone completion is safe to retry with the same private invocation identity and unchanged request. For an adopted Milestone, an exact retry returns the stored database receipt without appending another completion event. A retry of the current receipt may repair its summary projection; a historical receipt reports `superseded: true` and cannot overwrite a newer lifecycle projection. Reusing an identity with a changed request fails closed. Unadopted compatibility Milestones retain the legacy `alreadyComplete: true` redispatch behavior.

The auto loop applies the same idempotency at terminal closeout: if another session is already stopping for completion, or the database already shows the milestone closed, the loop exits as complete without replaying merge, desktop notification, cmux notification, or stop side effects.

If post-merge stash restore fails after a successful milestone merge, auto mode records the merge as complete before stopping for manual stash recovery. Resuming auto mode will not replay the completed merge.

For an adopted Milestone, `complete-milestone` enforces a current source-bound validation receipt, terminal and semantically matched descendants, current cancellation Waivers, no active Attempts, and any required subjective UAT acceptance. Missing or stale objective evidence remains agent-owned: rerun verification, UAT, or roadmap remediation as directed, then validate again. Only a genuinely subjective UAT decision or unavailable authority/access pauses for the user. Unadopted imports retain the legacy assessment and hierarchy gates.

### Planning-Only Milestone Closeout

When milestone history contains only `.gsd/` artifact changes (for example planning-only or documentation-only closeout), auto mode now continues `complete-milestone` dispatch instead of blocking completion for missing implementation files outside `.gsd/`. GSD emits a warning so operators can distinguish this path from implementation-bearing milestones.

### State Authority

The SQLite database is the runtime source of truth for milestones, slices, tasks, requirements, summaries, and completion status. Durable decisions and project knowledge use the same database through the `memories` table: decisions are stored as `architecture` memories, and KNOWLEDGE patterns/lessons are stored as `pattern`/`gotcha` memories.

Markdown files in `.gsd/` are rendered projections for review, prompts, and git-friendly history. `.gsd/DECISIONS.md` is projected from architecture memories, and the Patterns/Lessons sections of `.gsd/KNOWLEDGE.md` are projected from memory rows; editing those projections does not override the database unless a command imports or saves the change through GSD. The Rules section of `KNOWLEDGE.md` remains manually authored and is preserved separately.

Execute-task units use durable Attempt records. Before the worker starts, auto mode must hold a milestone lease and coordination dispatch, move the canonical task lifecycle to `in_progress`, create a running Attempt, and append an `execute` Kernel checkpoint. If an old worker is replaced by a newer lease, the old Attempt is settled as `interrupted` and the replacement Attempt links back to it as retry history.

On the canonical completion path, `gsd_task_complete` stages the executor result; it does not publish the task as complete by itself. A successful executor result settles the Attempt and advances the Kernel checkpoint to `verify`; host-owned verification then records the Technical Verdict and command evidence. Only a passing verdict for the current source revision publishes task completion: the canonical lifecycle becomes `completed`, the compatibility task row becomes `complete`, and summary/plan projections are refreshed from the database.

Task completion preserves the stored task title, including legacy completion when a blocker is discovered. The executor's one-line summary is stored separately; legacy completion uses it as the title only when creating a new task row.

Task recovery keeps three intents separate. Reopen returns a terminal task to canonical `ready` plus legacy `pending` without starting work or deleting history; retry or remediation creates a fresh lineage-linked Attempt after an execution failure/interruption or a succeeded Result whose current evidence-backed Technical Verdict did not pass, without resetting task status; cancel moves actionable work to canonical `cancelled` plus legacy `skipped`, interrupting any running Attempt first. Projection and summary rendering failures are retryable delivery work after the database transaction commits. They return a visible error and leave the authoritative lifecycle state intact instead of rolling a committed completion back to pending.

Resolving or dismissing a genuine user/external Blocker does not turn the paused Attempt into a pass or resume that worker in place. Work can continue only through a bounded agent-owned successor route and one fresh lineage-linked Attempt, which must produce its own Result and current verification evidence before completion can publish. A rejected subjective review aborts instead of authorizing that successor.

For subjective human review, an approval authorizes exactly one immediate fresh successor only while the reviewed source is unchanged. If the source changes before that successor is verified, GSD requires a new review instead of reusing the approval.

An agent-owned recovery abort remains fail-closed after its retry budget is exhausted. A settled Attempt with a current agent-owned `remediate` action can likewise require an explicit, evidence-backed continuation after the repair is complete. In either case, run the operator-facing `/gsd recover <recoveryActionId>` command with the exact current Recovery Action ID. The command verifies eligibility, prompts for a nonblank repair summary and concrete verification evidence, and then tells you to rerun `/gsd auto`. The equivalent control-plane operation is `gsd_task_recovery_resume`, whose custom clients must provide the same repair summary and non-empty structured evidence. Recovery preserves the predecessor Attempt, its Result, the Recovery Action, and its budget while authorizing exactly one immediate lineage-linked Attempt. A dispatched worker cannot resume its own action, and stale actions, duplicate authorizations, open blockers, or later Attempts are rejected.

When closeout or post-unit review finds task-specific rework, GSD can persist a structured rework brief with `gsd_rework_brief_save`. Blocking findings in that brief prevent `gsd_task_complete` from accepting the task until each finding has a `reworkResolution` entry with the same `findingId`, `status: "resolved"`, and concrete evidence. A finding can be deferred only with `status: "deferred-with-override"`, concrete evidence, and a `decisionRef`. If the plan for a reopened pending task needs to change for that rework, `gsd_replan_task` updates that one task's title, description, estimate, files, verification command, inputs, and expected output without mutating sibling tasks.

`.gsd/QUEUE-ORDER.json` is the special durable reorder contract for milestone queue order. Commands such as `/gsd rethink` and `/gsd phase` write it when an operator reorders milestones; when the runtime database is open, GSD mirrors that order into `milestones.sequence`. State derivation also replays an existing `QUEUE-ORDER.json` into the database before choosing the active milestone, which repairs stale DB sequence for prompt-driven reorder flows without making arbitrary markdown projections runtime authority.

In worktree mode, source-code execution remains rooted in the active worktree and the project-root database remains authoritative runtime state. Plan Milestone resolves canonical Project-state artifacts through the project root while expressing their paths relative to the worktree; it does not treat a worktree-local `.gsd/` as Project state. Other units may render non-authoritative projections under the active worktree-local `.gsd/`, but neither projection location is a runtime state fallback. If the database is unavailable, runtime state derivation refuses to silently rebuild from markdown. Use explicit recovery/import commands, or run `/gsd migrate` when markdown is the intended source.

### Single-Host Runtime Constraint

Phase C coordination is single-host only. Auto mode and parallel coordination rely on the project-root SQLite database running in WAL mode on local disk for worker heartbeats, milestone leases, dispatch claims, cancellation requests, and command handoff.

That means multiple terminals or worker processes can safely coordinate against the same project on one machine, but sharing `.gsd/gsd.db*` across machines or over network filesystems is unsupported. If you need cross-host orchestration, use an external coordinator instead of trying to stretch the local SQLite/WAL runtime.

### Deep Planning Mode

For projects that need more up-front discovery, enable deep planning mode in project preferences:

```yaml
planning_depth: deep
```

You can also opt in when starting project setup with `/gsd new-project --deep` or `/gsd new-milestone --deep`; GSD writes the project `.gsd/PREFERENCES.md` setting for you.

Deep mode keeps the normal slice execution loop, but first runs a one-time staged discovery flow before milestone-level planning:

```text
Workflow Preferences -> Project Context -> Requirements -> Research Decision -> Optional Project Research -> Milestone Context/Roadmap
```

| Artifact | When it appears | Purpose |
|----------|-----------------|---------|
| `.gsd/PREFERENCES.md` | `--deep` / `workflow-preferences` | Holds `planning_depth: deep` and captured workflow settings |
| `.gsd/PROJECT.md` | `discuss-project` | Project vision, users, anti-goals, constraints, and rough milestone sequence |
| `.gsd/REQUIREMENTS.md` | `discuss-requirements` | Capability contract using `R###` requirements grouped by Active, Validated, Deferred, and Out of Scope |
| `.gsd/runtime/research-decision.json` | `research-decision` | Records `research` or `skip`; this unit only asks the question and writes the marker |
| `.gsd/research/STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md` | `research-project`, only when the decision is `research` | Four scout-backed project research outputs for stack, feature norms, architecture, and pitfalls |
| `.gsd/phases/<NN-slug>/<NN>-CONTEXT.md` and `<NN>-ROADMAP.md` | Normal milestone discussion/planning | Milestone-specific context and executable roadmap; `` `[sketch]` `` marks slices awaiting `refine-slice`. Legacy projects may still resolve to `.gsd/milestones/<MID>/<MID>-*.md` until migrated. |

`REQUIREMENTS.md` is rendered from the requirements stored in the GSD database. Agents should save individual requirements with `gsd_requirement_save`; a final `gsd_summary_save` for `REQUIREMENTS` will fail if no active requirement rows exist instead of treating caller-supplied markdown as canonical.

Project research is informational, not binding. The `research-project` parent dispatches parallel scout subagents for the four research dimensions; each scout writes one file under `.gsd/research/` (`STACK.md`, `FEATURES.md`, `ARCHITECTURE.md`, `PITFALLS.md`). The outputs cross-check the requirements and surface table stakes, risks, and omissions; any new commitment should be added to `.gsd/REQUIREMENTS.md` before planning depends on it.

## Key Properties

### Fresh Session Per Unit

Every task, research phase, and planning step gets a clean context window. No accumulated garbage. No degraded quality from context bloat. The dispatch prompt includes everything needed — task plans, prior summaries, dependency context, decisions register — so the LLM starts oriented instead of spending tool calls reading files.

### Runtime Tool Policy

Each auto-mode unit has a `UnitContextManifest` with a `ToolsPolicy`, and GSD enforces that policy before tool calls execute. Execution units use `all` mode and may edit project files, run shell commands, and dispatch subagents. Most planning and discussion units use `planning` mode: they can read broadly, write planning artifacts under `.gsd/`, run only read-only shell commands, and cannot dispatch subagents. Selected planning and closeout units use `planning-dispatch` mode, which keeps the same source-write and bash restrictions but allows `subagent` dispatch for isolated recon, planning, or review work. Documentation units use `docs` mode, which keeps the same restrictions but also allows writes to the manifest's explicit documentation globs such as `docs/**`, top-level `README*.md`, `CHANGELOG.md`, and top-level `*.md`.

`workflow-only` mode is stricter: read/list/search tools, GSD workflow tools, and manifest-declared read-only subagents are allowed, while generic `bash` and direct write/edit artifact tools are blocked. `validate-milestone` uses this mode so validation output must be persisted through `gsd_validate_milestone`; remediation changes must go through workflow tools such as `gsd_reassess_roadmap`, not manual `VALIDATION.md` or roadmap edits.

The sidecar unit types now have distinct manifest behavior: `triage-captures` runs in `contextMode: triage` with `planning`-mode tools (read-heavy, `.gsd/`-scoped writes, no subagent dispatch), while `quick-task` runs in `contextMode: execution` with `all`-mode tools so it can apply and verify small inline fixes.

Writes outside those allowed paths, unsafe bash commands, and subagent dispatch from non-dispatch planning units are blocked with a hard policy error instead of relying on prompt compliance. In `planning-dispatch` units, prompts steer the parent agent toward read-only specialists such as `scout`, `planner`, `researcher`, `reviewer`, `security`, or `tester`; implementation-tier agents still belong in `execute-task`.

### ScheduleWakeup Continuations

`gsd_schedule_wakeup` schedules a delayed follow-up prompt. In auto mode, it is used for long external waits inside `execute-task` units and keeps the same unit session alive instead of ending the unit as incomplete. Outside auto mode, it waits for the requested delay and then starts a new triggered turn with the supplied wakeup prompt. Do not use Claude Code's native `ScheduleWakeup` tool for this.

- Use it when a task kicked off external work (for example CI, deploy, or async jobs) and needs a later poll.
- Include a concrete follow-up prompt that says what to check and what artifact to write when done.
- Re-arm it on each poll turn while the external process is still running.
- Outside auto mode, use it when you ask GSD to check back or poll later; the wakeup dispatches after the delay, not synchronously.

Auto mode consumes the scheduled wakeup only for the same `basePath + unitType + unitId`, waits the requested delay, and then dispatches the follow-up prompt in the same session. For safety, wakeups are bounded per unit; hitting the cap stops the unit with a timeout-style cancellation.

### Discovered Blockers at Verification

When a task completion records a settled, failed `blocker-discovered` Attempt awaiting failure routing, the host verification gate pauses auto mode. The pause names the task and Attempt and includes the staged blocker summary when present. If the task has a readable, unresolved escalation artifact, the pause also displays its question, options, and recommendation. Use `/gsd escalate list` to inspect pending escalations.

This pause surfaces the blocker; it does not authorize a retry or change failure routing. Although the message suggests `/gsd auto` after resolving the blocker, the failed Attempt still awaits routing and the task remains `in_progress`. Resuming can route that historical failure to an abort, so resolving an escalation alone does not guarantee continuation. A later successful Attempt can pass verification normally. Other failed Attempts still fail the verification gate's succeeded-Attempt requirement.

### Pre-Dispatch Runtime Blocks

Before auto mode launches a unit, the orchestration pipeline now enforces runtime invariants in this order: reconcile state, choose the next unit, compile the unit tool contract, validate the worktree or unit root, then persist the runtime transition. A failure in any pre-dispatch step returns a `blocked` result and records the block before a worker session starts.

Common block reasons and operator actions:

| Block reason | What it means | Remediation |
|--------------|---------------|-------------|
| State reconciliation blocker | The authoritative database snapshot is already blocked, or state derivation found existing blockers. | Inspect `/gsd status`, `STATE.md`, and the database-backed blocker message; resolve the blocker or run the appropriate GSD recovery command before retrying `/gsd auto`. |
| `unknown-unit-type` | The dispatch decision selected a unit with no registered `UnitContextManifest`. | Fix the unit registration or manifest mapping. Retrying without a code/config fix will select the same invalid unit. |
| `missing-closeout-tool` | A closeout unit such as task, slice, milestone, UAT, or gate completion has no required workflow tool available. | Restore the missing `gsd_*` workflow tool registration or update the unit manifest/tool contract so the unit can durably save its result. |
| `root-missing` / `root-not-directory` | A source-writing unit would run from a missing or invalid unit root. | Recreate or repair the milestone worktree/root, or clear an incorrect `GSD_UNIT_ROOT`, before launching another source-writing unit. |
| `git-metadata-missing` | A source-writing unit root exists but is not a git worktree or repository root. | Run the unit from the project root or milestone worktree with valid `.git` metadata; recreate the worktree if it was deleted or partially copied. |
| `preflight-unmerged-conflicts` | Milestone merge preflight found unresolved Git conflict stages in the working tree (shared with the global workspace git gate). | Resolve conflicts manually (`git status`, fix files, stage resolutions), then run `/gsd auto` to resume. Auto mode **pauses** on pre-dispatch health gate product conflicts; an unrecoverable git probe **stops** the loop. |
| `preflight-dirty-overlap` | Milestone merge preflight found local dirty files that overlap files changed by the milestone branch. | Commit or stash your local edits manually, or move them out of the way, then rerun `/gsd auto`. |

Recovery classification now treats deterministic policy, tool-schema, stale-worker, and invalid-worktree failures as non-transient stops. A Windows projection-root sharing violation is normalized as transient and consumes the existing transient-execution retry budget; sustained contention still exhausts that budget and stops. Provider failures still use provider-specific transient classification and may retry automatically, while genuine projection gaps, verification drift, and unknown runtime failures escalate for inspection because repeating the same dispatch can preserve the drift.

### Preference Diagnostics at Preflight

When you start auto mode, GSD re-surfaces any GSD preference parse or validation diagnostics (malformed `PREFERENCES.md` frontmatter or invalid settings) as notifications before the loop begins, so you get actionable file/line guidance before long-running automation proceeds. These re-surface at the auto-mode preflight even if the same problem was already shown at session start; each surface still dedupes repeated diagnostics. Preference problems do not block auto mode — they are advisory. See [Configuration](./configuration.md#invalid-or-malformed-preferences) and [Troubleshooting](./troubleshooting.md#preferences-file-ignored-or-settings-not-taking-effect).

### Context Pre-Loading

The dispatch prompt is carefully constructed with:

| Inlined Artifact | Purpose |
|------------------|---------|
| Task plan | What to build |
| Slice plan | Where this task fits |
| Prior task summaries | What's already done |
| Dependency summaries | Cross-slice context |
| Roadmap excerpt | Overall direction |
| Decisions register | Architectural context |

The amount of context inlined is controlled by your [token profile](./token-optimization.md). Budget mode inlines minimal context; quality mode inlines everything.

### Context Mode

Context Mode is enabled by default for auto-mode runs. Eligible auto-mode units receive manifest-driven guidance based on their context lane and any unit-specific override. Most execution-style lanes preserve the conversation window with `gsd_exec` for noisy codebase scans, builds, tests, and diagnostics, `gsd_exec_search` before repeating a prior sandboxed run, and `gsd_resume` after compaction or session resume. Some units name narrower tools instead; for example, `research-project` dispatches parallel scout subagents so each dimension writes one file under `.gsd/research/`.

`contextMode: triage` is used specifically for capture triage turns so they stay focused on classification and routing decisions instead of implementation work.

When present in a unit's tool contract, `gsd_exec` writes capped stdout/stderr and metadata under `.gsd/exec/`; output may be truncated. It then returns only a short digest to the agent. This keeps large command output out of the LLM context while preserving exact evidence on disk. In milestone worktree mode, `gsd_exec` also rejects scripts that target the original project root (including traversal patterns such as `cd ../../..`) so execution stays inside the active worktree boundary. To opt out of Context Mode guidance, snapshot injection, and context-mode execution tools, set:

```yaml
context_mode:
  enabled: false
```

You can also tune sandbox behavior with `context_mode.exec_timeout_ms`, `context_mode.exec_stdout_cap_bytes`, `context_mode.exec_digest_chars`, and `context_mode.exec_env_allowlist`. `context_mode.exec_timeout_ms` overrides the timeout for each `gsd_exec` call. When it is unset, verification-oriented workloads such as builds, tests, linting, type checks, and verification commands inherit `verification_timeout_ms` (default: `120000` ms); other `gsd_exec` calls use the sandbox's `30000` ms default.

### Git Isolation

GSD isolates milestone work using one of three modes (configured via `git.isolation` in preferences):

- **`none`** (default): Work happens directly on your current branch. No worktree, no milestone branch. Ideal for hot-reload workflows where file isolation breaks dev tooling.
- **`worktree`**: Each milestone runs in its own git worktree at `.gsd-worktrees/<MID>/` on a `milestone/<MID>` branch. Worktree mode requires at least one commit; in a zero-commit repo with no committed `HEAD`, GSD temporarily runs as `none` until the first commit exists. All slice work commits sequentially, and the milestone is squash-merged to main as one clean commit.
- **`branch`**: Work happens in the project root on a `milestone/<MID>` branch. Useful for submodule-heavy repos where worktrees don't work well.

See [Git Strategy](./git-strategy.md) for details.

### Parallel Execution

When your project has independent milestones, you can run them simultaneously. Each milestone gets its own worker process and worktree, and the shared project-root SQLite/WAL runtime coordinates worker heartbeats, milestone leases, dispatch ownership, retry windows, and control commands on the same machine. See [Parallel Orchestration](./parallel-orchestration.md) for setup and usage.

### Crash Recovery

Auto mode persists worker state, unit-dispatch state, and paused-session metadata in the project-root SQLite database. If the session dies, the next `/gsd auto` reconstructs the interrupted unit from DB-backed runtime state, reads the surviving session file, synthesizes a recovery briefing from every tool call that made it to disk, and resumes with full context.

**Headless auto-restart:** When running `gsd headless auto`, crashes trigger automatic restart with exponential backoff (5s → 10s → 30s cap, default 3 attempts). Configure with `--max-restarts N`. SIGINT/SIGTERM bypasses restart. Combined with crash recovery, this enables true overnight "run until done" execution.

### Provider Error Recovery

GSD classifies provider errors and auto-resumes when safe:

| Error type | Examples | Action |
|-----------|----------|--------|
| **Rate limit** | 429, "too many requests" | Auto-resume after retry-after header or 60s |
| **Server error** | 500, 502, 503, "overloaded", "api_error" | Auto-resume after 30s |
| **Permanent** | "unauthorized", "invalid key", "billing" | Pause indefinitely (requires manual resume) |

No manual intervention needed for transient errors — the session pauses briefly and continues automatically.

### Incremental Memory

GSD maintains durable project memory in the `memories` table and projects selected knowledge back into `.gsd/KNOWLEDGE.md` for review. `KNOWLEDGE.md` keeps manual Rules as file-canonical entries, while Patterns and Lessons are captured as memories, backfilled from existing rows, and rendered into the file on session start.

At the start of each unit, GSD injects the manual Rules from project `KNOWLEDGE.md`; Patterns and Lessons reach the agent through the memory block. Global `~/.gsd/agent/KNOWLEDGE.md` remains user-maintained and is injected unchanged.

### Context Pressure Monitor

When context usage reaches 70%, GSD sends a wrap-up signal to the agent, nudging it to finish durable output (commit, write summaries) before the context window fills. This prevents sessions from hitting the hard context limit mid-task with no artifacts written.

### Meaningful Commit Messages

Commits are generated from task summaries — not generic "complete task" messages. Each commit message reflects what was actually built, giving clean `git log` output that reads like a changelog.

### Post-Task Commit Hook Remediation

When turn-level gitops uses the default `uok.gitops.turn_action: commit`, an `execute-task` closeout runs a git commit after host verification passes. If `git commit` exits with hook-owned output, such as a pre-commit hook rejecting lint, formatting, secret, or policy checks, GSD classifies the failure as `hook-content` instead of treating it as a soft closeout warning.

For a single-repository task, or a parent workspace task where no repository has already committed, auto mode injects the hook output back into the same task as a remediation retry so the agent can fix the staged changes and complete the task again. This commit-hook remediation path is capped at 2 attempts. After the cap is exhausted, auto mode pauses and writes the full git error to `.gsd/git-action-failures.log` for operator inspection.

Transient git failures such as `.git/index.lock` contention still use the short git retry path. If a parent workspace partially committed some repositories before another repository's hook rejected the commit, GSD pauses instead of re-running the task, because redoing the task could duplicate work that is already committed in the successful repositories.

### Liveness Backstop

GSD records every non-advancing auto-mode outcome in the project database using the guard, target unit, and a hash of the inputs that guard read. A second occurrence with the same hash trips the guard even when other units ran between the two occurrences or the process restarted. Most guards create a persisted wedge; retry closeout uses the pause described below.

When a wedge trips, auto mode stops with blocked exit code 10, prints the guard and its sanctioned recovery, and refuses to re-enter while the wedge remains unacknowledged. Apply the printed recovery first, then run `/gsd auto --resume-wedge <id>` with the ID of the currently open wedge. GSD rechecks that wedge's originating guard before acknowledging it: if the guard still blocks, the wedge and its counter remain intact and auto mode stays stopped. Only after the blocker clears does GSD acknowledge the wedge and open one re-entry probe. The backstop never repairs workflow state itself: if the probe still reads the same unchanged blocker, it immediately reopens the same wedge with its prior evidence and occurrence count; changed input supersedes the old signature.

### Repeated Finalize Failures

With orchestration active, the second `finalize-retry` closeout failure with identical inputs pauses auto mode and surfaces the concrete cause from the dispatch ledger, such as stale source-integrity evidence. This path creates no wedge and needs no `--resume-wedge` acknowledgment. Headless runs retain blocked exit code 10.

Resolve the reported failure by supplying new verification evidence, changing the source revision, or applying the required recovery action, then run `/gsd auto`. Plain re-entry does not reset the persisted counter: unchanged inputs allow one redispatch, then the same failure pauses again. Changed inputs supersede the old signature. Other liveness guards and the loop fallback retain their wedge behavior; the no-orchestration fallback is unchanged.

### Consecutive Dispatch Blocker

Auto mode also retains a last-resort same-unit consecutive dispatch cap for every unit type. If that cap is reached, auto mode stops with a repeat-cap warning that instructs you to run `/gsd resume` after intervention. Repeated non-advancing outcomes, including `already-active` claim skips, normally trip the database-persisted liveness backstop first.

### Artifact Verification Retries

After each unit, GSD verifies that the expected artifact exists on disk. If the artifact is missing, auto mode re-dispatches the unit with explicit failure context and records an `artifact-verification-retry` journal event.

`reactive-execute` batches are handled differently after the retry cap. If dispatched tasks are still missing task summary files, GSD writes a slice-level `S##-REACTIVE-BLOCKER.md` diagnostic that lists which summaries are present or missing. The blocker prevents the same slice from launching another reactive batch, but it is not lifecycle authority: task statuses stay under canonical database Attempt/recovery control, not summary-file presence.

For `run-uat`, existence alone is not sufficient: a pre-existing
`S##-ASSESSMENT.md` only counts as completed when it contains a canonical
verdict field (for example frontmatter `verdict: PASS | FAIL | PARTIAL`). If
the file exists but has no verdict, artifact verification fails and `run-uat`
is redispatched. During milestone closeout, a UAT-scoped non-passing verdict is
also redispatched so closeout can recover with fresh UAT evidence; roadmap and
backfill assessments do not suppress that UAT run.

Artifact verification retries are capped at 3 attempts. If the expected artifact is still missing after those retries, GSD pauses auto mode with an "Artifact still missing..." error instead of relying on loop detection or an unbounded dispatch counter.

### Post-Mortem Investigation

`/gsd forensics` is a full-access GSD debugger for post-mortem analysis of auto-mode failures. It provides:

- **Anomaly detection** — structured identification of stuck loops, cost spikes, timeouts, missing artifacts, and crashes with severity levels
- **Unit traces** — last 10 unit executions with error details and execution times
- **Metrics analysis** — cost, token counts, and execution time breakdowns
- **Doctor integration** — includes structural health issues from `/gsd doctor`
- **Journal correlation** — uses `.gsd/journal/` events such as `unit-start`, `unit-end`, `post-unit-finalize-start`, `post-unit-finalize-end`, and `iteration-end` to show where the loop stopped
- **Worktree exit telemetry contract** — `auto-exit` journal events now include a normalized `reason` bucket plus `rawReason` (original free-form text) for operator debugging and analytics stability
- **LLM-guided investigation** — an agent session with full tool access to investigate root causes

Normalized `auto-exit` reason buckets are:
`pause`, `stop`, `blocked`, `merge-conflict`, `merge-failed`, `slice-merge-conflict`, `provider-error`, `session-failed`, `stream-aborted`, `unit-aborted`, `verification-exhausted`, `all-complete`, `no-active-milestone`, `other`.

```text
/gsd forensics [optional problem description]
```

See [Troubleshooting](./troubleshooting.md) for more on diagnosing issues.

### Timeout Supervision

Three timeout tiers prevent runaway sessions:

| Timeout | Default | Behavior |
|---------|---------|----------|
| Soft | 20 min | Warns the LLM to wrap up |
| Idle | 10 min | Detects stalls, intervenes |
| Hard | 30 min | Starts timeout recovery; pauses auto mode only if recovery cannot make durable progress |

Recovery steering nudges the LLM to finish durable output before timing out. When idle or hard timeout recovery is actively writing durable progress, the unit failsafe records fresh runtime progress in `.gsd/runtime/` and defers its final cancellation check for another short recheck window. This prevents auto mode from pausing while a recovered unit is finalizing, but future-dated or stale runtime timestamps are ignored so clock skew cannot keep the unit alive forever.

Interactive prompts that block waiting for human input (such as `ask_user_questions` during discuss-phase/milestone, or secure value entry) are exempt from the idle and hard timeouts: while one is in flight, the watchdogs re-arm instead of firing, so a long human deliberation never cancels the prompt or aborts its turn. A genuinely hung non-interactive unit still hits the hard cap as usual.

If a unit is abandoned, auto mode aborts its active turn, dismisses any pending question dialog, and clears its in-flight tool tracking. Transcript scrolling is restored, and the abandoned prompt no longer exempts later units from the idle or hard timeout.

When a unit ends with `unit-hard-timeout`, its `unit_dispatches` ledger row
records `status = failed` and `exit_reason = timeout`, rather than completion.

For operator forensics, timeout recovery updates the unit runtime record with fields such as `phase`, `timeoutAt`, `lastProgressAt`, `lastProgressKind`, `recoveryAttempts`, and `lastRecoveryReason`. Finalize timeouts are recorded with `lastProgressKind` values like `finalize-pre-timeout` or `finalize-post-timeout`; successful finalization records `finalize-success`.

The journal also closes every iteration explicitly. After a unit ends, auto mode emits `post-unit-finalize-start` before closeout and `post-unit-finalize-end` with a `status`, `action`, and optional `reason`. Every loop iteration then emits `iteration-end` with the final status and, when available, the failure class, unit type, unit id, and reason. Use these events to distinguish "agent never returned" from "agent returned but finalize/closeout stopped the loop."

Configure in preferences:

```yaml
auto_supervisor:
  soft_timeout_minutes: 20
  idle_timeout_minutes: 10
  hard_timeout_minutes: 30
```

### Cost Tracking

Every unit's token usage and cost is captured, broken down by phase, slice, and model. The dashboard shows running totals and projections. Budget ceilings can pause auto mode before overspending.

See [Cost Management](./cost-management.md).

### Adaptive Replanning

After each slice completes, the roadmap is reassessed. If the work revealed new information that changes the plan, slices are reordered, added, or removed before continuing. Removed pending slices and tasks remain in database history as cancelled, disappear from the active roadmap or plan projection, and must be explicitly reopened before their IDs can be reused. This can be skipped with the `balanced` or `budget` token profiles.

### Verification Enforcement

Configure shell commands that run automatically after every task execution:

```yaml
verification_commands:
  - npm run lint
  - npm run test
verification_auto_fix: true    # auto-retry runnable failures (default)
verification_max_retries: 2    # max retry attempts (default: 2)
```

Runnable checks that fail are eligible for bounded auto-fix retries — the agent sees the verification output and attempts to fix the issues before advancing.

If the shell cannot find an executable, GSD classifies the check as `command-not-found`. This includes exit code 127, `command not found` output, and Windows `is not recognized as an internal or external command` errors. The individual check remains `inconclusive` in verification evidence and does not consume an auto-fix retry.

The verification verdict passes via task evidence when every non-zero check is `command-not-found`, no blocking runtime error is present, and the current task has qualifying structured `verificationEvidence` staged through `gsd_task_complete`. Evidence qualifies when at least one record exists and every record has exit code 0 and a verdict of `pass` or `passed` (case-insensitive, ignoring surrounding whitespace). A genuine failing check or blocking runtime error prevents this exception. Source-integrity and post-execution checks still apply.

Otherwise, auto mode pauses and clears auto-fix retry state. Install the missing executable or correct the verification command, then resume auto mode.

Commands must be directly runnable checks such as `npm run lint`, `npm run test`, or `python3 -m pytest`. GSD supports single shell pipelines with `|`, so commands like `python3 -m pytest | tail -5` are valid. Logical OR fallbacks (`||`) are rejected, and GSD also rejects redirects (`>` and `<`), semicolons, backticks, and command substitution because verification is run as a controlled command list, not as an arbitrary shell program.

If you do not configure commands and the task plan does not provide a `verify` command, GSD attempts project discovery. See [Configuration — Verification](./configuration.md#verification) for the authoritative discovery order and package-manager command forms.

### Slice Discussion Gate

For projects where you want human review before each slice begins:

```yaml
require_slice_discussion: true
```

Auto-mode pauses before each slice, presenting the slice context for discussion. After you confirm, execution continues. Useful for high-stakes projects where you want to review the plan before the agent builds.

### HTML Reports

After a milestone completes, GSD auto-generates a self-contained HTML report in `.gsd/reports/`. Reports include project summary, progress tree, slice dependency graph (SVG DAG), cost/token metrics with bar charts, execution timeline, changelog, knowledge base, and active memories. No external dependencies — all CSS and JS are inlined.

```yaml
auto_report: true    # enabled by default
```

Generate all missing milestone reports and open the reports index anytime with `/gsd report`. Use `/gsd report --html` for a single active-milestone snapshot, or `/gsd report --html --all` for the explicit all-milestones form.

### Failure Recovery

Auto-mode reliability is hardened with multiple safeguards: atomic file writes prevent corruption on crash, OAuth fetch timeouts (30s) prevent indefinite hangs, RPC subprocess exit is detected and reported, and blob garbage collection prevents unbounded disk growth. Combined with the existing crash recovery and headless auto-restart, auto-mode is designed for true "fire and forget" overnight execution.

### Pipeline Architecture

The auto-loop is structured as a linear phase pipeline rather than recursive dispatch. Each iteration flows through explicit stages:

1. **Pre-Dispatch** — validate state, check guards, resolve model preferences
2. **Dispatch** — execute the unit with a focused prompt
3. **Post-Unit** — close out the unit, update caches, run cleanup
4. **Verification** — optional validation gate (lint, test, etc.)
5. **Liveness Backstop** — persist and adjudicate non-advancing outcomes

This linear flow is easier to debug, uses less memory (no recursive call stack), and provides cleaner error recovery since each phase has well-defined entry and exit conditions.

### Real-Time Health Visibility

Doctor issues (from `/gsd doctor`) now surface in real time across three places:

- **Dashboard widget** — health indicator with issue count and severity
- **Workflow visualizer** — issues shown in the status panel
- **HTML reports** — health section with all issues at report generation time

Issues are classified by severity: `error` (blocks auto-mode), `warning` (non-blocking), and `info` (advisory). Auto-mode checks health at dispatch time and can pause on critical issues.

### Skill Activation in Prompts

Configured skills are automatically resolved and injected into dispatch prompts. The agent receives an "Available Skills" block listing skills that match the current context, based on:

- `always_use_skills` — always included
- `prefer_skills` — included with preference indicator
- `skill_rules` — conditional activation based on `when` clauses

See [Configuration](./configuration.md) for skill routing preferences.

## Controlling Auto Mode

### Start

```text
/gsd auto
```

### Pause

Press **Escape**. The conversation is preserved. You can interact with the agent, inspect state, or resume.

### Resume

```text
/gsd auto
```

Auto mode derives the latest database state and picks up where it left off.

### Stop

```text
/gsd stop
```

Stops auto mode gracefully. Can be run from a different terminal.

### Steer

```text
/gsd steer
```

Hard-steer plan documents during execution without stopping the pipeline. Changes are picked up at the next phase boundary.

### Capture

```text
/gsd capture "add rate limiting to API endpoints"
```

Fire-and-forget thought capture. Captures are triaged automatically between tasks. See [Captures & Triage](./captures-triage.md).

### Visualize

```text
/gsd visualize
```

Open the workflow visualizer — interactive tabs for progress, dependencies, metrics, timeline, knowledge, memories, captures, and export. See [Workflow Visualizer](./visualizer.md).

### Remote Control via Telegram

When Telegram is configured as your remote channel, you can control auto-mode and query project status directly from the Telegram chat — without touching the terminal.

| Command | What it does |
|---------|-------------|
| `/pause` | Pause auto-mode after the current unit finishes |
| `/resume` | Clear a pause directive and continue auto-mode |
| `/status` | Show current milestone, active unit, and session cost |
| `/progress` | Roadmap overview (done / open milestones) |
| `/budget` | Token usage and cost for the current session |
| `/log [n]` | Last `n` activity log entries (default: 5) |

GSD polls for incoming Telegram commands every ~5 seconds while auto-mode is active. Commands are only available during active auto-mode sessions.

See [Remote Questions — Telegram Commands](./remote-questions.md#telegram-commands) for the full command reference and setup instructions.

## Dashboard

`Ctrl+Alt+G` or `/gsd status` shows real-time progress:

- Current milestone, slice, and task
- Auto mode elapsed time and phase
- Per-unit cost and token breakdown
- Cost projections
- Completed and in-progress units
- Pending capture count (when captures are awaiting triage)
- Parallel worker status (when running parallel milestones — includes 80% budget alert)

## Phase Skipping

Token profiles can skip certain phases to reduce cost:

| Phase | `budget` | `balanced` | `quality` |
|-------|----------|------------|-----------|
| Milestone Research | Skipped | Runs | Runs |
| Slice Research | Skipped | Skipped | Runs |
| Reassess Roadmap | Skipped | Runs | Runs |

See [Token Optimization](./token-optimization.md) for details.

## Dynamic Model Routing

When enabled, auto-mode automatically selects cheaper models for simple units (slice completion, UAT) and reserves expensive models for complex work (replanning, architectural tasks). See [Dynamic Model Routing](./dynamic-model-routing.md).

## Reactive Task Execution

Reactive task execution is enabled by default. During task execution, GSD derives a dependency graph from the IO annotations in task plans. When at least three ready tasks can be considered safely, tasks that do not conflict (no shared file reads/writes) are dispatched in parallel via subagents, while dependent tasks wait for their predecessors to complete.

```yaml
reactive_execution:
  enabled: false    # opt out; omit this block to keep the default-on behavior
```

The graph derivation is pure and deterministic: it resolves a ready-set of tasks, detects conflicts, and guards against deadlocks. If the graph is ambiguous or fewer than the threshold number of ready tasks are available, auto-mode falls back to the normal sequential executor. Setting `reactive_execution.enabled: true` explicitly keeps the earlier opt-in threshold of two ready tasks; omitting the setting uses the safer default-on threshold of three. Verification results carry forward across parallel batches, so tasks that pass verification don't need to be re-verified when subsequent tasks in the same slice complete.

Optional tuning:

```yaml
reactive_execution:
  enabled: true              # explicit opt-in threshold: 2 ready tasks
  max_parallel: 4            # default: 2, allowed range: 1-8
  isolation_mode: same-tree  # currently the only supported isolation mode
  subagent_model: claude-sonnet-4-6
```

The implementation lives in `reactive-graph.ts` (graph derivation, ready-set resolution, conflict/deadlock detection) with integration into `auto-dispatch.ts` and `auto-prompts.ts`.
