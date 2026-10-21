# CONTEXT

## Domain glossary

### Accepted ADR-046 vocabulary

These terms describe the accepted database-authoritative lifecycle contract in
[ADR-046](docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md). They
do not describe current runtime authority until the relevant cutover has
completed.

- **Project**: the complete body of work a user wants GSD to guide from discovery through delivery.
- **Milestone**: a durable, resumable stage of a Project, including discovery, research, planning, or delivery work.
- **Milestone Kind**: the purpose of a Milestone: discovery, research, requirements, roadmap, delivery, or remediation. Kind changes its expected outcomes, not its Lifecycle Status.
- **Slice**: a coherent outcome within a Milestone, decomposed into Tasks and independently verifiable.
- **Task**: the smallest planned piece of work whose completion produces evidence toward a Slice.
- **Planning Horizon**: an advisory start, end, or review window for long-running work. A missed horizon prompts review and reforecasting; it is not a timeout, readiness gate, or failure.
- **Open Question**: an unresolved choice scoped to work, carrying the current recommendation, rationale, alternatives, uncertainty, and a condition for revisiting it.
- **Interaction Kind**: the interaction contract for an Open Question or update: open, choice, clarification, recap, consent, or subjective UAT. Kind determines whether an answer is required and whether affected work may pause.
- **Nonblocking Recap**: a concise statement of decisions, assumptions, and uncertainty offered for correction while reversible work continues.
- **Consent**: explicit authorization for an irreversible, public, paid, destructive, or account-level action. Silence, cancellation, and timeout are never Consent.
- **Subjective UAT**: an acceptance check that requires a person's experiential judgment because tools cannot observe the result.
- **Work Checkpoint**: a durable summary of confirmed context, unresolved questions, evidence, and suggested next work at a meaningful resume boundary.
- **Lifecycle Status**: where a Milestone, Slice, or Task is in its durable progression: pending, ready, in progress, paused, completed, or cancelled.
- **Attempt Result**: the immutable result of one execution attempt: succeeded, failed, or interrupted. An Attempt Result does not by itself complete or cancel the work.
- **Requirement Disposition**: whether a requirement is unsatisfied, satisfied, or waived. Required Dependencies progress only from satisfied or explicitly waived requirements.
- **Required Dependency**: a relationship that prevents downstream work from progressing until the upstream work is complete or explicitly waived.
- **Waiver**: a recorded decision that releases a Required Dependency without claiming the upstream work was completed. Skipping work does not imply a Waiver.
- **Blocker**: a durable impediment attached to affected work, with an owner and resolution state. A Blocker is not a Lifecycle Status or an Attempt Result.
- **Database Authority**: the rule that workflow decisions and progress are derived only from canonical database state during normal operation. Missing database state is an error, not permission to infer truth from a Projection.
- **Domain Operation**: one validated, atomic change to workflow state and its durable history.
- **Projection**: a rebuildable human- or tool-readable representation of database state. A Projection never authorizes or reverses workflow progress.
- **Projection Work**: durable work to bring a Projection to a specific database revision, including retry and visible staleness.
- **Projection Worker**: the runtime module that observes and preserves external Projection bytes, renders database-backed Projections, and settles durable Projection Work without influencing workflow progression.
- **Import Preview**: a read-only candidate interpretation and exact diff of legacy material before it may affect Database Authority.
- **Import Application**: the explicitly authorized, backed-up, atomic application of an unchanged Import Preview.
- **Failure Observation**: an immutable record of one failed Attempt, its normalized cause and evidence, and the Recovery Action selected under a named policy version.
- **Recovery Action**: exactly one response to a Failure Observation: retry, repair, replan, remediate, clarify, pause, or abort.
- **Verification Evidence**: an immutable, fresh observation tied to an acceptance criterion, Attempt, source revision, and execution environment.
- **Technical Verdict**: a mechanically derived pass, fail, or inconclusive result from required Verification Evidence.
- **Human Acceptance**: an explicit disposition of a required Subjective UAT check, separate from the Technical Verdict.
- **Attempt**: one claimed execution of a Task or other executable work item against an observed database revision and lease token.
- **Lifecycle Kernel**: the sole durable sequencer of an Attempt through advance, execute, verify, route, and closeout. It owns stage progression and normalized outcomes, not the mechanics behind each stage.
- **Kernel Outcome**: the normalized result of one Lifecycle Kernel call: progressed, scheduled, needs interaction, waiting, closed, complete, or aborted.
- **Closeout Plan**: durable proof that canonical completion requirements are satisfied, plus the host effects that still require settlement.
- **Settlement Receipt**: the durable idempotency and completion record for one host effect from a Closeout Plan.
- **Compatibility Window**: the bounded period when legacy sources remain available through explicit import/export, never as competing runtime authority.
- **Authority Epoch**: the durable per-Project version of the authority contract. Advancing it prevents normal runtime from downgrading to an earlier authority source.
- **Shadow Comparison**: a read-only comparison of normalized decisions from old and replacement paths without changing lifecycle truth.
- **Restore Window**: the single bounded state after an Import Application while that Application remains the canonical operation head and before any later canonical operation or Cutover.
- **Cutover**: the recorded advancement of a Project to a new Authority Epoch after migration evidence passes, permanently closing its Restore Window.
- **Forward Repair**: correction of current canonical state while preserving accepted post-migration work, required after the Restore Window closes.
- **Removal Gate**: an evidence requirement that must pass before a legacy runtime path can be deleted.

### Current runtime vocabulary

