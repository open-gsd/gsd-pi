# Plan 008: Extract auto-loop phase modules from `auto/phases.ts`

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/auto/phases.ts src/resources/extensions/gsd/auto/orchestrator.ts src/resources/extensions/gsd/auto/loop.ts src/resources/extensions/gsd/tests/auto-loop.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P3
- **Effort**: L
- **Risk**: HIGH
- **Depends on**: 001, 002, 003
- **Category**: tech-debt
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

`src/resources/extensions/gsd/auto/phases.ts` is a 3,286-line god module that owns the entire auto-loop pipeline: pre-dispatch, dispatch, guards, unit execution, finalize, merge closeout, and finalize timeouts. Any change to dispatch, safety, merge, or recovery requires editing the same file, coupling lifecycle stages that ADR-014 wants behind the Auto Orchestration module. Extracting focused modules makes the pipeline reviewable, testable, and paves the way for re-seating the Auto Closeout adapter behind `closeUnit`.

## Current state

- `src/resources/extensions/gsd/auto/phases.ts` — 3,286 lines. Header says it contains `runPreDispatch`, `runDispatch`, `runGuards`, `runUnitPhase`, `runFinalize`, plus merge closeout helpers.
- `src/resources/extensions/gsd/auto/orchestrator.ts` — already implements the new invariant pipeline owner (ADR-014); calls into `phases.ts` for legacy paths.
- `src/resources/extensions/gsd/auto/loop.ts` — the linear auto-loop that calls `runUnitPhase`/`runFinalize` from `phases.ts`.
- `src/resources/extensions/gsd/tests/auto-loop.test.ts` — extensive auto-loop tests that will guard the extraction.

Relevant excerpt from `auto/phases.ts:1-10`:

```ts
// Project/App: gsd-pi
// File Purpose: Auto-loop pipeline phases, merge closeout, and finalize handling.
/**
 * auto/phases.ts — Pipeline phases for the auto-loop.
 *
 * Contains: runPreDispatch, runDispatch, runGuards, runUnitPhase, runFinalize,
 * plus internal helpers generateMilestoneReport and closeoutAndStop.
 *
 * Imports from: auto/types, auto/detect-stuck, auto/run-unit, auto/loop-deps
 */
```

Repo conventions:
- Extension-first; keep core lean.
- Behavior-neutral refactors must pass the existing test suite.
- Use the existing discriminated-result types (`PhaseResult`, `DispatchDecision`, etc.).
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Auto-loop tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` | all pass |
| Orchestrator tests | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-orchestrator.test.ts` | all pass |
| Unit suite | `pnpm run test:unit` | all pass |
| Verify merge | `pnpm run verify:pr` | all pass |

## Suggested executor toolkit

- Read `docs/dev/ADR-014-auto-orchestration-deep-module.md` for the intended module boundaries.
- Read `docs/dev/ADR-032-unit-closeout-seam.md` for the closeout seam goals.

## Scope

**In scope**:
- `src/resources/extensions/gsd/auto/phases.ts` — extract functions into focused modules; keep as a thin compatibility shim.
- New modules:
  - `src/resources/extensions/gsd/auto/pre-dispatch.ts` — `runPreDispatch` and pre-dispatch guards.
  - `src/resources/extensions/gsd/auto/dispatch.ts` — `runDispatch` and closed-status dispatch reasoning.
  - `src/resources/extensions/gsd/auto/unit-phase.ts` — `runUnitPhase` and session-timeout handling.
  - `src/resources/extensions/gsd/auto/finalize.ts` — `runFinalize` and post-unit verification.
  - `src/resources/extensions/gsd/auto/closeout.ts` — merge closeout helpers (`closeoutAndStop`, `generateMilestoneReport`).
- `src/resources/extensions/gsd/auto/loop.ts` — update imports to call the new modules.
- `src/resources/extensions/gsd/auto/orchestrator.ts` — update imports if it directly calls extracted functions.

**Out of scope**:
- Changing auto-loop behavior or recovery policy.
- Re-seating the Auto Closeout adapter behind `closeUnit` (move helpers into the new `closeout.ts` module but keep behavior).
- Refactoring `auto-dispatch.ts`, `auto-worktree.ts`, or the orchestrator beyond import updates.

## Git workflow

- Branch: `refactor/extract-auto-loop-phase-modules`
- Commit per extracted module, e.g.:
  - `refactor(gsd): extract runPreDispatch to auto/pre-dispatch.ts`
  - `refactor(gsd): extract runDispatch to auto/dispatch.ts`
  - `refactor(gsd): extract runUnitPhase to auto/unit-phase.ts`
  - `refactor(gsd): extract runFinalize to auto/finalize.ts`
  - `refactor(gsd): extract closeout helpers to auto/closeout.ts`
  - `refactor(gsd): make auto/phases.ts a thin compatibility shim`
- Do not push or open a PR unless instructed.

## Steps

### Step 0: Ensure prerequisites are landed

Before starting, confirm that plans 001, 002, and 003 are DONE in `plans/README.md`. Their changes touch `auto/phases.ts` and `auto/orchestrator.ts`; landing them first prevents merge conflicts.

**Verify**: `plans/README.md` shows 001, 002, 003 as DONE.

### Step 1: Add a safety harness — run tests before touching code

