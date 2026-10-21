# Plan 005: Convert source-grep tests to behavioral tests

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/tests/notifications.test.ts src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts src/tests/cli-model-override-startup.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: LOW
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

Several tests read source files with `readFileSync` and assert against strings or regexes. `CONTRIBUTING.md` explicitly forbids source-grep tests because they pass when strings exist regardless of runtime behavior, create false confidence, and break on harmless refactors. `scripts/check-source-grep-tests.sh` only scans *changed* test files, so these grandfathered suites remain in the active test corpus.

## Current state

The following test files read source code and assert text:

- `src/resources/extensions/gsd/tests/notifications.test.ts:62-73` — reads `ask-user-questions.ts` and asserts regex matches for bell calls.
- `src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts:1-107` — reads `notifications.ts` and asserts import/source structure.
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts:19-229` — reads `engine-types.ts`, `workflow-engine.ts`, `execution-policy.ts`, `engine-resolver.ts` and asserts source shapes.
- `src/tests/cli-model-override-startup.test.ts:1-24` — reads `src/cli.ts` and asserts source structure.

Repo conventions:
- Tests use `node:test` and `node:assert/strict`.
- `CONTRIBUTING.md` bans source-grep tests; the narrow exception is file-structure-as-product tests marked with `// allow-source-grep`.
- Prefer importing the code under test and exercising it, or spawning the CLI/binary and asserting on real output.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/notifications.test.ts src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` | all pass |
| CLI test  | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/cli-model-override-startup.test.ts` | all pass |
| Source-grep gate | `bash scripts/check-source-grep-tests.sh` | exit 0 (no new source-grep tests) |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/tests/notifications.test.ts`
- `src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts`
- `src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts`
- `src/tests/cli-model-override-startup.test.ts`

**Out of scope**:
- Production code changes unless a function must be exported to be tested behaviorally.
- Removing the `check-source-grep-tests.sh` gate.
- Other test files that legitimately use `// allow-source-grep`.

## Git workflow

- Branch: `test/convert-source-grep-tests`
- Commit message style: `test(gsd): convert source-grep tests to behavioral tests`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Convert `notifications.test.ts` bell tests

Open `src/resources/extensions/gsd/tests/notifications.test.ts`. The tests at lines 61-73 assert that `ask-user-questions.ts` and `auto.ts` contain certain calls to `playNotificationBell`. Replace them with behavioral tests:

1. Export `playQuestionBell` from `ask-user-questions.ts` if it is not already exported, or test `askUserQuestions` with a mock stream and verify the bell is written.
2. For `stopAuto`, import `stopAuto` and a notification bell helper, then call it with mocked preferences and verify the bell output.

If the functions are hard to import due to side effects, use a subprocess test that runs a small script importing the module and asserting observable output.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/notifications.test.ts` exits 0 and `readFileSync` calls pointing into source files are removed.

### Step 2: Convert `remote-notification-from-desktop.test.ts`

Open `src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts`. Replace source-grep assertions with a behavioral test that:
1. Imports `sendDesktopNotification` from `notifications.ts`.
2. Mocks `sendRemoteNotification` using `node:test` module mocking if available, or by extracting `sendRemoteNotification` to a swappable dependency.
3. Calls `sendDesktopNotification` with test arguments.
4. Asserts that `sendRemoteNotification` was called with the same title/message and that the call is fire-and-forget.

If `node:test` module mocking is not available and refactoring `notifications.ts` is required to accept a dependency seam, do that minimal refactor and add a test-only export path. Do not change the public call sites.

**Verify**: the new behavioral tests pass and the `readFileSync` of `notifications.ts` is removed.

### Step 3: Convert `engine-interfaces-contract.test.ts`

This file has the most source-grep tests. Preserve the runtime tests (the `resolveEngine` tests and `AutoSession` tests) and replace the source-shape tests with behavioral or import tests:

- For `engine-types.ts` leaf-node constraint: this is a structural rule about the file not importing GSD modules. This is a legitimate file-structure test; mark it with `// allow-source-grep: verifies engine-types.ts is a leaf node by design` and keep it, or replace it with a test that attempts to import `engine-types.ts` in an isolated context. Keep it if marked.
- For `EngineState` field checks: import `EngineState` (as a type-only import, or use `import type`) and use TypeScript compile-time checks, or instantiate a valid object and assert runtime fields.
- For `EngineDispatchAction` variants: import the type and use a helper function that constructs each variant.
- For `WorkflowEngine` members: import the interface and use a compile-time `satisfies` check, or construct a stub object that implements it.
- For `ExecutionPolicy` methods: same approach.
- For `ResolvedEngine` export: this is a structural export check. Either keep it with `// allow-source-grep` or replace with an import assertion.

**Goal**: remove all unmarked `readSource`/`readFileSync` calls and source-text assertions. Any source-text checks that remain must be justified with an inline `// allow-source-grep` marker.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` exits 0.

### Step 4: Convert `cli-model-override-startup.test.ts`

Open `src/tests/cli-model-override-startup.test.ts`. Replace source-grep assertions with a behavioral test:

1. Import `applyModelOverride` from `src/cli.ts` if exported, or factor it into a testable helper.
2. Create a mock session object with `setModel` and a mock `modelRegistry`.
3. Call `applyModelOverride(session, modelRegistry, "provider/model")`.
4. Assert that `session.setModel` was called with the parsed model and that the function did not await a readiness promise.

If `applyModelOverride` is deeply embedded in `cli.ts`, consider extracting it to `src/cli-model-override.ts` with no behavioral change and importing it from both `cli.ts` and the test. This is still a test-only refactor but improves testability.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/cli-model-override-startup.test.ts` exits 0 and the `readFileSync` of `src/cli.ts` is removed.

### Step 5: Run the source-grep gate

Run the repository's source-grep check to ensure no new source-grep tests were introduced and any kept exceptions are properly marked.

**Verify**: `bash scripts/check-source-grep-tests.sh` exits 0.

### Step 6: Run the full unit suite

Run `pnpm run test:unit` to catch regressions.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- Converted behavioral tests for:
  - notification bell in `ask-user-questions.ts` and `auto.ts`.
  - `sendDesktopNotification` side-effect to `sendRemoteNotification`.
  - engine interface runtime contracts.
  - CLI `--model` override application.
- Existing tests to preserve:
  - runtime tests in `engine-interfaces-contract.test.ts` (`resolveEngine`, `AutoSession`).

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/notifications.test.ts src/resources/extensions/gsd/tests/remote-notification-from-desktop.test.ts src/resources/extensions/gsd/tests/engine-interfaces-contract.test.ts` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/tests/cli-model-override-startup.test.ts` exits 0.
- [ ] `bash scripts/check-source-grep-tests.sh` exits 0.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `rg "readFileSync.*src/(resources/extensions/gsd/)?(notifications|ask-user-questions|engine-types|workflow-engine|execution-policy|engine-resolver|cli)"` returns no matches in the four test files.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 005 updated to DONE.

## STOP conditions

Stop and report back if:
- A production function cannot be imported or tested without a large refactor.
- Converting a test requires changing the public API of a module.
- `node:test` module mocking is unavailable and no dependency seam exists.
- A source-grep test is the only practical way to verify a compile-time-only contract; mark it with `// allow-source-grep` and document the reason instead of deleting it.

## Maintenance notes

- Future tests should import and exercise code, not inspect source text.
- If a compile-time-only contract must be verified, prefer a TypeScript type test (e.g., `type _ = Assert<MyType extends Expected ? true : false>`) over source-grep.
- Reviewers should reject any new `readFileSync` into source files in test PRs unless it carries `// allow-source-grep`.
