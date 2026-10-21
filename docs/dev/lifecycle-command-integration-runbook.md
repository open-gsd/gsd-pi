<!-- Project/App: gsd-pi -->
<!-- File Purpose: Integration and verification runbook for canonical lifecycle command writers. -->

# Lifecycle command integration runbook

This runbook governs the command primitives introduced in M003/S01 and first
adopted by planning in M003/S02. They write canonical lifecycle, Attempt,
Result, and Kernel checkpoint facts only inside an active Domain Operation.
Milestone, slice, and task planning, task and slice replanning, and roadmap
reassessment now use the lifecycle and replay-fence subset. Task execution,
Task recovery, verified Task completion, and Slice complete/cancel/reopen/reset
also use command-specific Domain Operations. Milestone validation, verified
completion, and full-redo reopen use the same boundary. Legacy hierarchy reads
and public responses remain the compatibility contract until a later,
separately proven read-authority cutover.

## Command boundary

1. Read the current or replay fence with `readDomainOperationFence`.
2. Start one semantic Domain Operation with that expected revision and Authority
   Epoch.
3. Run the legacy compatibility mutation and the matching canonical writer in
   the same callback.
4. Compare legacy and canonical states with `compareLifecycleShadow`; preserve
   the raw statuses even when the normalized states agree.
5. Return the legacy response during M003. Projection delivery follows the
   committed operation and cannot compensate canonical state backward.

Handlers must use `normalizeLegacyLifecycleStatus` and the exported
`CanonicalLifecycleStatus` type. Do not duplicate alias tables in tools,
commands, or orchestration modules.

## S02 planning boundary

- Planning handlers carry a private `PlanningInvocation`; Pi keys use the
  canonical tool name and tool-call ID, while workflow MCP requires a nonblank
  `io.opengsd/idempotency-key` in private request metadata. Missing identity
  fails before mutation because request/session IDs are not replay-stable.
- A planning mutation, lifecycle adoption or transition, shadow comparison,
  event/outbox rows, Projection Work, and authority revision commit atomically.
  Projection rendering follows commit; replay retries rendering without
  rerunning the mutation or duplicating compatibility events. Replan and
  reassessment projections read their content and creation time from the
  committed domain event or assessment row, so a replay reproduces the
  original artifact instead of the retry payload or clock.
- Removed pending tasks and slices retain their hierarchy identity as legacy
  `skipped` and canonical `cancelled`. Active plan projections omit them, and
  their IDs cannot be reused until the matching reopen command succeeds. Stale
  PLAN cleanup removes only content still owned by the compatibility marker or
  PLAN artifact; a user-modified file is preserved.
- Restore, hierarchy replacement, milestone discard, and worktree teardown fail
  closed when they would erase or strand adopted canonical history.

## Integration boundaries

- S03 established schema-authorized interrupted settlement and retry after an
  original lease expires or is replaced. Production claims must preserve that
  lease fence and immediate Attempt lineage.
- Kernel checkpoints follow the S03 stage/state matrix and are appended only
  inside their owning Domain Operation.
- S04 makes terminal Task reopen ordering explicit. Canonical
  `completed/cancelled -> ready` commits with legacy `pending`; the later claim
  owns a separate `ready -> in_progress` revision.
- S05 owns Slice complete/cancel/reopen/reset. S06 adds Milestone validation,
  completion, and full-redo reopen without changing production read authority.

## S05 Slice lifecycle boundary

- `slice.cancel`, `slice.complete`, and `slice.reopen` each own the full Slice
  hierarchy mutation, semantic shadow evidence, ordered event/outbox lineage,
  Projection Work, and authority revision in one Domain Operation.
- Cancellation preserves completed Tasks, cancels unfinished Tasks, and settles
  any running Attempt as an immutable interrupted Result with a terminal
  dispatch. The same operation grants one durable Slice-scoped Waiver that
  records the dependency-bypass decision. Reopen revokes that Waiver before a
  later cancellation may grant a replacement. It never leaves a cancelled
  lifecycle with a running Attempt or an unaudited bypass decision.
- Completion requires terminal legacy/canonical parity for every descendant,
  no running Attempt, and current published Result/verdict/evidence/Kernel proof
  for each completed Task. Normalized closeout and Q8 facts commit before render.
