# Subagents

Subagents delegate focused work to separate agent processes. Each child gets its own context window, model selection, tools, and system prompt, while the parent session receives the final answer, usage data, and a durable run record that can be inspected later.

Use subagents for bounded work such as codebase scouting, implementation, review, security checks, doc writing, or independent task batches. Auto mode may also dispatch subagents during reactive task execution when ready tasks do not depend on each other.

## Available Agents

List agents from an active session:

```text
/subagent
```

Agents are Markdown files loaded from:

| Location | Scope |
|----------|-------|
| `~/.gsd/agent/agents/` | User-wide agents |
| `.gsd/agents/` | Project-local agents |

Project-local agents are repository-controlled. For trusted-repo prompts, the parent can set `confirmProjectAgents: true` so GSD asks before running project-local agents.

## Invocation Modes

The `subagent` tool supports three launch shapes:

```json
{ "agent": "scout", "task": "Find the files involved in auth redirects." }
```

```json
{
  "tasks": [
    { "agent": "tester", "task": "Run focused API tests and report failures." },
    { "agent": "reviewer", "task": "Review the changed auth files for regressions." }
  ]
}
```

```json
{
  "chain": [
    { "agent": "scout", "task": "Map the checkout flow." },
    { "agent": "planner", "task": "Create an implementation plan from this context: {previous}" },
    { "agent": "worker", "task": "Implement the plan: {previous}" }
  ]
}
```

Single mode runs one child. Parallel mode runs independent tasks concurrently, with a maximum of eight tasks and an execution concurrency cap of four. Chain mode runs steps sequentially and replaces `{previous}` with the prior step's output.

Optional fields:

| Field | Applies to | Description |
|-------|------------|-------------|
| `agentScope` | all modes | `"user"`, `"project"`, or `"both"`; default is `"both"` |
| `model` | all modes | Model override for the child process |
| `cwd` | single, task, or chain step | Working directory for that child |
| `context` | all modes, task, or chain step | `"fresh"` or `"fork"`; default is `"fresh"` |
| `background` | all modes | Return immediately and persist progress for later `status` checks |
| `isolated` | launch | Run through the configured filesystem isolation backend before merging patches back |

## Child Tools And Session Evidence

The launcher passes an explicit `--tools` list to the child process only when its agent definition configures one; otherwise the child starts with the default toolset. A tool available in the parent session — for example the native `gsd_graph` memory graph tool — is not automatically available to a child. Check the agent definition to know which tools a child can use; do not infer child access from the parent session.

To verify what a child actually received, read local records only:

- **Fresh context (default):** the child runs with `--no-session`, so no child session file exists. That is expected, not a failure. The run record's per-child status, output, and stderr are the evidence (see [Run State](#run-state)).
- **Forked context:** the run record lists the child session file. Inspect it — or `resume` it — to see the conversation the child actually had.
- **Tool access:** when the agent definition sets an explicit `tools` list, the child process is launched with exactly that list. Without one, the child starts from the default toolset plus loaded extension tools, so a tool missing from the frontmatter is not proof it is unavailable. In the child's output, a `Tool <name> not found` error means the child lacked the tool; any other error means the tool ran and failed. These are different facts.

## Context Modes

`context: "fresh"` is the default. The child starts with the agent's prompt and the delegated task, keeping the parent conversation out of the child context.

`context: "fork"` branches from the current parent session. Use it when the child needs the exact conversation state, selected files, or prior decisions. Forked context requires a persisted parent session and a current session leaf; in-memory sessions cannot be forked.

Child processes are marked with `GSD_SUBAGENT_CHILD=1`, which suppresses recursive subagent registration inside the child.

When a project has a [project-local runtime contract](./local-runtime-contract.md), a child launched into a nested repository inherits the owning project's runtime authority while its other preferences and context remain local to the child. The same authority is propagated to explicitly isolated children so a temporary checkout cannot silently replace the startup and teardown contract.

## Skills In Child Sessions

A child does not inherit the parent session's skill inventory. Each session — parent or child — scans the skill directories at startup and builds its own inventory (see [Skill Directories](./skills.md#skill-directories)). Project-scope directories resolve against that session's working directory, so a child launched with a different `cwd` scans a different set:

| Directory | Found when the child cwd is below the project root? |
|-----------|-----------------------------------------------------|
| `<cwd>/.gsd/skills/` | No — exact working directory only |
| `<cwd>/.agents/skills/` | Yes — nearest first, up to the nearest enclosing directory containing a `.git` entry (or the filesystem root when there is none) |
| `<cwd>/.claude/skills/` | No — exact working directory only |
| `~/.gsd/agent/skills/` (bundled) | Yes — home-level, independent of cwd |
| `~/.agents/skills/`, `~/.claude/skills/` | Yes — home-level, independent of cwd |

A root-local `.agents/skills/` directory is therefore still discovered from a child launched into a subdirectory, while root-local `.gsd/skills/` and `.claude/skills/` are not. When task isolation is active, discovery follows the isolation environment's working directory instead of the original one.

### Skill Activation Evidence

The discovered inventory is bookkeeping, not model-visible context: the base system prompt does not automatically embed the skill inventory. A skill's instructions reach the model only when its `SKILL.md` is read — for example because the GSD system context or the agent's prompt named the skill, or the model chose to read a known skill path. (Auto mode is the exception on the parent side: it can append newly discovered skills with their locations to the system prompt mid-run, and unit prompts can add explicit activation directives. Neither is attached to subagent launches.)

Installation and inventory presence are not evidence that a child used a skill. The stages are distinct:

