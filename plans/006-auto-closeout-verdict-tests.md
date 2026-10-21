# Plan 006: Add `CloseoutGitVerdict` tests for auto-mode closeout paths

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- src/resources/extensions/gsd/unit-closeout.ts src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tests
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

The `unit-closeout.ts` module is intended to be the single seam for durable unit completion (ADR-032). Today it ships only the Interactive Closeout adapter; the Auto Closeout adapter is pending. The existing test file (`auto-unit-closeout.test.ts`) only covers activity-classification helpers (`isSuspiciousGhostCompletion`, `snapshotUnitActivity`). The critical `closeUnit()` function and its `CloseoutGitVerdict` outcomes are not exercised by a focused test, leaving the 2026-06-10 regression class — a milestone completed with untracked files and no merge — without an auto-path regression guard.

## Current state

- `src/resources/extensions/gsd/unit-closeout.ts:96-136` — `closeUnit()` computes `CloseoutGitVerdict` and notices.
- `src/resources/extensions/gsd/unit-closeout.ts:76-94` — `UnitCloseoutDeps` seam accepts injectable `isolationMode`, `currentBranch`, `commit`, and `notify`.
- `src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts:1-68` — only tests activity helpers.
- `src/resources/extensions/gsd/worktree.ts` — `autoCommitCurrentBranch` is the default commit dependency.

Relevant excerpt from `unit-closeout.ts:96-136`:

```ts
export function closeUnit(request: UnitCloseoutRequest, deps: UnitCloseoutDeps = defaultDeps): UnitCloseoutResult {
  let commitMessage: string | null = null;
  let gitVerdict: CloseoutGitVerdict;
  let notice: string | undefined;

  try {
    commitMessage = deps.commit(request.basePath, request.unitType, request.unitId);
    gitVerdict = commitMessage === null ? "nothing-to-commit" : "committed";
  } catch (err) {
    gitVerdict = "commit-failed";
    notice = `Unit closeout commit failed for ${request.unitId}: ${err instanceof Error ? err.message : String(err)}`;
    logWarning("engine", notice);
    deps.notify(notice, "error");
  }

  if (request.boundary === "milestone" && gitVerdict !== "commit-failed") {
    const isolation = deps.isolationMode(request.basePath);
    if (isolation !== "none") {
      const branch = deps.currentBranch(request.basePath);
      if (branch?.startsWith(MILESTONE_BRANCH_PREFIX)) {
        gitVerdict = "milestone-branch";
        ...
      } else {
        gitVerdict = "isolation-bypassed";
        ...
      }
    }
  }

  return { gitVerdict, commitMessage, notice };
}
```

Repo conventions:
- Tests use `node:test` and `node:assert/strict`.
- Use temp directories with `mkdtempSync` and `t.after()` cleanup.
- Git fixtures are acceptable; use the repo's git helper functions if available.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| Tests     | `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts` | all pass |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts` — extend to cover `closeUnit()`.
- Minimal test-only exports or helpers in `src/resources/extensions/gsd/unit-closeout.ts` if required.

**Out of scope**:
- Re-seating the Auto Closeout adapter (that is a larger refactor, plan 008 territory).
- Changing `closeUnit()` behavior.
- Modifying `auto-post-unit.ts` or `auto/phases.ts`.

## Git workflow

- Branch: `test/auto-closeout-verdict`
- Commit message style: `test(gsd): add CloseoutGitVerdict tests for unit closeout`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Add git-fixture helper for tests

Open `src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts`. At the top, add imports for `mkdtempSync`, `writeFileSync`, `rmSync`, `execSync`, and `join`/`tmpdir`. Add a helper function:

```ts
function createTempGitRepo(t: TestContext): string {
  const dir = mkdtempSync(join(tmpdir(), "closeout-test-"));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  execSync("git init", { cwd: dir });
  execSync("git config user.email test@test.com", { cwd: dir });
  execSync("git config user.name Test", { cwd: dir });
  return dir;
}
```

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 2: Add `closeUnit` verdict tests