- **Auto Orchestration**: runtime coordination of GSD auto-mode units from start to completion, including dispatch and stop/resume behavior; unit-execution failure recovery is classified by the Recovery Classification module.
- **Unit**: the smallest executable workflow step (e.g., plan slice, execute task, complete slice).
- **Unit progression**: movement from one Unit to the next under orchestration rules.
- **Phase (model-routing bucket)**: one of the coarse buckets a Unit maps to for model and reasoning selection — `research`, `planning`, `discuss`, `execution`, `execution_simple`, `completion`, `validation`, `subagent`, `uat`. Many Units collapse to one Phase (e.g. `research-milestone` and `research-slice` both route to `research`). Distinct from a Unit: a Unit is dispatched and executed; a Phase is only a routing key for which model/thinking applies. The `subagent` Phase is special — it is not dispatched as a Unit and is honored by prompt injection into the coordinator rather than by framework-applied model/thinking selection.
- **Phase Thinking Level**: the reasoning effort (`off`/`minimal`/`low`/`medium`/`high`/`xhigh`) resolved for a Phase, travelling with that Phase's model as a `(model, thinking)` pair. Distinct from the session-wide thinking level set via `/model`, which is only the fallback when no Phase-level value resolves. See `docs/dev/ADR-026-per-phase-thinking-level.md`.
- **Thinking Floor**: the rule that raises (never lowers) the applied thinking level for the `execute-task` Unit to a measured minimum (`medium`), because lower reasoning made the model stop planning edits and thrash on re-reads. The floor governs only the session/default resolution path; an explicitly configured Phase Thinking Level for execution bypasses it and is honored verbatim. Distinct from capability clamping, which lowers a level the resolved model cannot support.
- **Discussion Complete, Planning Pending**: a Milestone state where the discovery conversation has settled the Milestone context, but the Milestone has not yet been decomposed into planned Slices. Distinct from a reserved future Milestone.
- **Discuss Preload (Inlined Context)**: the guided-discuss context assembled from existing `.gsd/` artifacts (milestone ROADMAP, CONTEXT, RESEARCH, the Decisions Register, and prior-milestone SUMMARYs) and injected into the discuss prompt under a "preloaded — do not re-read these files" banner. It is string assembly from disk, not agent tool-calls, and is capped by the inline-context budget. It is the authoritative plan/decision context for guided discuss.
- **Preparation Snapshot**: a bounded, in-process codebase sample taken once per discuss dispatch (≤5 source files, ≤8KB each, ≤3000-char brief) describing current code reality (stack, structure, patterns) that the Discuss Preload's `.gsd` artifacts do not capture. Cheap (~milliseconds), not agent tool-calls. Complements, and never replaces, the Discuss Preload.
- **Grounded Questioning (no upfront survey)**: the invariant that guided-discuss Units ask questions grounded in the Discuss Preload plus the Preparation Snapshot, reading a specific file only when a question's answer hinges on it. They must NOT open-endedly survey the codebase (`rg`/`find`/`scout`) before the first question round — that contradicts the preload's "do not re-read" banner and reintroduces slow, repetitive upfront file review. Distinct from `resolve_library`/docs lookups for unfamiliar libraries, which remain permitted and bounded.
- **Grounded Research (no upfront survey)**: the auto-mode counterpart of Grounded Questioning for the `research-milestone` Unit. The research prompt preloads a bounded **Codebase Snapshot** (the same in-process `analyzeCodebase`/`formatCodebaseBrief` sample as the Preparation Snapshot) plus the milestone's **Project Classification** size signal, and the Unit grounds its research in those rather than running an open-ended `rg`/`find`/`scout` survey — reading a specific file only when a research question hinges on it. `resolve_library`/docs lookups stay permitted. See `docs/dev/ADR-029-preload-authoritative-auto-research-validate.md`.
- **Forwarded Validation Evidence**: the invariant that `validate-milestone`'s 3 parallel reviewers consume the evidence the orchestrator already preloaded (roadmap, per-slice SUMMARY/ASSESSMENT excerpts, requirements, verification classes) — embedded into each reviewer's `subagent` task — instead of independently re-reading those artifacts from disk. A reviewer reads a full file only on-demand when its excerpt is missing, truncated, or internally inconsistent. Preserves the independent-review architecture; removes the up-to-3× re-survey. See ADR-029.
- **Research Resume (lightweight)**: the rule that a re-dispatched `research-milestone` Unit inlines any durable output from a prior interrupted attempt — a partial RESEARCH artifact and/or the research phase anchor — under a "continue, do not redo" banner, and that research saves to RESEARCH incrementally so an interruption leaves a resumable draft. No mid-flight checkpoint state machine; the partial artifact and existing anchor are the durable signals. See ADR-029.
- **Post-Unit Hook**: a configured follow-up evaluation that runs after a Unit completes. It may be advisory or may act as a Post-Unit Gate.
- **Advisory Post-Unit Hook**: a Post-Unit Hook whose outcome may be recorded but is not required for Unit progression.
- **Post-Unit Gate**: a Post-Unit Hook whose successful completion is required before Unit progression continues.
- **Post-Unit Gate Enforcement**: the orchestration rule that decides whether a Post-Unit Gate permits, delays, or stops Unit progression.
- **Post-Unit Hook Outcome**: the recorded result of a Post-Unit Hook, including whether it allows progress or calls for rework or remediation.
- **Rework**: corrective work that revisits the Unit that produced an unsatisfactory result.
- **Remediation**: corrective workflow work scheduled beyond the triggering Unit to address a finding before downstream completion or progression.
- **Needs Attention**: a finding that requires human review before progression or completion continues.
- **First-visible response latency**: the user-perceived delay from submitting a prompt to seeing the first assistant output. Distinct from total completion time, Unit duration, or tool execution duration.
- **Closeout Boundary Stop**: the rule that a foreground run stops after the first task, slice, or milestone closeout boundary and leaves a durable final closeout surface visible in the live terminal, not merely scrollback or a cleared progress area.
- **Closeout Consistency Gate**: the preventive rule that finalization, merge, and all-complete stop paths require canonical DB state to prove the closeout is complete before they proceed. Distinct from State Reconciliation, which detects and repairs drift before dispatch.
- **Dispatch decision**: selection of the next Unit plus rationale and preconditions.
- **Recovery decision**: retry/escalate/abort choice after runtime failure.
- **Runtime persistence**: lock state, transition journal, and any persisted execution state required for safe resume.
- **DB snapshot persistence**: crash-safe persistence of a full SQLite image exported from `sql.js`, written as a same-directory temporary file and atomically renamed over the live database path.
- **Worktree Lifecycle**: creation, entry, teardown, and merge of an auto-mode worktree, including `s.basePath` mutation, `process.chdir` discipline, milestone lease coordination, and guarded milestone-merge preflight/postflight stash ordering.
- **Worktree State Projection**: directional flow of state files between the project root and the auto-worktree, where one side is authoritative per file class (e.g., project root is authoritative for `completed-units.json` after crash recovery; worktree is authoritative for in-flight artifacts).
- **Drift**: a state-shape mismatch between DB rows, disk artifacts, and in-memory state that has a known repair. Distinct from a `blocker`, which describes a terminal condition needing human attention or recovery escalation.
- **Drift catalog**: the discriminated union of typed workflow-state repair records and Projection observation records; the State Reconciliation Module handles only the workflow-state subset.
- **Tool Surface Readiness**: the Tool Contract module's runtime face — verification at SDK session init that the live tool surface (registered tools + MCP server statuses) covers the Unit's required workflow tools, aborting before the first model turn when the workflow server is terminal (`failed`/`needs-auth`/`disabled`), absent from the init surface, or still missing required tools (including while `pending`). A `pending` server with every required tool already on the init surface passes through. Stdio MCP probes (`testMcpServerConnection`, background warm) run with `GSD_MCP_PROBE=1` so they never register in or kill the live per-project PID registry entry that Claude Code owns. Complements the static pre-dispatch gate (`getWorkflowTransportSupportError`). See `docs/dev/ADR-036-tool-surface-readiness.md`.
- **`tool-unavailable` (Recovery kind)**: the Recovery Classification failure kind for a tool call that raced the workflow MCP server's registration (`No such tool available` / a Tool Surface Readiness abort). Transient — action `retry` with bounded attempts and its own exit reason; distinct from `tool-schema`/`tool-contract`, which are deterministic stops. The system retries; the model must never improvise a fallback around a missing workflow tool.
- **Workflow Bridge Warm-up**: the stdio MCP server's eager load + shape-check of the executor and write-gate bridges before connecting when workflow tools are enabled. A broken bridge fails the spawn with the actionable error (fail closed) instead of advertising tools that error on first call; a healthy spawn pre-pays the bridge import.

## State layer (filesystem-state cutover shipped)

The live project-state path is **database-authoritative**. `.gsd/gsd.db` decides
phase, registry, and progress. Markdown files under `.gsd/` (STATE.md, ROADMAP,
PLAN, SUMMARY, CONTEXT, and the rest of the inventory) are stamped **read-only
projections** of that database. They are not a fallback when the DB is missing:
an unavailable DB fails closed.

The frozen projection format, stamp, and reader contract live in
[`docs/dev/state-db-cutover-projection-contract.md`](docs/dev/state-db-cutover-projection-contract.md).
External readers should treat that document as the reference, not on-disk
markdown as authority.

Downgrade recovery uses the explicit backup-restore command:
`/gsd db restore-backup`. Canonical lifecycle *read* authority (public status
responses and the D005 shadow surface) remains deferred under M003; that
surface is still pinned by `gate:lifecycle-shadow-no-cutover`.

## Current pre-cutover architecture

> [ADR-046](docs/dev/ADR-046-database-authoritative-workflow-lifecycle.md)
> defines the accepted post-cutover direction. Filesystem-state authority has
> cut over (see **State layer** above). The entries below still describe
> runtime modules whose *canonical lifecycle* read surface remains on the
> pre-cutover D005 contract. Future-looking recommendations inherited from
> earlier ADRs are historical and do not override ADR-046.

