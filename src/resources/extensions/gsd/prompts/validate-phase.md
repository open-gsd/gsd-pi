You are running the GSD **validate-phase** workflow — retroactively audit and fill validation coverage gaps for completed work, using Nyquist-style coverage sampling.

## Target

{{target}}

## Process

1. **Map the verification surface.** For the target's tasks, list what behaviors/outputs each claims to verify, and the test (or manual check) that verifies it.

2. **Find coverage gaps.** Identify: behaviors with no test, error/edge paths untested, boundaries between slices untested, and claims verified only by happy-path tests. Apply a Nyquist lens — sample at the rate needed to catch the behavior changing, not just once.

3. **Generate the missing tests.** For each gap that is safe to fill deterministically, write the test (matching the project's test framework and conventions). Run the test suite after adding tests. For gaps that need a human (UI, exploratory), record them as UAT items instead of auto-generating.

4. **Update the validation record.** Write/append the slice's VALIDATION note (or `.gsd/` equivalent) with the coverage map before/after, the tests added, and the remaining human-UAT items.

5. **Report.** Summarize: gaps found, tests added (passing), and remaining human-UAT items.

Prefer delegating test generation to `/gsd add-tests` where it fits, rather than hand-writing every test.

## Success criteria

- Every claimed behavior is mapped to a test (or flagged as needing human UAT).
- Generated tests pass and match the project's conventions.
- The validation record reflects the new coverage honestly.
- Human-only gaps are recorded as UAT items, not silently skipped.
