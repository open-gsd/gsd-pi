# gsd-pi Database Map

> Complete schema, access layer, migration history, and cross-reference to the prompt system.

---

## 1. Database Infrastructure Stack

```
gsd_* tool call (from LLM)
       │
       ▼
bootstrap/db-tools.ts          ← tool registration + input parsing
       │
       ▼
tools/workflow-tool-executors.ts  ← business logic
       │
       ├── validation reads (milestones, slices, tasks)
       │
       ▼
gsd-db.ts  ← compatibility barrel over the explicit single-writer allowlist
       │
       ├── db/engine.ts     ← connection/handle, schema/migrations, transaction primitives
       ├── db/domain-operation.ts
       │                    ← revision-checked authoritative transaction boundary
       ├── db/lifecycle-shadow-comparison.ts
       │                    ← pure legacy/canonical lifecycle comparison
       ├── db/writers/*.ts  ← the Single Writer Layer (one write subsystem per file)
       ├── db/{milestone-leases,unit-dispatches,auto-workers,runtime-kv}.ts
       │                    ← typed coordination/runtime writers
       ├── schema/migration helper modules
       │                    ← write-capable helpers are explicitly listed by
       │                       SCHEMA_DB_WRITER_FILES in single-writer-invariant.test.ts
       ├── memory-backfill.ts
       │                    ← allowlisted ADR migration/backfill helper
       ├── db/queries.ts    ← the Query Module (read-only SELECT wrappers)
       │
       ├── transaction()/immediateTransaction()
       │   (db/engine.ts via db-transaction.ts — depth counter, no nested BEGIN)
       │
       ▼
db-adapter.ts  ← normalized prepared-statement cache
       │
       ▼
db-provider.ts  ← node:sqlite
       │
       ▼
SQLite WAL  (.gsd/gsd.db)
       │
       ▼
After commit: regenerate markdown artifacts → write to disk → invalidate cache
```

**Connection scoping (db-connection-cache.ts):**

