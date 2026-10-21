# ADR-038: Dispatch History deep module

> **Disposition under [ADR-047](ADR-047-auto-mode-liveness-backstop.md): Superseded.** Durable dispatch attribution remains in `unit_dispatches`; the dispatch-history window, Rule 1 detector, and graduated stuck recovery are deleted in favor of the DB-persisted liveness backstop.

## Status

Superseded (2026-08-08)

## Context

"What was dispatched, when, with what outcome" was implemented four times with no shared interface: the `unit_dispatches` DB ledger, the journal, the Auto Orchestration module's private in-memory `dispatchKeyWindow`, and a `runtime_kv` recovery counter. The two stuck-loop detectors disagreed: the live orchestrator path used a bare saturation count whose window reset on every `start()`/`resume()` — so a fresh session never saw prior re-dispatches (#482: one unit dispatched 146× across sessions, burning entire token budgets) — while the rule-based `detectStuck()` (4 rules + retry-budget suppression) was reachable only from the legacy `runDispatch` path that production no longer executes. Window key formats also diverged (`type:id` vs `type/id`), and retry-budget suppression looked up ledger rows by a compound key that production rows (keyed by bare unit id) could never match.

## Decision

Dispatch history deepens behind one module, `auto/dispatch-history.ts`:

- `createDispatchHistory({ resolveScopeId, windowSize })` owns the dispatch-key window, ledger-error attachment, stuck verdicts (delegating to the `detect-stuck.ts` rules — one rules engine, not two), retry-budget suppression, rehydration, and recovery clearing.
- One canonical key home: `buildDispatchKey` / `normalizeDispatchKey` / `parseDispatchKey` (canonical `type:id`; legacy `type/id` normalized on rehydrate). `STUCK_WINDOW_SIZE` lives here.
- The Auto Orchestration module rehydrates the window from the `unit_dispatches` ledger in `start()`, and in `resume()` when the window is empty — cross-session stuck detection fires by construction (#482). In-process pause/resume preservation (#572) is unchanged.
- At window saturation the orchestrator consults the module's `detectStuck` verdict, gaining retry-budget suppression (saturated-but-in-backoff proceeds instead of hard-stopping) and rule-based reasons. Graduated stuck-artifact recovery is unchanged.
- Retry-budget suppression queries the bare `unit_id` + `unit_type` match first (the production ledger shape), with the compound-key lookup as fallback — fixing the production-never-matched compound-key lookup. The key grammar itself lives in one home (`auto/dispatch-key.ts`: `buildDispatchKey`/`parseDispatchKey`/`normalizeDispatchKey`, re-exported by `dispatch-history.ts`).

## Consequences

- Stuck behavior is table-testable through the module interface (fixture windows), not only via full `advance()` cycles.
- New stuck rules and window-lifecycle changes have one home.
- The #442 Phase 3 deletion of `runPreDispatch`/`runDispatch` was NOT performed: those functions are load-bearing for the auto-loop test harness (~116 live-behavior tests build their orchestration module from them), and `loopState.recentUnits` is written by the live `runUnitPhase` error tagging. Deleting the legacy path requires a harness rewrite first; that remains the recorded follow-up for #442.
