# ADR-048: UnitRun is the claimed `unit_dispatches` row

- **Status:** Accepted
- **Date:** 2026-08-14
- **Driver:** Auto-mode identity wedges (#1754, #1739, #1726) after v1.15.0
- **Supersedes:** RAM `status.activeUnit` + `lastAdvanceKey` as sources of truth for the in-flight unit

## Context

v1.15 auto-mode kept three identities for the same run: an in-memory `activeUnit` / `lastAdvanceKey` on the orchestrator, a later `unit_dispatches` claim in the loop, and ADR-047 liveness signatures over guard input hashes. `advance()` could return `advanced` before a durable claim existed. The loop then hoped `finally` would clear RAM. Process kill, publication failure, and terminal recovery abort left `activeUnit` set while the ledger row was missing or already terminal, so the next tick string-matched `"idempotent advance: unit already active"` and livelocked.

ADR-047 stays the **block detector**. It must not grow a third identity or new string matches.

## Decision

**UnitRun = the `unit_dispatches` row for this worker with `status IN ('claimed','running')`.**

- `advance()` inserts that claim in the same step that returns `kind: "advanced"` and always includes `dispatchId`. If the claim cannot open, the result is `blocked`/`stopped`, never `advanced`.
- `getStatus().activeUnit` is a defensive copy of that row, not RAM state.
- Closeout is `settle(dispatchId, outcome, reason)`. `complete` / `retry` / `abandon` remain wrappers that load the row (or run ADR-047 hashing when the row is already terminal).
- If this worker already holds a claimed/running row for the **same** unit and `unitExecutionInFlight` is set, `advance()` returns `skipped` with `code: "unit-already-active"`. If the unit is **not** in flight (restart between `advanced` and unit phase), `advance()` returns `advanced` with the existing `dispatchId` (resume). A claimed row for a **different** unit is canceled, then a new claim opens.
- ADR-047 is unchanged: liveness over guard input hashes. It does not decide the active unit.

## Consequences

- `lastAdvanceKey`, `orchestrationUnitPendingCloseout`, and optional `releaseActiveUnit` are deleted.
- The canonical loop does not call `openDispatchClaim` after `advance()`. Custom workflow steps and sidecar items still claim themselves.
- Skip reasons keep human-readable strings for logs and liveness payloads; loop branches on `code`, not reason text.

## Amendment 2026-10-03: kernel state for non-task units lives on the dispatch row

ADR-046 names one persisted Lifecycle Kernel but defines Attempts only for Task execution. The owner decision for the other unit types (planning, research, closeout, hooks) is:

- The claimed `unit_dispatches` row is the kernel record of a non-task unit. Retry counts, recovery budgets, pause state and stage checkpoints are columns on that row or child rows keyed by its `id`.
- Attempts stay for Task execution only. The Attempt table and its claim rules do not change.
- Advance, resume and recovery read these rows, not session memory. A restart must not change the next work.

The work has four parts:

1. Retry and recovery budgets on the dispatch row.
2. Pause and resume state on the dispatch row. (Changed by the third 2026-10-04 amendment: the pause has its own row with a link to the dispatch row.)
3. The sidecar queue (hooks, triage, quick tasks) as rows linked to the dispatch that triggered them.
4. Advance selects from the database only.

Part 1 has started. `unit_dispatch_budgets (dispatch_id, kind, used)` holds one count for each budget kind. A retry opens a new dispatch row for the same unit, so the count of a unit is the value on its newest dispatch row that holds the kind, and a reset writes `0` on the newest row. The zero-tool, tool-unavailable and pre-execution repair budgets use it (`db/unit-dispatch-budgets.ts`). The three budgets have one release rule: a pass of the unit, or the pause at the cap, writes `0`, so a resume after a person fixed the cause starts a new budget. A unit that runs with no dispatch row has no durable identity, so its count lasts for the process only.

Part 4 has started with one decision: the planner retry after a failed pre-execution check (see the second 2026-10-04 amendment). One session field was deleted with no database replacement: the findings of a failed pre-execution check (`lastPreExecFailure` on the auto session and in the paused-session metadata). Its only reader was the `planning → plan-slice` dispatch rule. That rule matches only a slice with no task rows. The check stores findings only for a slice that has task rows, and the rows stay after the failure, so the reader was unreachable. A paused-session row written by an older build may still carry the deleted field; it is ignored.

## Amendment 2026-10-04: the sidecar queue is rows linked to the dispatch row

Owner decision 2026-10-03: the claimed `unit_dispatches` row is the kernel record of a non-task unit, and the follow-on work a unit queues (post-unit hooks, capture triage, quick tasks) is stored as rows linked to the dispatch that triggered it. `AutoSession.sidecarQueue` and `AutoSession.pendingQuickTasks` are deleted. The queue is the `unit_dispatch_sidecars` table (`db/unit-dispatch-sidecars.ts` reads it, `db/writers/unit-dispatch-sidecars.ts` writes it).

Rules:

- **Link.** `trigger_dispatch_id` is the newest `unit_dispatches` row of the unit whose close-out queued the item. It is `NULL` when that unit ran with no dispatch row, and when a resume queues a restored hook again.
- **Scope.** A row belongs to the worker, not to the milestone it runs: the scope has no milestone unless the worker is a parallel worker (`GSD_PARALLEL_WORKER`), which stays on the milestone of its lock, and on the slice of its lock for a slice-parallel worker (`GSD_SLICE_LOCK`). A worker reads only the rows of its own scope, so two live workers do not run the queue of each other. A restarted worker has the same scope and takes the rows of the process that died, also when the restart is on the next milestone: the rows of the finished milestone run before the new work. A start that is not a parallel worker also takes the `held` and `queued` rows of a parallel scope that no live worker owns, so a parallel worker that was killed at the end of its milestone does not strand its rows. A scope has an owner when another process holds an unexpired `milestone_leases` row of the scope, or when the worker that holds the lease or that ran the dispatch which queued the row is live. A live worker is an active `workers` row of another process with a fresh heartbeat or with a process that is alive on this host. So a scope is ownerless only when the lease is expired, the heartbeat is stale and the process is dead. The loop renews the heartbeat and the lease during the unit phase and the finalize phase, so a long verification does not make a live worker look dead.
- **Status.** `held` is a quick task that waits (one quick task runs between two units). `queued` is ready work: the auto loop runs the oldest queued row before it selects a unit. `done` is set when the loop iteration that ran the row ends, with any result. `canceled` is set by `stopAuto`.
- **Kill.** A killed process leaves the row `held` or `queued`. The next start runs it. A pause or a stop is not a kill: a pause in the middle of an item closes its row, and `stopAuto` cancels every queued row and every held quick task of the worker, as the in-memory queue did.
- **Hooks.** The `hook_state` row in the database still holds the active hook and the gate block. On start and resume the hook reconcile queues the restored hook only when no queued row for that hook exists, so a row that survived a kill is not queued twice.
- **Quick tasks.** Triage stores each quick task as a `held` row. A capture that already has a `held` or `queued` row is not added again. The capture is marked executed after its row becomes `queued`, so a kill between the two steps cannot lose the task. When the row becomes `queued` its unit id takes the milestone the session runs at that time, so a session that moves to the next milestone runs the quick tasks it holds as units of that milestone.

Changed by the Lifecycle Kernel amendment below: the kernel `advance()` selects the queued rows.

## Amendment 2026-10-04: the planner retry after a failed pre-execution check is a row on the dispatch row

This is the first piece of part 4. The pre-execution check runs at the close-out of a `plan-slice` or `refine-slice` unit. When it refuses the plan, the host decides to run the planner again with the findings. Before this amendment the decision was session memory only (`pendingVerificationRetry` and the `pendingVerificationRetryDispatch` snapshot). The task rows of the refused plan stay in the database, so a restart derived the `executing` phase and ran the first task of the refused plan.

The decision is now a row in `unit_dispatch_retries (dispatch_id, failure_context, attempt, created_at)` (`db/unit-dispatch-retries.ts`).

Rules:

- **Store.** The check stores the retry on the newest dispatch row of the planner unit, together with the pre-execution budget count it used. A unit with no dispatch row stores nothing and keeps the session snapshot, so its retry lasts for the process only.
- **Select.** The dispatch rule `stored retry → plan-slice / refine-slice` reads the row. It matches in the `evaluating-gates` and `executing` phases, before a gate or a task uses the refused plan, and sends the slice back to the unit type that stored the retry. A live process and a restarted process use the same rule: finalize keeps no session snapshot for a retry that has a row.
- **Prompt.** The unit prompt gets the stored failure context when the session has none for the unit.
- **Release.** The row is deleted when the next close-out of the planner unit does not ask for a retry (the check passed, or it did not run), when the retry cap pauses auto-mode, and when the retry policy pauses auto-mode. This is the release rule of the budgets. A new dispatch of the unit does not release the row, so a process that is killed in the middle of the re-plan runs the re-plan again. A pause or a stop by the user does not release it.

Not changed by this amendment: every other verification retry (artifact verification, host verification of a Task, milestone validation, the git-commit repair) and `exhaustedVerificationUnits`. The next amendment moves them.

## Amendment 2026-10-04: every verification retry, its count and its failure history are rows on the dispatch row

This finishes the retry part of part 4 and the verification budgets of part 1. It replaces the store and select rules of the amendment above where they differ.

**Retry rows.** Every close-out that decides to run a unit again stores the decision in `unit_dispatch_retries`: artifact verification, host verification of a Task, milestone validation, the git-commit repair, the complete-slice tool error, the gate-evaluate missing verdict, and the pre-execution check. The row has a new nullable column `signature`.

- **Select.** The `pendingVerificationRetryDispatch` session snapshot is deleted. The dispatch rules select the next unit from the database in a live process and after a restart. State derivation selects a unit again when its verification failed, because the unit is not complete. Two retries are for a unit that state derivation does not select again, so a rule selects the unit by its row:
  - a pre-execution retry (signature `pre-execution:`), rule `stored retry → plan-slice / refine-slice`;
  - a git-commit repair retry (signature `git-commit:`), rule `stored retry → execute-task (commit repair)`. The task is closed when its commit is refused. The rule runs before `summarizing → complete-slice`, so the slice does not close with the commit open.
- **Prompt.** The unit prompt gets the failure context of the stored retry of the unit.
- **Release.** A verification gate that clears the retry state of a unit (a pass, a pause for a person, an abort) deletes the rows that a verification gate stored. It does not delete a pre-execution retry or a git-commit repair retry: the check that stored each one releases it (the pre-execution check on a result that is not a retry; the git action on a commit that succeeds or at its cap). The pause at the artifact verification cap deletes the verification rows with the `exhausted` mark, so a unit that is reopened or re-planned starts with no old failure context and at attempt 1. The retry-policy pause, and the skip of a closed unit that has no git-commit repair retry, delete every row of the unit.
- **Failure history.** Each retry of a unit opens a new dispatch row, so the retry rows of the earlier dispatches are the failure history of the unit. The duplicate-failure check compares the new failure with the retry that an earlier dispatch of the unit stored. `verificationRetryFailureHashes` is deleted. A restart keeps the check.
- **Session.** `pendingVerificationRetry` stays as the hand-over inside one close-out (from the gate that decides the retry to the retry policy and the journal) and as the failure context of a unit that has no dispatch row.

**Budget kinds.** `unit_dispatch_budgets` has four more kinds:

- `verification`: the count of verification retries of the unit (artifact verification, host verification, milestone validation). Dev-engine units no longer use `verificationRetryCount`; that map and `custom-verify-retries.json` now hold only the counts of custom-engine steps.
- `git-commit`: the count of git-commit repair retries of a task. A soft git failure in a repair run (a transient failure that lets the loop continue) also counts, because the stored retry selects the task again. At the cap the row is released and auto-mode pauses.
- `timeout-recovery`: the count of timeout recoveries of the unit (`unitRecoveryCount` is deleted). A start of auto-mode no longer resets it, so a restart keeps the backoff.
- `exhausted`: a mark, not a count. It is set when the unit used all its artifact verification retries; the `verification` count is reset and the verification retry rows are released at the same time. `exhaustedVerificationUnits` is deleted, and `custom-verify-retries.json` no longer stores an exhausted list.

**Exhausted units.** `resolveDispatch` does not dispatch a unit that holds the `exhausted` mark, with or without a session, so a restart does not dispatch it again. Release rule: a reopen or a re-plan releases the mark of the unit and of every unit below it (`gsd_task_reopen`, `gsd_slice_reopen`, `gsd_milestone_reopen`, `gsd_replan_slice`, `gsd_replan_task`). A pass of the artifact verification of the unit also writes `0`. An exhausted list in a `custom-verify-retries.json` file that an older build wrote is not read.

## Amendment 2026-10-04: the pause is a row, and the dispatch row has a stage checkpoint

This is part 2. Before this amendment the pause was a JSON value in `runtime_kv` (key `paused_session`), and that table is for soft state only. The value decided resume routing.

Decision (2026-10-04): a pause is state of the worker, not of a unit. Auto-mode can pause with no active unit. So the pause does not live on the dispatch row. It is a row in `auto_pauses` (`db/writers/auto-pauses.ts`).

Rules for the pause row:

- **Scope.** One row is open for each worker scope. The scope is the scope of the sidecar queue: the project root, or the milestone and slice lock of a parallel worker.
- **Content.** The row holds the blocker kind, the session context a resume needs (milestone, worktree path, step mode, session file, engine, run directory, milestone lock, start time) and `dispatch_id`.
- **Link.** `dispatch_id` is the claimed `unit_dispatches` row of the worker when that row is the row of the current unit, or the newest row of the current unit when the loop settled it before the pause. The loop claims a row before the unit starts its session. A pause between the claim and the start does not link the claimed row, because the session file belongs to an earlier unit. It is `NULL` when no unit was active and when the unit ran with no dispatch row.
- **Close.** A resume, a discard (the milestone is gone, complete or superseded) and `/gsd doctor fix` close the row (`closed_at`). A new pause closes the row that is still open. A closed row stays in the table. These closers act on the scope of their own process. A row of a milestone or slice scope whose item is closed, discarded or gone is stale, because no worker starts for that item again: `/gsd doctor fix` (`stale_paused_session`) and the start of the root session close such a row in every scope (`closeStaleScopedPauses`).
- **Migration.** An open row in any scope blocks `/gsd migrate`. The refusal names each scope and the command that closes its pause.
- **Legacy.** Nothing writes the `paused_session` key. It is read when the scope has no open row, so a pause that an older build stored can still be resumed. Such a pause has no blocker kind and no dispatch link, so it gets no tool-call replay. The clear of a pause deletes the key.

`pauseAuto` takes the blocker kind as a required parameter, and every call site passes one. The kind is one of the seven human blocker kinds of ADR-046 (`workflow_blockers.blocker_kind`), `user_request` (the user asked for the pause) or `machine_fixable`. `machine_fixable` marks a pause for a failure that ADR-046 does not list as human-only (a timeout, a failed verification, a git failure, a tool failure). These pauses are not changed here; they must move to a Recovery Action. The pause row does not open a `workflow_blockers` row.

Rules for the stage checkpoint (`unit_dispatch_stages (dispatch_id, stage, updated_at)`):

- **Write.** The auto loop writes `verify` when pre-verification passes: a pause in pre-verification for a unit that did not finish its work (tool invocation error, user skip, per-unit cost cap, cost spike, missing artifact) leaves the stage at `execute`. It writes `route` when finalize completes, and `closeout` before it settles that completed iteration. A finalize that pauses or stops writes no further stage. A dispatch with no stage row is in `execute`. A retry opens a new dispatch row, so the new run starts in `execute`.
- **Read.** A resume asks one question of the rows: does the unit still have execution to continue? The answer is yes when the stage of the dispatch row is `execute` (`isDispatchExecutionOpen`) and the result rows of the unit do not exist. The row status does not decide this: the loop settles the row of a unit that paused in pre-verification. Only then the session file of the unit is read, to build the tool-call replay text for the next prompt. The pause path (`handlePausedSessionResumeRecovery`) takes the unit from the dispatch link of the pause row. The crash path (`assessInterruptedSession`) takes it from the newest dispatch row of the dead worker.
- A live process and a restarted process use the same rule: `pauseAuto` keeps the dispatch link in the session and writes the same value to the row.

A restart continues a non-task unit at the `verify` stage (see the Lifecycle Kernel amendment below). Not changed: in the crash path, the count of tool calls in the session file is still one of the two signals that classify an interrupted session as recoverable. Resume routing asks for the milestone row before it restores the milestone of the pause; a milestone directory is not needed.

## Amendment 2026-10-04: a custom workflow step is claimed as a dispatch row

A custom workflow step (`custom-step`) is a non-task unit, so its kernel record is the claimed `unit_dispatches` row. It has no Attempt. The custom engine emits only `custom-step` units: the `execute-task` branches of the custom loop path (lease, Attempt, host verification, human-review response, publication) had no production producer and are deleted.

Rules:

- **Unit id.** `<name>/<timestamp>/<stepId>`: the run id and the step id. The claim guard is the partial unique index on `unit_id`, so two runs of one workflow do not block each other.
- **Scope.** `milestone_id` on the row is the run id. A run is not a milestone and `milestone_leases` references `milestones`, so a step claim has no lease and `milestone_lease_token` is `0` (`recordRunDispatchClaim`).
- **Second session.** A second session that resumes the run gets the active step again, fails the claim, and stops with a notice that names the worker. It does not call the agent.
- **Dead or stopped worker.** When the worker that holds the claim is dead (its process is not alive on this host) or its `workers` row is not `active` (it stopped or crashed), the next session cancels that row and claims the step with the next `attempt_n`. A session that stops while its step runs leaves the row `running`, and the next session can be in the same process.
- **Settle.** A verified step settles the row `completed` before the step row is marked complete. A unit break, a unit retry, a verification retry and a verification pause settle it `failed` with the reason.

Not changed:

- The custom loop path is still a separate branch of the auto loop. It shares guards, the unit phase and the dispatch ledger with the standard path.
- `/gsd workflow approve` completes a step with no dispatch row, because no unit runs. It does not check for a live claim of the step.
- A step has no expected artifact in the unit registry and no Tool Contract in the unit manifest, so the artifact check and the Worktree Safety check of the standard path do not run for it. The verification policy of the step is its check, and its result is the evidence row that completion requires (ADR-046). A run has no worktree: a step runs in the project root.

## Amendment 2026-10-04: the Lifecycle Kernel module selects the next unit from rows

This is part 4. `auto/lifecycle-kernel.ts` is the Lifecycle Kernel module. It has four entry points: `kernelStart`, `kernelAdvance`, `kernelResume` and `kernelStop`. `auto.ts` and the auto loop call these four for start, advance, resume and stop. `auto/workflow-kernel.ts` stays the pure policy layer below it.

`kernelAdvance` selects the next unit in this order:

1. **A unit that a killed process left in the `verify` stage.** The row is `canceled` with exit reason `crash-recovered` (the crash sweep of the next start) or `signal-exit` (the signal handler). It is the newest dispatch row of the milestone of the session (of the slice, for a slice-parallel worker), so a unit that the auto loop dispatched after it makes it history. The loop claims a new dispatch row for the unit, writes `verify` on it, does not run the unit and does not run pre-verification again, and continues at the verification gate. Budgets and stored retries are read by unit, so the new row keeps them. Not selected: `execute-task` (its Attempt holds the stage, and state derivation selects the Task again), `custom-step` (the engine selects the step again), a unit with an open sidecar row (the queue runs that row again), and a unit whose post-verification produced follow-on work before the kill. A pause or a stop is not a kill.
2. **The oldest `queued` row of the sidecar queue.**
3. **The step of a custom engine**, selected by the engine from the step rows of its run (the kernel returns `engine`).
4. **The unit the Auto Orchestration module selects** from the lifecycle rows and the stored retry rows. It claims the `unit_dispatches` row.

A unit produced follow-on work when a sidecar row with any status has its dispatch row as `trigger_dispatch_id`, or when the `hook_state` row holds an active hook whose trigger is the unit. The second rule is needed for a kill after the hook state was stored and before the hook was queued: the hook reconcile of the next start queues that hook with no link. A second post-verification of such a unit would queue the hook or the triage again. So the unit is history: the queue runs the follow-on work and the next unit comes from state, as before this amendment. This keeps the Hooks rule of the sidecar amendment true for the kernel: a row that survived a kill is not queued twice.

The selection runs after the session-lock check. A process that lost the lock selects nothing, so a queued sidecar row stays `queued` for the process that holds the lock. Before this amendment the loop took the row before the lock check and closed it without running it.

A unit killed in `route` or `closeout` finished its work and its verification. It is not selected again; the next unit comes from state. Its dispatch row stays `canceled` with the stage, which records where the process died.

Not changed:

- `kernelStart`, `kernelResume` and `kernelStop` pass to the Auto Orchestration module. Resume routing from the pause row is still in `auto.ts` and `interrupted-session.ts`.
- The other calls of the Auto Orchestration module did not move to the kernel. The auto loop calls `completeActiveUnit`, `retryActiveUnit`, `abandonActiveUnit` and `getStatus`. `auto.ts` calls `recheckWedge`. `auto-post-unit.ts` calls `retryActiveUnit`.
- Only the auto loop writes dispatch rows. The guided flow, `/gsd dispatch` and a workflow tool that is called outside auto-mode change lifecycle rows with no dispatch row, so their work does not make a canceled `verify` row history. After such work the next `/gsd auto` still continues the unit at `verify`: its verification gate, its post-unit hooks and its pre-execution check run again, also when the slice of the unit is complete. This is open until the guided flow and `/gsd dispatch` claim a dispatch row through the kernel advance. (Closed for the guided flow and `/gsd dispatch` by the amendment below; a workflow tool outside auto-mode still writes no dispatch row.)

## Amendment 2026-10-05: the guided flow and `/gsd dispatch` claim their unit through the one-unit bound

The gap above is closed. `lifecycle-kernel.ts` has a one-unit bound of the kernel advance for callers outside the auto loop: `kernelClaimUnit` and `kernelSettleUnitClaim`.

- **Claim.** Before the unit's turn runs, the caller claims the unit: a `dispatch-` worker row, the milestone lease, and the `unit_dispatches` row (marked `running`, except `execute-task`, which stays `claimed` as in the loop). The rules are the loop's rules: a live worker that holds the unit or the milestone lease refuses the claim, and the caller does not dispatch; the active row of a dead worker is taken over. A unit of a milestone that has no row yet, of a virtual milestone (`PROJECT`), or a dispatch with the database unavailable claims nothing and dispatches as before — the same units the loop claims nothing for. The turn runs under the claim's worker heartbeat and lease renewal (`runInteractiveClaimTurn`, the same wrapper every auto-loop unit phase runs under), so a turn longer than the lease TTL keeps the lease instead of losing it to another session's stale-takeover; the renewal stops when the turn settles.
- **Settle.** When the unit's turn ends, the row settles (`completed`, or `failed` when the send threw) and the lease and worker row are released. The guided flow settles in the agent-end handler before the discuss-to-auto handoff claims the lease, so the handoff cannot meet its own claim; both turn-end paths are safe to run twice.
- **Effect.** The claimed row is the newest dispatch row of its milestone scope, so an older interrupted `verify` row stops being selected: non-auto work that follows a crash no longer makes the next `/gsd auto` re-run the unit's verification gates. A unit that is still open after its interactive turn is dispatched again by state derivation under a fresh claim; the takeover of the settled unit's row records the old attempt.
- Not changed: a workflow tool outside auto-mode still writes no dispatch row; restart continuation, crash-path classification and the pause row rules are unchanged.

## Amendment 2026-10-05: the pause routes through the Recovery Classifier, and a human pause opens its blocker

Two routing rules of the pause row changed:

- **`machine_fixable` routes through the Recovery Classifier, and the route is consumed on advance.** `pauseAuto` classifies the failure (`auto/recovery-classification.ts`) and the open `auto_pauses` row records the route — `recovery:<failure-kind>/<action>`, the classified reason and the remediation — instead of the bare failure text. A resume no longer re-diagnoses the failure from prose: `routePausedSessionResume` reads the recorded route from the row. A recorded `retry` resumes by machine decision on the advance: the milestone pin restores, the advance re-runs the unit under its stored budgets and retries, and the interrupted turn is not replayed for a person — no paused-session file and no tool-call recovery prompt. A recorded `escalate` or `stop` — like every other action and every row without a recorded route — restores the person-facing paused session as before, with the session file replay. A superseded pin still adopts the project's active milestone first; the stale-pin exit outranks the retry. A custom-engine pause (`activeEngineId` set) is not routed by the recorded action and stays human-resumed. The seven human blocker kinds keep their own reason on the row.
- **A human pause opens its blocker.** A pause of one of the seven human blocker kinds opens a `workflow_blockers` row for the paused item (the task, slice or milestone lifecycle, most specific first) through the `pause.blocker.open` Domain Operation, and links it to the pause row (`auto_pauses.blocker_id`, a required-schema-feature column). A `machine_fixable` or `user_request` pause, and a pause of an item with no lifecycle row, opens none. The resolution of the pause resolves the row: `clearPausedSession` resolves it, a stale scoped pause dismisses it, and a newer pause resolves the row of the pause it replaces (`pause.blocker.resolve`). A blocker row that cannot open never blocks the pause itself.

## Amendment 2026-10-05: the advance selects a linked Remediation Task

`workflow_remediation_links` was schema-only: no dispatch rule read it. The kernel advance's selection now has the rule `executing → remediation-task (linked Remediation Task)` (ADR-046: a machine-fixable failure creates a linked Remediation Task). While a `remediation` link of the milestone has an open target Task (the target lifecycle is neither completed nor cancelled and the task row is not closed), the rule selects that Task before the reactive-execute and execute-task rules, as an ordinary `execute-task` unit. A `rework` link targets its own source item and is never selected. When the target Task completes, the rule stops matching and the ordinary state-derived unit runs. A closed target Task can hold no new link: the schema refuses it.

## Rejected alternatives

- Freeze 1.15.x — leaves field users wedged.
- Backport the full UnitRun collapse onto 1.15.x — too large for a patch (shipped as 1.15.1 fail-closed, then this 1.16 identity change).
- A new table or a new RAM `UnitRef` — `unit_dispatches` already has the lifecycle.
