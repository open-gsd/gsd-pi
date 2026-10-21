# Plan 003: Reset session-timeout auto-resume counter per auto-mode session

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/auto/loop.ts src/resources/extensions/gsd/auto/phases.ts src/resources/extensions/gsd/tests/auto-loop.test.ts`
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

`auto/phases.ts` keeps a module-level `consecutiveSessionTimeouts` counter that decides whether to auto-resume after session-creation timeouts. The counter is reset to 0 inside `runUnitPhase()` when a unit completes successfully (line 2769), but there is no reset at the start of a new auto-mode session. In a long-lived process (daemon, web host, or repeated `/gsd auto` invocations in the same process), three timeouts in any session permanently exhaust the budget for all future sessions in that process, causing otherwise-recoverable timeouts to pause instead of resume.

## Current state

- `src/resources/extensions/gsd/auto/phases.ts:414-421` — module-level counter and exported `resetSessionTimeoutState()`.
- `src/resources/extensions/gsd/auto/phases.ts:2645-2648` — counter used to decide auto-resume eligibility.
- `src/resources/extensions/gsd/auto/phases.ts:2769` — counter reset on successful unit completion.
- `src/resources/extensions/gsd/auto/loop.ts:380-406` — `autoLoop()` entry point; does not currently call `resetSessionTimeoutState()`.
- `src/resources/extensions/gsd/tests/auto-loop.test.ts` — existing auto-loop tests; add a regression test.

Relevant excerpt from `auto/phases.ts:414-421`:

```ts
let consecutiveSessionTimeouts = 0;
const MAX_SESSION_TIMEOUT_AUTO_RESUMES = 3;
/** Maximum zero-tool-call retries before pausing — context exhaustion is deterministic. */
const MAX_ZERO_TOOL_RETRIES = 1;

export function resetSessionTimeoutState(): void {
  consecutiveSessionTimeouts = 0;
}
```

Relevant excerpt from `auto/loop.ts:380-406`:

```ts
export async function autoLoop(
  ctx: ExtensionContext,
  pi: ExtensionAPI,
  s: AutoSession,
  deps: LoopDeps,
  options?: AutoLoopOptions,
): Promise<void> {
  debugLog("autoLoop", { phase: "enter" });
  let iteration = 0;
  const dispatchContract = options?.dispatchContract ?? "legacy-direct";
  const unitDispatchDeps = createExecutionGraphUnitDispatchDeps();
  const persisted = loadStuckState(s);
  hydrateCustomVerifyRetryCounts(s, { logFailure: logCustomVerifyRetryLoadFailure });
  const loopState: LoopState = {
    ...
  };
  ...
```

Repo conventions:
- Module-level mutable state is acceptable for process-wide counters but must be reset at session boundaries.
- Keep the change minimal: one import and one call.
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` | all pass |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/auto/loop.ts` — call `resetSessionTimeoutState()` at `autoLoop()` entry.
- `src/resources/extensions/gsd/tests/auto-loop.test.ts` — add a regression test (or extend an existing timeout test).

**Out of scope**:
- Changing the timeout/backoff math.
- Moving the counter out of `auto/phases.ts` (plan 008 may address module boundaries).
- Any other session counters.

## Git workflow

- Branch: `fix/reset-session-timeout-counter`
- Commit message style: `fix(gsd): reset session timeout counter at start of each auto session`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Import the reset function in auto/loop.ts

In `src/resources/extensions/gsd/auto/loop.ts`, add `resetSessionTimeoutState` to the imports from `auto/phases.js`. Find the existing `import { ... } from "./phases.js"` line and add the symbol.

If `auto/loop.ts` does not currently import from `./phases.js`, add:
```ts
import { resetSessionTimeoutState } from "./phases.js";
```

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 2: Call reset at autoLoop entry

Inside `autoLoop`, immediately after `debugLog("autoLoop", { phase: "enter" });`, add:

```ts
resetSessionTimeoutState();
```

This ensures every new auto-mode session starts with a fresh timeout budget, even in a long-lived process.

**Verify**: `git diff src/resources/extensions/gsd/auto/loop.ts` shows the import and the call.

### Step 3: Add a regression test

Open `src/resources/extensions/gsd/tests/auto-loop.test.ts`. Find an existing test that exercises session-timeout handling, or add a focused test that:
1. Creates an `AutoSession` and enters `autoLoop`.
2. Simulates three session-creation timeouts in one session and verifies auto-resume is still attempted for the first three.
3. Starts a second `autoLoop` invocation and verifies the counter was reset so timeouts again trigger auto-resume rather than pausing.

Because `autoLoop` is async and long-running, the test may need to mock the orchestrator and provider layer. Use the existing test harness in `auto-loop.test.ts` (search for `mock` or `deps` in that file) rather than spinning up a real provider.

If a direct `autoLoop` test is too heavy, add a lighter test in `src/resources/extensions/gsd/tests/auto-phases.test.ts` that calls `resetSessionTimeoutState()` and then exercises the timeout path. Document the choice in the test comment.

**Verify**: the new test fails before the fix (counter not reset) and passes after the fix.

### Step 4: Run the test suite

Run the auto-loop tests and the full unit suite.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- Regression test proving `resetSessionTimeoutState()` is invoked at `autoLoop` entry. Options:
  - A behavior test in `auto-loop.test.ts` that observes auto-resume behavior across two `autoLoop` invocations.
  - A focused unit test in `auto-phases.test.ts` that resets, increments, resets, and asserts the counter is back to 0.
- Existing tests to preserve:
  - all existing session-timeout tests.
  - all `auto-loop.test.ts` cases.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-loop.test.ts` exits 0 (or the chosen focused test file).
- [ ] `pnpm run test:unit` exits 0.
- [ ] `git diff src/resources/extensions/gsd/auto/loop.ts` shows `resetSessionTimeoutState()` imported and called inside `autoLoop`.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 003 updated to DONE.

## STOP conditions

Stop and report back if:
- `resetSessionTimeoutState` is not exported from `auto/phases.ts`.
- `auto/loop.ts` already calls `resetSessionTimeoutState()` (the finding is already fixed).
- Adding the import creates a circular dependency that `typecheck:extensions` reports.
- The only way to test the fix requires modifying production interfaces.

## Maintenance notes

- This is a minimal boundary fix. Plan 008 (extracting auto-loop phase modules) may move the counter or rename the reset function; ensure the reset call is preserved.
- If the counter is ever moved to `auto/session.ts` or `auto/loop.ts`, the reset becomes trivial and this plan can be retired.
- Reviewers should confirm the reset happens exactly once per `autoLoop` invocation, not per iteration.