| Stage | Meaning | Evidence |
|-------|---------|----------|
| Installed | Files exist in a directory the child scans | Filesystem only — not child-specific |
| Discovered | The skill entered the child's inventory at startup | The table above gives search eligibility; membership additionally requires a parseable `SKILL.md` with a description that wins name collisions. Inventory presence is not model-visible and does not imply use |
| Read | The child's model loaded the skill's `SKILL.md` with a `read` tool call | Child transcript only (see below) |
| Followed | The output conforms to the skill's instructions | Not directly observable — judge the child's output |

Skills are instruction files, not tools: reading one does not register tools or grant permissions the child does not already have (see [Child Tools And Session Evidence](#child-tools-and-session-evidence)).

To evidence a read by a specific child, launch it with `context: "fork"` and inspect the branched session file recorded in the run record (`sessionFile` field of `~/.gsd/agent/subagent-runs/<runId>.json`). Branched sessions copy the parent's history, so match only entries the child appended after branching, and require the read to have succeeded — the tool result must carry the skill content. Note that a fork can also carry skill content inherited from the parent conversation without any new child read; the recipe above proves a child read, not the only way skill instructions can reach the child's context. Fresh children run with `--no-session`, so no persisted child transcript exists for them; their output mentioning a skill is the model's narrative, not proof of a read. Re-run with `context: "fork"` when you need an inspectable trace.

Auto-mode skill telemetry (the `skills` data recorded per unit and surfaced by `/gsd skill-health`) captures the skill names available to a parent auto-mode unit at dispatch. It is not a record of reads, and it never describes a subagent child's activity.

## Background Runs

Any valid dispatch — single, parallel, or chain — can launch in the background. For a long single-agent task:

```json
{
  "agent": "tester",
  "task": "Run the full regression suite and summarize failures.",
  "background": true
}
```

Batches work the same way: pass `background: true` alongside `tasks` (parallel) or `chain` (sequential). The children run detached — they outlive the dispatching turn — and one completion wake summarizes the batch with per-child success or failure.

The tool returns a run id:

```text
Started background subagent run <runId>. Use action: "status" with runId: "<runId>" to inspect it.
```

Check the persisted run:

```json
{ "action": "status", "runId": "<runId>" }
```

Status output includes the run status, mode, context mode, update time, child status, exit code, output or error, and the child session file when one exists.

Each child is also assigned a random tracking name, shown as `<tracking-name> / <agent>`. The name is only for human tracking in status and result output; agent selection still uses the configured agent id.

Live child rows retain the requested model. When the provider reports a different model, the TUI shows both as `<requested> ← <reported>` without changing model selection or routing.

## Resume And Follow-Up

Resume follows up inside a child session captured by a previous run:

```json
{
  "action": "resume",
  "runId": "<runId>",
  "followUp": "Apply the smallest fix for the failing test and report changed files."
}
```

If the run has more than one resumable child session, include the agent selector:

```json
{
  "action": "resume",
  "runId": "<runId>",
  "agent": "tester",
  "followUp": "Re-run only the failing tests."
}
```

Resume requires a run record with exactly one matching child session file. If no run exists, no child session was recorded, or multiple child sessions match without an `agent` selector, GSD returns a hard error instead of guessing.

## Run State

Subagent run records are JSON files stored under:

```text
~/.gsd/agent/subagent-runs/<runId>.json
```

`GSD_HOME` and `GSD_CODING_AGENT_DIR` can move this location; the store uses the active GSD agent directory returned by the runtime. Each record contains:

| Field | Meaning |
|-------|---------|
| `runId` | Unique dispatch id |
| `mode` | `single`, `parallel`, or `chain` |
| `contextMode` | `fresh` or `fork` |
| `status` | `running`, `succeeded`, `failed`, or `interrupted` |
| `cwd` | Parent working directory for the dispatch |
| `children` | Per-child tracking name, agent, task, cwd, status, session file, output, stderr, usage, model, and merge result |
| `failure` | Failure category and message when the run did not succeed |

The persisted record is the operational source for `status` and `resume`. The child session JSONL file remains the source for conversation continuation.

## Filesystem Isolation

By default, subagents run in the selected working directory and can edit that checkout according to their tool permissions.

Set `isolated: true` to request task-level filesystem isolation. Isolation only activates when global settings contain a supported backend:

```json
{
  "taskIsolation": {
    "mode": "worktree"
  }
}
```

Supported modes are:

| Mode | Behavior |
|------|----------|
| `worktree` | Creates a detached git worktree under `~/.gsd/wt/<encoded-cwd>/<task-id>/`, snapshots parent dirty state into it, captures the child delta, applies the patch back to the parent checkout, then removes the worktree |
| `fuse-overlay` | Uses `fuse-overlayfs` on Linux when available, otherwise falls back to `worktree` |

If `taskIsolation.mode` is unset or invalid, `isolated: true` is ignored and the child runs in the normal working directory. If patch merge fails, the run is marked failed and the merge result lists applied and failed patches.

## Recovery Behavior

When the parent session shuts down, GSD sends `SIGTERM` to live child processes and then `SIGKILL` to any process that does not exit promptly. Completed, failed, and interrupted child evidence is written to the run record when available.

Use `status` first after an interruption. If a child session file was recorded, use `resume` with a follow-up instruction to continue that child's conversation. If the child never launched far enough to create a session file, relaunch the task from the parent with a new `launch` action.

Subagent run records are local machine state, not a team artifact. They are intended for same-host recovery and inspection; do not rely on them as shared project documentation.
