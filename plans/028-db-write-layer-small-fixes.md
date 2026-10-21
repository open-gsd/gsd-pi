# Plan 028: Six small state/DB correctness fixes (status aliases, gate atomicity, claim locking, derive-cache locks, lease test)

> **Executor instructions**: Follow this plan step by step. Each step is an
> independent fix — commit each one separately. Run every verification command
> and confirm the expected result before moving on. If anything in the "STOP
> conditions" section occurs, stop and report — do not improvise. When done,
> update the status row for this plan in `plans/README.md` — unless a reviewer
> dispatched you and told you they maintain the index.
>
> **Drift check (run first)**: `git diff --stat f095797f..HEAD -- src/resources/extensions/gsd/db/writers/cascades.ts src/resources/extensions/gsd/gsd-db.ts src/resources/extensions/gsd/db/command-queue.ts src/resources/extensions/gsd/auto.ts src/resources/extensions/gsd/db/milestone-leases.ts`
> If any in-scope file changed since this plan was written, compare the
> "Current state" excerpts against the live code before proceeding; on a
> mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S (per step; S–M total)
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug + tests
- **Planned at**: commit `f095797f`, 2026-07-07

## Why this matters

Six independently-verified, small-blast-radius defects in the state/DB layer.
Background you need: the DB stores free-form status strings with legacy
aliases — `RAW_CLOSED_STATUSES = ["complete", "done", "skipped", "closed"]`
in `status-guards.ts:37` is the single closed-set source of truth, and
`isClosedStatus()` / `toStatus()` are the sanctioned predicates. Inline
re-derivations that hand-pick two of the four aliases are how completed data
gets silently corrupted.

1. `skipSliceCascade` guards "already complete" with two inline literals,
   missing the `closed` alias — a completed slice stored as `closed` gets
   downgraded to `skipped` with its `completed_at` nulled. (Found
   independently by two auditors.)
2. `insertTask` stamps `completed_at` only for `done`/`complete` — a task
   imported as `closed` is terminal but has no completion timestamp, so
   `completed_at`-dependent reads (recent-completions, timelines) miss it.
3. `saveGateResult` writes the gate verdict UPDATE and the `gate_runs` audit
   INSERT as two separate autocommits — a crash between them records a
   completed gate with no ledger row (the ledger Recovery Classification
   reads).
4. `claimNextCommand` does SELECT-then-UPDATE inside a **deferred**
   transaction — under WAL, two workers racing produces
   `SQLITE_BUSY_SNAPSHOT` (which `busy_timeout` does not retry), so the loser
   **throws** instead of gracefully returning `null`. `immediateTransaction`
   exists for exactly this.
5. The 100 ms derive-state cache is keyed on `basePath` only, but
   `deriveStateFromDb` filters by `GSD_MILESTONE_LOCK`, which auto-mode
   mutates at runtime — a derive cached before a lock flip serves the
   wrong-lock phase for up to 100 ms after it.
6. `forceReleaseLeasesForWorker` — the crash-recovery path that frees a dead
   worker's milestone leases — has zero test references. Over-matching frees
   a *live* peer's lease (two workers drive one milestone); under-matching
   leaves a milestone leased forever.

## Current state

Files and roles:

- `src/resources/extensions/gsd/db/writers/cascades.ts` — hierarchy cascade
  writers; `skipSliceCascade` at ~line 208.
- `src/resources/extensions/gsd/gsd-db.ts` — DB barrel + write primitives;
  `insertTask` completed_at at ~line 518; `saveGateResult` at ~line 1075;
  `insertGateRun` at ~line 1197.
- `src/resources/extensions/gsd/status-guards.ts` — `RAW_CLOSED_STATUSES`,
  `isClosedStatus`, `toStatus`.
- `src/resources/extensions/gsd/db/command-queue.ts` — worker IPC queue;
  `claimNextCommand` at ~line 73.