- Reopen/reset is a full redo: the Slice and every terminal descendant become
  legacy Slice `in_progress`, legacy Tasks `pending`, and canonical `ready` in
  one revision. Attempts, Results,
  verdicts, evidence, dispatches, and checkpoints remain immutable history.
  Reopen fails without residue while any dependency-reachable downstream Slice
  has progressed; reopen downstream work first.
- Pi, workflow MCP canonical names and aliases, internal reset, auto, and
  recovery callers enter through shared executors with stable private identity.
  JSONL reconciliation cannot replay a lifecycle mutation after canonical
  adoption, and automated recovery cannot fabricate completion.
- Exact retry returns the stored receipt. A changed payload conflicts; a stale
  revision or Authority Epoch, deep mismatch, active descendant, or writer
  failure leaves the hierarchy and operation ledger unchanged.

## S06 Milestone lifecycle boundary

- `milestone.validate` records one immutable, source-bound validation receipt
  with its Attempt, Result, criteria, verdicts, evidence, and any genuine
  subjective acceptance. Filesystem assessment prose cannot authorize adopted
  Milestone completion.
- `milestone.complete` revalidates that receipt, descendant terminality and
  semantic parity, current cancellation Waivers, and the absence of active
  Attempts in one transaction. It changes only the Milestone heads and emits
  one `milestone.completed` receipt plus Projection Work. An unregistered
  historical quality-gate row is inert only when its persisted status is
  exactly `complete`; pending or malformed unregistered rows fail closed.
- `milestone.reopen` performs the established full redo in one transaction:
  Milestone, Slices, and terminal Tasks return to canonical `ready` with their
  legacy compatibility statuses; current cancellation Waivers are revoked and
  immutable execution and evidence history remains intact.
- Pi, workflow MCP names and aliases, auto, and recovery callers use shared
  executors with stable private identity. Exact retry returns the stored
  receipt; changed reuse conflicts. `stale`, `current`, and `superseded` report
  projection delivery and operation ownership separately from mutation success.
- Merge cleanup, startup journal replay, stuck artifact recovery, legacy event
  reconciliation, PROJECT registration, and Markdown hierarchy import cannot
  close an adopted Milestone. They may observe a current durable completion
  receipt or retain explicit unadopted-import compatibility; SUMMARY,
  VALIDATION, Git, and checked boxes never manufacture completion.

### S07 and later boundaries

- Slice completion proves each completed Task's tested source revision, but it
  does not yet record one integrated Slice source snapshot. Automated UAT runs
  after completion, and its structured result/source identity is not part of
  the `slice.completed` receipt.
- S07 compares exact legacy responses with normalized canonical state across
  every runtime mode and produces the cutover dossier. It does not switch
  production reads or dependency eligibility to canonical authority.
- Production read cutover, canonical dependency eligibility, prepared/settled
  closeout effects, merge/publication settlement, park/unpark/discard,
  projection-worker redesign, legacy cascade deletion, and compatibility
  retirement remain later work. Until then active-Slice selection may still
  recognize legacy `skipped`; the later cutover must consume its current Waiver
  rather than infer satisfaction from that alias.

## S07 semantic-shadow dossier

The S07 dossier keeps two evidence planes separate:

- `capstone_fixture` is fresh, disposable canonical-schema evidence. It proves
  all six modes, both transports, all five frozen classifications, response
  neutrality, repair dispositions, and durable observation-loss accounting.
  It is not live production telemetry.
- `live_project` is a read-only snapshot of the canonical project database. It
  proves the 33 scoped repair receipts, current M003 semantic drift, T01-T06
  verification heads, project revision, and Authority Epoch.

Generate the candidate only from local evidence. First emit normalized capstone
evidence for the current checkout, then collect the canonical input, then write
the dossier:

```sh
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types \
  src/resources/extensions/gsd/tests/emit-semantic-shadow-capstone-evidence.ts \
  --source-root "$PWD" --output <capstone-json>
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types scripts/m003-s07-dossier-input.ts \
  --source-root "$PWD" --database <canonical-gsd-db> \
  --capstone <capstone-json> --output <dossier-input-json>
node scripts/m003-s07-cutover-dossier.mjs --input <dossier-input-json>
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types scripts/m003-s07-dossier-input.ts \
  --source-root "$PWD" --database <canonical-gsd-db> \
  --capstone <capstone-json> \
  --check-dossier docs/dev/m003-s07-cutover-dossier.json
```

