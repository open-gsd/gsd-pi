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
2. Pause and resume state on the dispatch row.
3. The sidecar queue (hooks, triage, quick tasks) as rows linked to the dispatch that triggered them.
4. Advance selects from the database only.

Part 1 has started. `unit_dispatch_budgets (dispatch_id, kind, used)` holds one count for each budget kind. A retry opens a new dispatch row for the same unit, so the count of a unit is the value on its newest dispatch row that holds the kind, and a reset writes `0` on the newest row. The zero-tool, tool-unavailable and pre-execution repair budgets use it (`db/unit-dispatch-budgets.ts`). The three budgets have one release rule: a pass of the unit, or the pause at the cap, writes `0`, so a resume after a person fixed the cause starts a new budget. A unit that runs with no dispatch row (a custom-engine step) has no durable identity, so its count lasts for the process only.

## Amendment 2026-10-04: the sidecar queue is rows linked to the dispatch row

Owner decision 2026-10-03: the claimed `unit_dispatches` row is the kernel record of a non-task unit, and the follow-on work a unit queues (post-unit hooks, capture triage, quick tasks) is stored as rows linked to the dispatch that triggered it. `AutoSession.sidecarQueue` and `AutoSession.pendingQuickTasks` are deleted. The queue is the `unit_dispatch_sidecars` table (`db/unit-dispatch-sidecars.ts` reads it, `db/writers/unit-dispatch-sidecars.ts` writes it).

Rules:

- **Link.** `trigger_dispatch_id` is the newest `unit_dispatches` row of the unit whose close-out queued the item. It is `NULL` when that unit ran with no dispatch row (a custom-engine step that is not an execute-task), and when a resume queues a restored hook again.
- **Scope.** A row belongs to one milestone, and to one slice for a slice-parallel worker (`GSD_SLICE_LOCK`). A worker reads only the rows of its own scope, so two live workers do not run the queue of each other. A restarted worker has the same scope and takes the rows of the process that died.
- **Status.** `held` is a quick task that waits (one quick task runs between two units). `queued` is ready work: the auto loop runs the oldest queued row before it selects a unit. `done` is set when the loop iteration that ran the row ends, with any result. `canceled` is set by `stopAuto`.
- **Kill.** A killed process leaves the row `held` or `queued`. The next start runs it. A pause or a stop is not a kill: a pause in the middle of an item closes its row, and `stopAuto` cancels every queued row of the scope and every quick task the worker holds, as the in-memory queue did.
- **Hooks.** The `hook_state` row in the database still holds the active hook and the gate block. On start and resume the hook reconcile queues the restored hook only when no queued row for that hook exists, so a row that survived a kill is not queued twice.
- **Quick tasks.** Triage stores each quick task as a `held` row. A capture that already has a `held` or `queued` row is not added again. The capture is marked executed after its row becomes `queued`, so a kill between the two steps cannot lose the task. A `held` row belongs to the worker, not to the milestone: its scope has no milestone unless the worker is a parallel worker (`GSD_PARALLEL_WORKER`), which stays on the milestone of its lock. When the row becomes `queued` it takes the scope of the milestone the session runs at that time, so a session that moves to the next milestone still runs the quick tasks it holds.

Not changed: the auto loop still takes queued rows before `advance()`. Selecting them inside `advance()` is part of the Lifecycle Kernel work.

## Rejected alternatives

- Freeze 1.15.x — leaves field users wedged.
- Backport the full UnitRun collapse onto 1.15.x — too large for a patch (shipped as 1.15.1 fail-closed, then this 1.16 identity change).
- A new table or a new RAM `UnitRef` — `unit_dispatches` already has the lifecycle.