- Keyed by workspace `identityKey` (realpath of project root)
- Sibling worktrees share the same `.gsd/gsd.db` via SQLite WAL
- Only one connection is "active" at a time; others cached for fast re-activation
- Fresh, active, and cached opens verify the registered non-versioned schema invariants described under [ADR-047 liveness ledger](#adr-047-liveness-ledger-non-versioned) before reuse.
- A new open fails closed when the database is at a lower Authority Epoch than a Domain Operation receipt that the same process holds for that Project (the file was replaced by an older copy). The receipt is in process memory only, so a new process does not have this fence.
- On process exit: close without checkpointing; coordinated maintenance owns checkpoint and vacuum
- Before file-backed schema migrations, `db-migration-backup.ts` checkpoints WAL and copies the database being migrated to `.gsd/gsd.db.backup-vN`. An existing backup is never overwritten: later copies go to the first free `backup-vN.latest`, `backup-vN.latest-2`, ... name, and `/gsd db restore-backup` lists and accepts all of them. The copy must report the expected schema version and pass SQLite `quick_check`; checkpoint, copy, or validation failures warn and fail closed before migration DDL.

**Provider selection:**

1. `node:sqlite` (Node ≥ 22.18 built-in)
2. null → DB unavailable. Runtime `deriveState()` fails closed with an explicit blocker; markdown-only recovery is available only through explicit migration/recovery commands.

**Runtime state derivation:** `deriveState()` opens the existing workflow DB through `state/derive/db-open.ts`, projects rows in `state/derive/from-db.ts`, and returns a DB-unavailable blocker instead of implicitly deriving runtime state from markdown projections. Markdown hierarchy import is explicit recovery/migration behavior, not the normal read path. When `GSD_MILESTONE_LOCK` changes, auto-mode invalidates the short-lived derive cache because the cache key is only the base path while the DB projection is lock-filtered.

---

## 2. Schema Version History

The current version is defined by `SCHEMA_VERSION` in `db/engine.ts`; the
history below explains each migration without duplicating that live value.

| Version | What Changed |
|---------|-------------|
| V1 | schema_version + decisions + requirements tables |
| V2 | artifacts table |
| V3 | memories + memory_processed_units; FTS3 |
| V4 | decisions.made_by column |
| V5 | **Core hierarchy**: milestones, slices, tasks, verification_evidence |
| V6 | slices.full_summary_md, full_uat_md |
| V7 | slices.depends, demo; milestones.depends_on |
| V8 | Deep planning fields on milestones/slices/tasks; replan_history; assessments |
| V9 | sequence ordering on slices + tasks |
| V10 | slices.replan_triggered_at |
| V11 | tasks.full_plan_md; replan_history unique index |
| V12 | quality_gates table (broken DDL, fixed in V22) |
| V13 | Hot-path indexes; verification_evidence dedup index |
| V14 | slice_dependencies table |
| V15 | gate_runs, turn_git_transactions, audit_events, audit_turn_index |
| V16 | slices.is_sketch, sketch_scope (ADR-011); decisions.source |
| V17 | tasks escalation columns (blocker_source, escalation_*) |
| V18 | memory_sources; memories.scope + tags |
| V19 | memory_embeddings; memories_fts (FTS5 virtual table + triggers) |
| V20 | memory_relations |
| V21 | memories.structured_fields |
| V22 | quality_gates table repair (task_id constraint); scope column |
| V23 | milestones.sequence |
| V24 | **Auto-mode coordination**: workers, milestone_leases, unit_dispatches, cancellation_requests, command_queue |
| V25 | runtime_kv (soft state KV with global/worker/milestone scope) |
| V26 | milestone_commit_attributions |
| V27 | artifacts.content_hash (SHA-256 of full_content, computed on every insertArtifact) |
| V28 | memories.last_hit_at; incrementMemoryHitCount sets it; queryMemoriesRanked applies time-decay (1.0 → 0.7 floor over 90 days) |
| V29 | slices.target_repositories and tasks.target_repositories for multi-repository planning |
| V30 | rework_briefs and rework_brief_findings for structured task rework gates |
| V31 | **Additive canonical foundation**: singleton project authority with revision and Authority Epoch, workflow operation provenance/idempotency receipts, immutable revision-linked domain events, and a durable event outbox |
| V32 | **Additive lifecycle foundation**: canonical lifecycle state, fenced execution Attempts, immutable Attempt Results, user- or external-owned Blockers, authorized Waivers, and immutable Requirement Disposition history |
| V33 | **Additive guided-conversation foundation**: milestone context and advisory horizons, focused recommendation-first interactions, immutable verbatim Answers and correction-safe Decisions, dependency-targeted impacts, and restart-safe Work Checkpoints |
| V34 | **Additive recovery and evidence foundation**: immutable Failure Observations and Recovery Actions, immutable count budgets whose use is derived from linked Actions, versioned acceptance criteria, verdict-owned objective evidence, separate subjective Human Acceptance, and immutable remediation routing |
| V35 | **Additive projection, import, kernel, and closeout foundation**: durable per-target projection delivery, immutable import application receipts, restart-safe kernel checkpoint chains, versioned closeout plans with ordered effects, and success-only settlement receipts |
| V36 | **Attempt recovery fencing**: explicit settlement outcomes, replacement-worker lease identity, dispatch-scoped transitions, and the Kernel stage/state transition matrix |
| V37 | **Task cancellation authorization**: permits `task.cancel` to interrupt and settle an active Attempt without weakening ordinary lease fencing |
| V38 | **Verification-caused recovery**: permits a succeeded Result with a failed or inconclusive host Technical Verdict to cause a verification-stage Failure Observation |
| V39 | **Verification recovery current-head enforcement**: only the current non-superseded criterion and latest non-superseded evidence-backed failure verdict across tested source revisions may authorize recovery or a route-head successor claim, including routes retained from V38 |
| V40 | **Slice cancellation authorization**: permits `slice.cancel` to settle running descendant Attempts as interrupted while retaining Task cancellation's dispatch and lease fences |
| V41 | **Slice completion transition**: permits only Slice lifecycles to move directly from canonical `ready` to `completed`; Task and Milestone transition policy remains unchanged |
| V42 | **Milestone validation settlement**: permits `milestone.validate` to atomically settle its validation Attempt and record causally matching verdicts and evidence |
| V43 | **Milestone completion transition**: permits only a causally matching `milestone.complete` operation to move a Milestone lifecycle directly to canonical `completed` |
| V44 | **Hierarchy reopen authorization**: permits terminal-to-`ready` transitions only through the matching Task, Slice, or Milestone reopen operation for each hierarchy level |
| V45 | **Authority recovery receipts**: immutable, operation-bound receipts for Authority Cutover, pre-later-write Import Restore, and retained-Application Forward Repair |
| V46 | **State-DB cutover stamp**: records schema version 46 and stamps `PRAGMA application_id` and `PRAGMA user_version`; adds no tables |
| V47 | **Same-lease Attempt settlement** (#1740): extends the Attempt dispatch-scope transition trigger so a worker holding its own milestone lease can settle its own running Attempt after its coordination dispatch is gone; adds no tables |
| V48 | **Task execution-tool requirements**: adds `tasks.required_workflow_tools` as a non-null JSON-array column defaulting to `[]`; planning and replanning persist the workflow tools each Task expects its execution unit to expose |
| V51 | **Outbox as audit link**: drops `workflow_outbox` delivery columns (`attempt_count`, `claimed_by`, `claim_expires_at`, `delivered_at`, `last_error`) and `idx_workflow_outbox_pending`; `workflow_projection_work` is the only delivery queue |

---

## 3. Complete Table Inventory

### 3a. Core Hierarchy (V1, V5–V11)

#### `schema_version`

```
version    INTEGER NOT NULL
applied_at TEXT NOT NULL
```

Tracks which migrations have run.

---

#### `decisions`

```
seq            INTEGER PRIMARY KEY AUTOINCREMENT
id             TEXT NOT NULL UNIQUE
when_context   TEXT NOT NULL DEFAULT ''
scope          TEXT NOT NULL DEFAULT ''
decision       TEXT NOT NULL DEFAULT ''
choice         TEXT NOT NULL DEFAULT ''
rationale      TEXT NOT NULL DEFAULT ''
revisable      TEXT NOT NULL DEFAULT ''
made_by        TEXT NOT NULL DEFAULT 'agent'     ← V4
source         TEXT NOT NULL DEFAULT 'discussion' ← V16
superseded_by  TEXT DEFAULT NULL
```

- View: `active_decisions` WHERE superseded_by IS NULL

---

#### `requirements`

```
id                TEXT PRIMARY KEY
class             TEXT NOT NULL DEFAULT ''
status            TEXT NOT NULL DEFAULT ''
description       TEXT NOT NULL DEFAULT ''
why               TEXT NOT NULL DEFAULT ''
source            TEXT NOT NULL DEFAULT ''
primary_owner     TEXT NOT NULL DEFAULT ''
supporting_slices TEXT NOT NULL DEFAULT ''
validation        TEXT NOT NULL DEFAULT ''
notes             TEXT NOT NULL DEFAULT ''
full_content      TEXT NOT NULL DEFAULT ''
superseded_by     TEXT DEFAULT NULL
```

- View: `active_requirements` WHERE superseded_by IS NULL

---

#### `artifacts` (V2)

```
path          TEXT PRIMARY KEY
artifact_type TEXT NOT NULL DEFAULT ''
milestone_id  TEXT DEFAULT NULL
slice_id      TEXT DEFAULT NULL
task_id       TEXT DEFAULT NULL
full_content  TEXT NOT NULL DEFAULT ''
imported_at   TEXT NOT NULL DEFAULT ''
content_hash  TEXT DEFAULT NULL                  ← V27, SHA-256 of full_content
```

Stores markdown artifact content (PROJECT, REQUIREMENTS, SUMMARY, RESEARCH, CONTEXT, etc.).
V27: `content_hash` is computed and stored on every `insertArtifact` for integrity fingerprinting.

---

#### `milestones` (V5)

```
id                      TEXT PRIMARY KEY
title                   TEXT NOT NULL DEFAULT ''
status                  TEXT NOT NULL DEFAULT 'active'
depends_on              TEXT NOT NULL DEFAULT '[]'   ← JSON array, V7
created_at              TEXT NOT NULL DEFAULT ''
completed_at            TEXT DEFAULT NULL
vision                  TEXT NOT NULL DEFAULT ''           ← V8
success_criteria        TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
key_risks               TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
proof_strategy          TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
verification_contract   TEXT NOT NULL DEFAULT ''           ← V8
verification_integration TEXT NOT NULL DEFAULT ''          ← V8
verification_operational TEXT NOT NULL DEFAULT ''          ← V8
verification_uat        TEXT NOT NULL DEFAULT ''           ← V8
definition_of_done      TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
requirement_coverage    TEXT NOT NULL DEFAULT ''           ← V8
boundary_map_markdown   TEXT NOT NULL DEFAULT ''           ← V8
sequence                INTEGER DEFAULT 0                  ← V23
```

- Index: `idx_milestones_status` (status)
- Status values: `active`, `closed`, `queued`; `parked` after `/gsd park`; `skipped` for a discarded milestone, whose row stays as a tombstone that reserves the ID, is hidden from derived state and renders, and never satisfies a dependency
- `sequence` is the canonical DB ordering used to choose the next open milestone. The `/gsd queue` reorder writes it through the `milestone.reorder` Domain Operation and then renders `.gsd/QUEUE-ORDER.json` from the committed order. `/gsd rethink` reorders through the `gsd_milestone_reorder` tool, which runs the same operation. No path reads the file back into `milestones.sequence`.

---

#### `slices` (V5)

```
milestone_id         TEXT NOT NULL
id                   TEXT NOT NULL
title                TEXT NOT NULL DEFAULT ''
status               TEXT NOT NULL DEFAULT 'pending'
risk                 TEXT NOT NULL DEFAULT 'medium'
depends              TEXT NOT NULL DEFAULT '[]'         ← V7, JSON
demo                 TEXT NOT NULL DEFAULT ''           ← V7
created_at           TEXT NOT NULL DEFAULT ''
completed_at         TEXT DEFAULT NULL
full_summary_md      TEXT NOT NULL DEFAULT ''           ← V6
full_uat_md          TEXT NOT NULL DEFAULT ''           ← V6
goal                 TEXT NOT NULL DEFAULT ''           ← V8
success_criteria     TEXT NOT NULL DEFAULT ''           ← V8
proof_level          TEXT NOT NULL DEFAULT ''           ← V8
integration_closure  TEXT NOT NULL DEFAULT ''           ← V8
observability_impact TEXT NOT NULL DEFAULT ''           ← V8
target_repositories TEXT NOT NULL DEFAULT '[]'          ← V29, JSON
sequence             INTEGER DEFAULT 0                  ← V9
replan_triggered_at  TEXT DEFAULT NULL                  ← V10
is_sketch            INTEGER NOT NULL DEFAULT 0         ← V16
sketch_scope         TEXT NOT NULL DEFAULT ''           ← V16
PRIMARY KEY (milestone_id, id)
FOREIGN KEY milestone_id → milestones(id)
```

- Index: `idx_slices_active` (milestone_id, status)
- Status values: `pending`, `in_progress`, `complete`, `skipped` (legacy/imported `done` and `closed` are treated as closed aliases by `status-guards.ts`)

---

#### `tasks` (V5)

```
milestone_id                TEXT NOT NULL
slice_id                    TEXT NOT NULL
id                          TEXT NOT NULL
title                       TEXT NOT NULL DEFAULT ''
status                      TEXT NOT NULL DEFAULT 'pending'
one_liner                   TEXT NOT NULL DEFAULT ''
narrative                   TEXT NOT NULL DEFAULT ''
verification_result         TEXT NOT NULL DEFAULT ''
duration                    TEXT NOT NULL DEFAULT ''
completed_at                TEXT DEFAULT NULL
blocker_discovered          INTEGER DEFAULT 0
blocker_source              TEXT NOT NULL DEFAULT ''           ← V17
escalation_pending          INTEGER NOT NULL DEFAULT 0         ← V17
escalation_awaiting_review  INTEGER NOT NULL DEFAULT 0         ← V17
escalation_artifact_path    TEXT DEFAULT NULL                  ← V17
escalation_override_applied_at TEXT DEFAULT NULL              ← V17
deviations                  TEXT NOT NULL DEFAULT ''
known_issues                TEXT NOT NULL DEFAULT ''
key_files                   TEXT NOT NULL DEFAULT '[]'         ← JSON
key_decisions               TEXT NOT NULL DEFAULT '[]'         ← JSON
full_summary_md             TEXT NOT NULL DEFAULT ''
description                 TEXT NOT NULL DEFAULT ''           ← V8
estimate                    TEXT NOT NULL DEFAULT ''           ← V8
files                       TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
verify                      TEXT NOT NULL DEFAULT ''           ← V8
inputs                      TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
expected_output             TEXT NOT NULL DEFAULT '[]'         ← V8, JSON
required_workflow_tools     TEXT NOT NULL DEFAULT '[]'         ← V48, JSON
observability_impact        TEXT NOT NULL DEFAULT ''           ← V8
full_plan_md                TEXT NOT NULL DEFAULT ''           ← V11
target_repositories         TEXT NOT NULL DEFAULT '[]'         ← V29, JSON
sequence                    INTEGER DEFAULT 0                  ← V9
PRIMARY KEY (milestone_id, slice_id, id)
FOREIGN KEY (milestone_id, slice_id) → slices(milestone_id, id)
```

- Indexes: `idx_tasks_active` (milestone_id, slice_id, status), `idx_tasks_escalation_pending`
- Status values: `pending`, `in_progress`, `complete`, `skipped`, `blocked` (legacy/imported `done` and `closed` are treated as complete aliases; `insertTask` stamps `completed_at` for `complete`/`done`/`closed`, but not `skipped`)

---

#### `verification_evidence` (V5)

```
id           INTEGER PRIMARY KEY AUTOINCREMENT
task_id      TEXT NOT NULL DEFAULT ''
slice_id     TEXT NOT NULL DEFAULT ''
milestone_id TEXT NOT NULL DEFAULT ''
command      TEXT NOT NULL DEFAULT ''
exit_code    INTEGER DEFAULT 0
verdict      TEXT NOT NULL DEFAULT ''
duration_ms  INTEGER DEFAULT 0
created_at   TEXT NOT NULL DEFAULT ''
attempt_ref  TEXT NOT NULL DEFAULT ''   ← Attempt that made the claim (non-versioned); '' when no Attempt made it
FOREIGN KEY (milestone_id, slice_id, task_id) → tasks
```

- Indexes: `idx_verification_evidence_task`, unique dedup index (V13) on
  `(task_id, slice_id, milestone_id, attempt_ref, command, verdict)`
- `attempt_ref` and the dedup index with it are the non-versioned required
  schema feature `verification-evidence-attempt`. Host verification reads only
  the claims of the Attempt under verification; the claims of an earlier
  Attempt stay stored.

---

#### `replan_history` (V8)

```
id                       INTEGER PRIMARY KEY AUTOINCREMENT
milestone_id             TEXT NOT NULL
slice_id                 TEXT DEFAULT NULL
task_id                  TEXT DEFAULT NULL
summary                  TEXT NOT NULL DEFAULT ''
previous_artifact_path   TEXT DEFAULT NULL
replacement_artifact_path TEXT DEFAULT NULL
created_at               TEXT NOT NULL DEFAULT ''
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `rework_briefs` (V30)

```
id            TEXT PRIMARY KEY
milestone_id  TEXT NOT NULL DEFAULT ''
slice_id      TEXT NOT NULL DEFAULT ''
task_id       TEXT NOT NULL DEFAULT ''
created_at    TEXT NOT NULL DEFAULT ''
updated_at    TEXT NOT NULL DEFAULT ''
```

- Index: `idx_rework_briefs_task` (milestone_id, slice_id, task_id)
- Default ID when omitted by the caller: `RB-<milestoneId>-<sliceId>-<taskId>`

---

#### `rework_brief_findings` (V30)

```
brief_id              TEXT NOT NULL
finding_id            TEXT NOT NULL
severity              TEXT NOT NULL DEFAULT 'blocking'
description           TEXT NOT NULL DEFAULT ''
required_fix          TEXT NOT NULL DEFAULT ''
verification_commands TEXT NOT NULL DEFAULT '[]'
status                TEXT NOT NULL DEFAULT 'pending'
evidence              TEXT NOT NULL DEFAULT ''
decision_ref          TEXT NOT NULL DEFAULT ''
updated_at            TEXT NOT NULL DEFAULT ''
PRIMARY KEY (brief_id, finding_id)
FOREIGN KEY brief_id → rework_briefs(id)
```

- Index: `idx_rework_findings_status` (brief_id, severity, status)
- `severity = 'blocking'` and `status = 'pending'` gates `gsd_task_complete` for the linked task until the finding is resolved or explicitly deferred with an override.

---

#### `assessments` (V8)

```
path         TEXT PRIMARY KEY
milestone_id TEXT NOT NULL DEFAULT ''
slice_id     TEXT DEFAULT NULL
task_id      TEXT DEFAULT NULL
status       TEXT NOT NULL DEFAULT ''
scope        TEXT NOT NULL DEFAULT ''
full_content TEXT NOT NULL DEFAULT ''
created_at   TEXT NOT NULL DEFAULT ''
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `quality_gates` (V12, repaired V22)

```
milestone_id TEXT NOT NULL
slice_id     TEXT NOT NULL
gate_id      TEXT NOT NULL
scope        TEXT NOT NULL DEFAULT 'slice'   ← V22
task_id      TEXT NOT NULL DEFAULT ''        ← V22 (was broken)
status       TEXT NOT NULL DEFAULT 'pending'
verdict      TEXT NOT NULL DEFAULT ''
rationale    TEXT NOT NULL DEFAULT ''
findings     TEXT NOT NULL DEFAULT ''
evaluated_at TEXT DEFAULT NULL
PRIMARY KEY (milestone_id, slice_id, gate_id, task_id)
FOREIGN KEY (milestone_id, slice_id) → slices
```

- Index: `idx_quality_gates_pending`

---

#### `slice_dependencies` (V14)

```
milestone_id        TEXT NOT NULL
slice_id            TEXT NOT NULL
depends_on_slice_id TEXT NOT NULL
PRIMARY KEY (milestone_id, slice_id, depends_on_slice_id)
FOREIGN KEY (milestone_id, slice_id) → slices
FOREIGN KEY (milestone_id, depends_on_slice_id) → slices
```

- Index: `idx_slice_deps_target`
- Maintained from the milestone `ROADMAP.md` slice `depends` declarations. The
  ADR-017 `roadmap-divergence` reconciliation repair re-imports the roadmap as
  the source of truth, then refreshes this junction table so dependency checks
  see the same edges as the markdown projection.

---

#### `gate_runs` (V15)

```
id            INTEGER PRIMARY KEY AUTOINCREMENT
trace_id      TEXT NOT NULL
turn_id       TEXT NOT NULL
gate_id       TEXT NOT NULL
gate_type     TEXT NOT NULL DEFAULT ''
unit_type     TEXT DEFAULT NULL
unit_id       TEXT DEFAULT NULL
milestone_id  TEXT DEFAULT NULL
slice_id      TEXT DEFAULT NULL
task_id       TEXT DEFAULT NULL
outcome       TEXT NOT NULL DEFAULT 'pass'
failure_class TEXT NOT NULL DEFAULT 'none'
rationale     TEXT NOT NULL DEFAULT ''
findings      TEXT NOT NULL DEFAULT ''
attempt       INTEGER NOT NULL DEFAULT 1
max_attempts  INTEGER NOT NULL DEFAULT 1
retryable     INTEGER NOT NULL DEFAULT 0
evaluated_at  TEXT NOT NULL DEFAULT ''
```

- Indexes: `idx_gate_runs_turn`, `idx_gate_runs_lookup`

---

#### `turn_git_transactions` (V15)

```
trace_id      TEXT NOT NULL
turn_id       TEXT NOT NULL
unit_type     TEXT DEFAULT NULL
unit_id       TEXT DEFAULT NULL
stage         TEXT NOT NULL DEFAULT 'turn-start'
action        TEXT NOT NULL DEFAULT 'status-only'
push          INTEGER NOT NULL DEFAULT 0
status        TEXT NOT NULL DEFAULT 'ok'
error         TEXT DEFAULT NULL
metadata_json TEXT NOT NULL DEFAULT '{}'
updated_at    TEXT NOT NULL DEFAULT ''
PRIMARY KEY (trace_id, turn_id, stage)
```

- Index: `idx_turn_git_tx_turn`

---

#### `audit_events` (V15)

```
event_id     TEXT PRIMARY KEY
trace_id     TEXT NOT NULL
turn_id      TEXT DEFAULT NULL
caused_by    TEXT DEFAULT NULL
category     TEXT NOT NULL
type         TEXT NOT NULL
ts           TEXT NOT NULL
payload_json TEXT NOT NULL DEFAULT '{}'
```

- Indexes: `idx_audit_events_trace`, `idx_audit_events_turn`

---

#### `audit_turn_index` (V15)

```
trace_id    TEXT NOT NULL
turn_id     TEXT NOT NULL
first_ts    TEXT NOT NULL
last_ts     TEXT NOT NULL
event_count INTEGER NOT NULL DEFAULT 0
PRIMARY KEY (trace_id, turn_id)
```

---

#### `milestone_commit_attributions` (V26)

```
commit_sha   TEXT NOT NULL
milestone_id TEXT NOT NULL
slice_id     TEXT DEFAULT NULL
task_id      TEXT DEFAULT NULL
source       TEXT NOT NULL DEFAULT 'recorded'
confidence   REAL NOT NULL DEFAULT 1.0
files_json   TEXT NOT NULL DEFAULT '[]'
created_at   TEXT NOT NULL DEFAULT ''
PRIMARY KEY (commit_sha, milestone_id)
```

- Index: `idx_milestone_commit_attr_milestone`

---

### 3b. Memory & Knowledge Layer (V3, V18–V21)

#### `memories` (V3)

```
seq               INTEGER PRIMARY KEY AUTOINCREMENT
id                TEXT NOT NULL UNIQUE
category          TEXT NOT NULL
content           TEXT NOT NULL
confidence        REAL NOT NULL DEFAULT 0.8
source_unit_type  TEXT
source_unit_id    TEXT
created_at        TEXT NOT NULL
updated_at        TEXT NOT NULL
superseded_by     TEXT DEFAULT NULL
hit_count         INTEGER NOT NULL DEFAULT 0
scope             TEXT NOT NULL DEFAULT 'project'   ← V18
tags              TEXT NOT NULL DEFAULT '[]'         ← V18, JSON
structured_fields TEXT DEFAULT NULL                  ← V21, JSON
last_hit_at       TEXT DEFAULT NULL                  ← V28, set by incrementMemoryHitCount
```

- Index: `idx_memories_active` (superseded_by), `idx_memories_scope` (scope)
- View: `active_memories` WHERE superseded_by IS NULL
- FTS: `memories_fts` virtual table (V19)
- V28: `queryMemoriesRanked` applies `memoryDecayFactor(last_hit_at)` — linear decay from 1.0 (≤0 days) to 0.7 floor (≥90 days)

---

#### `memory_processed_units` (V3)

```
unit_key     TEXT PRIMARY KEY
activity_file TEXT
processed_at TEXT NOT NULL
```

---

#### `memory_sources` (V18)

```
id           TEXT PRIMARY KEY
kind         TEXT NOT NULL
uri          TEXT
title        TEXT
content      TEXT NOT NULL
content_hash TEXT NOT NULL UNIQUE
imported_at  TEXT NOT NULL
scope        TEXT NOT NULL DEFAULT 'project'
tags         TEXT NOT NULL DEFAULT '[]'
```

- Indexes: `idx_memory_sources_kind`, `idx_memory_sources_scope`

---

#### `memory_embeddings` (V19)

```
memory_id  TEXT PRIMARY KEY
model      TEXT NOT NULL
dim        INTEGER NOT NULL
vector     BLOB NOT NULL
updated_at TEXT NOT NULL
```

---

#### `memory_relations` (V20)

```
from_id    TEXT NOT NULL
to_id      TEXT NOT NULL
rel        TEXT NOT NULL
confidence REAL NOT NULL DEFAULT 0.8
created_at TEXT NOT NULL
PRIMARY KEY (from_id, to_id, rel)
```

- Indexes: `idx_memory_relations_from`, `idx_memory_relations_to`

---

#### `memories_fts` (V19, Virtual)

```
FTS5 virtual table
Content: memories.content
Tokenizer: porter unicode61
Triggers: memories_ai, memories_ad, memories_au (keep in sync)
Fallback: LIKE scan if FTS5 unavailable
```

---

### 3c. Auto-Mode Coordination (V24 and ADR-047)

#### `workers`

```
worker_id              TEXT PRIMARY KEY
host                   TEXT NOT NULL
pid                    INTEGER NOT NULL
started_at             TEXT NOT NULL
version                TEXT NOT NULL
last_heartbeat_at      TEXT NOT NULL
status                 TEXT NOT NULL
project_root_realpath  TEXT NOT NULL
```

---

#### `milestone_leases`

```
milestone_id   TEXT PRIMARY KEY
worker_id      TEXT NOT NULL
fencing_token  INTEGER NOT NULL
acquired_at    TEXT NOT NULL
expires_at     TEXT NOT NULL
status         TEXT NOT NULL
FOREIGN KEY worker_id → workers(worker_id)
FOREIGN KEY milestone_id → milestones(id)
```

---

#### `unit_dispatches`

```
id                      INTEGER PRIMARY KEY AUTOINCREMENT
trace_id                TEXT NOT NULL
turn_id                 TEXT
worker_id               TEXT NOT NULL
milestone_lease_token   INTEGER NOT NULL
milestone_id            TEXT NOT NULL
slice_id                TEXT
task_id                 TEXT
unit_type               TEXT NOT NULL
unit_id                 TEXT NOT NULL
status                  TEXT NOT NULL
attempt_n               INTEGER NOT NULL DEFAULT 1
started_at              TEXT NOT NULL
ended_at                TEXT
exit_reason             TEXT
error_summary           TEXT
verification_evidence_id INTEGER
next_run_at             TEXT
retry_after_ms          INTEGER
max_attempts            INTEGER NOT NULL DEFAULT 3
last_error_code         TEXT
last_error_at           TEXT
FOREIGN KEY worker_id → workers
FOREIGN KEY verification_evidence_id → verification_evidence(id)
```

- Indexes: `idx_unit_dispatches_active`, `idx_unit_dispatches_trace`
- Unique partial index: `idx_unit_dispatches_active_per_unit` ON unit_id WHERE status IN ('claimed','running') — prevents double-claim

---

#### `cancellation_requests`

```
id              INTEGER PRIMARY KEY AUTOINCREMENT
requested_at    TEXT NOT NULL
requested_by    TEXT NOT NULL
scope           TEXT NOT NULL
scope_id        TEXT NOT NULL
dispatch_id     INTEGER
reason          TEXT NOT NULL
status          TEXT NOT NULL
acked_at        TEXT
acked_worker_id TEXT
FOREIGN KEY dispatch_id → unit_dispatches(id)
FOREIGN KEY acked_worker_id → workers(worker_id)
```

---

#### `command_queue`

```
id           INTEGER PRIMARY KEY AUTOINCREMENT
target_worker TEXT     ← NULL = broadcast to all workers
command      TEXT NOT NULL
args_json    TEXT NOT NULL DEFAULT '{}'
enqueued_at  TEXT NOT NULL
claimed_at   TEXT
claimed_by   TEXT
completed_at TEXT
result_json  TEXT
```

- Index: `idx_command_queue_pending` (target_worker, claimed_at)
- `db/command-queue.ts` writes and takes the rows. The parallel coordinator queues `pause`, `resume` and `stop` with `target_worker` set to the milestone ID of the worker (`session-status-io.ts` `sendSignal`). The worker takes the oldest pending row at each unit boundary (`consumeSignal`); a poll with no pending row is a plain read, and the take sets `claimed_at`, `claimed_by` and `completed_at` in one write. When a parallel session ends, its pending rows are completed so that they do not reach the next worker of the milestone. A deprecated `.gsd/parallel/<MID>.signal.json` file is input only: the worker queues its command as a row and removes the file.

---

#### ADR-047 liveness ledger (non-versioned)

`db-required-schema.ts` is the registration and completeness authority for
non-versioned schema features required on every database open. It registers
the ADR-047 liveness feature, the ADR-048
[`unit_dispatch_budgets`](#unit_dispatch_budgets-non-versioned),
[`unit_dispatch_sidecars`](#unit_dispatch_sidecars-non-versioned),
[`unit_dispatch_retries`](#unit_dispatch_retries-non-versioned) and
[`unit_dispatch_stages`](#unit_dispatch_stages-non-versioned) features,
the [`auto_pauses`](#auto_pauses-non-versioned) feature,
the runtime-control feature, the
[`milestone_integration_branches`](#milestone_integration_branches-non-versioned)
feature, the
[custom workflow run](#custom-workflow-run-tables-non-versioned) feature, the
[`unit_metrics`](#unit_metrics-non-versioned) feature and the
[`project_milestone_sequence`](#project_milestone_sequence-non-versioned)
feature below;
`db-liveness-backstop-schema.ts` owns the liveness table and open-wedge-index
DDL. Startup repair and `/gsd doctor` query the same registry, so missing
required objects trigger guarded startup maintenance without changing
`schema_version`, `application_id`, or `user_version`; doctor records a
detected repair of the liveness feature.

---

#### `unit_dispatch_budgets` (non-versioned)

```
dispatch_id  INTEGER NOT NULL
kind         TEXT NOT NULL      ← 'zero-tool' | 'tool-unavailable' | 'pre-exec' | 'verification' | 'git-commit' | 'timeout-recovery' | 'exhausted'
used         INTEGER NOT NULL CHECK (used >= 0)
updated_at   TEXT NOT NULL
PRIMARY KEY (dispatch_id, kind)
FOREIGN KEY dispatch_id → unit_dispatches(id)
```

- DDL owner: `db-unit-dispatch-budget-schema.ts`. Access: `db/unit-dispatch-budgets.ts`.
- Count and release rules: see the 2026-10-03 amendment in [ADR-048](dev/ADR-048-unitrun-dispatch-row.md).
- `exhausted` is a mark: a unit that holds it is not dispatched until a reopen or a re-plan releases it. See the third 2026-10-04 amendment in ADR-048.

---

#### `unit_dispatch_sidecars` (non-versioned)

```
id                   INTEGER PRIMARY KEY AUTOINCREMENT
trigger_dispatch_id  INTEGER            ← the dispatch whose close-out queued the row; NULL when there is none
scope                TEXT NOT NULL      ← the worker: '<milestone lock of a parallel worker>/<slice lock>'
kind                 TEXT NOT NULL      ← 'hook' | 'triage' | 'quick-task'
unit_type            TEXT NOT NULL
unit_id              TEXT NOT NULL
prompt               TEXT NOT NULL
model                TEXT
capture_id           TEXT               ← quick tasks only
status               TEXT NOT NULL      ← 'held' | 'queued' | 'done' | 'canceled'
queued_at            TEXT NOT NULL
settled_at           TEXT
FOREIGN KEY trigger_dispatch_id → unit_dispatches(id)
```

- DDL owner: `db-unit-dispatch-sidecar-schema.ts`. Reader: `db/unit-dispatch-sidecars.ts`. Writer: `db/writers/unit-dispatch-sidecars.ts`.
- Scope, status and kill rules: see the 2026-10-04 amendment in [ADR-048](dev/ADR-048-unitrun-dispatch-row.md).

---

#### `unit_dispatch_retries` (non-versioned)

```
dispatch_id      INTEGER PRIMARY KEY   ← the dispatch whose close-out decided the retry
failure_context  TEXT NOT NULL         ← the text the next run of the unit gets in its prompt
attempt          INTEGER NOT NULL CHECK (attempt >= 1)
created_at       TEXT NOT NULL
signature        TEXT                  ← what the duplicate-failure check compares; 'pre-execution:…' and 'git-commit:…' rows are selected by a dispatch rule
FOREIGN KEY dispatch_id → unit_dispatches(id)
```

- DDL owner: `db-unit-dispatch-retry-schema.ts`. Access: `db/unit-dispatch-retries.ts`.
- Store, read and release rules: see the second and third 2026-10-04 amendments in [ADR-048](dev/ADR-048-unitrun-dispatch-row.md).

---

#### `unit_metrics` (non-versioned)

```
unit_type     TEXT NOT NULL
unit_id       TEXT NOT NULL
started_at    INTEGER NOT NULL      ← ms; with unit_type and unit_id it identifies one unit run
finished_at   INTEGER NOT NULL      ← ms
cost          REAL NOT NULL CHECK (cost >= 0)   ← USD; the budget ceiling sums this column
metrics_json  TEXT NOT NULL         ← the full unit record (tokens, model, tool calls, ...)
PRIMARY KEY (unit_type, unit_id, started_at)
```

- DDL owner: `db-unit-metrics-schema.ts`. Reads: `db/unit-metrics.ts`. Write: `db/writers/unit-metrics.ts`.
- Written by `snapshotUnitMetrics` and `snapshotUnitMetricsByScope` (`metrics.ts`) together with `.gsd/metrics.json`. A second snapshot of the same run replaces the row.
- Read by the budget ceiling guard (`auto/phases.ts`), the budget pressure of dynamic model routing (`auto-model-selection.ts`), MCP `gsd_history` and the web history panel. `.gsd/metrics.json` stays the telemetry file of the TUI dashboards; it does not decide the budget.
- A row is telemetry: it is not a Domain Operation and does not change the project revision. `unit_metrics` is an exempt runtime/telemetry table, like `gate_runs` and the exec runs: one writer module (`db/writers/unit-metrics.ts`) writes it directly.
- A parallel worker (`GSD_PARALLEL_WORKER`) counts only its own units against the budget ceiling: rows with `started_at` at or after its session start and with a `unit_id` in its lock scope (`GSD_MILESTONE_LOCK`, or `GSD_MILESTONE_LOCK`/`GSD_SLICE_LOCK`). The coordinator owns the total across workers.
- When the table has no rows and `.gsd/metrics.json` holds units, MCP `gsd_history` and the web history panel return the ledger units with `readMetadata: { source: "projection", authority: "projection-fallback" }`. They do the same when the database is missing.
- Units that only `.gsd/metrics.json` holds (written by an older release) are not counted. When a budget ceiling is set, the budget guard warns the operator with the uncounted amount one time per auto session. `/gsd doctor` reports them (`metrics_ledger_units_unimported`) and `/gsd doctor --fix` imports them.

---

#### `unit_dispatch_stages` (non-versioned)

```
dispatch_id  INTEGER PRIMARY KEY   ← the dispatch whose unit left the execute stage
stage        TEXT NOT NULL         ← 'verify' | 'route' | 'closeout'; no row means 'execute'
updated_at   TEXT NOT NULL
FOREIGN KEY dispatch_id → unit_dispatches(id)
```

- DDL owner: `db-unit-dispatch-stage-schema.ts`. Access: `db/unit-dispatches.ts` (`setDispatchStage`, `getDispatchStage`, `isDispatchExecutionOpen`).
- Write and read rules: see the third 2026-10-04 amendment in [ADR-048](dev/ADR-048-unitrun-dispatch-row.md).

---

#### `auto_pauses` (non-versioned)

```
id                  INTEGER PRIMARY KEY AUTOINCREMENT
scope               TEXT NOT NULL      ← the worker: '<milestone lock of a parallel worker>/<slice lock>'
blocker_kind        TEXT NOT NULL      ← the seven human blocker kinds | 'user_request' | 'machine_fixable'
dispatch_id         INTEGER            ← the unit that was active; NULL when no unit with a dispatch row was active
milestone_id        TEXT
unit_type           TEXT
unit_id             TEXT
worktree_path       TEXT
original_base_path  TEXT
step_mode           INTEGER NOT NULL   ← 0 | 1
session_file        TEXT
active_engine_id    TEXT
active_run_dir      TEXT               ← the run of a custom-engine pause
auto_start_time     INTEGER
milestone_lock      TEXT
pause_reason        TEXT
paused_at           TEXT NOT NULL
closed_at           TEXT               ← NULL while the pause is open
FOREIGN KEY dispatch_id → unit_dispatches(id)
```

- Index: `idx_auto_pauses_open_scope` UNIQUE (scope) WHERE closed_at IS NULL — one open pause for each worker scope.
- DDL owner: `db-auto-pause-schema.ts`. Access: `db/writers/auto-pauses.ts`.
- This row replaces the `paused_session` key in `runtime_kv`. Rules: see the third 2026-10-04 amendment in [ADR-048](dev/ADR-048-unitrun-dispatch-row.md).

---

#### Runtime control rows (non-versioned)

`db-runtime-control-schema.ts` owns the DDL. `db/writers/runtime-control.ts` is
the only reader and writer. These are coordination rows, written outside
Domain Operations. They replace runtime files that auto-mode used to read back
as authority; the files that remain are diagnostic copies that nothing reads.

##### `unit_runtime_records`

One row per work root and unit (`work_root`, `unit_type`, `unit_id`), replaced on
each new run. A reader sees only the rows of its own work root, so a session at
the project root does not read or clear the rows of a session in a worktree.

```
work_root                 TEXT NOT NULL     ← real path of the worktree or project root that runs the unit
unit_type                 TEXT NOT NULL
unit_id                   TEXT NOT NULL
started_at                INTEGER NOT NULL  ← run identity (epoch ms)
updated_at                INTEGER NOT NULL
phase                     TEXT NOT NULL     ← dispatched | wrapup-warning-sent | timeout | finalize-timeout | crashed | recovered | finalized | paused | skipped
wrapup_warning_sent       INTEGER NOT NULL DEFAULT 0
continue_here_fired       INTEGER NOT NULL DEFAULT 0
timeout_at                INTEGER
last_progress_at          INTEGER NOT NULL
progress_count            INTEGER NOT NULL DEFAULT 0
last_progress_kind        TEXT NOT NULL
recovery_attempts         INTEGER NOT NULL DEFAULT 0  ← timeout recovery budget
last_recovery_reason      TEXT              ← idle | hard
harness_abort_kind        TEXT              ← tool-loop-guard | tool-error | turn-abort; blocks result-save tools
harness_abort_reason      TEXT
harness_abort_tool_name   TEXT
harness_abort_count       INTEGER
harness_abort_recorded_at INTEGER
end_status                TEXT              ← unit-end outcome of the latest run; decides post-unit hook success
end_artifact_verified     INTEGER
end_error                 TEXT
recovery_json             TEXT              ← execute-task durability snapshot (diagnostic)
PRIMARY KEY (work_root, unit_type, unit_id)
```

- Diagnostic copy: `.gsd/runtime/units/<type>-<id>.json`.

##### `hook_state`

Post-unit hook engine state: active hook, hook queue, cycle counts, pending
retry and pending gate block.

```
scope      TEXT PRIMARY KEY   ← real path of the .gsd directory the state belongs to
state_json TEXT NOT NULL
updated_at TEXT NOT NULL
```

- Diagnostic copy: `.gsd/hook-state.json`.
- The file is never read. A `.gsd/hook-state.json` with no row (left by an older
  build) is reported by doctor as `legacy_hook_state_file`; `doctor --fix` removes it.

##### `uat_retry_counters`

run-uat dispatch attempts per slice. The dispatch rule stops at 3.

```
milestone_id TEXT NOT NULL
slice_id     TEXT NOT NULL
attempts     INTEGER NOT NULL
updated_at   TEXT NOT NULL
PRIMARY KEY (milestone_id, slice_id)
```

- Deleted by `slice.reopen` and `milestone.reopen`, so a redone slice gets a new budget.

##### `write_gate_state`

Discussion write-gate state: verified depth milestones, verified approval
gates, the pending gate and the queue phase. `db-write-gate-schema.ts` owns the
DDL. `db/writers/write-gate.ts` is the only reader and writer, and
`bootstrap/write-gate.ts` is its only caller. The extension host and the
workflow MCP child read the same rows; every change is one write transaction.
These are enforcement rows, written outside Domain Operations.

```
gate_kind  TEXT NOT NULL   ← depth_verified | approval_verified | pending | queue_phase
gate_id    TEXT NOT NULL   ← milestone id (depth_verified), gate question id (approval_verified, pending), 'active' (queue_phase)
writer     TEXT NOT NULL   ← host | child (diagnostic)
updated_at TEXT NOT NULL
PRIMARY KEY (gate_kind, gate_id)
```

- At most one `pending` row. A verified gate is never also pending.
- A session start and a resumed session delete the `pending` row and the
  `queue_phase` row, and keep the verified rows. `/clear`, `/new` and the
  discuss→auto handoff delete every row.
- The latest answer to a gate question wins. A decline deletes the verified
  rows of that gate and leaves the gate `pending`.
- No file copy. `.gsd/runtime/write-gate-state.json` (older builds) is not read.
- A gate call opens the existing project database when it is not the open one,
  in the extension host and in the workflow MCP child. It never creates a
  database.
- A project database that exists and does not open fails closed for the gated
  writes only (milestone CONTEXT, PROJECT, REQUIREMENTS and requirement
  writes): they are refused with the open error and its remedy. Every other
  tool runs. A gate write records nothing and logs a warning.
- Only a project with no database keeps the gate in process memory. The first
  gate call after the database exists moves that state into the rows.

##### `discussion_handoffs`

The pending discuss-to-auto handoff: one row per project root while a guided
discussion waits to start auto-mode. It replaces the session-only pending
auto-start map as the durable record, and the agent-written
`.gsd/DISCUSSION-MANIFEST.json` gate file, which is no longer read or written.

```
base_path    TEXT PRIMARY KEY   ← project root that the discussion was dispatched from
milestone_id TEXT NOT NULL      ← primary milestone of the discussion
step         INTEGER            ← 1 | 0; NULL when the caller did not set the flag
start_auto   INTEGER            ← 1 | 0; NULL when the caller did not set the flag
session_id   TEXT               ← the conversation that holds the interview
created_at   INTEGER NOT NULL   ← discussion start (epoch ms)
```

- Written by `setPendingAutoStart` (`pending-auto-start.ts`) when a discussion
  is dispatched. The in-memory map holds the same entry bound to the live
  session handles.
- After a restart, `/gsd` binds the row to the current command
  (`restorePendingAutoStart`) when `session_id` is the current conversation. A
  row of another conversation is deleted.
- Deleted when the handoff is accepted and auto-mode starts, and when the
  pending entry is cleared: a stale discussion, `/clear` or `/new`, or a ready
  signal that was rejected too many times.
- The handoff gate reads rows only: each milestone that the discussion
  registered needs a CONTEXT or CONTEXT-DRAFT `artifacts` row, a planned slice,
  or a milestone-scope Work Checkpoint (the record of "queue it for later").

##### `exec_runs`

One row for each `gsd_exec` / `gsd_uat_exec` command the host ran. Evidence
checks read this row. `.gsd/exec/<id>.*` holds the output text and a
`.meta.json` copy of the run metadata for `gsd_exec_search` and the compaction
snapshot; the `.meta.json` file is not evidence.

```
id           TEXT PRIMARY KEY   ← the run id the tool returns
kind         TEXT NOT NULL      ← 'exec' | 'uat_exec'
runtime      TEXT NOT NULL
command      TEXT NOT NULL      ← the script, secrets redacted
cwd          TEXT NOT NULL
exit_code    INTEGER
signal       TEXT
timed_out    INTEGER NOT NULL
aborted      INTEGER NOT NULL
started_at   TEXT NOT NULL
duration_ms  INTEGER NOT NULL
output_hash  TEXT NOT NULL      ← sha256 of the stored stdout and stderr
milestone_id TEXT               ← uat_exec only
slice_id     TEXT               ← uat_exec only
check_id     TEXT               ← uat_exec only
attempt_ref  TEXT               ← the Attempt the run belongs to, or NULL
source_revision TEXT            ← uat_exec only: project source revision when the run was recorded
```

- Index: `idx_exec_runs_attempt` on `(attempt_ref)`
- `attempt_ref` of an `exec` run is the id of the one Task Attempt of the
  caller that was not settled when the command ended. The caller is known by
  its worker scope: `GSD_MILESTONE_LOCK` (with `GSD_SLICE_LOCK` for a Slice
  worker), or without a lock the name of the worktree the run is in. So
  parallel workers each bind their own runs. It is NULL with no such Attempt,
  or with more than one; a NULL run backs no claimed evidence.
- `attempt_ref` of a `uat_exec` run is `uat:<M>:<S>:attempt-<N>`, the run-uat
  attempt not saved yet. `gsd_uat_result_save` accepts a `gsd_uat_exec` ref only
  from its own slice and its own attempt. Reopen sets it to NULL.
- Host verification accepts the agent's claimed task evidence only when each
  claimed command names a run of the Attempt under verification that ended with
  exit 0.
- `source_revision` is the verification source revision of the project when a
  `uat_exec` run was recorded. It is NULL for an `exec` run (reading it hashes
  every source file) and when the source cannot be read, for example outside a
  git repository. `gsd_uat_result_save` stores the revision it was saved for in
  its operation result and in the `attempt-N.json` record.

---

#### `milestone_integration_branches` (non-versioned)

The branch a milestone merges back to. One row per milestone.

```
milestone_id       TEXT PRIMARY KEY
integration_branch TEXT NOT NULL      ← not blank
updated_at         TEXT NOT NULL
```

- DDL owner: `db-integration-branch-schema.ts`. Reader and writer: `db/writers/milestone-integration-branch.ts`.
- The row is workflow state. Only the `milestone.integration_branch.record`
  Domain Operation writes it, with a `milestone.integration_branch.recorded`
  event. Nothing is written when no database is open.
- The row is the merge target. `<MID>-META.json` is a rendered copy; it is read
  only when the milestone has no row or no database is open.

---

#### Custom workflow run tables (non-versioned)

A `yaml-step` custom workflow run, its steps and the verification evidence of
each step.

```
custom_workflow_runs
  run_id           TEXT PRIMARY KEY     ← '<name>/<timestamp>', the run directory under .gsd/workflow-runs
  name             TEXT NOT NULL
  definition_json  TEXT NOT NULL        ← the definition frozen at run creation
  params_json      TEXT
  created_at       TEXT NOT NULL
  operation_id     TEXT NOT NULL
  FOREIGN KEY operation_id → workflow_operations(operation_id)

custom_workflow_steps
  run_id           TEXT NOT NULL
  step_id          TEXT NOT NULL
  position         INTEGER NOT NULL
  title            TEXT NOT NULL
  status           TEXT NOT NULL        ← 'pending' | 'active' | 'complete' | 'expanded'
  prompt           TEXT NOT NULL
  depends_on_json  TEXT NOT NULL
  parent_step_id   TEXT
  started_at       TEXT
  finished_at      TEXT
  verify_retries   INTEGER NOT NULL DEFAULT 0 CHECK (verify_retries >= 0)
  PRIMARY KEY (run_id, step_id)
  FOREIGN KEY run_id → custom_workflow_runs(run_id)

custom_workflow_step_verifications
  id                INTEGER PRIMARY KEY AUTOINCREMENT
  run_id            TEXT NOT NULL
  step_id           TEXT NOT NULL
  verdict           TEXT NOT NULL       ← 'pass' | 'fail' | 'inconclusive'
  evidence_json     TEXT NOT NULL
  waiver_rationale  TEXT
  recorded_at       TEXT NOT NULL
  operation_id      TEXT NOT NULL
  FOREIGN KEY (run_id, step_id) → custom_workflow_steps(run_id, step_id)
  FOREIGN KEY operation_id → workflow_operations(operation_id)
```

- DDL owner: `db-custom-workflow-schema.ts`. Reader: `db/custom-workflow-runs.ts`. Writer: `db/writers/custom-workflow-runs.ts`.
- These are workflow-state rows: every write is a `custom_workflow.*` Domain
  Operation (`run.create`, `run.import`, `step.activate`, `step.expand`,
  `step.complete`, `step.verify`, `step.approve`, `step.retry`).
- A step that auto-mode runs also has a `unit_dispatches` row: `unit_type`
  `custom-step`, `unit_id` `<run_id>/<step_id>`, `milestone_id` the run id and
  `milestone_lease_token` 0 (a run has no milestone lease).
- `GRAPH.yaml`, `DEFINITION.yaml` and `PARAMS.json` in the run directory are
  renders of these rows, written by the Projection Worker
  (`custom-workflow-run` projection kind).
- Authority, approval and import rules: see
  [ADR-046](dev/ADR-046-database-authoritative-workflow-lifecycle.md).

---

#### `project_milestone_sequence` (non-versioned)

The Milestone Sequence of the PROJECT artifact. One row per milestone line.

```
milestone_id TEXT PRIMARY KEY      ← the id as the sequence line writes it
position     INTEGER NOT NULL      ← 0-based order of the line in the sequence
```

- DDL owner: `db-project-milestone-sequence-schema.ts`. Reader and writers: `db/writers/project-milestone-sequence.ts`.
- Writer: the `artifact.save` Domain Operation of `gsd_summary_save(PROJECT)` replaces all rows in the
  transaction that stores the PROJECT artifact row. A line that leaves the sequence leaves the table.
- Backfill: when startup maintenance creates the table and the table is empty, the rows are filled once from
  the stored `PROJECT.md` artifact row.
- Reader: `deriveState` promotes a content-less queued milestone only when it has a row here. The text of
  PROJECT.md is not parsed for that decision, on disk or in the artifact row.

---

### 3d. Soft State (V25)

#### `runtime_kv`

```
scope      TEXT NOT NULL    ← 'global' | 'worker' | 'milestone'
scope_id   TEXT NOT NULL DEFAULT ''
key        TEXT NOT NULL
value_json TEXT NOT NULL
updated_at TEXT NOT NULL
PRIMARY KEY (scope, scope_id, key)
```

Non-correctness-critical state: UI cursors, dashboard caches, resume pointers. Safe to lose.

---

### 3e. Additive Canonical Foundation (V31)

V31 created these tables on fresh databases and transactionally upgraded V30
databases. Production now routes milestone/slice/task planning, task/slice
replanning, roadmap reassessment, Task execution/recovery/publication, and Slice
complete/cancel/reopen/reset through Domain Operations and lifecycle primitives.
Milestone lifecycle commands, UAT orchestration, and import application remain
separate later cutovers.

#### `project_authority`

```
singleton            INTEGER PRIMARY KEY CHECK (singleton = 1)
project_id           TEXT NOT NULL UNIQUE
project_root_realpath TEXT NOT NULL DEFAULT ''
revision             INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
authority_epoch      INTEGER NOT NULL DEFAULT 0 CHECK (authority_epoch >= 0)
created_at           TEXT NOT NULL DEFAULT ''
updated_at           TEXT NOT NULL DEFAULT ''
```

- Exactly one row is seeded with a generated 32-character lowercase hex
  `project_id`; fresh and upgraded databases begin at revision/epoch `0`.
- `project_root_realpath` is the bound checkout root (`''` until the first
  open binds it), not identity; see ADR-046, "One database per bound checkout".
- `schema_version` remains the DDL compatibility version and is not this domain
  revision.

#### `workflow_operations`

```
operation_id             TEXT PRIMARY KEY
project_id               TEXT NOT NULL
operation_type           TEXT NOT NULL
idempotency_key          TEXT NOT NULL
expected_revision        INTEGER NOT NULL CHECK (expected_revision >= 0)
resulting_revision       INTEGER NOT NULL CHECK (resulting_revision = expected_revision + 1)
expected_authority_epoch INTEGER NOT NULL CHECK (expected_authority_epoch >= 0)
resulting_authority_epoch INTEGER NOT NULL
actor_type               TEXT NOT NULL
actor_id                 TEXT DEFAULT NULL
source_transport         TEXT NOT NULL
trace_id                 TEXT DEFAULT NULL
turn_id                  TEXT DEFAULT NULL
request_hash             TEXT NOT NULL
created_at               TEXT NOT NULL
FOREIGN KEY project_id → project_authority(project_id)
```

- `resulting_authority_epoch` must equal the expected epoch or advance it by
  exactly one.
- `(project_id, idempotency_key)` and `(project_id, resulting_revision)` are
  unique. The composite operation/project/result revision/result epoch key binds
  emitted events to the exact recorded operation result.
- A `project.start_empty` row is the stored `/gsd db start-empty` choice: the
  open admits a database with no milestone rows beside projections it did not
  produce; see ADR-046, "One database per bound checkout".
- Index: `idx_workflow_operations_created` (project_id, created_at, operation_id)

#### `workflow_domain_events`

```
event_id          TEXT PRIMARY KEY
operation_id      TEXT NOT NULL
event_index       INTEGER NOT NULL DEFAULT 0 CHECK (event_index >= 0)
project_id        TEXT NOT NULL
project_revision  INTEGER NOT NULL CHECK (project_revision > 0)
authority_epoch   INTEGER NOT NULL CHECK (authority_epoch >= 0)
event_type        TEXT NOT NULL
entity_type       TEXT NOT NULL
entity_id         TEXT NOT NULL
caused_by_event_id TEXT DEFAULT NULL
payload_json      TEXT NOT NULL DEFAULT '{}'
created_at        TEXT NOT NULL
```

- `(operation_id, event_index)` is unique.
- The composite foreign key to `workflow_operations` requires every event's
  project revision and Authority Epoch to match its operation result exactly;
  `caused_by_event_id` may link to another domain event.
- Update and delete triggers abort with `workflow domain events are immutable`.
- Index: `idx_workflow_domain_events_entity`
  (project_id, entity_type, entity_id, project_revision, event_index)

#### `workflow_outbox`

```
outbox_id        INTEGER PRIMARY KEY AUTOINCREMENT
event_id         TEXT NOT NULL
destination      TEXT NOT NULL
available_at     TEXT NOT NULL DEFAULT ''
FOREIGN KEY event_id → workflow_domain_events(event_id)
```

- `(event_id, destination)` is unique.
- Inserts whose generated identity exceeds JavaScript's maximum safe integer
  abort with `outbox identity exceeds safe integer range`.
- Delete attempts abort with `outbox rows are durable history`.
- The outbox is an audit link only. `workflow_projection_work` is the only
  delivery queue; schema v51 dropped the unused delivery columns and the
  `idx_workflow_outbox_pending` index.

These four tables are deliberately distinct from existing narrower concepts:
`audit_events` remains optional operational telemetry,
`milestone_commit_attributions` remains Git-specific attribution, and
`command_queue`/`runtime_kv` remain coordination/cache surfaces rather than
operation provenance, domain history, or an outbox.

#### Domain Operation boundary

`executeDomainOperation(request, mutate)` is exported through `gsd-db.ts`. A
fresh request must provide an operation type, project-scoped idempotency key,
expected revision and Authority Epoch, actor and transport provenance, and a
JSON-compatible semantic payload. The callback receives a frozen context and
must return at least one ordered event with an outbox destination plus at least
one normalized Projection Work target. It may compose deterministic typed
database writers, but filesystem, network, routing, retry, and swallowed-error
behavior are outside the transaction boundary.

One `BEGIN IMMEDIATE` transaction records the operation, mutation rows, ordered
events, outbox destinations, per-key Projection Work successor rows, and the
authority compare-and-swap. Exact retries return the original `replayed`
receipt without invoking `mutate`; a changed request under the same key raises
`GSD_IDEMPOTENCY_CONFLICT`. Stale revision, stale epoch, authority-CAS failure,
or writer contention raises `GSD_REVISION_CONFLICT`. The receipt contains the
operation/project identity, resulting revision and epoch, canonical `sha256:`
request hash, and ordered event, outbox, and projection-work identities.

The boundary requires safe non-negative revision/epoch integers, canonical
finite JSON numbers, unique destinations per event, backward-only event causal
links, lowercase normalized projection keys/kinds, unique projection keys, and
at most 10,000 projection targets. It must own the outer transaction. Adopted
planning, Task, and Slice handlers use this boundary; Milestone command
adapters, projection delivery, import, remaining closeout policy, and runtime
read-authority cutover remain deferred.

#### Lifecycle command primitives

`db/writers/lifecycle-commands.ts`, exported through `gsd-db.ts`, composes with
`executeDomainOperation()` but does not start a transaction or emit events and
Projection Work itself. `readDomainOperationFence()` returns the current fence,
or the original expected fence for an existing idempotency key. Inside the
active callback, `adoptOrTransitionLifecycle()` creates or advances one
canonical lifecycle head, `claimRunningAttempt()` creates a running Attempt and
its first `execute` checkpoint, `settleAttemptWithResult()` settles that Attempt
with one immutable Result, and `appendKernelCheckpoint()` extends the current
checkpoint head.

The schema triggers continue to enforce transition legality, live lease and
optional dispatch fencing, retry order, provenance, and checkpoint lineage.
V40 authorizes Slice cancellation to settle running descendants without
weakening those fences; V41 adds only the Slice `ready -> completed` face.
`db/lifecycle-shadow-comparison.ts` normalizes through the one
legacy-to-canonical status map in `status-guards.ts` and classifies exact matches, accepted semantic deltas,
missing or extra shadow rows, and mismatches while preserving both raw values.
Planning, Task execution/recovery/publication, and Slice lifecycle handlers now
use replay fences and lifecycle adoption/transition.
First-time adoption normally starts at state version zero; when the same
operation observes active legacy work and cancels it, the row records the legal
observed-to-cancelled transition at state version one. Attempt, Result, and
Kernel-stage production callers use the proven S03/S04 policy. Milestone
lifecycle callers remain deferred.

---

### 3f. Additive Lifecycle Foundation (V32)

V32 creates these tables on fresh databases and transactionally upgrades V31
databases. The migration itself remains additive, and the existing hierarchy
statuses and coordination ledgers retain their runtime meaning. Planning now
dual-writes lifecycle heads inside Domain Operations, but no general lifecycle
read-authority cutover, Attempt/Result integration, backfill, or Markdown
inference ships with it.

#### `workflow_item_lifecycles`

```
lifecycle_id          TEXT PRIMARY KEY
project_id            TEXT NOT NULL
item_kind             TEXT NOT NULL    ← 'milestone' | 'slice' | 'task'
milestone_id          TEXT NOT NULL
slice_id              TEXT DEFAULT NULL
task_id               TEXT DEFAULT NULL
lifecycle_status      TEXT NOT NULL    ← 'pending' | 'ready' | 'in_progress' |
                                         'paused' | 'completed' | 'cancelled'
state_version         INTEGER NOT NULL DEFAULT 0
created_at            TEXT NOT NULL
updated_at            TEXT NOT NULL
last_operation_id     TEXT NOT NULL
last_project_revision INTEGER NOT NULL
last_authority_epoch  INTEGER NOT NULL
```

- Partial unique indexes enforce one lifecycle per fully scoped milestone,
  slice, or task identity. Kind-specific checks require exactly the applicable
  identity columns.
- Updates preserve identity, increment `state_version` by one, and permit only
  `pending → ready|cancelled`, `ready → in_progress|paused|cancelled`,
  `in_progress → paused|completed|cancelled`, `paused → ready|in_progress|cancelled`,
  or `completed|cancelled → ready`. Operation/revision/Authority Epoch
  provenance must advance; deletes are rejected as durable-history loss.
- Indexes: `idx_workflow_lifecycle_milestone`,
  `idx_workflow_lifecycle_slice`, and `idx_workflow_lifecycle_task`.
- Lifecycle coverage fence (non-versioned, `db-lifecycle-coverage-schema.ts`,
  created on every open that does not find it). When `authority_epoch` is
  above 0, every `milestones`, `slices` and `tasks` row has a lifecycle row:
  `trg_milestones_lifecycle_coverage`, `trg_slices_lifecycle_coverage` and
  `trg_tasks_lifecycle_coverage` refuse an inserted hierarchy row when no
  Domain Operation is open, and `trg_project_authority_lifecycle_coverage`
  refuses the `project_authority` update of a Domain Operation, and of the
  cutover itself, while a hierarchy row has no lifecycle row. The Domain
  Operation error names each such row and `/gsd db adopt`.
  `trg_milestones_status_authority`, `trg_slices_status_authority` and
  `trg_tasks_status_authority` refuse a change of the legacy `status` of a
  hierarchy row that has a lifecycle row when no Domain Operation is open.
  Other columns are not fenced, and a row with no lifecycle row is not fenced,
  so its status can be fixed for the backfill. Epoch 0 is not
  fenced. A database that is already above epoch 0 and holds such a row (a
  canary cutover by an earlier build) is repaired when it opens: the open
  writes a verified backup, runs `lifecycle.backfill` for those rows and logs
  each legacy status that it changed. A row with an unknown raw status stops
  that run with an error that names it; `/gsd doctor` reports it too.

#### `workflow_execution_attempts`

```
attempt_id                TEXT PRIMARY KEY
project_id                TEXT NOT NULL
lifecycle_id              TEXT NOT NULL
attempt_number            INTEGER NOT NULL
retry_of_attempt_id       TEXT DEFAULT NULL
attempt_state             TEXT NOT NULL    ← 'claimed' | 'running' | 'settled'
coordination_dispatch_id  INTEGER DEFAULT NULL UNIQUE
worker_id                 TEXT DEFAULT NULL
milestone_lease_token     INTEGER DEFAULT NULL
claimed_at                TEXT NOT NULL
started_at                TEXT DEFAULT NULL
ended_at                  TEXT DEFAULT NULL
claim_operation_id        TEXT NOT NULL
claim_project_revision    INTEGER NOT NULL
claim_authority_epoch     INTEGER NOT NULL
settle_operation_id       TEXT DEFAULT NULL
settle_project_revision   INTEGER DEFAULT NULL
settle_authority_epoch    INTEGER DEFAULT NULL
```

- `(lifecycle_id, attempt_number)` is unique, attempt numbers are contiguous,
  and every retry points to the immediately preceding Attempt for that
  lifecycle. A partial unique index permits only one `claimed` or `running`
  Attempt per lifecycle.
- Worker-bound inserts and transitions require the current unexpired held
  milestone lease. Dispatch attribution must match the lifecycle's complete
  milestone/slice/task scope, worker, fencing token, and active dispatch state.
- Only `claimed → running|settled` and `running → settled` are valid.
  Claim identity and timestamps are preserved, settlement provenance must
  advance causally, and settled Attempts and all deletes are immutable.
- Index: `idx_workflow_attempt_active` (lifecycle_id), limited to `claimed` and
  `running` rows.

#### `workflow_attempt_results`

```
result_id         TEXT PRIMARY KEY
project_id        TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
attempt_id        TEXT NOT NULL UNIQUE
outcome           TEXT NOT NULL    ← 'succeeded' | 'failed' | 'interrupted'
failure_class     TEXT NOT NULL DEFAULT 'none'
summary           TEXT NOT NULL DEFAULT ''
output_json       TEXT NOT NULL DEFAULT '{}'
created_at        TEXT NOT NULL
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
```

- Exactly one Result may exist per Attempt, and only after that Attempt is
  settled. Its operation, revision, and Authority Epoch must exactly match the
  Attempt's settlement provenance.
- Updates and deletes are rejected. Result outcome does not mutate lifecycle
  status or requirement disposition.

#### `workflow_blockers`

```
blocker_id               TEXT PRIMARY KEY
project_id               TEXT NOT NULL
lifecycle_id             TEXT NOT NULL
blocker_kind             TEXT NOT NULL    ← 'missing_authority' | 'missing_access' |
                                              'external_dependency' | 'consent' |
                                              'ambiguous_intent' | 'subjective_uat' |
                                              'user_limit'
resolution_owner         TEXT NOT NULL    ← 'user' | 'external'
blocker_status           TEXT NOT NULL    ← 'open' | 'resolved' | 'dismissed'
description              TEXT NOT NULL
requested_action         TEXT NOT NULL DEFAULT ''
resolution               TEXT NOT NULL DEFAULT ''
opened_at                TEXT NOT NULL
resolved_at              TEXT DEFAULT NULL
opened_operation_id      TEXT NOT NULL
opened_project_revision  INTEGER NOT NULL
opened_authority_epoch   INTEGER NOT NULL
resolved_operation_id    TEXT DEFAULT NULL
resolved_project_revision INTEGER DEFAULT NULL
resolved_authority_epoch INTEGER DEFAULT NULL
```

- Blockers represent only user- or external-owned impediments and remain
  separate from lifecycle and execution outcomes.
- Opening facts are immutable. An open Blocker may become `resolved` or
  `dismissed` with causally newer operation provenance; terminal records and
  deletes are immutable.

#### `workflow_waivers`

```
waiver_id              TEXT PRIMARY KEY
project_id             TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
requirement_id         TEXT DEFAULT NULL
blocker_id             TEXT DEFAULT NULL
waiver_status          TEXT NOT NULL    ← 'active' | 'revoked' | 'expired'
scope                  TEXT NOT NULL
rationale              TEXT NOT NULL
granted_by_actor_type  TEXT NOT NULL    ← 'user' | 'policy'
granted_by_actor_id    TEXT DEFAULT NULL
granted_at             TEXT NOT NULL
expires_at             TEXT DEFAULT NULL
ended_at               TEXT DEFAULT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
ended_operation_id     TEXT DEFAULT NULL
ended_project_revision INTEGER DEFAULT NULL
ended_authority_epoch  INTEGER DEFAULT NULL
```

- User grants require an actor ID. At most one active Waiver may reference a
  Blocker, and requirement/blocker references must resolve to canonical rows.
- Grant facts are immutable. An active Waiver may become `revoked` or
  `expired` with causally newer provenance; terminal records and deletes are
  immutable. A Waiver cannot terminate while it still authorizes the current
  waived disposition.
- Index: `idx_workflow_waiver_active_blocker` (blocker_id), limited to active
  rows with a Blocker.

#### `workflow_requirement_dispositions`

```
disposition_id             TEXT PRIMARY KEY
project_id                 TEXT NOT NULL
requirement_id             TEXT NOT NULL
disposition                TEXT NOT NULL    ← 'unsatisfied' | 'satisfied' | 'waived'
waiver_id                  TEXT DEFAULT NULL
supersedes_disposition_id  TEXT DEFAULT NULL UNIQUE
rationale                  TEXT NOT NULL
created_at                 TEXT NOT NULL
operation_id               TEXT NOT NULL
project_revision           INTEGER NOT NULL
authority_epoch            INTEGER NOT NULL
```

- Rows form an immutable, single-head history per requirement. Every successor
  must supersede the current head with causally newer revision/Authority Epoch
  provenance.
- Only `waived` rows carry a Waiver. That Waiver must belong to the same
  project and requirement, be active and unexpired, and precede the disposition
  revision. Updates and deletes are rejected.
- Index: `idx_workflow_requirement_disposition_history`
  (requirement_id, project_revision, disposition_id)

Every V32 table is linked to the V31 authority root and exact
`workflow_operations` provenance. The separation of lifecycle, execution
history, Results, Blockers, Waivers, and requirement truth prevents one concept
from silently fabricating another.

---

### 3g. Additive Guided-Conversation Foundation (V33)

V33 transactionally adds durable conversation facts without backfilling or
changing runtime routing. Prompts, Markdown, process caches, and legacy
decision rows retain their current behavior until the later cutover slice.

| Table | Durable responsibility |
|---|---|
| `workflow_milestone_contexts` | Append-only Milestone Kind and advisory planning-horizon history. Kinds are `discovery`, `research`, `requirements`, `roadmap`, `delivery`, or `remediation`; reforecasts supersede the current head without changing readiness or lifecycle state. |
| `workflow_open_questions` | Focused question identity and its explicit `open` → `answered|withdrawn` lifecycle. Answered transitions require the accepted Answer from the same operation. |
| `workflow_question_dependencies` | The exact lifecycle scope a question may inform or cause to be revalidated. |
| `workflow_interactions` | Presented conversational turns. Interaction Kinds are `open`, `choice`, `clarification`, `recap`, `consent`, and `subjective-uat`; every answer-requiring turn carries recommendation text and rationale. |
| `workflow_interaction_options` | Up to three ordered options; `choice` Interactions require two or three. Presentation is rejected unless the declared recommendation belongs to the Interaction and is ordinal one. |
| `workflow_answers` | Immutable verbatim user language stored separately from normalized interpretation. Response Kinds are `answer`, `pushback`, `correction`, `clarification`, and `consent`. Only one Answer per Interaction may be accepted; conflicting revisions remain append-only facts. |
| `workflow_conversation_decisions` | Immutable Decisions derived from accepted Answers. Corrections form a causally advancing, single-head supersession chain. |
| `workflow_decision_impacts` | Immutable, dependency-reachable `inform`, `revalidate`, or `invalidate` effects. Inform-only dependencies reject revalidation and invalidation; unrelated work is always rejected. |
| `workflow_work_checkpoints` | Restart-safe, append-only conversation/work summaries with one ordered head per scope. Kinds cover `discovery`, `research`, `requirements`, `roadmap`, `delivery`, `answer`, `pause`, `correction`, `recap`, and `handoff`. Narrative fields are resumability aids; canonical Answer and Decision heads remain the machine truth. |

#### `workflow_milestone_contexts`

```
context_id             TEXT PRIMARY KEY
project_id             TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
milestone_id           TEXT NOT NULL
milestone_kind         TEXT NOT NULL
planned_start_at       TEXT DEFAULT NULL
planned_end_at         TEXT DEFAULT NULL
review_at              TEXT DEFAULT NULL
horizon_note           TEXT NOT NULL DEFAULT ''
supersedes_context_id  TEXT DEFAULT NULL UNIQUE
created_at             TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```

- The lifecycle must identify the same milestone. Each later context supersedes
  the current head with causally newer provenance; updates and deletes fail.

#### `workflow_open_questions`

```
question_id                 TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
lifecycle_id                TEXT NOT NULL
question_text               TEXT NOT NULL
question_status             TEXT NOT NULL    ← 'open' | 'answered' | 'withdrawn'
state_version               INTEGER NOT NULL DEFAULT 0
accepted_answer_id          TEXT DEFAULT NULL
created_at / updated_at     TEXT NOT NULL
created_operation_id        TEXT NOT NULL
created_project_revision    INTEGER NOT NULL
created_authority_epoch     INTEGER NOT NULL
last_operation_id           TEXT NOT NULL
last_project_revision       INTEGER NOT NULL
last_authority_epoch        INTEGER NOT NULL
```

- Questions begin open at version zero. The only transition is from `open` to
  `answered` or `withdrawn`, with a one-step version increment and newer causal
  provenance. Answering requires an accepted Answer created by that same final
  operation; withdrawal carries no Answer. Deletes fail.

#### `workflow_question_dependencies`

```
question_id       TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
project_id        TEXT NOT NULL
dependency_kind   TEXT NOT NULL DEFAULT 'revalidate' ← 'inform' | 'revalidate'
created_at        TEXT NOT NULL
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (question_id, lifecycle_id)
```

- Dependencies are immutable and bound to an existing Question, lifecycle,
  Domain Operation, revision, and Authority Epoch.

#### `workflow_interactions`

```
interaction_id              TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
question_id                 TEXT NOT NULL
sequence                    INTEGER NOT NULL
interaction_kind            TEXT NOT NULL
presentation_state          TEXT NOT NULL    ← 'prepared' | 'presented'
focused_prompt              TEXT NOT NULL
requires_answer             INTEGER NOT NULL
option_count                INTEGER NOT NULL DEFAULT 0
recommended_option_id       TEXT DEFAULT NULL
recommendation_text         TEXT NOT NULL DEFAULT ''
recommendation_rationale    TEXT NOT NULL DEFAULT ''
recommendation_evidence     TEXT NOT NULL DEFAULT ''
recommendation_confidence   REAL DEFAULT NULL
recommendation_uncertainty  TEXT NOT NULL DEFAULT ''
revisit_condition           TEXT NOT NULL DEFAULT ''
presented_at                TEXT NOT NULL DEFAULT ''
operation_id                TEXT NOT NULL
project_revision            INTEGER NOT NULL
authority_epoch             INTEGER NOT NULL
```

- Interactions begin `prepared`. The only update presents the immutable turn
  after validating its exact option count and ordinal-one recommendation.
  `choice` requires two or three options. Every Kind except `recap` requires an
  Answer and non-empty recommendation text and rationale.

#### `workflow_interaction_options`

```
interaction_id    TEXT NOT NULL
option_id         TEXT NOT NULL
project_id        TEXT NOT NULL
ordinal           INTEGER NOT NULL    ← 1..3
label             TEXT NOT NULL
description       TEXT NOT NULL DEFAULT ''
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (interaction_id, option_id)
```

- Options may be added only while the Interaction is prepared. Ordinals are
  unique within an Interaction; updates and deletes fail.

#### `workflow_answers`

```
answer_id                  TEXT PRIMARY KEY
project_id                 TEXT NOT NULL
question_id                TEXT NOT NULL
interaction_id             TEXT NOT NULL
response_kind              TEXT NOT NULL
verbatim_response          TEXT NOT NULL
selected_option_id         TEXT DEFAULT NULL
normalized_interpretation  TEXT NOT NULL
interpretation_confidence  REAL NOT NULL    ← 0..1
answer_disposition         TEXT NOT NULL    ← 'accepted' | 'revision-conflict'
observed_project_revision  INTEGER NOT NULL
created_at                 TEXT NOT NULL
operation_id               TEXT NOT NULL
project_revision           INTEGER NOT NULL
authority_epoch            INTEGER NOT NULL
```

- An accepted Answer must target a presented Interaction at the observed
  revision; recaps accept only corrections. The resulting revision must advance
  beyond the observed revision. The optional selected option must belong to the
  Interaction. Updates and deletes fail.
- Unique partial index: `idx_workflow_answer_accepted` permits one accepted
  Answer per Interaction.

#### `workflow_conversation_decisions`

```
decision_id             TEXT PRIMARY KEY
project_id              TEXT NOT NULL
question_id             TEXT NOT NULL
answer_id               TEXT NOT NULL
decision_text           TEXT NOT NULL
supersedes_decision_id  TEXT DEFAULT NULL UNIQUE
created_at              TEXT NOT NULL
operation_id            TEXT NOT NULL
project_revision        INTEGER NOT NULL
authority_epoch         INTEGER NOT NULL
```

- A Decision requires an accepted Answer from the same operation. A successor
  must derive from a correction Answer and supersede the causally older current
  head for that Question. Updates and deletes fail.

#### `workflow_decision_impacts`

```
decision_id       TEXT NOT NULL
lifecycle_id      TEXT NOT NULL
project_id        TEXT NOT NULL
effect            TEXT NOT NULL    ← 'revalidate' | 'invalidate' | 'inform'
operation_id      TEXT NOT NULL
project_revision  INTEGER NOT NULL
authority_epoch   INTEGER NOT NULL
PRIMARY KEY (decision_id, lifecycle_id)
```

- The target lifecycle must be a declared dependency of the Decision's
  Question. `inform` works with either dependency Kind; `revalidate` and
  `invalidate` require a `revalidate` dependency. Updates and deletes fail.
- Index: `idx_workflow_decision_impacts_lifecycle` (lifecycle_id, effect)

#### `workflow_work_checkpoints`

```
checkpoint_id          TEXT PRIMARY KEY
project_id             TEXT NOT NULL
scope_key              TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
checkpoint_kind        TEXT NOT NULL
sequence               INTEGER NOT NULL
previous_checkpoint_id TEXT DEFAULT NULL UNIQUE
confirmed_context      TEXT NOT NULL DEFAULT ''
unresolved_summary     TEXT NOT NULL DEFAULT ''
evidence_summary       TEXT NOT NULL DEFAULT ''
suggested_next_action  TEXT NOT NULL DEFAULT ''
created_at             TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```

- A scope begins at sequence one. Each later checkpoint extends the current
  head for the same project, scope, and lifecycle with the next sequence and
  causally newer provenance. Updates and deletes fail.
- Index: `idx_workflow_checkpoints_scope` (project_id, scope_key, sequence)
- Two scope chains exist. The `task:` chain belongs to task recovery
  (`gsd_task_recovery_resume`). The `continue:<milestone>[/<slice>[/<task>]]`
  chain is the resume state: the `checkpoint.save` Domain Operation
  (`work-checkpoint.ts`) appends to it for `gsd_checkpoint_save` (`pause` or
  `handoff`) and for the pause checkpoint that session compaction saves for the
  active task.
- The head of a `continue:` chain selects the resume path: the Resume State of
  the execute-task and guided-resume-task prompts, the Resume choice of `/gsd`,
  and the handoff of `/gsd resume-work` (active task, else the newest of the
  active slice and its tasks, else the active milestone). `CONTINUE.md` is a
  one-way render of the row (`renderWorkCheckpoint`); no reader takes resume
  state from `CONTINUE.md`, `continue.md` or `HANDOFF.md`, and the write
  intercept refuses an agent write to a `CONTINUE.md` under `.gsd/milestones`
  or `.gsd/phases`.

Index `idx_workflow_questions_open` supports open-Question lookup by project,
lifecycle, and status.

All nine tables bind to the exact V31 Domain Operation, project revision, and
Authority Epoch that created the fact. Identity and historical content are
immutable; only the Open Question close and Interaction presentation
transitions update existing rows. Planning dates remain advisory data and have
no triggers into Blockers, Attempts, readiness, or lifecycle status.
V33 validates each relational fact but does not yet promise an atomic
multi-table conversation bundle; S06 Domain Operations add that commit boundary
before runtime cutover.

---

### 3h. Additive Recovery And Evidence Foundation (V34)

V34 adds eight canonical shadow tables. It deliberately reuses V32 Lifecycles,
Attempts, Attempt Results, and user- or external-owned Blockers instead of
creating another execution, UAT-run, or blocker model. It does not backfill or reinterpret legacy
verification evidence, assessments, quality gates, gate runs, UAT files, rework
briefs, dispatch retry fields, runtime JSON, or process-local counters. Those
surfaces retain their existing compatibility meaning until the explicit
runtime cutover.

#### `workflow_failure_observations`

```
failure_observation_id  TEXT PRIMARY KEY
project_id              TEXT NOT NULL
lifecycle_id            TEXT NOT NULL
attempt_id              TEXT DEFAULT NULL
result_id               TEXT DEFAULT NULL
blocker_id              TEXT DEFAULT NULL
recovery_owner          TEXT NOT NULL
boundary_stage          TEXT NOT NULL
failure_kind            TEXT NOT NULL
failure_fingerprint     TEXT NOT NULL
summary                 TEXT NOT NULL
evidence_json           TEXT NOT NULL DEFAULT '{}'
observed_at             TEXT NOT NULL
operation_id            TEXT NOT NULL
project_revision        INTEGER NOT NULL
authority_epoch         INTEGER NOT NULL
```

- Boundary stage is `advance | execute | verify | route | closeout`.
- Failure kinds and fingerprints are non-empty, trimmed, lowercase normalized
  values. The kind vocabulary remains extensible so a newer deterministic
  classifier can persist a new normalized kind without a schema migration.
- An `execute` observation requires the matching V32 Attempt and its immutable
  `failed` or `interrupted` Attempt Result. Result provenance must be causally
  older than the observation. A `verify` observation instead requires a
  `succeeded` Result plus the current non-superseded criterion and latest
  non-superseded evidence-backed `fail` or `inconclusive` Technical Verdict
  across tested source revisions. A Result cannot be attached at another
  boundary stage. Updates and deletes fail.
- Recovery owner is an explicit `agent | user | external` classification and
  is not inferred from the extensible failure kind. Agent-owned failures cannot
  carry a Blocker. User/external failures must own the exact open V32 Blocker
  with the matching resolution owner; clarify and pause route only through it.
- Index: `idx_workflow_failure_fingerprint`
  (lifecycle_id, failure_fingerprint, project_revision)

#### `workflow_recovery_budgets`

```
recovery_budget_id  TEXT PRIMARY KEY
project_id          TEXT NOT NULL
lifecycle_id        TEXT NOT NULL
failure_kind        TEXT NOT NULL
failure_fingerprint TEXT NOT NULL
policy_class        TEXT NOT NULL
max_uses            INTEGER NOT NULL
policy_version      TEXT NOT NULL
created_at          TEXT NOT NULL
operation_id        TEXT NOT NULL
project_revision    INTEGER NOT NULL
authority_epoch     INTEGER NOT NULL
```

- A budget is an immutable count allocation for one lifecycle, normalized
  failure kind/fingerprint, policy class, and policy version.
- Only one allocation may exist for a project/lifecycle, failure
  kind/fingerprint, and policy class, regardless of policy version. A restart
  or policy-version change therefore cannot create a fresh allowance for the
  same failure scope.
- `max_uses` counts Recovery Actions after the initial Attempt. It is capped at
  one for deterministic repair and two for transient execution, schema
  correction, remediation, and objective UAT.
- There is no mutable `consumed` counter. Consumption is the authoritative
  `COUNT(*)` of immutable `workflow_recovery_actions` referencing the budget.
  The budget trigger rejects the next budgeted Action when that count reaches
  `max_uses`, so restart cannot reset or double-spend the allowance.
- V34 intentionally does not add cost or elapsed-time budget ledgers. Those
  require canonical Attempt metrics and later policy work.

#### `workflow_recovery_actions`

```
recovery_action_id     TEXT PRIMARY KEY
project_id             TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
failure_observation_id TEXT NOT NULL UNIQUE
action                 TEXT NOT NULL
recovery_budget_id     TEXT DEFAULT NULL
target_lifecycle_id    TEXT DEFAULT NULL
blocker_id             TEXT DEFAULT NULL
rationale              TEXT NOT NULL
policy_version         TEXT NOT NULL
selected_at            TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```

- Action is exactly `retry | repair | replan | remediate | clarify | pause |
  abort`; one Failure Observation can have only one selected Action.
- Retry requires a matching unexhausted budget and the same lifecycle target.
  Repair and remediate also require matching unexhausted budgets and a target
  lifecycle; remediation targets actionable Task work. Replan requires a target
  lifecycle without a budget. Clarify and pause require the existing open V32
  user- or external-owned Blocker owned by the Failure Observation. Abort has
  no budget, target, or blocker.
- Budget policy classes constrain the selected Action: retry accepts
  `transient-execution | schema-correction | objective-uat`, repair accepts
  `deterministic-repair | schema-correction`, and remediate accepts only
  `remediation`.
- The Action must causally follow its Failure Observation. Updates and deletes
  fail.
- Index: `idx_workflow_recovery_actions_budget`
  (recovery_budget_id, project_revision)

#### `workflow_acceptance_criteria`

```
criterion_id             TEXT PRIMARY KEY
criterion_key            TEXT NOT NULL
project_id               TEXT NOT NULL
lifecycle_id             TEXT NOT NULL
requirement_id           TEXT DEFAULT NULL
criterion_kind           TEXT NOT NULL
evidence_class           TEXT NOT NULL
required                 INTEGER NOT NULL
description              TEXT NOT NULL
supersedes_criterion_id  TEXT DEFAULT NULL UNIQUE
created_at               TEXT NOT NULL
operation_id             TEXT NOT NULL
project_revision         INTEGER NOT NULL
authority_epoch          INTEGER NOT NULL
```

- Criterion kind is `technical | subjective_uat`. Evidence class is `command |
  runtime | browser | artifact | human`; technical criteria cannot use `human`
  and subjective UAT must use it.
- `criterion_key` identifies a lineage within one project/lifecycle and
  optional Requirement. A null Requirement means lifecycle-level scope, not a
  wildcard. A changed criterion must supersede the causally older current head
  of the same key, kind, and Requirement scope. Old proof remains historical
  and cannot authorize a verdict for the new head. Updates and deletes fail.

#### `workflow_technical_verdicts`

```
verdict_id             TEXT PRIMARY KEY
project_id             TEXT NOT NULL
criterion_id           TEXT NOT NULL
lifecycle_id           TEXT NOT NULL
attempt_id             TEXT NOT NULL
tested_source_revision TEXT NOT NULL
verdict                TEXT NOT NULL
policy_id              TEXT NOT NULL
policy_version         TEXT NOT NULL
rationale              TEXT NOT NULL
supersedes_verdict_id  TEXT DEFAULT NULL UNIQUE
created_at             TEXT NOT NULL
operation_id           TEXT NOT NULL
project_revision       INTEGER NOT NULL
authority_epoch        INTEGER NOT NULL
```

- Verdict is `pass | fail | inconclusive`. Corrections append to an immutable
  current-head chain for the same criterion, Attempt, and tested source revision.
- Only the current technical criterion and a matching settled V32 Attempt may
  receive a verdict. PASS additionally requires the Attempt Result to be
  `succeeded`. Supersession must advance the project revision without decreasing
  the Authority Epoch, and forks from a non-head verdict are rejected.
- Verification-caused recovery additionally selects the current non-superseded
  criterion and latest non-superseded verdict with Verification Evidence across
  tested source revisions. Superseded, older-source, and evidence-less verdicts
  cannot authorize a Failure Observation or Recovery Action.

#### `workflow_verification_evidence`

```
evidence_id              TEXT PRIMARY KEY
project_id               TEXT NOT NULL
verdict_id               TEXT NOT NULL
criterion_id             TEXT NOT NULL
lifecycle_id             TEXT NOT NULL
attempt_id               TEXT NOT NULL
evidence_class           TEXT NOT NULL
command_or_tool          TEXT NOT NULL
working_directory        TEXT NOT NULL
started_at               TEXT NOT NULL
ended_at                 TEXT NOT NULL
exit_code                INTEGER DEFAULT NULL
observation              TEXT NOT NULL
source_revision          TEXT NOT NULL
observed_project_revision INTEGER NOT NULL
content_hash             TEXT NOT NULL
durable_output_ref       TEXT NOT NULL
environment_json         TEXT NOT NULL
created_at               TEXT NOT NULL
operation_id             TEXT NOT NULL
project_revision         INTEGER NOT NULL
authority_epoch          INTEGER NOT NULL
```

- Evidence class is objective only: `command | runtime | browser | artifact`.
  Observation is `passed | failed | inconclusive`.
- Evidence is owned directly by one Technical Verdict; there is no separate
  membership table. Its criterion, lifecycle, Attempt, source revision,
  operation, project revision, Authority Epoch, and evidence class must match
  the owning verdict bundle. PASS accepts only passed evidence. FAIL may retain
  passed companion checks alongside failed evidence, and INCONCLUSIVE may
  retain passed companions alongside inconclusive evidence. S06 bundle queries
  must require at least one failed or inconclusive observation for those
  verdicts, so an all-passed bundle cannot authorize FAIL or INCONCLUSIVE.
- The observed project revision must be at or after both Attempt settlement and
  creation of the current criterion version, and before the verdict operation.
  Updates and deletes fail.
- Timestamps must be valid and ordered, `content_hash` must be a lowercase
  `sha256:` value with 64 hexadecimal digits, and `environment_json` must be a
  non-empty JSON object. Command/tool, working directory, source revision, and
  durable output reference must all be non-empty.
- A host Task verdict (`attempt.verify`) is refused when its
  `durable_output_ref` does not resolve. A `db://<kind>/<attemptId>` reference
  must name the Attempt under verification; it resolves to this evidence row.
  Any other reference must be the id of an `exec_runs` row.
- The evidence row of a host verification run stores the record of each host
  check in `environment_json.checks`: command, exit code, duration, verdict and
  the bounded stdout/stderr of a failed check. `T##-VERIFY.json` is a copy of
  that record for people; no code reads it.
- Index: `idx_workflow_evidence_verdict` (verdict_id, evidence_id)

#### `workflow_human_acceptances`

```
human_acceptance_id            TEXT PRIMARY KEY
project_id                     TEXT NOT NULL
criterion_id                   TEXT NOT NULL
lifecycle_id                   TEXT NOT NULL
answer_id                      TEXT NOT NULL
question_id                    TEXT NOT NULL
interaction_id                 TEXT NOT NULL
disposition                    TEXT NOT NULL
actor_id                       TEXT NOT NULL
rationale                      TEXT NOT NULL
supersedes_human_acceptance_id TEXT DEFAULT NULL UNIQUE
created_at                     TEXT NOT NULL
operation_id                   TEXT NOT NULL
project_revision               INTEGER NOT NULL
authority_epoch                INTEGER NOT NULL
```

- Disposition is `accepted | rejected`; pending is represented by no row.
- Human Acceptance is separate from Technical Verdict. It requires the current
  `subjective_uat` criterion and the current accepted V33 Answer from an
  answered Question and a `subjective-uat` Interaction. Generic consent cannot
  satisfy this relation. The Answer and Human Acceptance share one user-authored
  Domain Operation, and `actor_id` must match that operation's user actor.
- Corrections append a new current head for the same criterion. Updates and
  deletes fail.

#### `workflow_remediation_links`

```
remediation_link_id     TEXT PRIMARY KEY
project_id              TEXT NOT NULL
source_lifecycle_id     TEXT NOT NULL
technical_verdict_id    TEXT DEFAULT NULL
human_acceptance_id     TEXT DEFAULT NULL
route_kind              TEXT NOT NULL
remediation_fingerprint TEXT NOT NULL
required_outcome        TEXT NOT NULL
target_lifecycle_id     TEXT NOT NULL
created_at              TEXT NOT NULL
operation_id            TEXT NOT NULL
project_revision        INTEGER NOT NULL
authority_epoch         INTEGER NOT NULL
```

- Exactly one source is required: a `fail | inconclusive` Technical Verdict or
  the current rejected Human Acceptance. A technical source must already own at
  least one Verification Evidence row; S06 still owns aggregate evidence
  completeness and observation-specific validation.
- Route kind is `rework | remediation`. Rework targets the source lifecycle;
  remediation targets distinct, actionable Task work. Fingerprints are
  normalized and duplicate source/target/fingerprint routes are rejected.
- Links are immutable durable history; later fresh verdicts or acceptance
  facts show that the required outcome was achieved rather than mutating the
  original link.

All eight tables bind to the exact V31 Domain Operation, project revision, and
Authority Epoch that created the fact. V34 validates individual causal facts,
scope, immutability, criterion lineage, count-budget eligibility, proof
ownership, subjective acceptance, and remediation routing. It does not yet
guarantee that every Failure Observation has a Recovery Action or that every
Technical Verdict has its Evidence: SQLite immediate insert constraints cannot
safely enforce those circular bundle-completeness rules.

Command-specific writers use the Domain Operation boundary to atomically commit
each failure/action bundle, each verdict/evidence bundle, and any applicable
remediation links. Task execution, recovery, publication, Slice lifecycle, and
Milestone validation/completion/reopen writers have cut over. Kernel queries
require bundle completeness before dispatch or closeout.

### 3i. Additive Projection, Import, Kernel, And Closeout Foundation (V35)

V35 adds six tables for durable projection delivery, sealed imports,
restart-safe kernel position, and closeout settlement. It reuses V31–V34
authority, Lifecycle, Attempt, recovery, and evidence records instead of
creating parallel project, work-item, execution, or recovery models. The
migration is additive: it performs no legacy backfill and does not cut runtime
readers, writers, adapters, or lifecycle completion over to these tables.

#### `workflow_projection_work`

```
projection_work_id          TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
projection_key              TEXT NOT NULL
projection_kind             TEXT NOT NULL
supersedes_projection_work_id TEXT DEFAULT NULL UNIQUE
source_project_revision     INTEGER NOT NULL
source_authority_epoch      INTEGER NOT NULL
renderer_version            TEXT NOT NULL
delivery_state              TEXT NOT NULL DEFAULT 'pending'
state_version               INTEGER NOT NULL DEFAULT 0
claim_owner                 TEXT DEFAULT NULL
claim_fencing_token         INTEGER NOT NULL DEFAULT 0
claimed_at                  TEXT DEFAULT NULL
claim_expires_at            TEXT DEFAULT NULL
attempt_count               INTEGER NOT NULL DEFAULT 0
next_attempt_at             TEXT NOT NULL DEFAULT ''
last_error                  TEXT NOT NULL DEFAULT ''
rendered_content_hash       TEXT DEFAULT NULL
rendered_at                 TEXT DEFAULT NULL
enqueue_operation_id        TEXT NOT NULL
created_at                  TEXT NOT NULL
updated_at                  TEXT NOT NULL
```

- Each normalized projection key has one immutable desired-work lineage.
  Successors name the causally older current head and advance the source
  revision without decreasing the Authority Epoch.
- Delivery state is `pending | claimed | rendered | dead_letter`. Claims and
  renewals are fenced and versioned; completed attempts increment the durable
  cumulative count. A retry records a nonempty diagnostic and future backoff;
  the next claim preserves both. Superseded rows cannot be claimed or rendered.
- Enqueue provenance binds to the exact V31 Domain Operation. Delivery updates
  are operational mutations and intentionally do not create Domain Operations
  or advance the project revision. Currentness is per logical projection key,
  so an unrelated project operation does not stale a rendered projection.
- Delivery scans use `idx_workflow_projection_delivery`; current-head scans
  reuse the unique `(project_id, projection_key, source_project_revision)` index.

#### `workflow_import_applications`

```
operation_id                  TEXT PRIMARY KEY
project_id                    TEXT NOT NULL
import_kind                   TEXT NOT NULL
importer_version              TEXT NOT NULL
preview_schema_version        INTEGER NOT NULL
preview_id                    TEXT NOT NULL UNIQUE
preview_hash                  TEXT NOT NULL UNIQUE
base_project_revision         INTEGER NOT NULL
base_authority_epoch          INTEGER NOT NULL
base_database_schema_version  INTEGER NOT NULL
source_set_hash               TEXT NOT NULL
change_set_hash               TEXT NOT NULL
create_count                  INTEGER NOT NULL
update_count                  INTEGER NOT NULL
delete_count                  INTEGER NOT NULL
preserve_count                INTEGER NOT NULL
unparsed_count                INTEGER NOT NULL
unresolved_count              INTEGER NOT NULL
preview_json                  TEXT NOT NULL
backup_ref                    TEXT NOT NULL
backup_sha256                 TEXT NOT NULL
backup_byte_size              INTEGER NOT NULL
backup_schema_version         INTEGER NOT NULL
backup_project_revision       INTEGER NOT NULL
backup_authority_epoch        INTEGER NOT NULL
backup_quick_check            TEXT NOT NULL
backup_verified_at            TEXT NOT NULL
applied_at                    TEXT NOT NULL
resulting_project_revision    INTEGER NOT NULL
resulting_authority_epoch     INTEGER NOT NULL
```

- Preview generation is non-authoritative. One immutable receipt seals the
  versioned preview envelope, ordered source/change fingerprints, raw legacy
  diagnoses, explicit resolutions, and aggregate counts used by application.
  Envelope metadata, hashes, and counts must exactly match their receipt
  columns, and the `import.apply` operation request hash must equal the sealed
  preview hash.
- Application requires `unresolved_count = 0` and records independently
  verified backup metadata with `quick_check = ok`; the schema requires that
  metadata's schema/revision/epoch to match the base snapshot. The deferred
  import application writer owns opening and hashing the referenced backup
  before insertion.
- The receipt must bind to an `import.apply` V31 operation whose expected tuple
  matches the base, whose request hash matches the preview hash, and whose exact
  resulting tuple matches the receipt; its resulting revision is exactly the
  base revision plus one. A receipt makes that operation immutable. Updates,
  deletes, duplicate preview identities, and duplicate preview hashes fail.
- V35 validates lowercase `sha256:` shape and equality between repeated receipt,
  preview-envelope, and operation fields. SQLite does not recompute SHA-256;
  S06 must canonicalize the preview and verify its source/change hashes before
  the receipt transaction.

#### `workflow_authority_cutovers`

```
operation_id                TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
authority_contract_version INTEGER NOT NULL
evidence_hash               TEXT NOT NULL
consent_hash                TEXT NOT NULL
cutover_at                  TEXT NOT NULL
resulting_project_revision  INTEGER NOT NULL
resulting_authority_epoch   INTEGER NOT NULL
```

- The receipt must match one `authority.cutover` operation that advances the
  project revision and Authority Epoch by exactly one. Project/epoch pairs are
  unique. Receipt and linked operation rows are immutable.

#### `workflow_import_restores`

```
operation_id                            TEXT PRIMARY KEY
project_id                              TEXT NOT NULL
application_operation_id               TEXT NOT NULL
application_identity_hash              TEXT NOT NULL
application_resulting_project_revision INTEGER NOT NULL
application_resulting_authority_epoch  INTEGER NOT NULL
erased_lineage_hash                     TEXT NOT NULL
erased_lineage_json                     TEXT NOT NULL
preview_id                              TEXT NOT NULL
preview_hash                            TEXT NOT NULL
backup_id                               TEXT NOT NULL
backup_sha256                           TEXT NOT NULL
backup_byte_size                        INTEGER NOT NULL
backup_schema_version                   INTEGER NOT NULL
backup_project_revision                 INTEGER NOT NULL
backup_authority_epoch                  INTEGER NOT NULL
difference_hash                         TEXT NOT NULL
consent_hash                            TEXT NOT NULL
verification_hash                       TEXT NOT NULL
restored_at                             TEXT NOT NULL
resulting_project_revision              INTEGER NOT NULL
resulting_authority_epoch               INTEGER NOT NULL
```

- Restore replaces the live database with the verified pre-Application backup
  and therefore deliberately does not reference the erased Application or its
  operation by foreign key. The erased identity is retained as checked JSON
  plus scalar digests.
- The restored database records one `import.restore` operation whose resulting
  project revision is the backup revision plus one, at the unchanged backup
  Authority Epoch. The erased Application operation and receipt must be absent.
  Restore receipts and their linked operation are immutable.

#### `workflow_import_forward_repairs`

```
operation_id                 TEXT PRIMARY KEY
project_id                   TEXT NOT NULL
application_operation_id    TEXT NOT NULL
application_identity_hash   TEXT NOT NULL
preview_id                   TEXT NOT NULL
preview_hash                 TEXT NOT NULL
backup_id                    TEXT NOT NULL
difference_hash              TEXT NOT NULL
plan_schema_version          INTEGER NOT NULL
plan_hash                    TEXT NOT NULL UNIQUE
plan_json                    TEXT NOT NULL
target_count                 INTEGER NOT NULL
mutation_count               INTEGER NOT NULL
preserved_count              INTEGER NOT NULL
rejected_count               INTEGER NOT NULL
unresolved_count             INTEGER NOT NULL
repaired_at                  TEXT NOT NULL
resulting_project_revision   INTEGER NOT NULL
resulting_authority_epoch    INTEGER NOT NULL
```

- Forward Repair requires the retained Import Application and its exact
  index-zero `legacy-import.applied` event. It advances revision once without
  lowering or advancing the Authority Epoch.
- The checked plan envelope binds the Application, Preview, backup, difference,
  and complete disposition accounting. `target_count` equals the mutation,
  preserved, and rejected counts; unresolved work must be zero. Receipt and
  linked operation rows are immutable.

#### `workflow_kernel_checkpoints`

```
kernel_checkpoint_id          TEXT PRIMARY KEY
project_id                    TEXT NOT NULL
lifecycle_id                  TEXT NOT NULL
attempt_id                    TEXT NOT NULL
next_stage                    TEXT NOT NULL
sequence                      INTEGER NOT NULL
previous_kernel_checkpoint_id TEXT DEFAULT NULL UNIQUE
created_at                    TEXT NOT NULL
operation_id                  TEXT NOT NULL
project_revision              INTEGER NOT NULL
authority_epoch               INTEGER NOT NULL
```

- Absence of a checkpoint means Advance. The first row is sequence one,
  records Execute, and shares the exact operation/revision/epoch tuple that
  claimed its V32 Attempt.
- Checkpoints form one immutable, gap-free, no-fork current-head chain per
  lifecycle. Stages are `execute | verify | route | closeout | settled`.
- Ordinary successors retain the Attempt. An Attempt change requires Execute
  and a descendant retry/reopen Attempt linked to the previous Attempt. The
  S03/S04 Task execution and recovery policy owns legal stage prerequisites
  and atomic sibling facts.
- Current-head scans reuse the unique `(project_id, lifecycle_id, sequence)` index.

#### `workflow_closeout_plans`

```
closeout_plan_id            TEXT PRIMARY KEY
project_id                  TEXT NOT NULL
lifecycle_id                TEXT NOT NULL
attempt_id                  TEXT NOT NULL
tested_source_set_hash      TEXT NOT NULL
readiness_basis_hash        TEXT NOT NULL
supersedes_closeout_plan_id TEXT DEFAULT NULL UNIQUE
prepared_at                 TEXT NOT NULL
operation_id                TEXT NOT NULL
project_revision            INTEGER NOT NULL
authority_epoch             INTEGER NOT NULL
```

- A plan requires a causally prior settled Attempt of its lifecycle. The
  Attempt must have succeeded, or the lifecycle must hold a causally prior
  active `milestone-validation` Waiver that has not expired. One immutable
  lineage exists per lifecycle; its head is current.
- Plan Attempt trigger (non-versioned,
  `db-projection-import-kernel-closeout-foundation-schema.ts`):
  `ensureCloseoutPlanAttemptTrigger` creates
  `trg_workflow_closeout_plan_attempt` on every open that does not find it
  with the Waiver branch, and replaces a trigger without that branch. The
  startup-repair check (`hasCloseoutPlanAttemptTrigger`) starts that open.
- Supersession preserves project/lifecycle and may retain the Attempt or name a
  later Attempt in the same lifecycle. There is no mutable plan status.
- Tested-source and readiness-basis hashes must use lowercase `sha256:` format;
  `db/writers/closeout.ts` builds the canonical input and the hash.
- Index: `idx_workflow_closeout_plan_head`.
- Production use: `prepareCloseout` in `closeout-domain-operation.ts` stores a
  plan and its effects in one `milestone.closeout.prepare` operation, only for
  a Milestone whose work is on a milestone branch. `milestone.complete` fails
  while a required effect of the current plan has no receipt. Tasks and Slices
  have no plan.
- Production supersession: `supersedeCloseoutPlan` stores a successor plan with
  the same effects and no receipts, through the same operation type. It runs
  when the commit of a `performed` merge receipt is no longer on the
  integration branch and the milestone work is on that branch again. The merge
  is then recorded as `recognized` under the successor plan; the old plan and
  its receipts stay.

#### `workflow_closeout_effects`

```
closeout_effect_id TEXT PRIMARY KEY
closeout_plan_id   TEXT NOT NULL
project_id         TEXT NOT NULL
lifecycle_id       TEXT NOT NULL
ordinal            INTEGER NOT NULL
effect_kind        TEXT NOT NULL
idempotency_key    TEXT NOT NULL
effect_spec_json   TEXT NOT NULL
effect_spec_hash   TEXT NOT NULL
created_at         TEXT NOT NULL
operation_id       TEXT NOT NULL
project_revision   INTEGER NOT NULL
authority_epoch    INTEGER NOT NULL
```

- Settlement-critical host effects are immutable and inserted in contiguous
  ordinal order. Idempotency keys are unique within a plan and may recur on a
  superseding plan so an adapter can recognize an earlier host result.
- Every effect is born with the exact preparation operation/revision/epoch
  tuple of its plan. Effects cannot be added after the plan is superseded or
  after receipt settlement begins. A plan may have zero host effects.
- Effect specs must be nonempty JSON objects and their hashes must use lowercase
  `sha256:` format. `db/writers/closeout.ts` owns canonicalization and the
  hash; `milestone-closeout-effects.ts` is the host adapter.
- Effect kinds in production, in ordinal order: `milestone-merge` (required),
  then `integration-push` and `github-milestone-close` (not required; they
  never gate completion). The `required` flag is stored in the effect spec.
- The host runs an effect only when every effect before it has a receipt. An
  effect that is not run stays pending and the next closeout pass tries it
  again. Thus a failed GitHub close cannot block the push receipt, and the
  GitHub close waits for the push.

#### `workflow_settlement_receipts`

```
settlement_receipt_id TEXT PRIMARY KEY
closeout_effect_id    TEXT NOT NULL UNIQUE
project_id            TEXT NOT NULL
lifecycle_id          TEXT NOT NULL
outcome               TEXT NOT NULL
external_ref          TEXT NOT NULL
proof_json            TEXT NOT NULL
proof_hash            TEXT NOT NULL
settled_at            TEXT NOT NULL
operation_id          TEXT NOT NULL
project_revision      INTEGER NOT NULL
authority_epoch       INTEGER NOT NULL
```

- Receipts are immutable success-only facts with outcome `performed |
  recognized`. Missing receipt means pending; failures remain V34 Failure
  Observations and Recovery Actions rather than failed receipts.
- Each effect has at most one receipt. Receipts advance in effect-ordinal
  order, causally follow plan creation, and cannot be added to a superseded
  plan. Current plan plus complete receipt coverage is the settlement state;
  V35 adds no settlement aggregate.
- Receipt proofs must be nonempty JSON objects and their hashes must use
  lowercase `sha256:` format. `db/writers/closeout.ts` builds the canonical
  proof and hash; each receipt is one `milestone.closeout.settle_effect`
  operation.
- Index: `idx_workflow_settlement_receipt_scope`.

V35 enforces local shape, provenance, lineage, immutability, delivery fencing,
and settlement ordering. The Domain Operation boundary owns the base
atomic provenance/event/outbox/Projection Work bundle and authority CAS. Later
milestones own command-specific adapters and sibling facts, queries, stage and
readiness prerequisites, runtime cutover, and final lifecycle completion.

---

## 4. Entity Relationship Diagram

```
milestones ──┐
  │ id        │ (depends_on → milestones.id, via JSON)
  │           │
  ▼           │
slices ───────┘
  │ (milestone_id, id) PRIMARY KEY
  │
  ├──► slice_dependencies (milestone_id, slice_id, depends_on_slice_id)
  │
  ▼
tasks
  │ (milestone_id, slice_id, id) PRIMARY KEY
  │
  ├──► verification_evidence (milestone_id, slice_id, task_id)
  ├──► quality_gates (milestone_id, slice_id, gate_id, task_id)
  └──► unit_dispatches.task_id (via coordination layer)

milestones ──► replan_history (milestone_id)
milestones ──► assessments (milestone_id)
milestones ──► milestone_leases (milestone_id) ◄── workers
milestones ──► unit_dispatches (milestone_id) ◄── workers
milestones ──► milestone_commit_attributions (milestone_id)
milestones ──► milestone_integration_branches (milestone_id, no FK)

memories ──► memories_fts (FTS5 virtual, via triggers)
memories ──► memory_embeddings (memory_id)
memories ──► memory_relations (from_id, to_id)
memory_sources ──► (imported content, feeds memories)

unit_dispatches ──► cancellation_requests (dispatch_id)
unit_dispatches ──► verification_evidence (verification_evidence_id)

decisions  (independent, supersedable)
requirements  (independent, supersedable)
artifacts  (independent, keyed by path)
gate_runs  (audit, keyed by trace_id + turn_id + gate_id)
turn_git_transactions  (audit, keyed by trace_id + turn_id + stage)
audit_events  (append-only audit log)
audit_turn_index  (turn-level index into audit_events)
runtime_kv  (soft state KV)

project_authority ──► workflow_operations (project_id)
workflow_operations ──► workflow_domain_events
  (operation_id + project_id + resulting revision + resulting Authority Epoch)
workflow_domain_events ──► workflow_domain_events (caused_by_event_id)
workflow_domain_events ──► workflow_outbox (event_id)

milestones/slices/tasks ──► workflow_item_lifecycles
workflow_item_lifecycles ──► workflow_execution_attempts
workflow_execution_attempts ──► workflow_attempt_results
workflow_item_lifecycles ──► workflow_blockers
workflow_item_lifecycles ──► workflow_waivers
requirements ──► workflow_waivers
requirements ──► workflow_requirement_dispositions
workflow_waivers ──► workflow_requirement_dispositions
workflow_blockers ──► workflow_waivers

workflow_item_lifecycles ──► workflow_milestone_contexts
workflow_item_lifecycles ──► workflow_open_questions
workflow_open_questions ──► workflow_question_dependencies ──► workflow_item_lifecycles
workflow_open_questions ──► workflow_interactions ──► workflow_interaction_options
workflow_interactions ──► workflow_answers ──► workflow_conversation_decisions
workflow_conversation_decisions ──► workflow_decision_impacts ──► workflow_item_lifecycles
workflow_item_lifecycles ──► workflow_work_checkpoints

workflow_item_lifecycles ──► workflow_failure_observations
workflow_failure_observations ──► workflow_recovery_actions
workflow_recovery_budgets ──► workflow_recovery_actions
workflow_item_lifecycles ──► workflow_acceptance_criteria
workflow_acceptance_criteria ──► workflow_acceptance_criteria (supersession lineage)
workflow_acceptance_criteria ──► workflow_technical_verdicts
workflow_execution_attempts ──► workflow_technical_verdicts
workflow_technical_verdicts ──► workflow_verification_evidence
workflow_answers ──► workflow_human_acceptances
workflow_technical_verdicts ──┐
                              ├──► workflow_remediation_links ──► workflow_item_lifecycles
workflow_human_acceptances ───┘

workflow_operations ──► workflow_projection_work (enqueue provenance)
workflow_operations ──► workflow_import_applications
workflow_operations ──► workflow_authority_cutovers
workflow_operations ──► workflow_import_restores
workflow_operations ──► workflow_import_forward_repairs ──► workflow_import_applications
workflow_item_lifecycles ──► workflow_kernel_checkpoints
workflow_execution_attempts ──► workflow_kernel_checkpoints
workflow_kernel_checkpoints ──► workflow_kernel_checkpoints (current-head chain)
workflow_item_lifecycles ──► workflow_closeout_plans
workflow_execution_attempts ──► workflow_closeout_plans
workflow_closeout_plans ──► workflow_closeout_plans (supersession lineage)
workflow_closeout_plans ──► workflow_closeout_effects ──► workflow_settlement_receipts

workflow_operations ──► all V32 lifecycle records
  (operation + project + revision + Authority Epoch provenance)
workflow_operations ──► all V33 guided-conversation records
  (operation + project + revision + Authority Epoch provenance)
workflow_operations ──► all V34 recovery/evidence records
  (operation + project + revision + Authority Epoch provenance)
workflow_operations ──► all V35 import/kernel/closeout records
  (operation + project + revision + Authority Epoch provenance;
   projection delivery transitions are operational and do not advance revision)
```

---

## 4b. Recovery And Worktree Merge Surfaces

`.gsd/state-manifest.json` snapshots legacy DB-backed correctness state: requirements,
artifacts, milestones, slices, tasks, decisions, replan history, assessments,
quality gates, verification evidence, and milestone commit attributions. Restore
rebuilds decision mirror memories from the restored decisions and preserves
optional rows when reading older manifests that predate the extended arrays.
The additive V31 canonical-foundation, V32 lifecycle-foundation, V33
guided-conversation, V34 recovery/evidence, and V35 projection/import/kernel/
closeout tables are
not part of this legacy manifest surface. Restore and hierarchy-replacement
paths now refuse to run when adopted lifecycle rows exist, preventing the
legacy snapshot from deleting canonical history.

`.gsd/state.json` is the GSD state contract v1 projection for external readers
such as GSD Workbench. Its schema is owned by `gsd-workbench`'s
`docs/state-contract/v1.md`; this repository writes contract `1.0.0` with flavor
`pi` whenever it writes the legacy state manifest. The projection describes the
active milestone and its slices and includes a deliberately approximate,
stale-tolerant next-command hint. It is a local runtime projection, not a restore
or worktree-merge input.

`reconcileWorktreeDb` runs only from the explicit `/worktree import-db` command;
no merge, teardown, or projection path calls it. Its `preview` option returns
the row counts, the conflicts and every hierarchy status change (also the
changes of the lifecycle adoption) and changes no row. Its `confirmed` option
commits the merge only when the result equals that preview. The command takes a
snapshot of the project database before the merge. It merges the legacy
correctness rows of a worktree-local `gsd.db` into the main DB, including hierarchy, requirements, artifacts, memories, replan history,
assessments, quality gates, slice dependencies, verification evidence, gate
runs, and milestone commit attributions. Runtime-only/audit substrates such as
`runtime_kv`, `turn_git_transactions`, `audit_events`, and `audit_turn_index`
remain outside manifest restore. The V31 canonical-foundation, V32
lifecycle-foundation, V33 guided-conversation, V34 recovery/evidence, and V35
projection/import/kernel/closeout tables remain outside worktree reconciliation.
Before merging legacy rows, reconciliation detects worktree operations or
lifecycle heads that are missing from, newer than, or inconsistent with main
and fails closed. Hierarchy merging uses identity-preserving UPSERTs and does
not overwrite a status protected by a newer canonical lifecycle head. When the
main lifecycle is newer, worktree planning fields may still merge, but main-side
completion summaries, verification results, blocker/escalation facts, and other
execution evidence remain authoritative. The merge runs in one
`lifecycle.backfill` Domain Operation with one revision bump. Each hierarchy
row that the merge inserts gets its lifecycle row in that operation, by the
rules of the lifecycle backfill. At Authority Epoch 0 a row that main already
held keeps its adoption state, and the merge never refuses for adoption: an
inserted row with an unknown raw status, or whose adoption would change its
legacy status (a legacy completion with no evidence, or open work under a
completed or cancelled parent), merges with no lifecycle row and waits for
`/gsd db adopt`. After the Cutover the merge applies those status changes,
logs them and returns them in `adoptionStatusChanges`. An inserted row with an
unknown raw status then refuses the whole merge as a canonical divergence, so
the worktree is kept; the error names each row and the `sqlite3` statement
that gives it a known status in the worktree database. After the Cutover the
same operation also adopts each row that main already held with no lifecycle
row. If such a row has an unknown raw status, the coverage fence refuses the
commit; that is a canonical divergence too, so the worktree is kept, and the
error names the row and `/gsd db adopt`.

---

## 5. Complete gsd_* Tool → Table Map

| Tool | Tables READ | Tables WRITTEN | Disk Artifacts |
|------|------------|----------------|----------------|
| `gsd_decision_save` | project_authority, workflow_operations, memories | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, memories (`category = "architecture"`); decision text never changes a Slice status | DECISIONS.md (projection) |
| `gsd_requirement_save` | project_authority, workflow_operations, requirements | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, requirements (one `requirement.save` operation) | REQUIREMENTS.md (projection) |
| `gsd_requirement_update` | project_authority, workflow_operations, requirements | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, requirements (one `requirement.update` operation) | REQUIREMENTS.md (projection) |
| `gsd_summary_save` | project_authority, workflow_operations, milestones, slices, tasks, requirements | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, artifacts (one `artifact.save` operation); also `slices.full_uat_md` for `UAT` and new `queued` milestones rows with their `ready` workflow_item_lifecycles rows for `PROJECT`, in the same operation. A task `SUMMARY` is the exception: the projection write stores its artifacts row with no operation | M##/S##/T## artifact files; STATE.md |
| `gsd_milestone_generate_id` | project_authority, workflow operations, milestones | project_authority, workflow operations/events/Projection Work, milestones (new `queued` row) and workflow_item_lifecycles (its `ready` row), in one `milestone.register` Domain Operation | STATE.md |
| `gsd_plan_milestone` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, milestones, slices | ROADMAP.md |
| `gsd_plan_slice` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices, tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, quality_gates, slices metadata; tasks and their `required_workflow_tools` only when a non-empty `tasks` payload performs full replacement/update; removed pending tasks become `skipped`/`cancelled` | NN-MM-PLAN.md with active task planning when tasks exist |
| `gsd_plan_task` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices, tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, quality_gates, one task planning row including `required_workflow_tools` | re-renders NN-MM-PLAN.md; task PLAN paths resolve to the slice plan |
| `gsd_task_complete` | project_authority, workflow operations/lifecycles, current Attempt/Result/verdict/evidence, tasks, slices, rework briefs/findings | project_authority, workflow operations/events/outbox/Projection Work, Attempt Result/checkpoints, Technical Verdict evidence/publication, tasks, verification evidence, rework findings | S##-T##-SUMMARY.md; toggles checkbox in NN-MM-PLAN.md after commit; reads legacy T##-SUMMARY.md |
| `gsd_slice_complete` | project_authority, workflow operations/lifecycles, Tasks and their Attempts/Results/verdict evidence, milestones, slices, quality_gates | project_authority, workflow operations/events/outbox/Projection Work, Milestone/Slice lifecycles, milestones, slices, quality_gates, gate_runs | S##-SUMMARY.md, S##-UAT.md; toggles checkpoint in ROADMAP.md after commit |
| `gsd_uat_result_save` | project_authority, workflow_operations, slices, artifacts, gate_runs (the highest UAT `attempt` of the Slice gives the next attempt number), exec_runs (each cited `gsd_exec` / `gsd_uat_exec` evidence ref) | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, artifacts, assessments, quality_gates, gate_runs (one `uat-result.save` operation) | S##-ASSESSMENT.md; UAT attempt JSON, both written after commit. A replay writes the attempt JSON again from the stored result |
| `gsd_complete_milestone` | project_authority, workflow operations/lifecycles, current validation Attempt/Result/verdict/evidence, Waivers, milestones, slices, tasks | project_authority, workflow operations/events/outbox/Projection Work, Milestone lifecycle, milestones. For an adopted Milestone with a milestone branch, validated or closed out on a validation Waiver, the tool writes workflow_closeout_plans and workflow_closeout_effects and leaves the Milestone open; the host writes workflow_settlement_receipts and completes the Milestone after the merge. For a waived Milestone the plan cites the newest settled validation Attempt; when validation never ran, the tool first writes one workflow_execution_attempts row and one workflow_attempt_results row (outcome `interrupted`, failure class `validation-waived`) in an `attempt.settle` operation with a `milestone.validation.attempt_waived` event | M##-SUMMARY.md projection after commit |
| `gsd_validate_milestone` | project_authority, Milestone lifecycle, planned verification classes, current criteria/verdict/evidence, milestones, slices, tasks | project_authority, workflow operations/events/outbox/Projection Work, validation Attempts/Results, acceptance criteria, Technical Verdicts/evidence, assessments, quality_gates, gate_runs | VALIDATION.md projection after commit |
| `gsd_prepare_milestone_subjective_uat` | project_authority, Milestone lifecycle, current acceptance criteria, open questions, interactions, and validation events | project_authority, workflow operations/events/outbox/Projection Work, acceptance criteria, open questions, interactions, and interaction options | — |
| `/gsd uat-answer` (host command, no model tool; writes only from the terminal UI, not from an RPC or headless session) | project_authority, Milestone lifecycle, current subjective criterion, open question, interaction/options, validation events, and Human Acceptance | project_authority, workflow operations/events/outbox/Projection Work, Answers, Human Acceptance, and open-question/interactions status | — |
| `gsd_reassess_roadmap` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, milestones, slices, assessments; removed pending slices become `skipped`/`cancelled`; optional `metadataCorrections` updates only approved milestone acceptance fields and completed-slice evidence fields | ROADMAP.md, ROADMAP-ASSESSMENT.md; milestone corrections also invalidate stale VALIDATION.md |
| `gsd_replan_slice` | project_authority, workflow_operations, workflow_item_lifecycles, milestones, slices, tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, slices, tasks (including `required_workflow_tools`), replan_history, quality_gates; removed pending tasks become `skipped`/`cancelled` | NN-MM-PLAN.md, NN-MM-REPLAN.md |
| `gsd_replan_task` | project_authority, workflow_operations, workflow_item_lifecycles, slices, tasks | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_item_lifecycles, one pending task planning row including `required_workflow_tools`, replan_history | re-renders the task/slice PLAN projection |
| `gsd_rework_brief_save` | project_authority, workflow_operations, rework_briefs, rework_brief_findings | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, rework_briefs, rework_brief_findings (one `rework-brief.save` operation) | Task line in the Slice plan and Task SUMMARY (projection) |
| `gsd_skip_slice` | project_authority, workflow operations/lifecycles, slices, tasks, running Attempts and dispatches | project_authority, workflow operations/events/outbox/Projection Work, Slice/Task lifecycles, Slice-scoped Waiver, workflow execution Attempts, immutable Attempt Results, Kernel checkpoints, slices, tasks, dispatches | readable state projections after commit |
| `gsd_task_reopen` | tasks, slices, milestones | tasks | deletes S##-T##-SUMMARY.md and legacy T##-SUMMARY.md |
| `gsd_task_recovery_resume` | project_authority, workflow_operations, workflow_item_lifecycles, workflow_execution_attempts, workflow_failure_observations, workflow_recovery_actions, workflow_blockers, workflow_domain_events, workflow_work_checkpoints | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_work_checkpoints | — |
| `gsd_checkpoint_save` | project_authority, workflow_operations, workflow_item_lifecycles, workflow_work_checkpoints | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, workflow_work_checkpoints (one `checkpoint.save` operation) | CONTINUE.md of the slice or milestone (render of the head checkpoint) |
| `gsd_slice_reopen` | project_authority, workflow operations/lifecycles, workflow_waivers, slices, tasks, immutable execution history | project_authority, workflow operations/events/outbox/Projection Work, Slice/Task lifecycles, workflow_waivers, slices, tasks, quality_gates; removes the stale evidence of the Slice (verification_evidence, run-uat assessments and their artifacts, the UAT gate, uat_retry_counters), keeps the removed rows in the reopen event payload, and sets `attempt_ref` of its `uat_exec` exec_runs to NULL | repairs/removes Slice, UAT, Task SUMMARY, PLAN, ROADMAP, and STATE projections after commit |
| `gsd_milestone_reopen` | project_authority, workflow operations/lifecycles, Waivers and Requirement Dispositions, milestones, slices, tasks, active Attempts, dependent Milestones | project_authority, workflow operations/events/outbox/Projection Work, Milestone/Slice/Task lifecycles, Waiver dispositions, milestones, slices, tasks, quality_gates; removes the milestone-validation assessment and, for each reopened Slice, the same stale evidence as `gsd_slice_reopen`, and keeps the removed rows in the reopen event payload | fenced removal or repair of Milestone, Slice, UAT, Task, PLAN, ROADMAP, and STATE projections after commit |
| `gsd_milestone_park`, `gsd_milestone_unpark` | project_authority, workflow operations/lifecycles, milestones | project_authority, workflow operations/events/Projection Work, Milestone lifecycle, milestones.status | PARKED.md rendered or removed after commit; STATE.md |
| `gsd_milestone_discard` | project_authority, workflow operations/lifecycles, milestones, slices, tasks | project_authority, workflow operations/events/Projection Work, Milestone/Slice/Task lifecycles, milestone-scoped Waiver, milestones, slices, tasks | milestone directory, worktree and branch removed after commit; QUEUE-ORDER.json; STATE.md |
| `gsd_milestone_reorder` | project_authority, workflow operations, milestones | project_authority, workflow operations/events/Projection Work, milestones.sequence | QUEUE-ORDER.json; STATE.md |
| `gsd_milestone_set_dependencies` | project_authority, workflow operations, milestones | project_authority, workflow operations/events/Projection Work, milestones.depends_on | STATE.md |
| `gsd_research_decision_save` | project_authority, workflow operations | project_authority, workflow operations/events/Projection Work (one `project.setup.record` operation; the deep project setup gate reads the newest event) | STATE.md |
| `gsd_save_gate_result` | project_authority, workflow_operations, quality_gates | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, quality_gates, gate_runs (one `gate-result.save` operation) | Slice plan (projection) |
| `capture_thought` | project_authority, workflow_operations, memories | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work, memories (one `knowledge.capture` operation for `rule`, `pattern` or `gotcha`; one `memory.capture` operation for other categories) | KNOWLEDGE.md, rendered after each `rule`, `pattern` or `gotcha` capture |
| `gsd_capture_resolve` | project_authority, workflow_operations, workflow_domain_events (`capture.*`), milestones (active milestone) | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work (one `capture.resolve` operation) | CAPTURES.md, rendered after the operation |
| `gsd_capture_complete` | project_authority, workflow_operations, workflow_domain_events (`capture.*`) | project_authority, workflow_operations, workflow_domain_events, workflow_outbox, workflow_projection_work (one `capture.execute` operation; none when the capture is already executed) | CAPTURES.md, rendered after the operation |
| `memory_query` | memories, memories_fts, memory_embeddings | memories (hit_count++) | — |

Slice lifecycle writers own the taskless Q8 companion gate. Planning or
replanning a Slice, and reopening its Task, Slice, or Milestone hierarchy,
must establish exactly one Q8 row for that Slice and reset it to `pending`;
duplicate companion rows fail the operation instead of being silently retained.

The six planning mutations above commit legacy hierarchy changes, lifecycle
adoption or transition, one domain event/outbox destination, Projection Work,
and the project revision in one Domain Operation. Replays return the original
receipt and retry projection without rerunning the mutation. Replan and roadmap
assessment artifacts are rebuilt from the committed domain event or assessment
row, including its original creation time. Removed pending work retains its
hierarchy and lifecycle identity as legacy `skipped` and canonical `cancelled`;
active projections omit it, and explicit reopen is required before reuse.

The three Slice lifecycle mutations use the same operation ledger and stable
private identity across Pi, workflow MCP aliases, and internal adapters.
Cancellation preserves completed Tasks, records the dependency-bypass decision
in a durable Waiver, and atomically interrupts running descendants; completion
requires evidence-backed terminal descendant parity; reopen/reset moves the
full terminal subtree to legacy Slice `in_progress`, legacy Tasks `pending`, and
canonical `ready` without
deleting Attempts, Results, verdicts, evidence, dispatches, or checkpoints.
Progressed transitive dependents must be reopened first. Rendering is
post-commit. A stale public result
means canonical state is committed and readable projections remain queued for
repair; an exact retry reports `duplicate` without creating another operation.
A historical retry reports both `duplicate` and `superseded` and cannot repair
or present itself as the current lifecycle result.
While the Authority Epoch of the Project is 0, active-Slice selection still
recognizes legacy `skipped` directly. After the Cutover the read interface
`db/lifecycle-read.ts` requires the current active Waiver; see
[`dev/state-db-cutover-milestone-decision.md`](dev/state-db-cutover-milestone-decision.md).

The three Milestone lifecycle mutations use one source- and evidence-bound
operation ledger across Pi, workflow MCP names and aliases, auto, and recovery
callers. Validation records immutable Attempt, Result, criterion, verdict, and
evidence lineage. Completion revalidates that receipt, descendant parity,
current Waivers, and active-Attempt absence before changing only the Milestone
heads. Full-redo reopen moves the hierarchy to canonical `ready` with legacy
compatibility statuses, revokes current cancellation Waivers, and preserves
immutable execution and evidence history. Exact replay returns the stored
receipt; changed payload reuse conflicts; currentness, supersession, and
projection staleness are reported independently.

Task-bearing calls to `gsd_plan_slice`, `gsd_plan_task`, `gsd_replan_slice`, and `gsd_replan_task` expose `requiredWorkflowTools` in their public native and MCP schemas. Each Task must declare the array explicitly; use `[]` for ordinary implementation work. The handlers de-duplicate the array and, before any persistence, require every named tool to be available to both `execute-task` and `execute-task-simple`. An incompatible declaration rejects the whole planning mutation with guidance toward the lifecycle unit that owns the tool; for example, `gsd_requirement_update` is completion-owned and cannot be assigned to an execution Task. The accepted array is stored as `tasks.required_workflow_tools`, and task-plan projections render it as `required_workflow_tools` YAML frontmatter.

`gsd_reassess_roadmap.metadataCorrections` is the DB-backed correction path for stale acceptance or evidence language. `milestone` may update `successCriteria`, `verificationContract`, `verificationIntegration`, `verificationOperational`, `verificationUat`, `definitionOfDone`, `requirementCoverage`, and `boundaryMapMarkdown`. `completedSlices` entries identify a completed `sliceId` and may update only `demo`, `goal`, `successCriteria`, `proofLevel`, `integrationClosure`, and `observabilityImpact`; missing, pending, cancelled, duplicate, empty, and structurally extended entries fail before mutation. Metadata-only correction is allowed for a completed Milestone, but not a cancelled one, and preserves lifecycle states, Tasks, dependencies, and completed-slice structure. A milestone metadata correction invalidates the prior `milestone-validation` assessment and removes its stale VALIDATION projection; completed-slice-only evidence corrections do not invalidate milestone validation.

`gsd_replan_task` updates exactly one existing pending task after rework. MCP callers may omit `projectDir`; the server defaults it to the current project/worktree root. Required fields are `milestoneId`, `sliceId`, `taskId`, `title`, `description`, `estimate`, `files`, `verify`, `inputs`, `expectedOutput`, and `requiredWorkflowTools`; `reworkBriefRef` is optional and records the structured brief that triggered the replan. The handler rejects missing, closed/completed, and canonically cancelled tasks; those tasks must be reopened with `gsd_task_reopen` before replanning.

`gsd_rework_brief_save` persists structured findings for a task. MCP callers may omit `projectDir`; the server defaults it to the current project/worktree root. Required fields are `milestoneId`, `sliceId`, `taskId`, and non-empty `findings`. Each finding requires `findingId`, `severity` (`blocking` or `advisory`), `description`, `requiredFix`, and `verificationCommands`; optional fields are `status`, `evidence`, and `decisionRef`.

`gsd_task_complete` treats the task summary and slice plan projection as retryable delivery work after authoritative completion commits. In flat-phase layout it writes `S##-T##-SUMMARY.md` at the phase root so duplicate task IDs in different slices cannot collide; readers still accept legacy flat `T##-SUMMARY.md` summaries. If writing the task summary or re-rendering `NN-MM-PLAN.md` fails after the database transaction commits, the tool returns a visible projection error while leaving the committed task completion, Attempt Result, verification evidence, and lifecycle state intact for projection repair on retry. It also rejects completion when the task has pending blocking rework findings. To complete such a task, the caller must include `reworkResolution` entries with `findingId`, `status: "resolved"`, and non-empty `evidence`, or `status: "deferred-with-override"` with non-empty `evidence` and a `decisionRef`.

`gsd_checkpoint_save` saves a `pause` or `handoff` Work Checkpoint for a milestone, slice, or task that has a lifecycle row; a unit with no lifecycle row is refused and nothing is written. Required fields are `milestoneId`, `kind`, `confirmedContext`, and `nextAction`; `sliceId`, `taskId`, `unresolved`, and `evidence` are optional, and `taskId` needs `sliceId`. The row extends the `continue:` chain of the work item and is the resume state. The tool then renders `CONTINUE.md`; when the render fails the tool still succeeds and reports that the row is the resume state.

`gsd_task_recovery_resume` appends a correction Work Checkpoint and `task.recovery.resumed` event for the exact current agent-owned abort or remediation after receiving a nonblank repair summary and non-empty structured evidence. The predecessor Attempt, its Result, the Recovery Action, and recovery budget remain unchanged. The event authorizes only the immediate lineage successor Attempt; stale or duplicate actions, open blockers, and actions superseded by a later Attempt fail closed.

---

## 6. DB State → Dispatch Rule Mapping

The authoritative DB-state-to-prompt dispatch conditions are maintained in the
[prompt/DB combined map](./prompt-db-combined-map.md).
This database map owns the schema, read/write lineage, and transaction
invariants rather than duplicating dispatch policy.

---

## 7. Write Path Invariants

1. **Single-writer rule**: all write SQL lives in the explicit single-writer *layer*. The authoritative allowlists are `TYPED_DB_WRITER_FILES`, `SCHEMA_DB_WRITER_FILES`, and `MIGRATION_BACKFILL_WRITER_FILES` in `single-writer-invariant.test.ts`; `db/engine.ts`, `db/writers/**`, `gsd-db.ts`, and the separate `unit-ownership.ts` database have the named exceptions documented there. This is not permission for arbitrary raw writes under `db/`; `db/queries.ts` remains read-only. The structural test rejects every unlisted write site.

2. **Transaction wrapping**: every multi-table write uses `transaction()` or `immediateTransaction()` when it needs SQLite's reserved writer lock up front. Rollback on any error. Re-entrant callers normally increment the shared depth counter with no nested `BEGIN`; `executeDomainOperation()` is the exception and rejects an existing outer transaction so it owns the reserved-writer boundary. `gsd_save_gate_result` commits the `quality_gates` verdict update and matching `gate_runs` ledger insert together, so recovery never sees a completed gate without its audit row.

3. **Cascade semantics**: production Slice hierarchy changes are transaction-bound leaves in `db/writers/slice-lifecycle.ts`, invoked only inside their owning Domain Operation. Complete validates evidence-backed terminal descendants; cancel preserves completed history and settles running descendants; reopen/reset performs one guarded full redo while preserving immutable execution history. Milestone full-redo reopen is the matching transaction-bound leaf in `db/writers/milestone-lifecycle.ts`. Legacy cascade helpers remain only for explicit unadopted compatibility and later cleanup; `reopenMilestoneCascade` refuses any hierarchy with adopted canonical authority.

4. **Conflict guards**: `insertSlice`, `insertTask` use `ON CONFLICT` to preserve existing completed status and non-empty fields. `insertTask` treats `complete`/`done`/`closed` as complete for `completed_at` stamping and preserves existing completion metadata when `preserveCompletionMetadata` is set; `skipped` stays terminal but does not get a completion timestamp.

5. **FTS fallback**: if FTS5 unavailable, `memory_query` falls back to LIKE scan on `memories.content`.

6. **Workspace isolation**: same `.gsd/gsd.db` for all worktrees of one project; separate `.gsd/gsd.db` per project root. Coordination tables assume single-host shared WAL. Multi-host needs external coordinator.

7. **Pre-migration backup**: see the `db-migration-backup.ts` entry under "Connection scoping" in section 1 for naming, verification, and fail-closed rules.