- `src/resources/extensions/gsd/db-transaction.ts` + `db/engine.ts` —
  `transaction()` (BEGIN deferred) and `immediateTransaction()` (BEGIN
  IMMEDIATE), both re-entrant via a depth counter.
- `src/resources/extensions/gsd/state/derive/cache.ts` — single-slot 100 ms
  cache keyed on `basePath`; `invalidateStateCache()` at line ~28.
- `src/resources/extensions/gsd/auto.ts` — `captureMilestoneLockEnv` (line
  ~434) / `restoreMilestoneLockEnv` (line ~448) set/delete
  `process.env.GSD_MILESTONE_LOCK`.
- `src/resources/extensions/gsd/db/milestone-leases.ts` —
  `forceReleaseLeasesForWorker` at ~line 279.

Key excerpts (verify you see these before editing):

`cascades.ts` ~line 214 — the alias-blind guard (note the same function uses
`isClosedStatus` for tasks a few lines below):

```ts
    if (slice.status === "complete" || slice.status === "done") {
      outcome = { ok: false, reason: "slice-already-complete" };
      return;
    }
    const wasAlreadySkipped = slice.status === "skipped";
```

`gsd-db.ts` ~lines 518 and 534 — the two-literal completion stamp:

```ts
    ":completed_at": t.status === "done" || t.status === "complete" ? new Date().toISOString() : null,
    ...
    ":preserve_completion": t.preserveCompletionMetadata && (t.status === "complete" || t.status === "done") ? 1 : 0,
```

`gsd-db.ts` `saveGateResult` — UPDATE `quality_gates` ... then, after a
changes check and verdict→outcome mapping, a separate `insertGateRun(...)`
call. No `transaction(` wrapper appears inside the function.

`db/command-queue.ts:78` — `return transaction((): CommandQueueRow | null => {`
wrapping a SELECT (line ~81) then a conditional UPDATE (line ~96) with a
`changes !== 1 → return null` race guard that never runs if the write upgrade
throws first.

`state/derive/cache.ts:33-46` — cache hit requires only
`_stateCache.basePath === cacheKey` + TTL.

`db/milestone-leases.ts:279` — `forceReleaseLeasesForWorker(workerId)` runs
`UPDATE milestone_leases SET status = 'released' WHERE worker_id = :worker_id AND status = 'held'`.

Conventions: single quotes in gsd extension files, 2-space indent, WHY
comments, `_*ForTest` seams, `node:test` tests in
`src/resources/extensions/gsd/tests/`.

## Commands you will need

| Purpose | Command | Expected on success |
|---------|---------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0 |
| Compile tests | `pnpm run test:compile` | exit 0 |
| Run one test file | `node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/<name>.test.js` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/db/writers/cascades.ts`
- `src/resources/extensions/gsd/gsd-db.ts` (only `insertTask` and `saveGateResult`)
- `src/resources/extensions/gsd/db/command-queue.ts`
- `src/resources/extensions/gsd/auto.ts` (only the two lock-env functions)
- Test files: `tests/skip-slice-cascades-tasks.test.ts` (extend),
  `tests/gsd-db.test.ts` or `tests/gate-storage.test.ts` (extend),
  `tests/command-queue.test.ts` (extend), `tests/milestone-leases.test.ts`
  (extend), plus a small derive-cache test (extend `tests/derive-state-db.test.ts`
  or the file that tests `state/derive/cache.ts`)
- `plans/README.md` (status row only)

**Out of scope**:
- Routing the cascades through `applyStatusTransition` — ADR-030 explicitly
  sequences that behind sanctioned reopen faces; do not attempt it here.
- Any other inline status comparison elsewhere in the codebase (~50 sites) —
  this plan fixes only the two with verified data-loss consequences.
- `db/writers/status.ts`, `state-transition-matrix.ts`.
- Changing `transaction()`/`immediateTransaction()` themselves.

## Git workflow

- Branch: `advisor/028-db-write-layer-small-fixes`
- One conventional commit per step, e.g. `fix(gsd-db): recognize closed alias in skipSliceCascade guard`. No AI credit.
- Do NOT push or open a PR unless the operator instructed it.

## Steps

### Step 1: Fix the `skipSliceCascade` already-closed guard

In `cascades.ts`, replace the two-literal check with the shared predicate,
keeping the intentional re-skip path (`skipped` must NOT be rejected — it
falls through to the `wasAlreadySkipped` no-op):

```ts
    if (isClosedStatus(slice.status) && slice.status !== 'skipped') {
      outcome = { ok: false, reason: 'slice-already-complete' };
      return;
    }
