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

## Rejected alternatives

- Freeze 1.15.x — leaves field users wedged.
- Backport the full UnitRun collapse onto 1.15.x — too large for a patch (shipped as 1.15.1 fail-closed, then this 1.16 identity change).
- A new table or a new RAM `UnitRef` — `unit_dispatches` already has the lifecycle.
