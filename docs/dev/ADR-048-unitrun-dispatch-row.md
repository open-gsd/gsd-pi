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
- The canonical loop does not call `openDispatchClaim` after `advance()`. Custom-engine execute-task and sidecar items still claim themselves.
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

Part 1 has started. `unit_dispatch_budgets (dispatch_id, kind, used)` holds one count for each budget kind. A retry opens a new dispatch row for the same unit, so the count of a unit is the value on its newest dispatch row that holds the kind, and a reset writes `0` on the newest row. The zero-tool, tool-unavailable and pre-execution repair budgets use it (`db/unit-dispatch-budgets.ts`). The three budgets have one release rule: a pass of the unit, or the pause at the cap, writes `0`, so a resume after a person fixed the cause starts a new budget. A unit that runs with no dispatch row (a custom-engine step) has no durable identity, so its count lasts for the process only.

Part 4 has started with one decision: the planner retry after a failed pre-execution check (see the second 2026-10-04 amendment). One session field was deleted with no database replacement: the findings of a failed pre-execution check (`lastPreExecFailure` on the auto session and in the paused-session metadata). Its only reader was the `planning → plan-slice` dispatch rule. That rule matches only a slice with no task rows. The check stores findings only for a slice that has task rows, and the rows stay after the failure, so the reader was unreachable. A paused-session row written by an older build may still carry the deleted field; it is ignored.

## Amendment 2026-10-04: the sidecar queue is rows linked to the dispatch row

Owner decision 2026-10-03: the claimed `unit_dispatches` row is the kernel record of a non-task unit, and the follow-on work a unit queues (post-unit hooks, capture triage, quick tasks) is stored as rows linked to the dispatch that triggered it. `AutoSession.sidecarQueue` and `AutoSession.pendingQuickTasks` are deleted. The queue is the `unit_dispatch_sidecars` table (`db/unit-dispatch-sidecars.ts` reads it, `db/writers/unit-dispatch-sidecars.ts` writes it).

Rules:

- **Link.** `trigger_dispatch_id` is the newest `unit_dispatches` row of the unit whose close-out queued the item. It is `NULL` when that unit ran with no dispatch row (a custom-engine step that is not an execute-task), and when a resume queues a restored hook again.
- **Scope.** A row belongs to the worker, not to the milestone it runs: the scope has no milestone unless the worker is a parallel worker (`GSD_PARALLEL_WORKER`), which stays on the milestone of its lock, and on the slice of its lock for a slice-parallel worker (`GSD_SLICE_LOCK`). A worker reads only the rows of its own scope, so two live workers do not run the queue of each other. A restarted worker has the same scope and takes the rows of the process that died, also when the restart is on the next milestone: the rows of the finished milestone run before the new work. A start that is not a parallel worker also takes the `held` and `queued` rows of a parallel scope that no live worker owns, so a parallel worker that was killed at the end of its milestone does not strand its rows. A scope has an owner when another process holds an unexpired `milestone_leases` row of the scope, or when the worker that holds the lease or that ran the dispatch which queued the row is live. A live worker is an active `workers` row of another process with a fresh heartbeat or with a process that is alive on this host. So a scope is ownerless only when the lease is expired, the heartbeat is stale and the process is dead. The loop renews the heartbeat and the lease during the unit phase and the finalize phase, so a long verification does not make a live worker look dead.
- **Status.** `held` is a quick task that waits (one quick task runs between two units). `queued` is ready work: the auto loop runs the oldest queued row before it selects a unit. `done` is set when the loop iteration that ran the row ends, with any result. `canceled` is set by `stopAuto`.
- **Kill.** A killed process leaves the row `held` or `queued`. The next start runs it. A pause or a stop is not a kill: a pause in the middle of an item closes its row, and `stopAuto` cancels every queued row and every held quick task of the worker, as the in-memory queue did.
- **Hooks.** The `hook_state` row in the database still holds the active hook and the gate block. On start and resume the hook reconcile queues the restored hook only when no queued row for that hook exists, so a row that survived a kill is not queued twice.
- **Quick tasks.** Triage stores each quick task as a `held` row. A capture that already has a `held` or `queued` row is not added again. The capture is marked executed after its row becomes `queued`, so a kill between the two steps cannot lose the task. When the row becomes `queued` its unit id takes the milestone the session runs at that time, so a session that moves to the next milestone runs the quick tasks it holds as units of that milestone.

