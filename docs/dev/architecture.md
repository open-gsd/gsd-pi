# Architecture Overview

GSD is a TypeScript application built on the [Pi SDK](https://github.com/badlogic/pi-mono). It embeds the Pi coding agent and extends it with the GSD workflow engine, auto mode state machine, and project management primitives.

## System Structure

```
gsd (CLI binary)
  └─ loader.ts          Sets PI_PACKAGE_DIR, GSD env vars, dynamic-imports cli.ts
      └─ cli.ts         Wires SDK managers, loads extensions, starts InteractiveMode
          ├─ onboarding.ts   First-run setup wizard (LLM provider + tool keys)
          ├─ wizard.ts       Env hydration from stored auth.json credentials
          ├─ app-paths.ts    ~/.gsd/agent/, ~/.gsd/sessions/, auth.json
          ├─ resource-loader.ts  Syncs managed resources to ~/.gsd/agent/
          └─ src/resources/
              ├─ extensions/gsd/    Core GSD extension
              ├─ extensions/...     22 supporting extensions
              ├─ agents/            scout, researcher, worker
              ├─ AGENTS.md          Agent routing instructions
              └─ GSD-WORKFLOW.md    Manual bootstrap protocol

gsd headless              Headless mode — CI/cron orchestration via RPC child process
gsd --mode mcp            MCP server mode — exposes tools over stdin/stdout

vscode-extension/         VS Code extension — chat participant (@gsd), sidebar dashboard, RPC integration
```

## Key Design Decisions

### DB-Authoritative Project State

GSD stores runtime workflow state in the project-root SQLite database. Auto mode derives phases, completion status, requirements, decisions, summaries, and hierarchy from that database, then renders markdown projections in `.gsd/` for human review, prompt context, and git-friendly history. No in-memory state survives across sessions. This enables crash recovery, multi-terminal steering, and session resumption while avoiding silent markdown re-imports during normal runtime.

#### Evidence-gated lifecycle shadow repair

Projects that crossed the canonical-lifecycle cutover can be partially adopted: the Milestone has a `workflow_item_lifecycles` row while older, already-complete Tasks or Slices only have legacy hierarchy status. A closeout must not trust that status alone, but it also must not leave a project permanently blocked with `missing canonical lifecycle authority` when durable completion evidence exists.

Before an adopted Milestone records a new validation receipt, validation runs a narrow forward repair over its descendants. The repair:

- accepts only legacy-complete items with a completion timestamp and durable summary evidence;
- additionally requires a passing verification result for Tasks;
- repairs Tasks before Slices so authority converges from the leaves upward;
- records every transition through the replay-safe `lifecycle.shadow.repair` Domain Operation;
- reports unsupported or conflicting shadows instead of forcing them; and
- leaves the strict Milestone completion guard unchanged.

Repair happens before validation, not during completion. Descendant lifecycle writes intentionally make older validation receipts stale, so the new pass receipt must be recorded after repair. If a project already has a pass receipt from before this repair, rerun Milestone validation once; do not edit SQLite or lifecycle projections manually.

Milestone queue position has one explicit file contract: `.gsd/QUEUE-ORDER.json`. `/gsd rethink` and `/gsd phase` use it as a durable reorder record, and state derivation mirrors that order into `milestones.sequence` before selecting the active milestone. Other generated `.gsd` artifacts remain projections unless an explicit import or recovery command reads them.

`db/domain-operation.ts` is the authoritative write seam for milestone, slice, and task planning, task and slice replanning, roadmap reassessment, task execution Attempts, Task recovery routing, host Technical Verdicts, verified Task publication, and Slice complete/cancel/reopen/reset. `executeDomainOperation()` owns a `BEGIN IMMEDIATE` transaction that revision- and Authority-Epoch-checks a request, reserves a project-scoped idempotency key, records provenance and ordered events, enqueues their outbox destinations and Projection Work, then advances authority with a compare-and-swap. Exact retries return the durable receipt without rerunning the mutation. `planning-domain-operation.ts` and `slice-lifecycle-domain-operation.ts` compose those guarantees with legacy hierarchy writes and lifecycle shadow comparison; `planning-invocation.ts` and `execution-invocation.ts` supply transport-stable private identity for Pi, internal auto-mode, and workflow MCP calls. Planning adopts canonical lifecycle heads while preserving the legacy public response contract, and removed pending work is retained as legacy `skipped` / canonical `cancelled` until explicitly reopened. Cleanup removes a stale PLAN file only when its current content still matches the writer-owned compatibility marker or PLAN artifact, preserving user-modified files. Execute-task units claim a canonical Attempt, settle exactly one immutable Result, route failures through bounded immutable Recovery Actions, record host verification evidence before publication, and publish completion only after a passing Technical Verdict for the current source revision. Slice operations validate the entire descendant hierarchy and commit one atomic cascade without erasing immutable execution history. Compatibility JSONL and Markdown are emitted after commit and cannot authorize lifecycle transitions; public callers preserve stale and duplicate projection diagnostics so a missing readable artifact cannot masquerade as a failed or fresh mutation. A resolved or dismissed user/external Blocker can continue only by being superseded by an agent-owned recovery route and a fresh lineage-linked Attempt. Milestone lifecycle commands, standalone UAT authority, and broader lifecycle routing have not fully cut over yet; the current schema version is owned by `SCHEMA_VERSION` in `db/engine.ts`, and Markdown remains projection output rather than workflow authority.

Historical Slice lifecycle replays additionally surface `superseded` with
`duplicate`; they never use current-success wording or repair a newer
projection.

### Semantic Shadow Evidence and Cutover Boundary

Milestone status remains a legacy-response read during M003. The shared status
executor reads legacy hierarchy and canonical lifecycle state in one read
transaction, compares them with the frozen lifecycle vocabulary, and emits a
response-neutral observation after the read. Native Pi captures the exact
project source revision lazily on the first status call in a turn and reuses it
for later status calls in that turn. The Claude workflow-MCP pump carries a
private token, captures the source revision lazily on its first status call,
and reuses that revision for later status calls in the pump. Capture or sink
failure never changes the public response, but it produces explicit, durable
loss accounting. No public tool argument or environment-provided hash can
supply source authority.

The S07 cutover dossier is a deterministic projection over two intentionally
different inputs: disposable `capstone_fixture` coverage and read-only
`live_project` database history. Random fixture identifiers are discarded when
the collector emits its normalized UAT artifact and appear only as stable
presence facts in the checked report. Exact live-project lifecycle identifiers
remain in the canonical-history plane. The report includes exact
mode/transport/classification counts, public-response and
capstone hashes, scoped repair lineage, live drift, compatibility witnesses,
the no-cutover gate, and the 4/4 authority baseline. It cannot authorize a
transition, repair state, or turn fixture coverage into production telemetry.

Candidate evidence names the exact source tree exercised before the generated
JSON exists. Post-generation checks and `verify:merge` are persisted through
database-backed UAT. The final source-bound Technical Verdict is created only
after rerunning the capstone from the exact merged commit; that database receipt
binds the merge commit, source-content revision, dossier hash, capstone hash,
and durable evidence. This two-phase protocol avoids a self-referential source
hash. S07 therefore proves convergence while remaining `NO_GO` for canonical
read authority until the explicitly deferred compatibility and lifecycle
surfaces are implemented and separately approved.

### Two-File Loader Pattern

`loader.ts` sets all environment variables with zero SDK imports, then dynamically imports `cli.ts` which does static SDK imports. This ensures `PI_PACKAGE_DIR` is set before any SDK code evaluates.

### `pkg/` Shim Directory

`PI_PACKAGE_DIR` points to `pkg/` (not project root) to avoid Pi's theme resolution colliding with GSD's `src/` directory. Contains only `piConfig` and theme assets.

### Managed Resource Sync

Bundled extensions, shared files, agents, and skills are synced to
`~/.gsd/agent/` on launch when the managed-resource manifest or content
fingerprint is stale. The `gsd-browser` skill is then overlaid from the
installed `@opengsd/gsd-browser` package, including package-relative support
files, so browser automation guidance tracks the browser package instead of a
duplicated Pi copy.

### Lazy Provider Loading

LLM provider SDKs (Anthropic, OpenAI, Google, etc.) are lazy-loaded on first use rather than imported at startup. This significantly reduces cold-start time — only the provider you actually connect to gets loaded.

### Fresh Session Per Unit

Every dispatch creates a new agent session. The LLM starts with a clean context window containing only the pre-inlined artifacts it needs. This prevents quality degradation from context accumulation.

### Workspace Roots, Not Ambient `cwd`

GSD workflow code must treat the active project/worktree as explicit state, not infer it from ambient `process.cwd()`. Prefer `AutoSession.scope`, `s.canonicalProjectRoot`, `s.basePath`, `s.originalBasePath`, hook `ctx.cwd`, or an explicit `basePath` parameter depending on the boundary. `cwd` remains valid as a subprocess/shell option in generic Pi tooling, but GSD identity, DB paths, workflow gates, auto-mode sessions, and dynamic tool execution should be rooted from explicit workflow state.

## Bundled Extensions

| Extension | What It Provides |
|-----------|-----------------|
| **GSD** | Core workflow engine — auto mode, state machine, commands, dashboard |
| **Browser Tools** | Browser Automation Contract adapter; browser-facing projects prefer the managed gsd-browser engine when proven, falling back to Playwright (ADR-037) |
| **Search the Web** | Brave Search, Tavily, or Jina page extraction |
| **Google Search** | Gemini-powered web search with AI-synthesized answers |
| **Context7** | Up-to-date library/framework documentation |
| **Background Shell** | Long-running process management with readiness detection |
| **Subagent** | Delegated tasks with isolated context windows |
| **Mac Tools** | macOS native app automation via Accessibility APIs |
| **MCP Client** | Native MCP server integration via @modelcontextprotocol/sdk |
| **Voice** | Real-time speech-to-text (macOS, Linux) |
| **Slash Commands** | Custom command creation |
| **Google CLI** | Local Google CLI providers (Gemini CLI, Antigravity) via external-cli auth — GSD never owns the OAuth flow |
| **Visual Brief** | Self-contained HTML briefs via `/gsd brief` (diagram, plan, diff, recap, table, slides) |
| **Async Jobs** | Background command execution with `async_bash`, `await_job`, `cancel_job` |
| **Remote Questions** | Discord, Slack, and Telegram integration for headless question routing |
| **TTSR** | Tool-triggered system rules — conditional context injection based on tool usage |
| **Universal Config** | Discovery of existing AI tool configurations (Claude Code, Cursor, Windsurf, etc.) |
| **AWS Auth** | AWS credential management and authentication |
| **Claude Code CLI** | Claude Code CLI integration |
| **cmux** | Context multiplexing for multi-session coordination |
| **GitHub Sync** | GitHub issue and PR synchronization |
| **Ollama** | Local Ollama model integration |
| **Shared** | Shared utilities across extensions |

## Bundled Agents

| Agent | Role |
|-------|------|
| **Scout** | Fast codebase recon — compressed context for handoff |
| **Researcher** | Web research — finds and synthesizes current information |
| **Worker** | General-purpose execution in an isolated context window |

## Native Engine

Performance-critical operations use a Rust N-API engine:

- **grep** — ripgrep-backed content search
- **glob** — gitignore-aware file discovery
- **ps** — cross-platform process tree management
- **highlight** — syntect-based syntax highlighting
- **ast** — structural code search via ast-grep
- **diff** — fuzzy text matching and unified diff generation
- **text** — ANSI-aware text measurement and wrapping
- **html** — HTML-to-Markdown conversion
- **image** — decode, encode, resize images
- **fd** — fuzzy file path discovery
- **clipboard** — native clipboard access
- **git** — libgit2-backed git read operations
- **parser** — GSD file parsing and frontmatter extraction

## Dispatch Pipeline

The auto-loop is a **linear** pipeline (`auto/loop.ts`), the replacement for the older recursive `dispatchNextUnit → resolveAgentEnd → dispatchNextUnit` chain. Each iteration flows through explicit stages (see [auto-mode.md](../user-docs/auto-mode.md) for the full description):

```
1. Pre-Dispatch  — derive state, run UOK guards, resolve model preferences, check captures
2. Dispatch      — build the prompt and execute the unit with the selected model
3. Post-Unit     — close out the unit, snapshot metrics, verify artifacts, persist state
4. Finalize      — milestone/slice completion and projection
5. Loop          — advance to the next unit
```

Model routing (complexity classification, budget pressure, routing history, capability scoring) is folded into the Pre-Dispatch stage via `auto-model-selection.ts` (`selectAndApplyModel`), not handled as standalone pipeline steps. Phase skipping (from a token profile) gates which unit types are dispatched.

## Key Modules

> The auto-mode kernel lives under the `auto/` subdirectory (`auto/orchestrator.ts`, `auto/loop.ts`, `auto/phases.ts`, `auto/pre-dispatch.ts`, `auto/dispatch.ts`, `auto/finalize.ts`, `auto/dispatch-key.ts`, and `workflow-kernel.ts`). Pre-dispatch invariants are enforced by the `uok/` deep module (`uok/flags.ts`, `uok/gate-runner.ts`) wired into the orchestrator. The flat `auto-*.ts` modules below are the older, surrounding surface.

| Module | Purpose |
|--------|---------|
| `auto.ts` | Auto-mode state machine and orchestration |
| `auto/session.ts` | `AutoSession` class — all mutable auto-mode state in one encapsulated instance |
| `auto-dispatch.ts` | Declarative dispatch table (phase → unit mapping) |
| `auto/dispatch-key.ts` | Completed-key checks, skip loop detection, key eviction |
| `auto-liveness-backstop.ts` | DB-persisted non-advancing outcome signatures, wedge records, and explicit acknowledgment |
| `auto-start.ts` | Fresh-start bootstrap — git/state init, crash lock detection, worktree setup |
| `auto-post-unit.ts` | Post-unit processing — commit, doctor, state rebuild, hooks |
| `auto-verification.ts` | Post-unit verification gate (lint/test/typecheck with auto-fix retries) |
| `auto-prompts.ts` | Prompt builders with inline level compression |
| `worktree-lifecycle.ts` | Worktree Lifecycle module — enter, exit, merge guard ordering, teardown, and session root mutation |
| `milestone-merge-transaction.ts` | Milestone Merge Transaction module — production adapter that wraps the legacy merge primitive behind the Lifecycle runner seam |
| `auto-worktree.ts` | Lower-level worktree helpers and inner milestone merge primitive consumed through the default transaction adapter |
| `auto-recovery.ts` | Expected artifact resolution, completed-key persistence, self-healing |
| `auto-timeout-recovery.ts` | Timed-out unit recovery and continuation |
| `auto-timers.ts` | Unit supervision — soft/idle/hard timeouts, continue-here monitor |
| `complexity-classifier.ts` | Unit complexity classification (light/standard/heavy) |
| `model-router.ts` | Dynamic model routing with cost-aware selection |
| `model-cost-table.ts` | Built-in per-model cost data for cross-provider comparison |
| `routing-history.ts` | Adaptive learning from routing outcomes |
| `captures.ts` | Fire-and-forget thought capture and triage classification |
| `triage-resolution.ts` | Capture resolution (inject, defer, replan, quick-task) |
| `visualizer-overlay.ts` | Workflow visualizer TUI overlay |
| `visualizer-data.ts` | Data loading for visualizer tabs, including active memory-store rows |
| `visualizer-views.ts` | Tab renderers (progress, timeline, deps, metrics, health, agent, changes, knowledge, memories, captures, export) |
| `metrics.ts` | Token and cost tracking ledger |
| `state.ts` | Compatibility barrel for GSD state derivation; runtime callers use the DB-backed `state/derive/` pipeline and only the private legacy helper parses markdown for tests/recovery |
| `state/derive/index.ts` | DB-backed `deriveState()` orchestrator, cache use, recent-decision loading, and DB-unavailable blocker state |
| `state/derive/from-db.ts` | Pure DB-to-`GSDState` projection, milestone lock scoping, active unit selection, and registry assembly |
| `state/derive/cache.ts` | State derivation cache and telemetry counters |
| `state/derive/db-open.ts` | Workflow DB open helpers, queue-order projection sync, and DB-unavailable state construction |
| `session-lock.ts` | OS-level exclusive session locking (proper-lockfile) |
| `crash-recovery.ts` | Lock file management for crash detection and recovery |
| `guidance.ts` | Single catalog mapping typed findings (recovery kinds, milestone blockers, doctor issue codes, crash unit classes) to user-facing remediation prose |
| `stop-notice.ts` | Single owner of the auto/step-mode stop/pause notice vocabulary — formatters and headless exit-code classifiers stay in lockstep |
| `preferences.ts` | Preference loading, merging, validation |
| `runtime-contract.ts` | Safe project-local runtime contract discovery, snapshot validation, and system-context rendering |
| `git-service.ts` | Git operations — commit, merge, worktree sync, completed-units cross-boundary sync |
| `unit-id.ts` | Centralized `parseUnitId()` — milestone/slice/task extraction from unit IDs |
| `error-utils.ts` | `getErrorMessage()` — unified error-to-string conversion |
| `roadmap-slices.ts` | Roadmap parser with prose fallback for LLM-generated variants |
| `memory-extractor.ts` | Extract reusable knowledge from session transcripts |
| `memory-store.ts` | Persistent memory store for cross-session knowledge |
| `queue-order.ts` | Durable milestone queue ordering contract and DB sequence mirroring |
| `db/domain-operation.ts` | Additive revision-checked Domain Operation transaction and durable replay receipt boundary |
| `db/lifecycle-shadow-comparison.ts` | Pure legacy-to-canonical lifecycle status normalization and semantic shadow comparison |
| `db/writers/lifecycle-commands.ts` | Transaction-bound lifecycle, Attempt, Result, replay-fence, and Kernel checkpoint primitives |
| `task-execution-domain-operation.ts` | Canonical execute-task claim, settlement, retry lineage, coordination dispatch linkage, and Kernel checkpoint advancement |
| `task-recovery-domain-operation.ts` | Immutable failure routing, bounded Recovery Actions, genuine Blockers, one-use abort resume, and fresh successor Attempt authorization |
| `task-verification-domain-operation.ts` | Host-owned Technical Verdict and verification evidence persistence for settled task Attempts |
| `task-completion-compatibility-adapter.ts` | Bridges `gsd_task_complete` into staged canonical Results and publishes verified task completion while preserving the legacy response contract |
| `slice-lifecycle-domain-operation.ts` | Replay-safe Slice complete/cancel/reopen receipts, stable command identity, semantic shadow evidence, and Projection Work |
| `db/writers/slice-lifecycle.ts` | Transaction-bound deep Slice guards and atomic descendant completion, cancellation, interruption, and full-redo mutation leaves |
| `tools/workflow-tool-executors.ts` | Shared Pi, workflow MCP, alias, and internal response boundary that preserves projection delivery diagnostics |
| `context-masker.ts` | Context masking for model routing optimization |
| `phase-anchor.ts` | Phase anchoring for dispatch pipeline |
| `slice-parallel-orchestrator.ts` | Slice-level parallelism with dependency-aware dispatch |
| `slice-parallel-eligibility.ts` | Slice parallel eligibility checks |
| `slice-parallel-conflict.ts` | Slice parallel conflict detection |
| `preferences-models.ts` | Model preferences configuration |
| `preferences-validation.ts` | Preferences validation |
| `preferences-types.ts` | Preferences type definitions |

## External Integrations

| Integration | Location | Description |
|-------------|----------|-------------|
| **Hermes Agent** | [`integrations/hermes/`](../../integrations/hermes/) | Open GSD plugin (`open-gsd-hermes`) — gateway slash commands, `pre_llm_call` project snapshots, background supervisor, cron headless, memory provider. Uses `gsd-mcp-server` for orchestration (not `gsd --mode mcp`). See [`hermes-integration-plan.md`](hermes-integration-plan.md). |
| **OpenClaw** | [`packages/openclaw-plugin/`](../../packages/openclaw-plugin/) | Native OpenClaw plugin (`open-gsd-openclaw`, npm `@opengsd/openclaw-plugin`) — `/gsd` chat commands and per-conversation project binding backed by `gsd read --json`; supervised `gsd headless` runs and notifications follow in the next phase. See the package README. |