- **Auto Orchestration module**: the module that owns the pre-dispatch invariant pipeline and lifecycle telemetry. It runs the resource-version guard and pre-dispatch health gate before reconciliation, then gates whether a Unit may dispatch (resource-version guard → pre-dispatch health gate → State Reconciliation → Dispatch decision → Tool Contract → Worktree Safety) and journals lifecycle transitions, but does not execute the Unit or own runtime recovery for Unit-execution failures. The auto-loop runs the Unit and calls Recovery Classification directly when it fails.
- **Dispatch adapter**: adapter behind the Dispatch seam.
- **Recovery adapter**: adapter behind the Recovery seam.
- **Worktree adapter**: adapter behind the Worktree seam.
- **Health adapter**: adapter behind the Health seam.
- **Runtime persistence adapter**: adapter behind the Runtime persistence seam.
- **Notification adapter**: adapter behind the Notification seam.
- **DB snapshot persistence module**: the deep module that owns `sql.js` snapshot write semantics, including temp-file naming, fsync, cleanup, and rename ordering.
- **State Reconciliation module**: module that runs `reconcileBeforeDispatch` before any Dispatch decision or worker spawn. Surfaces terminal blocker messages with structured `ReconciliationBlockerDetail` evidence and machine-actionable `DriftRecord[]`. Owns workflow-state drift detectors and idempotent repairs; Projection observation is intentionally outside pre-dispatch reconciliation. Throws `ReconciliationFailedError` to Recovery Classification on persistent or repair-failed drift. See `docs/dev/ADR-017-state-reconciliation-drift-driven.md`.
- **Projection Worker module**: module that owns full Projection rebuilds. It observes writer-owned hashes, quarantines exact external modeled bytes, renders from Database Authority, and advances current durable Projection Work through fenced delivery transitions. Projection errors remain visible and retryable without blocking otherwise valid workflow progression.
- **Worktree Safety module**: module that validates project root, worktree registration, lease ownership, and git health before a source-writing Unit runs.
- **Worktree Lifecycle module**: module that owns worktree create/enter/teardown/merge verbs, `s.basePath` mutation, `process.chdir` discipline, and guarded milestone-merge preflight/postflight stash ordering. Sole owner of these mutations across single-loop and parallel callers.
- **Worktree State Projection module**: module that owns the direction-and-rules of state file flow between project root and auto-worktree. Encodes the bug-hardened invariants (additive milestone copy, ASSESSMENT verdict overwrite, completed-units forward-sync, WAL/SHM cleanup) that `syncProjectRootToWorktree` and `syncStateToProjectRoot` carry today.
- **Worktree Placement module**: module (`worktree-placement.ts`) that owns WHERE a worktree physically lives — the forward direction (project root + name → path). Creation always targets the Canonical Worktree Container; resolution prefers an existing worktree's actual location. The reverse direction (path → project identity) is owned by `worktree-root.ts`'s `findWorktreeSegment`, the single marker-matching seam. See `docs/dev/ADR-031-worktree-placement.md`.
- **Canonical Worktree Container**: `<projectRoot>/.gsd-worktrees/` — a real directory sibling of `.gsd` that never crosses the external-state symlink, so the working copy stays at the project root. Requires its own `.gitignore` entry (a blanket `.gsd` pattern does not cover it).
- **Legacy Worktree Container**: `<projectRoot>/.gsd/worktrees/` — the pre-ADR-031 location, which crosses the `.gsd → ~/.gsd/projects/<hash>/` symlink and materialises worktrees in the home directory. Stays recognized for in-flight worktrees: scans, containment, and safety checks accept both containers; new worktrees are never created here.
- **External State Layout**: the shipped `.gsd → ~/.gsd/projects/<hash>/` symlink arrangement managed by `repo-identity.ts` (ADR-002's closure note said it didn't exist; ADR-031 amends the record). Env contracts: `GSD_PROJECT_ROOT` (worker-process root override), `GSD_STATE_DIR` (overrides `~/.gsd` as the external-state parent).
- **Workflow Event Ledger module**: module (`workflow-event-ledger.ts`) that owns workflow progress event storage and path selection. Appends from a Canonical Worktree Container resolve to the project-root ledger (`<projectRoot>/.gsd/event-log.jsonl`) so progress evidence survives hidden worktree teardown; legacy worktree-local shards remain readable for reconciliation and conflict resolution.
- **Workflow Event Vocabulary module**: module (`workflow-event-vocabulary.ts`) that owns workflow event command normalization and event-to-entity identity. Replay, conflict detection, and tests share this vocabulary instead of each switch normalizing hyphen/underscore aliases independently.
- **Audit Plane**: the unified audit surface made of append-only JSONL evidence plus indexed SQLite projections. Workflow journal events, UOK audit events, metrics, workflow logger events, and Workflow Event Ledger appends are projected into this plane when unified audit is enabled.
- **Recovery Classification module**: module that maps provider, tool, policy, git, worktree, runtime, and reconciliation-drift failures to a Recovery decision.
- **Tool Contract module**: module that keeps Unit prompts, tool schemas, tool policy, source-observation invariants, and pre-dispatch validation aligned.
- **Task Output Contract**: the concrete files a planned Task promises to create or overwrite. Distinct from task inputs, verification commands, and human-readable success outcomes.
- **Task Input**: a source-tree file a planned Task reads at execution time. Task Inputs are source files only — `.gsd/` planning artifacts (CONTEXT, ROADMAP, PLAN, SUMMARY) are never Task Inputs, in any path form. They are projections of DB state; the framework delivers their content to executors as composed, preloaded context, never as a file path to re-read.
- **Observation Budgeting**: context-management policy for what prior tool observations remain available to a Provider on later turns. Distinct from Display Truncation: Observation Budgeting changes model-visible context, while Display Truncation changes only the user-visible terminal surface.
- **Display Truncation**: rendering policy that hides or collapses tool output in the terminal without changing the underlying tool result available to the session.
- **File Observation**: a durable record that a source file was observed, including enough identity and coverage metadata to let a Unit reason from the file without repeatedly reconstructing it from line windows.
- **Whole-File Observation**: a File Observation whose source file is small enough to be retained as complete source context for the active Unit. The initial threshold is the read-tool cap: at most 50KB and at most 2000 lines. A narrow read of an under-threshold file auto-upgrades the File Observation to whole-file coverage in the background while preserving the requested tool result shape. After the Unit closes, the observation may degrade to metadata or summary for downstream Units.
- **Source-observation set**: the files whose observations are protected from lossy Observation Budgeting for the active Unit. Files enter the set when declared by the Unit plan or when successfully read under the Whole-File Observation threshold. For `execute-task`, plan-declared files means `task.files` plus concrete filesystem-looking entries from `task.inputs`, not `expectedOutput`. Plan-declared files are preloaded as Whole-File Observations before the Unit's first Provider turn when they fit the threshold; later read calls can add discovered files.
- **Source Context Block**: provider-payload context generated from the active Unit's Source-observation set. It is attached deliberately during Provider request assembly instead of relying on historical read-tool results to survive Observation Budgeting unchanged. Files that cannot become Whole-File Observations are represented with explicit unavailable statuses, such as missing, binary/image, over-threshold, glob, directory, or unresolved selector, unless existing pre-execution validation already blocks the Unit.
- **Provider**: a model execution path inside the Pi/GSD agent loop, selected for a session or Unit and subject to GSD's tool and capability contracts.
- **Claude Code Runtime**: the user-installed local `claude` executable/runtime that GSD delegates to when the `claude-code` Provider is active. Distinct from a Provider and from GSD's own process.
- **Claude Code Runtime Floor**: the minimum Claude Code Runtime version a GSD release is validated against. It is a compatibility floor, not a latest-version target.
- **External MCP Client**: an AI client outside the Pi/GSD agent loop that connects to project MCP servers and owns discovery, startup, and presentation of those servers.
- **Browser Automation Contract**: the GSD capability contract for real browser inspection, interaction, assertions, screenshots, and runtime evidence. The contract is distinct from the transport that exposes it. Declared in code by the **Browser Automation Contract module** (`shared/browser-contract.ts`) — the single source of the canonical `browser_*` tool vocabulary; run-uat presentation, the managed engine adapter, UAT policy predicates, and the browser-evidence regexes are derived views.
- **Browser Automation Engine**: the runtime implementation that satisfies the Browser Automation Contract for Pi/GSD Providers.
- **Browser Engine Resolution**: the runtime decision (`browser-tools/engine/selection.ts`) of which Browser Automation Engine serves the canonical `browser_*` tools, returned as a typed record (engine, source, reason). Explicit `GSD_BROWSER_ENGINE` wins verbatim; otherwise browser-facing projects prefer managed gsd-browser when the availability probe proves a CLI exists, verified by a session-start daemon connect that falls back to legacy Playwright with a recorded reason. The verified outcome is committed back into the resolution record (`commitBrowserEngineResolution`), so ambient readers — UAT guidance, re-warm-up, later sessions — see the engine actually registered, not the prediction. Non-browser-facing projects keep legacy Playwright. See `docs/dev/ADR-037-browser-engine-proven-resolution.md`.
- **DriftRecord**: typed, machine-actionable signal of a single drift instance. Discriminated union over drift kinds; carries the identifiers (e.g., milestone id, slice id) the matching repair needs.
- **Single Writer**: the only code permitted to issue write SQL (`INSERT`/`UPDATE`/`DELETE`/`REPLACE`) and raw transaction control against `.gsd/gsd.db`. Enforced structurally by `tests/single-writer-invariant.test.ts`. Historically one file (`gsd-db.ts`); the decision in force re-scopes it from a file to a directory layer (`db/writers/`). `unit-ownership.ts` is intentionally outside the invariant (separate `unit-claims.db`).
- **Single Writer Layer**: the `db/writers/` directory whose files collectively hold every write-SQL statement against the engine DB. The structural invariant is enforced on this directory, not on a single filename. Each file is one cohesive write subsystem (`cascades.ts`, `import-restore.ts`, `memory.ts`, `reconcile.ts`, `status.ts`); `status.ts` holds the `applyStatusTransition` chokepoint.
- **Query Module**: the read-only seam (`db/queries.ts`) holding the `SELECT`-only functions. Separate from the Single Writer so read-only callers (forensics, dashboard, doctor) depend on a read seam, not the write surface. Reads through the shared engine handle; it never opens its own connection and contains no write SQL.
- **Domain Write Operation**: an atomic, intent-named write exported by the Single Writer that owns its own `transaction()` and mutates the related rows of one logical change in a single commit (e.g. `reopenSliceCascade`, `resetSliceCascade`). Distinct from a write primitive (a single-row `insert`/`update`/`delete` wrapper). Callers state intent once instead of hand-rolling the transaction-plus-cascade; the atomicity rule lives in one place. The operation owns DB-row atomicity only — markdown re-projection, validation, and messaging remain in callers / `db-writer.ts`, per the projection-only invariant.
- **Hierarchy Status Cascade**: the recurring Domain Write Operation shape that transitions a milestone/slice/task subtree's status under one transaction (reopen, skip, complete, reset). Today re-derived independently in four callers and missing or mis-ordered in several others; the decision in force gives it a single home in the Single Writer Layer.
- **Drift repair**: idempotent function that resolves one workflow-state `DriftRecord`. Repairs are owned by the State Reconciliation Module's `drift/` folder; Projection observation records are consumed by the Projection Worker instead. Owning modules retain raw primitives (DB writes, file IO) but not the detection-and-repair composition.
- **Reconciliation pass**: one cycle of derive → detect drift → apply repairs → re-derive, performed by `reconcileBeforeDispatch`. Capped at 2 passes per call; loops only when the prior pass fully succeeded but new drift surfaces in the re-derive.
- **Phase Transition Invariant**: the rule that `advance()` asserts each derived Phase change is a legal edge in `STATE_TRANSITION_MATRIX` before recording a Dispatch decision. The matrix is an assertion, not a decision-maker — `deriveState` chooses the next Phase; the invariant only rejects illegal derived edges (e.g. `executing → complete` skipping validation). Edge-keyed (`isLegalEdge(from, to)`), evaluated on the reconciled snapshot *after* State Reconciliation, with `from` carried in-memory as the prior advance's derived Phase (reset on pause/stop, skipped when null). Self-edges (`from === to`) are trivially legal. An illegal edge that survives reconciliation is not repairable drift; the guard hands a typed failure to Recovery Classification as kind `illegal-transition`. Distinct from State Reconciliation, which repairs drift, and from Dispatch, which selects the next Unit.
- **`illegal-transition` (Recovery kind)**: the Recovery Classification failure kind for a derived Phase edge the Phase Transition Invariant rejected after reconciliation. Sits in the same taxonomy as `reconciliation-drift`; Recovery Classification owns the retry/escalate/abort decision, not the guard.
- **Status Transition Core**: the single `applyStatusTransition` chokepoint in `db/writers/status.ts` that every row-level status write funnels through. Owns the closed→open guard (generalized from milestone-only to task/slice/milestone), the completion-timestamp invariant, derived-cache invalidation, and the transition journal entry. The public `updateTaskStatus`/`updateSliceStatus`/`updateMilestoneStatus` functions are thin entity-typed faces in `gsd-db.ts` that delegate to it — they retain their signatures so existing callers gain the policy without churn. Operates at row altitude; distinct from the Phase Transition Invariant, which operates at Phase altitude.
- **Status vocabulary (`type Status`)**: the canonical typed set of entity statuses the domain speaks (e.g. `pending`, `in_progress`, `complete`, `skipped`, `blocked`, `active`, `parked`, `deferred`). The single source from which the closed-status predicates and the SQL terminal-status fragment are derived, replacing the prior ≥4 independent definitions. The DB column stays free-form `string` so legacy/imported values still load; the typed vocabulary governs the in-memory domain.
- **Status normalization (`toStatus`)**: the single parse seam `toStatus(raw: string): Status` where free-form DB strings enter the typed domain. Maps aliases to canonical (`done`/`closed` → `complete`, `planned` → `pending`) and quarantines unknown values rather than forcing a data migration. The Status Transition Core writes canonical, so the store converges to canonical over time without violating the DB-is-source-of-truth drift invariant.
- **Unit Closeout module**: the module (`unit-closeout.ts`) that owns the durable completion pipeline for a Unit behind one interface, `closeUnit(request)`. It keeps no result cache — re-entrancy is naturally safe because a re-fire commits an already-clean tree (`nothing-to-commit`) and notifications carry their own dedup window. Dispatch, retry policy, and Recovery decisions stay outside; `closeUnit` reports typed results and stays general over all boundaries. Today it carries the Interactive Closeout adapter's durable git subset; re-seating the auto pipeline behind it is the recorded next step. See `docs/dev/ADR-032-unit-closeout-seam.md`.
- **Auto Closeout adapter** (pending): the adapter at the Unit Closeout seam for the auto loop — the existing `postUnitPreVerification`/`postUnitPostVerification`/finalize choreography re-housed behind `closeUnit`. Not yet re-seated; see ADR-032 "Implementation status" for the routing constraint that shapes it.
- **Interactive Closeout adapter**: the adapter at the Unit Closeout seam for non-auto sessions. Attaches at the host's `tool_result` observation hook on the milestone closeout tool (`gsd_complete_milestone`) only, is a no-op while `isAutoActive()`, and runs the durable git subset (commit + Closeout Git Verdict). Scoped to milestone boundaries so task/slice completions never sweep a developer's unrelated working-tree changes. Exists so interactive completion stops silently bypassing `git.isolation`.
- **Closeout Git Verdict**: the typed record of what git state a closeout found and did (`committed`, `nothing-to-commit`, `milestone-branch`, `isolation-bypassed`, `commit-failed`). `isolation-bypassed` — a milestone boundary closed outside a milestone worktree/branch under non-`none` isolation — commits where the work sits and surfaces a Needs Attention notice instead of completing silently.
- **Unit Registry**: the single declarative table (`unit-registry.ts`) mapping each Unit type to its **Unit Descriptor**. The source from which `KNOWN_UNIT_TYPES`/`UnitType`, the tool contracts, the scope-class Sets, direct one-template prompt associations (`promptTemplate`), verified conditional prompt-template sets (`promptTemplates`), and the unit→phase chain are derived. Prompt composition and runtime selection conditions still live in `auto-prompts.ts`. Preserves the pre-registry asymmetries explicitly: `discuss-slice`/`execute-task-simple` are `kind: "variant"` (contracts and scope Sets, but excluded from `KNOWN_UNIT_TYPES`); `triage-captures`/`quick-task` carry `toolContract: null` and `phaseChain: null`. See `docs/dev/ADR-033-unit-type-registry.md`.
- **Unit Descriptor**: one Unit type's declaration — kind (primary/variant), scope class (`execute-task` / `section-close` / `standard`), Phase routing chain, direct prompt-template id or verified conditional template set when known, and tool surface contract. Prompt *composition* and runtime template selection logic stay in `auto-prompts.ts`; the descriptor declares verified associations only.
- **Publication module**: the module (`publication.ts`) that owns pushing a merged milestone and opening a draft PR (`auto_push`/`auto_pr`) behind `publishMilestone(request)`. Distinct from the merge verb: merge is a Worktree Lifecycle concern; publication needs only the resulting commit, a remote, and preferences. Publication failure is non-fatal to a completed local merge. See `docs/dev/ADR-034-milestone-merge-publication-split.md`.