Append tests to `auto-unit-closeout.test.ts` that exercise `closeUnit` through its dependency seam. For each test, build a temp git repo, configure the deps, call `closeUnit`, and assert the verdict.

Test cases to add:

1. **nothing-to-commit / isolation none**: clean repo, `boundary: "milestone"`, `isolationMode: () => "none"`, `commit: () => null`. Assert `gitVerdict === "nothing-to-commit"` and no notice.

2. **committed / isolation none**: dirty repo (write a file, stage it), `commit` returns a message. Assert `gitVerdict === "committed"` and `commitMessage` is non-null.

3. **milestone-branch / worktree isolation**: `boundary: "milestone"`, `isolationMode: () => "worktree"`, `currentBranch: () => "milestone/M001"`. Assert `gitVerdict === "milestone-branch"` and an info notice was emitted.

4. **isolation-bypassed / worktree isolation**: `boundary: "milestone"`, `isolationMode: () => "worktree"`, `currentBranch: () => "main"`, `commit` returns a message. Assert `gitVerdict === "isolation-bypassed"` and a warning notice was emitted.

5. **isolation-bypassed / branch isolation**: same as #4 but `isolationMode: () => "branch"` and `currentBranch: () => "main"`.

6. **commit-failed**: `commit` throws. Assert `gitVerdict === "commit-failed"` and an error notice was emitted.

7. **task boundary ignores isolation verdict**: `boundary: "task"`, `isolationMode: () => "worktree"`, `currentBranch: () => "main"`. Assert `gitVerdict === "committed"` (or `nothing-to-commit`) — task boundaries must not trigger the milestone isolation check.

Use a mock `notify` function that records messages and severities so assertions can inspect them.

**Verify**: `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts` exits 0 and all new tests are listed.

### Step 3: Ensure no production code changes are required

If `closeUnit` or its types are not exported from `unit-closeout.ts`, add `export` to them. This is a test-only visibility change, not a behavior change.

**Verify**: `pnpm run typecheck:extensions` exits 0.

### Step 4: Run the full unit suite

Run `pnpm run test:unit` to ensure no regressions.

**Verify**: `pnpm run test:unit` exits 0.

## Test plan

- New tests in `auto-unit-closeout.test.ts` covering all `CloseoutGitVerdict` values:
  - `nothing-to-commit`
  - `committed`
  - `milestone-branch`
  - `isolation-bypassed` (worktree and branch isolation)
  - `commit-failed`
  - task boundary does not trigger milestone isolation logic
- Existing tests to preserve:
  - `isSuspiciousGhostCompletion` tests.
  - `snapshotUnitActivity` test.

## Done criteria

- [ ] `pnpm run typecheck:extensions` exits 0.
- [ ] `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts` exits 0 and lists the new `closeUnit` tests.
- [ ] `pnpm run test:unit` exits 0.
- [ ] `git diff src/resources/extensions/gsd/tests/auto-unit-closeout.test.ts` shows behavioral tests for `closeUnit` and removes no existing tests.
- [ ] No production behavior changes (`git diff src/resources/extensions/gsd/unit-closeout.ts` shows only export visibility changes, if any).
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 006 updated to DONE.

## STOP conditions

Stop and report back if:
- `closeUnit` is not exported from `unit-closeout.ts` and exporting it creates a circular dependency.
- Creating git fixtures in the test environment fails (e.g., `git` not on PATH).
- The test requires changes to `autoCommitCurrentBranch` or other production code.
- A verdict outcome differs from what the current code produces (document the actual outcome and stop).

## Maintenance notes

- These tests will become the regression suite for the Auto Closeout adapter re-seat (plan 008). Keep them behavior-focused so they survive the adapter move.
- If `closeUnit` gains new verdicts or notice text, update the tests to match.
- Reviewers should verify that no production code was changed to make the tests pass.