Run the auto-loop and orchestrator tests on a clean checkout to establish a baseline.

**Verify**:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` exits 0.
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-orchestrator.test.ts` exits 0.

### Step 2: Extract `runPreDispatch` to `auto/pre-dispatch.ts`

1. Create `src/resources/extensions/gsd/auto/pre-dispatch.ts`.
2. Move `runPreDispatch` and its private helpers from `auto/phases.ts` into the new file.
3. Export `runPreDispatch` with the same signature.
4. Update `auto/phases.ts` to import and re-export `runPreDispatch`.
5. Run typecheck.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 3: Extract `runDispatch` to `auto/dispatch.ts`

1. Create `src/resources/extensions/gsd/auto/dispatch.ts`.
2. Move `runDispatch`, `getAlreadyClosedDispatchReason`, and related dispatch helpers from `auto/phases.ts`.
3. Export them with the same signatures.
4. Update `auto/phases.ts` to import and re-export.
5. Run typecheck.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 4: Extract `runUnitPhase` to `auto/unit-phase.ts`

1. Create `src/resources/extensions/gsd/auto/unit-phase.ts`.
2. Move `runUnitPhase`, session-timeout handling, provider-pause/resume callbacks, and the zero-tool-call guard from `auto/phases.ts`.
3. Keep `consecutiveSessionTimeouts` module state inside `unit-phase.ts` (or pass it through a small state object if loop.ts needs visibility).
4. Export `runUnitPhase` with the same signature.
5. Update `auto/phases.ts` to import and re-export.
6. Run typecheck.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 5: Extract `runFinalize` to `auto/finalize.ts`

1. Create `src/resources/extensions/gsd/auto/finalize.ts`.
2. Move `runFinalize` and finalize helpers from `auto/phases.ts`.
3. Export `runFinalize` with the same signature.
4. Update `auto/phases.ts` to import and re-export.
5. Run typecheck.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 6: Extract merge closeout helpers to `auto/closeout.ts`

1. Create `src/resources/extensions/gsd/auto/closeout.ts`.
2. Move `closeoutAndStop`, `generateMilestoneReport`, and related merge helpers from `auto/phases.ts`.
3. Export them with the same signatures.
4. Update `auto/phases.ts` to import and re-export.
5. Run typecheck.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 7: Thin `auto/phases.ts` to a compatibility shim

After extraction, `auto/phases.ts` should:
- Import the five new modules.
- Re-export the public functions with identical names/signatures.
- Keep any module-level constants or types that other files import from `auto/phases.js` to avoid breaking external callers.

Run tests after each extraction step, not just at the end.

**Verify**: `git diff --stat src/resources/extensions/gsd/auto/phases.ts` shows significant line reduction and only import/re-export code remains.

### Step 8: Update `auto/loop.ts` and `auto/orchestrator.ts` imports

If `auto/loop.ts` and `auto/orchestrator.ts` import functions directly from `auto/phases.js`, update them to import from the focused modules where it improves clarity. If imports are already through `auto/phases.js`, this step is optional but recommended for new code clarity.

Do not change call signatures.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 9: Run focused tests after each module extraction

After each step 2-6, run:
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts`
- `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-orchestrator.test.ts`

If a test fails, fix it before moving to the next extraction. The goal is behavior-neutral movement.

**Verify**: all focused tests pass after each extraction.

### Step 10: Run full verification

Run the full PR verification suite.

**Verify**:
- `pnpm run typecheck:extensions` exits 0.
- `pnpm run test:unit` exits 0.
- `pnpm run verify:pr` exits 0.

## Test plan

- Existing tests are the contract:
  - `src/resources/extensions/gsd/tests/auto-loop.test.ts`
  - `src/resources/extensions/gsd/tests/auto-orchestrator.test.ts`
  - `src/resources/extensions/gsd/tests/dispatch-history.test.ts`
- No new tests required, but if a helper is now independently testable, add focused unit tests in the corresponding new module's test file (e.g., `auto/dispatch.test.ts`).

## Done criteria

- [ ] Plans 001, 002, 003 are DONE before this plan starts.
- [ ] `src/resources/extensions/gsd/auto/phases.ts` is reduced to a compatibility shim that re-exports functions from focused modules.
- [ ] New modules exist: `auto/pre-dispatch.ts`, `auto/dispatch.ts`, `auto/unit-phase.ts`, `auto/finalize.ts`, `auto/closeout.ts`.
- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-orchestrator.test.ts` exits 0.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `pnpm run verify:pr` exits 0.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 008 updated to DONE.

## STOP conditions

Stop and report back if:
- A prerequisite plan is not DONE.
- Extracting a function changes its signature or behavior and tests fail.
- A circular dependency appears between the new modules.
- `auto/phases.ts` still contains more than ~300 lines after extraction (indicates incomplete extraction).
- The extraction requires touching production behavior to make tests pass.

## Maintenance notes

- This is a pure locality refactor. No behavior should change.
- Reviewers should verify diff-only movement: the body of each extracted function should be identical to its original in `auto/phases.ts` except for import paths.
- After this lands, the Auto Closeout adapter re-seat becomes feasible: `auto/closeout.ts` can be evolved to call `unit-closeout.ts#closeUnit` instead of duplicating closeout logic.
- Future auto-loop changes should target the focused module, not `auto/phases.ts`.
