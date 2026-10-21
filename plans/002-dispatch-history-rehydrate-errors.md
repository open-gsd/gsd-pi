# Plan 002: Rehydrate ledger errors into Dispatch History window

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/auto/dispatch-history.ts src/resources/extensions/gsd/tests/dispatch-history.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: S
- **Risk**: LOW
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

`createDispatchHistory().rehydrate()` seeds the dispatch window from the DB dispatch ledger so stuck detection survives process restarts (#482). However, it currently stores only `{ key }` for each persisted entry. `detect-stuck.ts` Rules 1 and 4 rely on `entry.error` to detect repeat errors and repeated ENOENT paths. After a session restart, those rules cannot fire until the current session records a new error, so cross-session stuck loops may repeat many extra times before the saturation rules catch them.

## Current state

- `src/resources/extensions/gsd/auto/dispatch-history.ts:130-146` — `rehydrate()` maps persisted keys to window entries without attaching ledger error summaries.
- `src/resources/extensions/gsd/auto/dispatch-history.ts:87-98` — `lookupLatestLedgerError(unitType, unitId)` already exists and is used by `recordDispatch()` for the same purpose.
- `src/resources/extensions/gsd/auto/detect-stuck.ts:98-103` — Rule 1 fires when `last.error && prev.error && last.error === prev.error`.
- `src/resources/extensions/gsd/auto/detect-stuck.ts:142-158` — Rule 4 fires when the same ENOENT path appears twice in the window.
- `src/resources/extensions/gsd/tests/dispatch-history.test.ts` — existing tests cover rehydration and repeat-error attachment; add a cross-session regression test.

Relevant excerpt from `dispatch-history.ts:130-146`:

```ts
rehydrate(): number {
  const scopeId = options.resolveScopeId();
  if (!scopeId) return 0;
  try {
    const persisted = getRecentUnitKeysForProjectRoot(scopeId, windowSize);
    if (persisted.length === 0) return 0;
    window = persisted.map(({ key }) => ({ key: normalizeDispatchKey(key) }));
    while (window.length > windowSize) window.shift();
    return window.length;
  } catch (err) {
    debugLog("dispatchHistory", {
      phase: "rehydrate-failed",
      error: err instanceof Error ? err.message : String(err),
    });
    return 0;
  }
},
```

Relevant excerpt from `dispatch-history.ts:87-98`:

```ts
function lookupLatestLedgerError(unitType: string, unitId: string): string | undefined {
  try {
    const row = getLatestForUnit(unitId);
    if (!row || row.unit_type !== unitType) return undefined;
    return row.error_summary ?? undefined;
  } catch {
    return undefined;
  }
}
```

Repo conventions:
- Use the existing `buildDispatchKey`/`normalizeDispatchKey` helpers.
- Keep rehydration lazy and degradable (catch and log, return 0 on failure).
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-history.test.ts` | all pass |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/auto/dispatch-history.ts` — attach ledger errors during rehydration.
- `src/resources/extensions/gsd/tests/dispatch-history.test.ts` — add a regression test proving cross-session repeat-error detection.

**Out of scope**:
- Changing `detect-stuck.ts` rules.
- Changing `recordDispatch()` behavior.
- Any other caller of `createDispatchHistory`.

## Git workflow

- Branch: `fix/dispatch-history-rehydrate-errors`
- Commit message style: `fix(gsd): rehydrate ledger errors into dispatch history window`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Parse persisted keys into type/id pairs during rehydration

In `src/resources/extensions/gsd/auto/dispatch-history.ts`, change the `rehydrate()` body so each persisted key is normalized and then parsed into `unitType`/`unitId`. Use the existing `parseDispatchKey` helper (re-exported from `dispatch-key.ts`) or split the normalized key on `:`.

Before:
```ts
window = persisted.map(({ key }) => ({ key: normalizeDispatchKey(key) }));
```

After (shape):
```ts
window = persisted.map(({ key }) => {
  const normalized = normalizeDispatchKey(key);
  const { unitType, unitId } = parseDispatchKey(normalized);
  const error = lookupLatestLedgerError(unitType, unitId);
  return { key: normalized, error };
});
```

If `parseDispatchKey` returns a different shape, inspect `src/resources/extensions/gsd/auto/dispatch-key.ts` and adjust accordingly.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 2: Handle malformed persisted keys gracefully

If a persisted key cannot be parsed, still push `{ key: normalized }` without an error so the window remains populated for saturation rules. Do not throw; the existing catch block should continue to cover DB failures only, not parse failures.

**Verify**: read the new code and confirm parse errors result in an entry with `error: undefined`, not an exception.

### Step 3: Add a cross-session repeat-error regression test

Open `src/resources/extensions/gsd/tests/dispatch-history.test.ts`. Find the existing test `"recordDispatch attaches the latest ledger error on repeats"` (around line 139). Add a new test directly below it:

```ts
test("rehydrate attaches latest ledger error so repeat-error detection fires after restart", (t) => {
  // Persist a failed dispatch in the ledger, then construct a fresh history
  // with the same scope and rehydrate. The fresh window should contain the
  // error summary, and detectStuck should fire the repeat-error rule.
  const scopeId = /* use a temp project root or the existing fixture helper */;
  const history = createDispatchHistory({ resolveScopeId: () => scopeId });
  history.recordDispatch("execute-task", "M001/S01/T01");
  history.recordDispatch("execute-task", "M001/S01/T01"); // second triggers ledger lookup

  const fresh = createDispatchHistory({ resolveScopeId: () => scopeId });
  const count = fresh.rehydrate();
  assert.ok(count > 0);
  const stuck = fresh.detectStuck();
  assert.ok(stuck, "expected stuck verdict after rehydrating repeat errors");
  assert.match(stuck!.reason, /Same error repeated/);
});
```

Use the existing fixture helpers in the test file to create a scope and write to the dispatch ledger. If no helper exists, use `recordDispatchClaim` and `markFailed` from `db/unit-dispatches.ts` as shown in existing tests.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-history.test.ts` exits 0 and the new test is listed.

### Step 4: Run the broader unit suite

Run the compiled unit tests to ensure no regression in stuck-detection or dispatch-claim logic.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- New test in `dispatch-history.test.ts`: rehydrate from a ledger with a failed dispatch and assert `detectStuck()` returns a "Same error repeated" verdict.
- Existing tests to preserve:
  - all existing `dispatch-history.test.ts` cases.
  - `detect-stuck-respects-retry.test.ts` and `stuck-state-via-db.test.ts`.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/dispatch-history.test.ts` exits 0 and includes the new test.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `git diff src/resources/extensions/gsd/auto/dispatch-history.ts` shows each rehydrated entry populated with `error` from `lookupLatestLedgerError`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 002 updated to DONE.

## STOP conditions

Stop and report back if:
- `parseDispatchKey` does not exist or returns an unexpected shape.
- `getLatestForUnit` is unavailable or its signature differs from what `lookupLatestLedgerError` expects.
- The new test cannot be written without touching `detect-stuck.ts` (it should not need to).
- Existing tests fail because they assert rehydrated entries have no `error` field.

## Maintenance notes

- If the ledger schema gains a dedicated `unit_type` index, `lookupLatestLedgerError` can be simplified; until then, the type check must remain.
- Reviewers should confirm that `recordDispatch` and `rehydrate` attach errors identically so cross-session and in-session stuck detection behave the same.
- Future changes to the dispatch key grammar must update `parseDispatchKey` and this rehydration logic together.