Not changed: the auto loop still takes queued rows before `advance()`. Selecting them inside `advance()` is part of the Lifecycle Kernel work.

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

Decision (2026-10-04): a pause is state of the worker, not of a unit. Auto-mode can pause with no active unit, and a custom-engine step that is not a Task has no dispatch row. So the pause does not live on the dispatch row. It is a row in `auto_pauses` (`db/writers/auto-pauses.ts`).

Rules for the pause row:

- **Scope.** One row is open for each worker scope. The scope is the scope of the sidecar queue: the project root, or the milestone and slice lock of a parallel worker.
- **Content.** The row holds the blocker kind, the session context a resume needs (milestone, worktree path, step mode, session file, engine, run directory, milestone lock, start time) and `dispatch_id`.
- **Link.** `dispatch_id` is the claimed `unit_dispatches` row of the worker when that row is the row of the current unit, or the newest row of the current unit when the loop settled it before the pause. The loop claims a row before the unit starts its session. A pause between the claim and the start does not link the claimed row, because the session file belongs to an earlier unit. It is `NULL` when no unit was active and when the unit ran with no dispatch row.
- **Close.** A resume, a discard (the milestone is gone, complete or superseded) and `/gsd doctor fix` close the row (`closed_at`). A new pause closes the row that is still open. A closed row stays in the table. These closers act on the scope of their own process. A row of a milestone or slice scope whose item is closed, discarded or gone is stale, because no worker starts for that item again: `/gsd doctor fix` (`stale_paused_session`) and the start of the root session close such a row in every scope (`closeStaleScopedPauses`).
- **Migration.** An open row in any scope blocks `/gsd migrate`. The refusal names each scope and the command that closes its pause.
- **Legacy.** Nothing writes the `paused_session` key. It is read when the scope has no open row, so a pause that an older build stored can still be resumed. Such a pause has no blocker kind and no dispatch link, so it gets no tool-call replay. The clear of a pause deletes the key.

`pauseAuto` takes the blocker kind as a required parameter, and every call site passes one. The kind is one of the seven human blocker kinds of ADR-046 (`workflow_blockers.blocker_kind`), `user_request` (the user asked for the pause) or `machine_fixable`. `machine_fixable` marks a pause for a failure that ADR-046 does not list as human-only (a timeout, a failed verification, a git failure, a tool failure). These pauses are not changed here; they must move to a Recovery Action. The pause row does not open a `workflow_blockers` row.

Rules for the stage checkpoint (`unit_dispatch_stages (dispatch_id, stage, updated_at)`):

- **Write.** The auto loop writes `verify` when the unit phase ends and finalize starts, `route` when finalize returns, and `closeout` before it settles a completed iteration. A dispatch with no stage row is in `execute`. A retry opens a new dispatch row, so the new run starts in `execute`.
- **Read.** A resume asks one question of the rows: does the unit still have execution to continue? The answer is yes when the dispatch row is not `completed` and its stage is `execute` (`isDispatchExecutionOpen`), and the result rows of the unit do not exist. Only then the session file of the unit is read, to build the tool-call replay text for the next prompt. The pause path (`handlePausedSessionResumeRecovery`) takes the unit from the dispatch link of the pause row. The crash path (`assessInterruptedSession`) takes it from the newest dispatch row of the dead worker.
- A live process and a restarted process use the same rule: `pauseAuto` keeps the dispatch link in the session and writes the same value to the row.

Not changed: a restart does not continue a unit at the `verify`, `route` or `closeout` stage. It selects the next unit from state, as before. Continuing at the stored stage is part of the Lifecycle Kernel work. The custom-engine step that is not a Task has no dispatch row and so no stage. In the crash path, the count of tool calls in the session file is still one of the two signals that classify an interrupted session as recoverable. Resume routing still asks for a milestone directory with content before it restores the milestone of the pause.

## Rejected alternatives

- Freeze 1.15.x — leaves field users wedged.
- Backport the full UnitRun collapse onto 1.15.x — too large for a patch (shipped as 1.15.1 fail-closed, then this 1.16 identity change).
- A new table or a new RAM `UnitRef` — `unit_dispatches` already has the lifecycle.