- **Auto-mode Liveness Backstop**: the DB-persisted, interleaving-blind adjudicator for non-advancing auto-mode outcomes. It trips on the second identical guard/target/input hash, refuses re-entry until explicit `--resume-wedge` acknowledgment, and never repairs workflow state itself. It supersedes the deleted Dispatch History module and Rule 1 detector; see `docs/dev/ADR-047-auto-mode-liveness-backstop.md`.
- **Consent Question**: a question put to the user whose lifecycle (classification → pause gating → answer validation → cancellation) is owned by the Consent Question module (`consent-question.ts`). Kinds: `gate | consent | decision | informational`; **fail policy is a property of the kind** (informational is the only fail-open kind). Empty/missing `selected` on any fail-closed kind evaluates to `waiting` — never `answered` (#528). Pause promotion is classification-based, not unit-type-allowlist-based (#682). Gate kinds delegate structural validation to the consent-verdict leaf (`consent-verdict.ts`), the single verdict engine shared with the write gate. See `docs/dev/ADR-039-consent-question-module.md`.
- **Write-Gate State Adapter**: the seam (`WriteGateStateAdapter`) over write-gate state's two writers. Host adapter: in-memory + reconcile-on-read (verifications grow-only union; disk wins for pending/queue-phase; verified wins over pending). Child adapter: write-through, always-fresh read; selected via the child-spawn env. Snapshot writes are unconditional read-merge-write and carry a `writer` provenance tag (diagnostic only; the original epoch counter was write-only and removed); deferred approval gates are keyed per basePath. See `docs/dev/ADR-040-write-gate-two-adapter-seam.md`.
- **Engine Hook Contract**: the typed declaration (`engine-hook-contract.ts`) of which tool lifecycle hooks fire on every engine (`tool_execution_start/end` — universal) versus native-only (`tool_call`/`tool_result` — skipped by the external engine's `externalResult` short-circuit). Also the normalizer seam: `canonicalToolName` (MCP prefix strip) vs `canonicalWorkflowToolName` (strip + workflow alias resolution). Cross-engine enforcement must ride universal hooks. See `docs/dev/ADR-041-engine-hook-contract.md`.
- **Agent Turn**: one full agent response cycle — from the user's prompt through every tool round until `agent_end`. Distinct from a single tool round (one batch of tool calls and results) and from a multi-turn user task that spans several Agent Turns. The Tool Call Loop Guard's per-tool counters reset at Agent Turn boundaries.
- **Tool Call Loop Guard**: native-engine protection against runaway tool repetition within one Agent Turn. Two independent checks: an identical-args streak (same tool + same arguments repeated) and a per-tool-name cap regardless of arguments. A blocked call returns a model-facing error without executing the tool. Distinct from Recovery Classification's `tool-unavailable` retry path, which handles missing workflow tools rather than repetition.
- **Inherently Repeatable Tool**: a core session tool the loop guard treats as legitimately multi-called within one Agent Turn (e.g. read, bash, grep) and therefore assigns a higher per-tool cap than one-shot workflow tools. Distinct from tools that should fire at most a few times per turn (e.g. capture_thought, gsd_complete_milestone).
- **Diff-First Review Context**: the invariant for **source-code** review workflows (`/gsd code-review`, post-unit `code-review` hooks, thermos, grilling) — assemble context from `git diff` and a changed-file list first, then use `read` only for gaps the diff cannot answer, staying within the Tool Call Loop Guard's per-tool caps. Distinct from **Forwarded Validation Evidence** (`validate-milestone`), which is preload-first for `.gsd` planning artifacts, not git diff. Distinct from auto-mode **Source Context Block** preloading before `execute-task`.
- **Loop-Guard Block Response**: when the Tool Call Loop Guard blocks a tool call, the model must stop invoking tools for the remainder of that Agent Turn and respond to the user in text — not retry the blocked tool, pivot to one-shot tools like `capture_thought`, or substitute another tool for the same intent. Sharpened block copy and workflow skill guidance carry this rule; it is not a separate circuit breaker.

- **Dirty Projection Scope** (proposed): the `(milestoneId, sliceId?, taskId?)` scope a write marks as needing re-projection, recorded as part of the write itself. Paired with the **Projection Flush seam** — `flushProjections(basePath)` at pipeline exits — replacing the call-`render*`-after-every-mutation convention. Proposed, not in force; see `docs/dev/ADR-035-projection-dirty-scope.md` for the adoption trigger.

## Current decision in force

- Auto-mode architecture should deepen around a single Auto Orchestration module with interface:
  - `start(sessionContext)`
  - `advance()`
  - `resume()`
  - `stop(reason)`
  - `getStatus()`

See `docs/dev/ADR-014-auto-orchestration-deep-module.md`.

- Runtime invariants should deepen into four first-class modules: State Reconciliation, Worktree Safety, Recovery Classification, and Tool Contract.

See `docs/dev/ADR-015-runtime-invariant-modules.md`.

- Auto Orchestration `advance()` should call invariant modules explicitly in sequence rather than hiding the pre-dispatch pipeline inside the Dispatch adapter:
  - State Reconciliation
  - Dispatch decision
  - Tool Contract
  - Worktree Safety
  - Runtime persistence/journal

Dispatch remains responsible for selecting the next Unit from reconciled state. It should not own DB/disk repair, tool-policy compilation, or worktree root preparation.

- Worktree Safety should fail closed for source-writing Units under worktree isolation. A Unit whose Tool Contract permits writes outside `.gsd/**` must run in a proven milestone worktree root; it must not silently degrade to project-root source writes when the worktree is missing, empty, unregistered, on the wrong branch, or no longer lease-owned. Planning-only Units may continue to write `.gsd/**` artifacts at the project root.

- State Reconciliation should be drift-driven. The Module surfaces terminal `blockers: string[]` and machine-actionable `DriftRecord[]`. Each pre-dispatch and pre-spawn site calls `reconcileBeforeDispatch` (strict closure). Drift catalog includes sketch-flag, merge-state, stale-render, stale-worker, unregistered-milestone, roadmap-divergence, missing-completion-timestamp. Repairs are idempotent. Re-derive is capped at 2 passes (loops only on cascading-drift success path). Persistent or repair-failed drift throws `ReconciliationFailedError` to Recovery Classification (kind `reconciliation-drift`).

  See `docs/dev/ADR-017-state-reconciliation-drift-driven.md`.

- Thinking level should be configurable per Phase alongside the existing per-Phase model selection, resolved as a `(model, thinking)` pair across a hybrid config (`models.<phase>.thinking` and a separate `thinking:` block). The eight main-loop Phases apply it via `setThinkingLevel` at dispatch; the `subagent` Phase applies it via prompt injection + the subagent tool's `--thinking` subprocess flag (#508). The `execute-task` Thinking Floor protects only the session/default path; explicit config punches through. Unsupported levels are capability-clamped at dispatch, never sent to the provider.

  See `docs/dev/ADR-026-per-phase-thinking-level.md`.

- Active Units should retain source files through Source Context Blocks generated from File Observations, not by relying on old `read` tool results to survive Observation Budgeting. Tool Contract owns the source-observation invariant; Provider request assembly injects the active Unit's protected Source Context Block.

  See `docs/dev/ADR-027-source-observation-context-block.md`.

- The Single Writer should be a directory layer, not a single file. `gsd-db.ts` (1,441 lines, 66 exports) exploded into:
  - `db/engine.ts` — shared connection/handle state, transaction primitives (`transaction`, `readTransaction`), schema/migration control. The keystone every writer and the Query Module imports.
  - `db/writers/*.ts` — one cohesive write subsystem per file (`cascades.ts`, `import-restore.ts`, `memory.ts`, `reconcile.ts`, `status.ts`). Collectively the **Single Writer Layer**. `status.ts` owns the `applyStatusTransition` chokepoint.
  - `db/queries.ts` — the read-only **Query Module** (~45 `SELECT` functions), reading through the shared engine handle.
  - `gsd-db.ts` stays as the **barrel** re-exporting everything, so existing `from "../gsd-db.js"` imports are unchanged.

  The structural invariant (`tests/single-writer-invariant.test.ts`) re-scopes from a basename allowlist to: write SQL may appear only under `db/writers/`; `db/queries.ts` must contain no write SQL.

- The Single Writer should expose **Domain Write Operations** for multi-row changes, keeping single-row primitives public (hybrid). The **Hierarchy Status Cascade** family lives in `db/writers/cascades.ts`, each operation owning its own `transaction()`. Operations own DB-row atomicity only; projection/validation/messaging stay in callers.

  **Verified status (2026-06-09).** A first-pass exploratory catalog flagged several callers as non-atomic; direct inspection corrected most of them:
  - `resetSliceCascade` — **landed**. `undo`'s reset-slice was genuinely non-atomic (a per-task `updateTaskStatus` loop + a separate `updateSliceStatus`, each auto-committing); it now calls the atomic op.
  - `replan-slice`, `reassess-roadmap`, and `milestone-planning-persistence` now run through the authoritative Domain Operation boundary. Their legacy hierarchy writes, durable lifecycle adoption/transitions, event/outbox rows, Projection Work, and authority revision commit atomically; omitted adopted work is cancelled rather than deleted.
  - `state-reconciliation/drift/completion` `repairMissingCompletionTimestamp` — **single write per call** (mutually-exclusive milestone/slice/task branches), not a sequence. No fix needed.
  - `auto-recovery` `writeBlockerPlaceholder` — **deliberately best-effort** (each write independently try/caught during context-exhaustion recovery); must NOT become all-or-nothing.
  - `md-importer` `migrateHierarchyToDb` — genuinely unwrapped, but a one-shot migration whose writes are `INSERT OR IGNORE` / `ON CONFLICT` upserts, so a partial import self-corrects on re-run; a clean wrap is blocked by an interleaved `continue`. Low-priority follow-up.
  - **Locality fold (done).** The four hand-rolled-but-already-atomic cascades — `reopen-milestone`, `reopen-slice`, `skip-slice`, `complete-slice` — each independently re-derived the milestone/slice/task transaction-plus-cascade with guards inside the txn. They now call named ops (`reopenMilestoneCascade`, `reopenSliceCascade`, `skipSliceCascade`, `completeSliceCascade`) in `db/writers/cascades.ts`. Because their guards must stay inside the transaction, each op returns a **discriminated outcome** (structural guards in the writer; the caller maps the blocked reason to its verbatim user message). The cascade rule has one home; the four tools keep only projection/file-cleanup/event/cache logic.
  - **Open follow-ups:** (1) the `md-importer` per-milestone wrap (low priority, self-correcting); (2) `completeSliceCascade` reuses the complex `insertMilestone`/`insertSlice` primitives via a documented back-edge import from `gsd-db.ts` (hoisted bindings, runtime-only) — it dissolves when those hierarchy write primitives move into `db/writers/hierarchy.ts` (a further candidate-2 split not yet done).

  Takeaway: the `transaction()` discipline is used correctly almost everywhere; candidate 1's value is primarily **locality** (deduping the cascade rule into one home), with one real atomicity bug (now fixed).

- The state machine should be enforced at **two altitudes sharing one typed vocabulary**, with the Phase matrix as an assertion rather than a decision-maker:
  - **Phase altitude** — `advance()` runs the **Phase Transition Invariant**: `isLegalEdge(lastDerivedPhase, reconciledPhase)` is checked after State Reconciliation; `lastDerivedPhase` is in-memory (reset on start/resume/stop, skipped when null); self-edges are legal; the `illegal-transition` Recovery kind exists for enforcement. `deriveState` still chooses the Phase. **Ships in advisory mode (telemetry only)** because the matrix is a sparse hardening spec, not yet a validated legal-edge graph; enforcing would false-positive on real edges. Enforcement is a one-line flip once the matrix is expanded. See ADR-030 "Implementation status".
  - **Row altitude** — the **Status Transition Core** (`db/writers/status.ts`, `applyStatusTransition`) is the single chokepoint for status writes. The three `update*Status` functions become thin faces delegating to it; zero call-site churn. **Shipped behavior-neutral this pass:** the milestone closed→open guard is centralized here, but generalizing it to task/slice, write-normalization via `toStatus`, and the transition journal / cache-invalidation responsibilities are deferred (each behavior-sensitive). See ADR-030 "Implementation status".
  - **Vocabulary** — a canonical `type Status` plus `toStatus(raw): Status` (normalize-on-read, alias-mapping, quarantine unknowns) is the single source for the closed-status predicates and `TERMINAL_STATUS_SQL`; the DB column stays free-form and converges to canonical over time (no forced migration). First read-side SQL adoption has landed in the Query Module's active-row and task-count reads, so `closed`/`skipped` aliases no longer drift from `isClosedStatus` there.

  See `docs/dev/ADR-030-two-altitude-state-machine.md`.

- Foreground `/gsd next` and `/gsd auto` runs follow **Closeout Boundary Stop**: after the first durable task, slice, or milestone closeout boundary, the foreground terminal preserves the closeout transcript as the final visible surface instead of replacing it with a terminal roll-up widget. Headless runs may still emit durable terminal completion notifications/widgets for automation.

- Tool availability is enforced at **two altitudes**: the static pre-dispatch gate (launch-config discoverability, name membership) stays at dispatch sites, and **Tool Surface Readiness** verifies the live surface at SDK init before the first model turn. The startup race classifies as the transient `tool-unavailable` Recovery kind (bounded retry), the MCP server fails closed on a broken configured or discovered bridge (Workflow Bridge Warm-up), and per-Unit tool name lists are typed against the `CanonicalWorkflowToolName` literal union so drift fails typecheck. The fold of the four static-gate call sites into one helper is deferred.

  See `docs/dev/ADR-036-tool-surface-readiness.md`.

- Worktree placement deepens behind the **Worktree Placement module**: new worktrees are created at the Canonical Worktree Container (`<projectRoot>/.gsd-worktrees/<MID>`), the Legacy Worktree Container stays recognized for in-flight worktrees, and `findWorktreeSegment` (worktree-root.ts) is the only marker-matching implementation — new layouts are taught in exactly two places (placement forward, worktree-root reverse). ADR-002's "no external state directory exists" closure is amended: the External State Layout shipped.

  See `docs/dev/ADR-031-worktree-placement.md`.

- Unit completion should deepen behind the **Unit Closeout module** with two adapters: the Interactive Closeout adapter (shipped — host-side tool-observation trigger, no-op under `isAutoActive()`, fail-closed via the Closeout Git Verdict) and the Auto Closeout adapter (pending — the existing pipeline re-housed behind `closeUnit`, behaviour-neutral). Motivating failure: an interactive session under `git.isolation: worktree` completed a milestone with all source files untracked and no merge (2026-06-10).

  See `docs/dev/ADR-032-unit-closeout-seam.md`.

- "What a Unit type is" should be declared once, in the **Unit Registry**. The parallel tables (`KNOWN_UNIT_TYPES`, `UNIT_TOOL_CONTRACTS`, the scope Sets in `auto-unit-tool-scope.ts`, verified prompt-template associations, and the unit→phase switch in `preferences-models.ts`) become derived views with stable import paths (the `gsd-db.ts` barrel discipline). Parity is pinned by one table-driven registry test. The Tool Contract module (ADR-015) compiles from the registry. Remaining steps: fold `UNIT_MANIFESTS` data into descriptor rows (already type-enforced against the registry's `UnitType`) and migrate additional conditional/composite prompt-template associations only after their builder choices are verified.

  See `docs/dev/ADR-033-unit-type-registry.md`.

- The merge verb's full contract moves into Worktree Lifecycle. Publication is already split out, guarded milestone-merge preflight/postflight stash ordering now enters through the `exitMilestone(..., { merge: true, guardedMerge })` interface, and production wiring constructs the merge runner through the **Milestone Merge Transaction module**. The remaining step is relocating the merge core out of `auto-worktree.ts`. Push and PR creation stay in the **Publication module**, called after a successful milestone merge.

  See `docs/dev/ADR-034-milestone-merge-publication-split.md`.

- The Browser Automation Contract is declared once, in the **Browser Automation Contract module** (`shared/browser-contract.ts`): the canonical `browser_*` vocabulary, contract-membership/prefix predicates, and the evidence-signal subset. `RUN_UAT_BROWSER_TOOL_NAMES` (unit-registry), the managed adapter's surface, the UAT browser-tool predicate, and the browser-evidence regexes are derived views pinned by `tests/browser-contract.test.ts`. **Browser Engine Resolution** supersedes ADR-024's static legacy default: browser-facing projects prefer managed gsd-browser when the availability probe proves a CLI, verified by a session-start daemon connect with legacy-Playwright fallback and a recorded reason; explicit `GSD_BROWSER_ENGINE` is honored verbatim; non-browser-facing projects keep legacy Playwright.

  See `docs/dev/ADR-037-browser-engine-proven-resolution.md`.

- Auto-mode liveness is governed by `docs/dev/ADR-047-auto-mode-liveness-backstop.md`; it supersedes ADR-038's Dispatch History design.

- Consent questions deepen behind the **Consent Question module**: per-kind fail policy at one policy point (`evaluateAskUserQuestionsRound`), classification-based pause promotion, unified cancellation. `user-input-boundary.ts` is gone; importers use `consent-question.ts` directly. See `docs/dev/ADR-039-consent-question-module.md`.

- Write-gate state goes through the **Write-Gate State Adapter** seam (host reconcile-on-read / child write-through, read-merge-write snapshot persistence, per-basePath deferred gates). No file locking; temp+rename atomicity and the persistence opt-out are preserved. See `docs/dev/ADR-040-write-gate-two-adapter-seam.md`.

- Tool-hook guarantees are declared once in the **Engine Hook Contract**; decision reads of markdown projections are banned from dispatch/gate/completion paths (structural test `tests/parsers-legacy-importers.test.ts`; zero-importer / file-absence invariant after T020). Open follow-up from the contract work: nine `tool_call`-only guards have no universal-hook mirror and are silently dead under external engines — see ADR-041's consequences for the list. See `docs/dev/ADR-041-engine-hook-contract.md`.

- **Historical proposal, superseded before adoption:** ADR-035 proposed moving projection-after-write from an 11-site caller convention to Dirty Projection Scope marking at the write seam plus one Projection Flush seam. ADR-046 replaces that process-local design with durable, revision-aware Projection Work stored with the Domain Operation.

  See `docs/dev/ADR-035-projection-dirty-scope.md`.

## Current implementation snapshot (phase 1)

- `auto.ts` now wires a concrete Auto Orchestration module through `createWiredAutoOrchestrationModule(...)`.
- Session state now carries orchestration status via `AutoSession.orchestration`.
- Runtime snapshot exports orchestration telemetry (`orchestrationPhase`, `orchestrationTransitionCount`, `orchestrationLastTransitionAt`).
- Initial adapters are live for Dispatch, Health, and Runtime persistence seams.
- Main auto-loop dispatch is still the existing path; orchestration seam is integrated incrementally for lifecycle and observability.

## Triage synthesis (2026-05-05)

Recent triage showed repeated failures concentrated in orchestration state coherence, worktree hygiene, and tool-surface contracts.

### Common issue families

- **State drift between DB, disk artifacts, and in-memory loop state**
- Stale flags/rows repeatedly re-dispatch units (`is_sketch`, stale worker/lock, stale sequence/dependency rows)
- Disk artifacts exist but DB status lags or never reconciles (`PROJECT.md` milestone registration, completion timestamps, roadmap divergence)
- Recovery helpers exist but are not wired into dispatch/state derivation paths

- **Worktree lifecycle and path-root ambiguity**
- Units dispatch into ghost/invalid worktree roots (`.git` missing, fallback path-only creation, non-worktree git operations)
- Health checks are unit-specific instead of lifecycle-wide, allowing earlier units to write in invalid roots
- Worktree exit/merge decisions rely on brittle artifact signals instead of authoritative branch/commit state

- **Auto-loop recovery policy gaps**
- Deterministic and schema-validation failure modes are misclassified as generic provider failures
- Retry counters and stuck-loop controls are inconsistently keyed or reset across pause/resume boundaries
- Terminal guardrails are bypassed in side branches (e.g., complete-milestone placeholder behavior)

- **Tool contract mismatches**
- Prompt/tool/schema drift causes repeated invalid calls (`gsd_exec` runtime enums, closeout prompts vs policy constraints)
- Tool availability/surface inconsistencies under session boot/registration timing
- Validation happens too late (pre-exec catches issues that planner tools should reject upfront)

- **Provider/platform integration edge cases**
- Windows process/pipe semantics (`EOF`/abort timing) not normalized with POSIX assumptions
- Provider-specific metadata/capabilities not fully surfaced (reasoning support, context budgeting semantics, model override behavior)

- **Telemetry and diagnosis blind spots**
- Exit reasons collapse into `other`, masking repeatable failure classes
- Missing/imbalanced lifecycle events (`iteration-end`, dispatch/settlement gaps) weaken forensics and automated recovery decisions

### Priority review focus areas

- **Dispatch and state derivation invariants**
- Verify every state gate has a deterministic DB+disk reconciliation path before dispatch
- Ensure sketch/refine/plan transitions clear lifecycle flags atomically

- **Recovery and error classification**
- Add explicit classes for tool-schema overload, deterministic policy blocks, stale worker states, and worktree invalidity
- Ensure each class maps to an intentional action (`retry`, `pause with remediation`, `self-heal`, `stop`)

- **Worktree safety envelope**
- Enforce root validity checks for all source-writing unit types, not only `execute-task`
- Fail closed on worktree creation/registration errors; do not spawn workers into unresolved paths

- **Prompt-policy-tool alignment**
- Review every unit prompt against effective tools policy and schema enums
- Remove contradictory instructions (e.g., “fix failures” where policy forbids writes)

- **Migration and reconciliation**
- Add startup and pre-dispatch reconciliation for PROJECT/ROADMAP/DB drift
- Persist completion metadata consistently during recover/import flows

- **Observability completeness**
- Normalize exit reasons with dedicated buckets
- Guarantee dispatch lifecycle event pairs and settlement records for each unit attempt

### Deepening opportunities from triage

#### State Reconciliation module

- Files: `state.ts`, `gsd-db.ts`, `db-writer.ts`, `md-importer.ts`, `auto-recovery.ts`, PROJECT/ROADMAP parsers
- Problem: DB rows, markdown projections, and cached state are reconciled opportunistically. Helpers such as sketch-flag repair exist but are not wired into the state path, so bugs reappear as wrong Dispatch decisions.
- Refactor target: expose one pre-dispatch reconciliation Interface, e.g. `reconcileBeforeDispatch(basePath)`, that refreshes DB reads, repairs known workflow-state drift, returns blocking inconsistencies, and invalidates derived-state caches. Projection observation belongs to the Projection Worker so readable-file drift cannot block otherwise valid work.
- Leverage: Dispatch and recovery callers stop needing to know each artifact-specific repair rule.
- Locality: sketch flags, PROJECT milestone registration, ROADMAP sequence/dependency sync, completion timestamps, and artifact/DB mismatch handling move into one module.
- Test focus: call the Interface with DB+disk fixture states and assert the resulting state changes or blockers.

#### Worktree Safety module

- Files: `worktree-root.ts`, `worktree-safety.ts`, `worktree-placement.ts`, `auto/phases.ts`, `auto-worktree.ts`, `worktree-manager.ts`, parallel and slice-parallel orchestrators, git helpers
- Problem: worktree validity is checked in scattered, unit-specific places. Some paths build a worktree path string without proving it is registered, has `.git`, owns the lease, and matches `GSD_PROJECT_ROOT`.
- Refactor target: expose one Interface for source-writing Units, e.g. `prepareUnitRoot(unitType, unitId)`, that returns a valid root or a typed `worktree-invalid` Recovery decision.
- Leverage: every source-writing Unit receives the same root validation, lease fencing, and failure classification.
- Locality: ghost worktree, missing `.git`, stale worktree, branch/HEAD mismatch, and worktree cleanup logic are reviewed in one module.
- Test focus: invalid root, missing `.git`, stale path-only fallback, branch mismatch, and `GSD_PROJECT_ROOT` cases.

#### Recovery Classification module

- Files: `error-classifier.ts`, `bootstrap/agent-end-recovery.ts`, `auto-post-unit.ts`, `auto-timeout-recovery.ts`, `crash-recovery.ts`, `provider-error-pause.ts`
- Problem: recovery behavior is distributed across provider handlers, post-unit verification, timeout recovery, and crash cleanup. New deterministic failures often fall through as generic provider errors or `other` exit reasons.
- Refactor target: expose one failure taxonomy Interface, e.g. `classifyFailure(input) -> Recovery decision`, with explicit classes for tool schema, deterministic policy, stale worker, worktree invalid, provider quota, network, and verification drift.
- Leverage: callers ask for a Recovery decision instead of re-implementing retry/pause/stop semantics.
- Locality: bounded retries, pause messages, auto-resume behavior, exit reason normalization, and telemetry buckets are changed together.
- Test focus: table-driven classification and action tests covering every known triage failure family.

#### Tool Contract module

- Files: `unit-context-manifest.ts`, prompts under `prompts/`, `bootstrap/write-gate.ts`, `bootstrap/exec-tools.ts`, `workflow-tool-executors.ts`, `pre-execution-checks.ts`, `tools/plan-slice.ts`
- Problem: Unit prompts, tool schemas, and tool policy drift independently. The model can be instructed to do work the policy blocks, or call a schema value the tool rejects. Some validation waits until after planning artifacts are committed.
- Refactor target: compile a Unit Tool Contract before dispatch that includes prompt obligations, allowed tools, schema enum values, validation requirements, closeout tools, and source-observation invariants.
- Leverage: prompt authors and dispatch code get one reviewable contract per Unit type.
- Locality: prompt wording, policy gates, schema descriptions, and planner-time validation stop drifting across files.
- Test focus: prompt/policy/schema parity tests and planner tool validation tests for concrete task inputs.

#### Auto Orchestration adapter depth pass

- Files: `auto/orchestrator.ts`, `auto/contracts.ts`, `auto/phases.ts`, `auto.ts`, `auto-post-unit.ts`
- Problem: ADR-014 introduced adapter seams, but adapter boundaries can become too shallow if Dispatch hides unrelated pre-dispatch invariants. That would make `advance()` look simple while preserving the same cross-cutting state repair, tool-contract, and worktree-safety coupling behind a larger Dispatch adapter.
- Refactor target: keep `advance()` as the explicit lifecycle pipeline owner. It should call State Reconciliation before Dispatch, then call Tool Contract and Worktree Safety checks for the selected Unit before persisting/journaling the transition.
- Leverage: reviewers can inspect orchestration ordering in one place, tests can assert the invariant sequence directly, and each adapter stays deep around one concern.
- Locality: orchestration flow remains in Auto Orchestration; invariant modules own their own policy; Dispatch only selects the next Unit from reconciled state.
- Test focus: contract tests for `advance()` ordering, short-circuit behavior, idempotency for the same reconciled snapshot, and typed failure handoff to Recovery Classification.

### Refactor order

- Start with the **Auto Orchestration adapter depth pass** so `advance()` has an explicit invariant pipeline before individual modules are extracted underneath it.
- Then implement the **State Reconciliation module** and **Worktree Safety module**. They address the highest-cost loops and prevent invalid Dispatch decisions before a model turn is launched.
- Follow with the **Recovery Classification module** to normalize outcomes once invalid runtime states are no longer the dominant source of noise.
- Then add the **Tool Contract module** to prevent prompt/schema/policy drift from creating new recovery cases.

### Standing review checklist for this context

- Is DB state authoritative, and if yes, where is disk->DB reconciliation guaranteed?
- Can this unit dispatch into an invalid basePath/worktree and still mutate artifacts?
- Are retry/stuck-loop counters stable across pause/resume and keyed consistently by unit identity?
- Do prompt instructions require tools or writes blocked by the current policy?
- Can tool schema/documentation mismatch induce repeated invalid calls?
- Does each abnormal stop path produce a distinct reason code and actionable remediation?
