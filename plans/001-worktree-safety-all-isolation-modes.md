# Plan 001: Enforce Worktree Safety for all git isolation modes

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/auto/orchestrator.ts src/resources/extensions/gsd/worktree-safety.ts src/resources/extensions/gsd/auto/phases.ts src/resources/extensions/gsd/tests/worktree-safety.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P1
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: bug
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

`worktree-safety.ts` already supports validating `branch` and `none` isolation modes, but `auto/orchestrator.ts:691-693` short-circuits and returns `{ ok: true }` whenever the effective isolation is not `worktree`. Under `git.isolation: branch` or `none`, a source-writing unit can therefore run from the project root without proving the checkout is on the expected milestone branch, so edits can land on the wrong branch. This violates the Worktree Safety module's fail-closed contract (ADR-016) and can silently corrupt the user's main checkout.

## Current state

- `src/resources/extensions/gsd/auto/orchestrator.ts` — `prepareWorktreeForUnit()` (around line 680-729) skips safety validation for non-worktree isolation modes.
- `src/resources/extensions/gsd/worktree-safety.ts` — `validateUnitRoot()` (around line 150-329) supports `branch`/`none` validation: it expects `unitRoot === projectRoot` and checks `expectedBranch` when supplied, and also supports a `lease` check when `input.lease` is provided.
- `src/resources/extensions/gsd/auto/phases.ts` — legacy path (around line 373) mirrors the same skip; update it too so both dispatch paths behave identically.
- `src/resources/extensions/gsd/tests/worktree-safety.test.ts` — existing tests for the safety module; add new cases there.

Relevant excerpt from `auto/orchestrator.ts:680-712`:

```ts
async prepareWorktreeForUnit(
  unitType: string,
  unitId: string,
): Promise<{ ok: true; reason: string } | { ok: false; reason: string }> {
  const isolationMode = this.getEffectiveUnitIsolationMode(this.runtimeBasePath);
  const manifest = resolveManifest(unitType);
  if (!manifest) {
    return {
      ok: false,
      reason: `No Unit manifest is registered for ${unitType}`,
    };
  }
  if (isolationMode !== "worktree") {
    return { ok: true, reason: "not-required" };
  }
  const writeScope =
    manifest.tools.mode === "all" || manifest.tools.mode === "docs"
      ? "source-writing"
      : "planning-only";
  const safety = createWorktreeSafetyModule();
  const activeBasePath = this.getLiveDispatchBasePath();
  const snapshot = await deriveState(activeBasePath);
  const milestoneId = snapshot.activeMilestone?.id ?? null;
  const expectedBranch = milestoneId ? autoWorktreeBranch(milestoneId) : null;
  let result = safety.validateUnitRoot({
    unitType,
    unitId,
    writeScope,
    projectRoot: this.runtimeBasePath,
    unitRoot: activeBasePath,
    milestoneId,
    isolationMode,
    expectedBranch,
  });
```

Relevant excerpt from `worktree-safety.ts:159-178`:

```ts
const projectRoot = resolve(input.projectRoot);
const unitRoot = resolve(input.unitRoot);
const isolationMode = input.isolationMode ?? "worktree";
const expectedRoots = isolationMode === "worktree"
  ? worktreesDirs(projectRoot).map((dir) => join(dir, milestoneId))
  : [projectRoot];
if (!expectedRoots.some((expectedRoot) => samePath(unitRoot, expectedRoot))) {
  return failure(
    "invalid-root",
    isolationMode === "worktree"
      ? `Unit root ${unitRoot} is not the expected worktree root for ${milestoneId}.`
      : `Unit root ${unitRoot} is not the project root while isolation mode is ${isolationMode}.`,
    ...
  );
}
```

Repo conventions:
- TypeScript with NodeNext resolution, strict mode.
- Use the existing `failure()`/`success()` helpers in `worktree-safety.ts`.
- Match the discriminated-result style already used by `validateUnitRoot`.
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-safety.test.ts` | all pass |
| Relevant unit tests | `pnpm run test:unit` | all pass |

## Suggested executor toolkit

- Read `docs/dev/ADR-016-worktree-safety-fail-closed.md` and `docs/dev/ADR-031-worktree-placement.md` for the intended safety semantics.

## Scope

**In scope**:
- `src/resources/extensions/gsd/auto/orchestrator.ts` — remove the non-worktree skip and pass lease state.
- `src/resources/extensions/gsd/worktree-safety.ts` — ensure branch/none mode validation is complete and reachably exercised.
- `src/resources/extensions/gsd/auto/phases.ts` — mirror the orchestrator change in the legacy `runGuards` path.
- `src/resources/extensions/gsd/tests/worktree-safety.test.ts` — add tests for branch/none mode validation and lease-lost detection.

**Out of scope**:
- Refactoring the rest of `auto/phases.ts` (covered by plan 008).
- Changing worktree creation/placement logic.
- Modifying the Phase Transition Invariant.

## Git workflow

- Branch: `fix/worktree-safety-all-isolation-modes`
- Commit messages follow Conventional Commits, e.g. `fix(gsd): enforce worktree safety for branch and none isolation modes`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Remove the non-worktree skip in the orchestrator

In `src/resources/extensions/gsd/auto/orchestrator.ts`, delete the early return that skips validation for non-worktree isolation:

```ts
if (isolationMode !== "worktree") {
  return { ok: true, reason: "not-required" };
}
```

After removal, `prepareWorktreeForUnit` should always resolve the manifest, compute `writeScope`, create the safety module, derive state, and call `safety.validateUnitRoot` regardless of isolation mode.

**Verify**: `git diff src/resources/extensions/gsd/auto/orchestrator.ts` shows the block removed and no new TypeScript errors introduced.

### Step 2: Pass lease state to Worktree Safety in the orchestrator

Still in `prepareWorktreeForUnit`, after computing `milestoneId`, add a `lease` field to the `safety.validateUnitRoot` call. The lease should be considered required when the unit is source-writing and the milestone is leased by the current session:

```ts
const lease = milestoneId
  ? {
      required: writeScope === "source-writing",
      held: this.s.currentMilestoneId === milestoneId && this.s.milestoneLeaseToken !== null,
      owner: this.s.workerId,
    }
  : undefined;