```

(`isClosedStatus` is already imported in this file for the task loop.) Add a
test case to `tests/skip-slice-cascades-tasks.test.ts`: insert a slice with
raw status `closed`, call `skipSliceCascade`, assert
`{ ok: false, reason: 'slice-already-complete' }` and that the row's status
and `completed_at` are unchanged. Also assert the existing `skipped` re-skip
case still returns `ok: true, wasAlreadySkipped: true`.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/skip-slice-cascades-tasks.test.js` → all pass.

### Step 2: Stamp `completed_at` for all complete-aliases in `insertTask`

In `gsd-db.ts`, compute once above the `.run({...})`:

```ts
  const isCompleteAlias = t.status != null && toStatus(t.status) === 'complete';
```

and use it for both params: `":completed_at": isCompleteAlias ? new Date().toISOString() : null`
and `":preserve_completion": t.preserveCompletionMetadata && isCompleteAlias ? 1 : 0`.
Import `toStatus` from `./status-guards.js` if not already imported (check the
existing import line). Deliberately do NOT stamp for `skipped` — the cascade
writers set `completed_at = NULL` for skipped rows; a skipped task was not
completed. Say this in a one-line comment.

Add a test (in `tests/gsd-db.test.ts`, near existing `insertTask` coverage):
inserting a task with status `closed` yields a non-null `completed_at`;
inserting with `skipped` yields null.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/gsd-db.test.js` → all pass.

### Step 3: Make `saveGateResult` atomic

Wrap the body of `saveGateResult` (the `quality_gates` UPDATE, the
changes-check throw, and the `insertGateRun` call) in the module's existing
`transaction(() => { ... })` helper (check how other functions in `gsd-db.ts`
import/call it — e.g. `deleteTask`). The runner is re-entrant (depth counter),
so callers already inside a transaction are safe. Keep the throw-on-zero-changes
inside the transaction so a missing gate row rolls back nothing.

Add a test (extend `tests/gate-storage.test.ts` if it covers `saveGateResult`,
else `tests/gsd-db.test.ts`): stub/point `insertGateRun` at a failure — if no
seam exists, instead assert transactional behavior structurally: begin →
UPDATE + INSERT commit together by checking that after a successful
`saveGateResult` both the gate row shows `complete` AND exactly one matching
`gate_runs` row exists (`SELECT count(*) FROM gate_runs WHERE gate_id = ...`).
If you can trigger the failure path cheaply (e.g. drop the `gate_runs` table
in the test DB before the call), assert the gate row's status/verdict are
UNCHANGED after the throw — that is the regression this fixes.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/gate-storage.test.js` (or gsd-db) → all pass.

### Step 4: Claim commands with `BEGIN IMMEDIATE`

In `db/command-queue.ts`, switch `claimNextCommand` from `transaction(` to
`immediateTransaction(` (check the import at the top of the file — both come
from the same module; add `immediateTransaction` to the import list). Add a
WHY comment:

```ts
  // BEGIN IMMEDIATE: this is a read-then-write claim. Under WAL, a deferred
  // transaction that reads first and then upgrades to a writer can fail with
  // SQLITE_BUSY_SNAPSHOT (not retried by busy_timeout) when two workers race;
  // taking the write lock up front serializes claimants so the loser waits
  // and then sees the row already claimed (changes !== 1 → null).
```

