# Plan 004: Batch slice queries in `deriveStateFromDb`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/state.ts src/resources/extensions/gsd/db/queries.ts src/resources/extensions/gsd/tests/derive-state-helpers.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: perf
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

`deriveStateFromDb()` calls `buildRegistryAndFindActive()`, which loops over every milestone and calls `getMilestoneSlices(milestoneId)` once per milestone. Each call issues a separate `SELECT * FROM slices WHERE milestone_id = :mid`. On projects with many milestones, every state derivation performs O(M) SQL round-trips. Because `reconcileBeforeDispatch` and the orchestrator call `deriveState` repeatedly, this adds measurable dispatch latency and SQLite lock pressure.

## Current state

- `src/resources/extensions/gsd/state.ts:480-486` — `buildRegistryAndFindActive` loops over milestones and calls `getMilestoneSlices(m.id)` per milestone.
- `src/resources/extensions/gsd/db/queries.ts:267-271` — `getMilestoneSlices` executes one query per milestone.
- `src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` — existing tests for `buildRegistryAndFindActive`.

Relevant excerpt from `state.ts:467-509`:

```ts
async function buildRegistryAndFindActive(
  basePath: string,
  milestones: MilestoneRow[],
  completeMilestoneIds: Set<string>,
  parkedMilestoneIds: Set<string>
) {
  const registry: MilestoneRegistryEntry[] = [];
  ...
  for (const m of milestones) {
    if (parkedMilestoneIds.has(m.id)) {
      registry.push({ id: m.id, title: stripMilestonePrefix(m.title) || m.id, status: 'parked' });
      continue;
    }

    const slices = getMilestoneSlices(m.id);
    ...
  }
}
```

Relevant excerpt from `db/queries.ts:267-271`:

```ts
export function getMilestoneSlices(milestoneId: string): SliceRow[] {
  if (!getDbOrNull()!) return [];
  const rows = getDbOrNull()!.prepare("SELECT * FROM slices WHERE milestone_id = :mid ORDER BY sequence, id").all({ ":mid": milestoneId });
  return rows.map(rowToSlice);
}
```

Repo conventions:
- The Query Module (`db/queries.ts`) is read-only; add new `SELECT` functions there.
- Keep `getMilestoneSlices` unchanged for other callers.
- Preserve ordering (`ORDER BY sequence, id`).
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` | all pass |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/db/queries.ts` — add a batched slice query.
- `src/resources/extensions/gsd/state.ts` — use the batched query in `buildRegistryAndFindActive`.
- `src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` — add a test that exercises the batched path with multiple milestones.

**Out of scope**:
- Task-query batching (similar N+1 exists for tasks but is not covered here).
- Markdown renderer batching (plan for separately if needed).
- Changing the public signature of `getMilestoneSlices`.

## Git workflow

- Branch: `perf/batch-slice-queries-state-derivation`
- Commit message style: `perf(gsd): batch slice queries across milestones in deriveState`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add a batched slice query to the Query Module

In `src/resources/extensions/gsd/db/queries.ts`, add a new function after `getMilestoneSlices`:

```ts
/**
 * Load slices for many milestones in a single query. Returns a Map keyed by
 * milestone_id, preserving `ORDER BY sequence, id` within each bucket.
 */
export function getSlicesByMilestoneIds(milestoneIds: readonly string[]): Map<string, SliceRow[]> {
  const db = getDbOrNull();
  if (!db || milestoneIds.length === 0) return new Map();
  const rows = db
    .prepare(
      `SELECT * FROM slices WHERE milestone_id IN (${milestoneIds.map(() => ":id").join(", ")}) ORDER BY milestone_id, sequence, id`
    )
    .all(Object.fromEntries(milestoneIds.map((id, i) => [`:id${i}`, id])))
    // alternative if the above placeholder approach is awkward with the sql.js driver:
    // use a single JSON-table or temporary-table approach supported by SQLite.
  ...
}
```

**Important**: the sql.js driver used here may not support numbered `:id0`, `:id1` style placeholders in the same way as better-sqlite3. Inspect existing dynamic `IN (...)` queries in `db/queries.ts` or `db/writers/` for the exact placeholder pattern used in this repo, and match it. If no pattern exists, use a safe approach such as:
- A fixed-size chunking strategy with literal placeholders (`:a, :b, :c`).
- Or query all slices and filter in memory if the table is small.

The function must return `Map<string, SliceRow[]>` where each array is ordered by `sequence, id`.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 2: Use the batched query in `buildRegistryAndFindActive`

In `src/resources/extensions/gsd/state.ts`, before the `for (const m of milestones)` loop, collect all non-parked milestone ids and fetch slices in one call:

```ts
const activeMilestoneIds = milestones
  .filter((m) => !parkedMilestoneIds.has(m.id))
  .map((m) => m.id);
const slicesByMilestone = getSlicesByMilestoneIds(activeMilestoneIds);

for (const m of milestones) {
  if (parkedMilestoneIds.has(m.id)) { ... }
  const slices = slicesByMilestone.get(m.id) ?? [];
  ...
}
```

Remove the per-milestone `getMilestoneSlices(m.id)` call.

**Verify**: `pnpm run typecheck:extensions` exits 0 and `rg "getMilestoneSlices\(m\.id\)" src/resources/extensions/gsd/state.ts` returns no matches.

### Step 3: Ensure ordering and behavior preservation

Confirm that:
- Slices within each milestone remain ordered by `sequence, id`.
- Milestones with no slices still produce an empty array (the `?? []` fallback).
- Parked milestones are still skipped (no query needed).

If `getSlicesByMilestoneIds` cannot guarantee per-milestone ordering in SQL, sort each bucket in memory after fetching.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` exits 0.

### Step 4: Add a focused performance/behavior test

Add a test in `src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` that:
1. Creates three milestones.
2. Inserts slices into each milestone with varying `sequence` values.
3. Calls `buildRegistryAndFindActive` (or the public `deriveStateFromDb` if easier).
4. Asserts that each milestone's slices are returned in the correct order and that no slices are missing.

If the test file already covers multi-milestone state derivation, extend that test to assert ordering explicitly.

**Verify**: the new test passes.

### Step 5: Run the full unit suite

Run `pnpm run test:unit` to ensure no regressions in state derivation, dispatch decisions, or closeout logic.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- New or extended test in `derive-state-helpers.test.ts` covering multi-milestone slice ordering.
- Existing tests to preserve:
  - all `derive-state-helpers.test.ts` cases.
  - all tests that depend on `deriveStateFromDb` (orchestrator, dispatch, closeout).

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/derive-state-helpers.test.ts` exits 0.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `getMilestoneSlices(m.id)` is no longer called inside the `buildRegistryAndFindActive` loop.
- [ ] `getSlicesByMilestoneIds` returns a `Map<string, SliceRow[]>` with correct per-milestone ordering.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 004 updated to DONE.

## STOP conditions

Stop and report back if:
- The sql.js driver does not support the `IN (...)` placeholder style you chose and no existing pattern can be copied.
- `buildRegistryAndFindActive` is not an `async` function and the change forces a signature change elsewhere.
- Removing `getMilestoneSlices(m.id)` causes tests to fail because they monkey-patch that function.
- The batched query returns slices in a different order than the per-milestone query.

## Maintenance notes

- If the slices table grows very large, consider an index on `(milestone_id, sequence, id)` — but do not add it in this plan unless schema analysis shows it is missing.
- A similar N+1 exists for tasks inside `buildRegistryAndFindActive` or the markdown renderer; document that as a follow-up in the PR.
- Reviewers should verify that the behavior change is query-consolidation only: no milestone/slice status derivation logic changes.