The generator rejects incomplete matrix cardinality, mixed or unavailable
source identity, changed public responses, unaccounted loss, corrupt repair
lineage, missing current verification heads, unexplained live drift, a failed
no-cutover/authority gate, compatibility removal, non-local metadata, or a GO
recommendation. GitHub labels, tags, milestones, reviews, and release metadata
are never inputs.

The checked JSON records observed pre-generation gates and marks dossier check
and `verify:merge` as required post-generation gates. This is deliberate: a
file cannot honestly certify its own future validation. Candidate UAT persists
those later results as database-backed assessment/gate/run receipts. After a
guarded merge, rerun the capstone from a detached worktree at the exact
`mergeCommit.oid`, persist the exact source-content revision and evidence
hashes in the T07 Technical Verdict, then publish T07 and complete S07 through
canonical operations. The checked JSON is a readable projection; the database
receipt is final authority.

The dossier remains `NO_GO` for read-authority cutover while production reads,
dependency eligibility, integrated Slice source/UAT identity, closeout and
merge settlement, park/unpark/discard, Projection Work redesign, legacy cascade
deletion, or compatibility retirement remain deferred. Missing evidence or an
automatable failure returns to agent-owned repair. Work stops for a person only
when access/authority is unavailable or a genuinely ambiguous product choice
cannot be resolved from accepted decisions.

## Resume after an agent-owned abort or remediation

Use `gsd_task_recovery_resume` only after the recorded cause has been repaired:

1. Read the current `abort` or `remediate` action and preserve its exact `recoveryActionId`.
2. Repair the cause outside the failed dispatched unit and run the smallest
   meaningful verification.
3. Call the tool with that action ID, a plain-language repair summary, and
   non-empty structured evidence. Keep replay identity in private Pi/MCP
   metadata; never add it to the public arguments.
4. Resume orchestration. The next claim must name the recovered Attempt as its
   immediate predecessor and atomically consume the authorization.

At successor claim, the database revalidates the causal Result and any current
evidence-backed failure verdict. A resume is valid only when its
`workCheckpointId` names the Work Checkpoint created by the same resume
operation for the same lifecycle. The v39 migration applies the same
current-head gate to recovery routes retained from v38.

Do not cancel/reopen the Task, delete the Recovery Action, reset its budget, or edit the
database directly. A stale action, duplicate resume, open blocker, running or
later Attempt, mismatched Result, or missing repair evidence must fail without
partial checkpoint or event residue.

## Recover a Milestone lifecycle operation

Milestone command failures remain agent-owned unless authority, access, or a
genuinely subjective choice is unavailable. Interpret the structured result
before choosing a repair:

| Observation | Recovery |
| --- | --- |
| Validation, source, UAT, or evidence is missing or stale | Rerun the required automated verification against the current source, then retry completion through the normal command. |
| A descendant is nonterminal, an Attempt is active, or a Waiver is missing | Settle or remediate that descendant through its own lifecycle operation, then retry. |
| `stale: true` and `current: true` | Authority committed. Repair filesystem access or the projection obstruction and replay the exact invocation to deliver readable status. |
| `superseded: true` | The receipt is historical. Do not repair its projection; inspect and follow the current lifecycle head. |
| Canonical/legacy mismatch or corrupt receipt | Treat this as an invariant failure. Do not edit Markdown or use a generic status writer; forward-repair the database through an authorized remediation or restore verified database authority. |
| Merge, journal, SUMMARY, or VALIDATION evidence claims an adopted ready Milestone is complete | Treat the legacy signal as non-authoritative and dispatch normal validation/completion. |
| Database unavailable | Restore database access before any mutation. Files are not a fallback authority. |
| PROJECT registration fails | Repair the database-side cause and retry. The failed save leaves no new PROJECT artifact; adopted checkbox state is rebuilt from the database. |

An exact replay uses the original private idempotency key and unchanged request.
If intent changed, issue a new command identity; do not reuse a key with a
different payload.

## S04 recovery convergence matrix

The database explains every pause, retry, resume, reopen, cancellation, and
publication. Markdown, manifests, summaries, blocker placeholders, and UAT
reports are readable projections; they cannot authorize a lifecycle change.