Leave `markCommandComplete`/enqueue paths alone (they are write-first).

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/command-queue.test.js` → all pass.

### Step 5: Invalidate the derive cache when the milestone lock flips

In `auto.ts`, at the end of `captureMilestoneLockEnv` and
`restoreMilestoneLockEnv`, call `invalidateStateCache()` (check `auto.ts`'s
existing imports — it very likely already imports from `./state.js`; if not,
import `invalidateStateCache` the same way sibling modules do). One WHY
comment at the first call site:

```ts
  // The derive cache is keyed on basePath only; GSD_MILESTONE_LOCK changes
  // what deriveState computes, so a lock flip must not serve a cached result.
```

Test: in the derive-cache test file, assert that after a cached
`deriveState`, changing `process.env.GSD_MILESTONE_LOCK` and calling
`invalidateStateCache()` yields a fresh derivation — if wiring a full
auto-mode fixture is disproportionate, a direct unit test that
`captureMilestoneLockEnv`/`restoreMilestoneLockEnv` clear the cache
(observable via the exported cache read/write helpers in
`state/derive/cache.ts`) is sufficient. If `auto.ts`'s lock functions are not
exported and have no test seam, cover via the cache helpers only and note it.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/derive-state-db.test.js` → all pass.

### Step 6: Test `forceReleaseLeasesForWorker`

Extend `tests/milestone-leases.test.ts` (the harness — in-memory DB +
`registerAutoWorker` + `claimMilestoneLease` — already exists there):

1. Register workers A and B; A claims milestone M1, B claims M2.
   `forceReleaseLeasesForWorker(A)` → returns 1; M1's lease row is
   `released`; **B's M2 lease is still `held`** (the over-release guard).
2. After the force release, a new claim on M1 succeeds and the fencing token
   is greater than the released lease's token.
3. `forceReleaseLeasesForWorker` on a worker with no held leases returns 0.

**Verify**: `pnpm run test:compile && node --import ./scripts/dist-test-resolve.mjs --test dist-test/src/resources/extensions/gsd/tests/milestone-leases.test.js` → all pass, including 3 new cases.

## Test plan

Per-step above. Final sweep: run the five touched test files standalone; then
`pnpm run typecheck:extensions`.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0
- [ ] `grep -n '"complete" || slice.status === "done"' src/resources/extensions/gsd/db/writers/cascades.ts` → no matches
- [ ] `grep -n 'immediateTransaction' src/resources/extensions/gsd/db/command-queue.ts` → match in `claimNextCommand`
- [ ] `saveGateResult` body is inside a `transaction(` callback
- [ ] Both lock-env functions call `invalidateStateCache()`
- [ ] New/extended tests pass in all five test files; each fix has at least one assertion that fails on the pre-change code
- [ ] No files outside the in-scope list modified (`git status`)
- [ ] `plans/README.md` status row updated

## STOP conditions

Stop and report back (do not improvise) if:

- Any excerpt in "Current state" doesn't match the live code.
- `gsd-db.ts` does not already have a usable `transaction` import for step 3
  and adding one creates an import cycle — report the cycle.
- `immediateTransaction` is not exported along the path `command-queue.ts`
  currently gets `transaction` from.
- Step 5: `auto.ts` cannot import `invalidateStateCache` without a cycle —
  report; do not inline a copy of the cache.
- Any existing test in the five suites fails for a reason you can't trace to
  your specific change within two attempts.

## Maintenance notes

- Steps 1–2 are instances of a repo-wide pattern (inline status literals vs
  `status-guards.ts`); ADR-030's deferred write-normalization is the real fix.
  Reviewers: reject any NEW inline `status === "complete" || ...` in review.
- Step 4 sets the precedent: any read-then-write claim helper on this DB
  should use `immediateTransaction`. `milestone-leases.ts` and
  `auto-workers.ts` are write-first and correct as-is — do not "fix" them.
- Step 3 makes the gate verdict + ledger row atomic; if `saveGateResult` ever
  grows more side effects (notifications, cache pokes), keep DB writes inside
  and side effects outside the transaction.