```

Pass `lease` as the `lease` property of the validation input. If the `AutoSession` type does not expose `milestoneLeaseToken` or `workerId`, check `src/resources/extensions/gsd/auto/session.ts` for the correct field names and adjust.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 3: Update the legacy path in `auto/phases.ts`

Find the equivalent Worktree Safety call in `src/resources/extensions/gsd/auto/phases.ts` (search for `isolationMode !== "worktree"` or `prepareWorktreeForUnit`). Remove the same early return and pass `lease` state there too, using the session fields available in that function's scope (`s.currentMilestoneId`, `s.milestoneLeaseToken`, `s.workerId` or equivalents).

**Verify**: `rg "not-required" src/resources/extensions/gsd/auto/` returns no matches for the worktree-safety skip reason.

### Step 4: Verify `worktree-safety.ts` branch/none validation is complete

Open `src/resources/extensions/gsd/worktree-safety.ts`. Confirm that for `isolationMode === "branch"` or `"none"`:
- `expectedRoots` is `[projectRoot]` (line 164-166).
- The `invalid-root` failure message covers branch/none (line 170-175).
- The `.git` marker and registered-worktree checks run for all modes where `unitRoot` exists and is expected to be a git checkout. If branch/none mode is meant to validate project-root git state, these checks are appropriate. If they should be skipped for `none` (e.g., a non-git project), add an early `return success(...)` when `isolationMode === "none"` and the project root is not a git repo. Do not skip them for `branch` mode.

If a gap is found (e.g., branch mismatch not checked for `branch` mode because `expectedBranch` is only set in worktree mode), fix it in this step.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 5: Add regression tests

Open `src/resources/extensions/gsd/tests/worktree-safety.test.ts`. Add tests that:
1. Reject source-writing unit under `branch` isolation when `unitRoot` is not the project root.
2. Reject source-writing unit under `branch` isolation when the current branch does not match `expectedBranch`.
3. Accept source-writing unit under `none` isolation when `unitRoot === projectRoot`.
4. Reject source-writing unit when `lease.required: true` but `lease.held: false`.

Use the existing test helpers for creating a temp project root and a mock git repo. Model new tests on existing `validateUnitRoot` tests in the same file.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-safety.test.ts` exits 0 and the new tests are listed.

### Step 6: Run the unit test suite

Run the compiled unit tests to catch regressions in the orchestrator and safety module.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- New tests in `src/resources/extensions/gsd/tests/worktree-safety.test.ts` covering:
  - `branch` isolation: wrong root.
  - `branch` isolation: branch mismatch.
  - `none` isolation: project root accepted.
  - lease-lost when source-writing and lease not held.
- Existing tests to preserve:
  - all existing `worktree-safety.test.ts` cases for `worktree` isolation.
  - orchestrator tests that construct an `AutoOrchestrator` and call `advance()`.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/worktree-safety.test.ts` exits 0 and includes the new tests.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `rg "if \(isolationMode !== \"worktree\"\)" src/resources/extensions/gsd/auto/` returns no matches.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 001 updated to DONE.

## STOP conditions

Stop and report back if:
- The code at the cited line ranges does not match the excerpts (drift occurred).
- `AutoSession` does not expose `milestoneLeaseToken` or `workerId` — report the actual field names instead of guessing.
- Removing the skip causes existing orchestrator tests to fail in a way that reveals a deliberate non-worktree bypass (e.g., a test that asserts `not-required` is returned).
- The fix appears to require touching files outside the in-scope list.

## Maintenance notes

- If a new isolation mode is added later, `worktree-safety.ts` and the orchestrator should treat it explicitly rather than defaulting to skip.
- Reviewers should verify that the legacy path in `auto/phases.ts` and the orchestrator path behave identically; any future change to Worktree Safety inputs must update both until plan 008 removes the legacy path.
- The lease check added here is intentionally fail-closed: if a session cannot prove it holds the milestone lease, source-writing dispatch is blocked.