| Scenario | Required canonical evidence | Expected outcome |
| --- | --- | --- |
| Agent failure | Immutable failure observation and bounded Recovery Action; each retry is a fresh lineage-linked Attempt and terminal dispatch | Retry/repair/remediate until the budget selects abort; never ask the user for an objective failure |
| Repaired recovery | Exact current abort or remediation plus one `task.recovery.resume` operation, concrete repair evidence, and a successor claim that consumes it | One immediate successor only; the dispatched worker cannot self-authorize or reuse the event |
| Genuine pause | Matching open user or external Blocker, Recovery Action, and work checkpoint | Ask one plain-language question, recommend the best route and why, allow pushback, then resolve or dismiss without consuming an agent budget |
| Verified completion | Succeeded Result, current passing Technical Verdict/evidence, and `task.completion.publish` | Legacy `complete` and canonical `completed` commit once; projection failure cannot roll either backward |
| Reopen/cancel | One Domain Operation, event, work checkpoint, semantic shadow payload, and Projection Work row | Reopen ends at `ready`; cancel ends at `cancelled`; all prior Attempts/Results remain immutable |
| Pi/MCP/internal | Private stable identity at the real entry point and persisted `source_transport` | Public text and structured outcome agree; replay returns the original operation without duplicate facts |

An automated objective failure remains agent-owned. Human review may pause only
when the configured policy makes the decision subjective. External ownership is
valid only for an external dependency. UAT and UOK may verify and report, but
their dispatched tool surfaces do not include Task recovery resume or reopen
authority.

Closing a user/external Blocker does not erase or mutate its pause action. If
work continues after an execution or subjective verification failure, reroute
the same Result through the agent policy with the exact resolved/dismissed
`blockerId` as `supersedesResolvedBlockerId`; the new retry-capable Recovery
Action authorizes one fresh lineage successor. The new Attempt must produce its
own Result and current evidence-backed verdict before publication.
The successor claim revalidates that causal Result and verdict at consumption
time, so a retained route or resume cannot outlive superseded, stale, or missing
verification evidence.

## Projection obstruction

Lifecycle mutation commits before rendering. Each Domain Operation enqueues a
current `workflow_projection_work` head. The capstone proves that obstructed
artifact cleanup cannot roll back the committed state and leaves its Projection
Work pending. The projection-delivery contract separately governs claim,
retry, and dead-letter state. Repair the filesystem and replay delivery. Do not
restore status from a checked PLAN item, SUMMARY file, manifest, or blocker
placeholder.

Public lifecycle responses expose projection delivery separately from the
canonical result. `stale: true` means the database commit succeeded but readable
status still needs repair; `duplicate: true` means an exact replay reused the
existing operation. A historical receipt reports both `duplicate: true` and
`superseded: true` and must not use current-success wording or repair a newer
projection. Callers must preserve these flags and say that the readable status
update is pending when stale. Exact retry may repair delivery only while
that operation is still the current lifecycle head; a delayed completion or
reopen retry must not overwrite a newer projection. Doctor may report or retry
pending Projection Work, but it must not claim a stale projection is repaired
merely because the database state is current.

Use these read-only diagnostics against the authoritative database:

```sql
-- Current Milestone legacy/canonical pair and the operation that owns it.
SELECT milestone.id, milestone.status AS legacy_status,
       lifecycle.lifecycle_status AS canonical_status,
       lifecycle.lifecycle_id, lifecycle.last_operation_id,
       lifecycle.last_project_revision,
       operation.operation_type, operation.source_transport
FROM milestones milestone
LEFT JOIN workflow_item_lifecycles lifecycle
  ON lifecycle.item_kind = 'milestone'
 AND lifecycle.milestone_id = milestone.id
 AND lifecycle.slice_id IS NULL
 AND lifecycle.task_id IS NULL
 AND lifecycle.project_id = (
   SELECT project_id FROM project_authority WHERE singleton = 1
 )
LEFT JOIN workflow_operations operation
  ON operation.operation_id = lifecycle.last_operation_id
WHERE milestone.id = :milestone_id;

-- Immutable validation/completion/reopen lineage for that Milestone.
SELECT event.project_revision, operation.operation_type,
       event.event_type, event.operation_id, event.event_id
FROM workflow_domain_events event
JOIN workflow_operations operation
  ON operation.operation_id = event.operation_id
 AND operation.project_id = event.project_id
WHERE event.entity_type = 'milestone'
  AND event.entity_id = :milestone_id
  AND event.event_type IN (
    'milestone.validation.recorded',
    'milestone.completed',
    'milestone.reopened'
  )
ORDER BY event.project_revision, event.event_index;

-- Current Task lifecycle plus immutable Attempt/Result lineage.
SELECT lifecycle.lifecycle_status, attempt.attempt_number,
       attempt.retry_of_attempt_id, attempt.attempt_state,
       result.outcome, dispatch.status AS dispatch_status
FROM workflow_item_lifecycles lifecycle
LEFT JOIN workflow_execution_attempts attempt
  ON attempt.lifecycle_id = lifecycle.lifecycle_id
LEFT JOIN workflow_attempt_results result
  ON result.attempt_id = attempt.attempt_id
LEFT JOIN unit_dispatches dispatch
  ON dispatch.id = attempt.coordination_dispatch_id
WHERE lifecycle.milestone_id = :milestone_id
  AND lifecycle.slice_id = :slice_id
  AND lifecycle.task_id = :task_id
ORDER BY attempt.attempt_number;

-- Current Projection Work heads that still need delivery.
SELECT work.projection_key, work.delivery_state, work.attempt_count,
       work.next_attempt_at, work.last_error
FROM workflow_projection_work work
WHERE work.delivery_state IN ('pending', 'claimed', 'dead_letter')
  AND NOT EXISTS (
    SELECT 1 FROM workflow_projection_work successor
    WHERE successor.supersedes_projection_work_id = work.projection_work_id
  )
ORDER BY work.source_project_revision;

-- Immutable recovery history, including the exact action/blocker IDs needed
-- for repair or supersession.
SELECT action.recovery_action_id, action.action, action.project_revision,
       observation.attempt_id, observation.result_id,
       observation.recovery_owner, observation.failure_kind,
       blocker.blocker_id, blocker.blocker_kind, blocker.blocker_status
FROM workflow_recovery_actions action
JOIN workflow_failure_observations observation
  ON observation.failure_observation_id = action.failure_observation_id
LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
WHERE action.lifecycle_id = :lifecycle_id
ORDER BY action.project_revision;

-- Current routed Attempt only. No row means execution has advanced beyond route.
SELECT action.recovery_action_id, action.action, observation.attempt_id,
       observation.result_id, blocker.blocker_id, blocker.blocker_status
FROM workflow_kernel_checkpoints checkpoint
JOIN workflow_failure_observations observation
  ON observation.kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
JOIN workflow_recovery_actions action
  ON action.failure_observation_id = observation.failure_observation_id
LEFT JOIN workflow_blockers blocker ON blocker.blocker_id = action.blocker_id
WHERE checkpoint.lifecycle_id = :lifecycle_id
  AND checkpoint.next_stage = 'route'
  AND NOT EXISTS (
    SELECT 1 FROM workflow_kernel_checkpoints successor
    WHERE successor.previous_kernel_checkpoint_id = checkpoint.kernel_checkpoint_id
  )
ORDER BY action.project_revision DESC
LIMIT 1;

-- Current host verdict, publication, and terminal dispatch closeout evidence.
SELECT attempt.attempt_id, result.outcome, verdict.verdict,
       evidence.evidence_id, publish.operation_id AS publication_operation_id,
       dispatch.status AS dispatch_status
FROM workflow_execution_attempts attempt
JOIN workflow_attempt_results result ON result.attempt_id = attempt.attempt_id
JOIN workflow_technical_verdicts verdict ON verdict.attempt_id = attempt.attempt_id
JOIN workflow_acceptance_criteria criterion
  ON criterion.criterion_id = verdict.criterion_id
JOIN workflow_verification_evidence evidence
  ON evidence.verdict_id = verdict.verdict_id
 AND evidence.project_id = verdict.project_id
 AND evidence.attempt_id = verdict.attempt_id
LEFT JOIN workflow_domain_events published
  ON published.event_type = 'task.completion.published'
 AND json_extract(published.payload_json, '$.attemptId') = attempt.attempt_id
LEFT JOIN workflow_operations publish ON publish.operation_id = published.operation_id
LEFT JOIN unit_dispatches dispatch ON dispatch.id = attempt.coordination_dispatch_id
WHERE attempt.lifecycle_id = :lifecycle_id
  AND NOT EXISTS (
    SELECT 1 FROM workflow_technical_verdicts successor
    WHERE successor.supersedes_verdict_id = verdict.verdict_id
  )
  AND NOT EXISTS (
    SELECT 1 FROM workflow_acceptance_criteria successor
    WHERE successor.supersedes_criterion_id = criterion.criterion_id
  )
  AND NOT EXISTS (
    SELECT 1
    FROM workflow_technical_verdicts newer
    JOIN workflow_verification_evidence newer_evidence
      ON newer_evidence.verdict_id = newer.verdict_id
     AND newer_evidence.project_id = newer.project_id
     AND newer_evidence.attempt_id = newer.attempt_id
    WHERE newer.project_id = verdict.project_id
      AND newer.criterion_id = verdict.criterion_id
      AND newer.lifecycle_id = verdict.lifecycle_id
      AND newer.attempt_id = verdict.attempt_id
      AND newer.project_revision > verdict.project_revision
      AND NOT EXISTS (
        SELECT 1 FROM workflow_technical_verdicts successor
        WHERE successor.supersedes_verdict_id = newer.verdict_id
      )
  )
ORDER BY attempt.attempt_number DESC
LIMIT 1;

-- Repaired-abort resume and the one successor that consumes it.
SELECT action.recovery_action_id, resumed.project_revision AS resume_revision,
       successor.attempt_id AS consuming_attempt_id,
       successor.attempt_number AS consuming_attempt_number
FROM workflow_domain_events resumed
JOIN workflow_recovery_actions action
  ON action.recovery_action_id = json_extract(resumed.payload_json, '$.recoveryActionId')
LEFT JOIN workflow_execution_attempts successor
  ON successor.retry_of_attempt_id = json_extract(resumed.payload_json, '$.attemptId')
 AND successor.claim_project_revision > resumed.project_revision
WHERE resumed.event_type = 'task.recovery.resumed'
  AND action.lifecycle_id = :lifecycle_id
ORDER BY resumed.project_revision DESC;
```

## Automated UAT and closeout

Run the Milestone capstone plus adjacent validation, recovery, transport,
projection, worktree, and compatibility suites. UAT should execute the live
runtime or browser path whenever automation can observe it; a human decision is
reserved for subjective acceptance or unavailable authority/access. S06 remains
open until the database contains the exact operation/event/evidence lineage,
current Projection Work state, hosted-CI evidence, and passing UAT for the exact
merged source. Record that post-merge run through the normal
Attempt/Result/Verdict/Evidence path. Markdown status alone never satisfies
closeout.

## Verification loop

Run the smallest focused gate while editing, then the adjacent contract matrix:

```sh
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs \
  --experimental-strip-types --test \
  src/resources/extensions/gsd/tests/milestone-lifecycle-capstone.test.ts \
  src/resources/extensions/gsd/tests/milestone-validation-domain-operation.test.ts \
  src/resources/extensions/gsd/tests/milestone-subjective-uat-domain-operation.test.ts \
  src/resources/extensions/gsd/tests/milestone-closeout-readiness.test.ts \
  src/resources/extensions/gsd/tests/milestone-completion-domain-operation.test.ts \
  src/resources/extensions/gsd/tests/milestone-reopen-domain-operation.test.ts \
  src/resources/extensions/gsd/tests/milestone-reopen-projection-fencing.test.ts \
  src/resources/extensions/gsd/tests/milestone-lifecycle-rebuild.test.ts \
  src/resources/extensions/gsd/tests/milestone-closeout-fencing.test.ts \
  src/resources/extensions/gsd/tests/auto-worktree-merge-db-ready.test.ts \
  src/resources/extensions/gsd/tests/auto-recovery.test.ts \
  src/resources/extensions/gsd/tests/workflow-authority-faults.test.ts
pnpm exec tsx --test \
  src/resources/extensions/gsd/tests/workflow-tool-executors.test.ts \
  packages/mcp-server/src/workflow-tools.test.ts \
  src/resources/extensions/gsd/tests/db-lifecycle-foundation.test.ts \
  src/resources/extensions/gsd/tests/domain-operation.test.ts \
  src/resources/extensions/gsd/tests/single-writer-invariant.test.ts
pnpm run test:compile
node --test-force-exit --test \
  dist-test/packages/mcp-server/src/workflow-tools.test.js \
  dist-test/packages/mcp-server/src/workflow-tools-parity.test.js
pnpm run typecheck:extensions
pnpm run baseline:workflow-authority
pnpm run baseline:refactor:gate
pnpm run test:changed:src
pnpm run verify:fast
```

Before merging, also run `pnpm run verify:merge`; it includes the required build
and full local merge-gate parity. For every new invariant, prove the
corresponding test fails under a temporary sabotage, restore the source, and
rerun the focused gate. After merge, rerun the capstone against the merged
source revision and persist that exact evidence; only that persisted
merged-source receipt closes S06.
