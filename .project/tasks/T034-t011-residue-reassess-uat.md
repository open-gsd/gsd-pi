---
id: T034
title: Repair the reassess/UAT dispatch tests T011 broke and restore the #1112 cache-race guard
wave: 3
deps: [T011, T030]
status: done
agent: build_T034
commit: d9b5d70d63394a7d8750fce31d4393467b23a5e1
base: 274430a457936ca0d4cece15dc2f92359e2d7816
worktree: .worktrees/gsd-path-T034
task_branch: gsd-path/T034
files:
  - src/resources/extensions/gsd/tests/reassess-detection.test.ts
  - src/resources/extensions/gsd/tests/uat-dispatch.test.ts
  - src/resources/extensions/gsd/auto-prompts.ts
---

# T034 — Repair the T011 residue (RED tests on the branch)

## Context

Fix task from wave-3 review cycle 2 (`.project/review/wave-3.cycle2.md`,
"T011 residue" section). **Three tests are RED on the branch right now.** This
was missed twice: T011's Verify never ran these files, and review cycle 1 marked
T011 AC3/AC4 pass without running them either. Verbatim:

> ❌ T011 AC3 and AC4 (suite green) — three tests are RED at review base, in two
> files neither T011 nor T030 listed:
> - `reassess-detection.test.ts:77` "checkNeedsReassessment returns sliceId when
>   assessment is missing" — `actual: null, expected: { sliceId: 'S01' }`.
> - `reassess-detection.test.ts:113` "checkNeedsReassessment detects assessment
>   written after initial cache population" — **the #1112 cache-race regression
>   guard** — `actual: null, expected: { sliceId: 'S01' }`.
> - `uat-dispatch.test.ts:118` "auto-prompts keeps the compatibility
>   checkNeedsRunUat wrapper" — `actual: null, expected: { sliceId: 'S01',
>   uatType: 'human-experience' }`.
> Attribution established by swapping `auto-prompts.ts` alone at three points:
> pre-wave-3 (`a27f96189^`) reassess 5/5 green, uat-dispatch 5/5 green;
> post-T011 / pre-T030 (`942d048d7`) reassess 3/5, uat-dispatch 4/5; review base
> identical to post-T011. So **T011 broke them and T030 neither fixed nor
> worsened them.** All three fixtures are markdown-only (`writeRoadmap` +
> `writeSummary`, no DB), so the removed roadmap-checkbox fallback is exactly
> what they asserted.
> Additionally the three still-green tests in `reassess-detection.test.ts`
> (`:60`, `:94`, `:141`) are now **vacuous** — they assert `null`.

## Steps

1. Read the "T011 residue" section of cycle 2 in full.
2. Reseed the three RED fixtures with DB rows so each still asserts its ORIGINAL
   subject and returns its original expected value. Do NOT invert them and do
   NOT delete them — these are live dispatch guards, not fallback pins.
   `:113` is the #1112 cache-race regression guard and must still exercise the
   race (assessment written AFTER initial cache population) under DB authority.
3. Fix the three vacuous tests at `:60`, `:94`, `:141`: an assertion of `null`
   that would hold no matter what the code does is not a guard. Either seed them
   so the assertion is meaningful, or assert the specific reason for `null`.
4. Only touch `auto-prompts.ts` if a genuine defect is found — e.g. if the cache
   is not invalidated when an assessment lands, the #1112 race is a real bug and
   not merely a fixture problem. Prefer fixture repair; state clearly in the Log
   which you concluded and why.

## Acceptance criteria

1. `reassess-detection.test.ts` and `uat-dispatch.test.ts` are fully green.
2. Every test in both files fails if its subject regresses — no test asserts a
   value that holds regardless of behaviour. Prove it: for each of the six
   affected tests, state in the Log what you changed and what now makes it fail.
3. The #1112 cache-race guard still exercises an assessment written after the
   cache is populated.
4. If `auto-prompts.ts` changed, the change is a defect fix with a stated
   rationale, not an accommodation to make a test pass.

## Verify

```bash
node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/reassess-detection.test.ts src/resources/extensions/gsd/tests/uat-dispatch.test.ts src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts
```

## Log

- 2026-08-06 — created by planner from wave-3 review cycle 2 (T011 residue; RED on branch)
- 2026-08-06 — coder. Confirmed the three REDs at task base before touching anything
  (`reassess-detection.test.ts:77`, `:113`, `uat-dispatch.test.ts:118`, all
  `actual: null`). Fixture repair only — **`auto-prompts.ts` is byte-unchanged**
  (sha1 `c4ff490be1b7d23a10d34b30853011cb134331df` before and after; only the two
  test files appear in `git status`).

  **Conclusion on the #1112 race: fixture problem, not a product defect.**
  `checkNeedsReassessment` resolves ASSESSMENT/SUMMARY through
  `resolveSliceFile` → `resolveFile` → `cachedReaddirWithTypes`
  (`paths.ts:73`), a Map with no TTL that only `invalidateAllCaches()` clears —
  and it has *never* had an `existsSync` fallback: the pre-wave-3 DB branch at
  `a27f96189^` resolved artifacts through exactly the same two calls. The old
  test's own `invalidateAllCaches()` before its second call (old `:131`) is what
  made it pass; the "existsSync fallback" in its comment does not exist. In
  production the auto loop clears the caches once per completed unit
  (`auto-post-unit.ts:1474`) between the agent writing ASSESSMENT.md and the next
  dispatch check, so the race is closed there. I kept that single invalidation in
  the fixture, mirroring the post-unit hook and nothing more, and rewrote the
  comments to say what actually closes the race. Verified the alternative first:
  dropping the invalidation makes the second pass return `{ sliceId: "S01" }`, so
  "fix the product" here would have meant adding an uncalled-for `existsSync`
  path to make a fixture green — the accommodation AC4 forbids.

  Reseeding: both files now seed DB rows (`openDatabase(":memory:")`,
  `insertMilestone`, `insertSlice`) since `checkNeedsReassessment` returns `null`
  before reading anything without a DB (`auto-prompts.ts:1651`). Roadmap markdown
  is dropped from the reassess fixtures — it drives nothing post-cutover, and
  `auto-prompts-fallback.test.ts:187` already pins that it is ignored. Teardown
  closes the DB (`cleanup()` in reassess, `t.after` in uat-dispatch).

  **Discrimination, proved by mutating `auto-prompts.ts` and re-running (each
  mutation reverted from a pristine copy; final sha1 re-checked):**
  1. `:60` returns null when assessment file exists — seeded S01 `complete`/S02
     `pending` + SUMMARY, so the fixture is dispatch-ready but for the
     ASSESSMENT. FAILS (probe A: delete `if (hasAssessment) return null;` → 8/10,
     this test red).
  2. `:77` returns sliceId when assessment is missing (was RED) — FAILS on probe D
     (`return { sliceId: lastCompleted }` → `return null` → 8/10, this test red);
     also red if the DB seed is removed, which is the original break.
  3. `:94` returns null when summary is missing — everything else is
     dispatch-ready. FAILS (probe B: delete `if (!hasSummary) return null;` →
     9/10, this test red).
  4. `:113` #1112 cache race (was RED) — still writes the ASSESSMENT *after* the
     first pass populated the caches (AC3 intact). FAILS on probe A **and** on
     probe D (red in both, 8/10 each): it discriminates the ASSESSMENT check, the
     positive dispatch, and any invalidation that stopped clearing the directory
     cache.
  5. `:141` returns null when all slices complete — S02 is the last completed row
     and has a SUMMARY but no ASSESSMENT, so only the open-slice guard suppresses
     dispatch. FAILS (probe C: `|| !hasIncomplete` removed → 9/10, this test red).
  6. `uat-dispatch.test.ts:118` compatibility wrapper (was RED) — FAILS on probe F
     (wrapper body → `return null` → 4/5, this test red), and is red without the
     DB seed (with no rows, `getDbCompletedSliceCandidates` yields no candidates
     and the wrapper's own fallback list is empty post-cutover). Noted, not fixed
     (out of scope): probe E — passing `[]` instead of
     `loadRoadmapCompletedSliceCandidates(...)` as the wrapper's fallback changes
     nothing, because `uat-dispatch.ts:151` consults the DB itself and only falls
     through when the milestone has no rows at all, at which point the wrapper's
     DB-derived fallback is empty too. The `fallbackCandidates` argument is dead
     post-cutover; `uat-dispatch.ts` is not in this task's `files`.

  Verify (exact command from the task) — exit 0:
  `ℹ tests 20 / ℹ suites 0 / ℹ pass 20 / ℹ fail 0 / ℹ cancelled 0 / ℹ skipped 0 /`
  `ℹ todo 0 / ℹ duration_ms 3195.357875`

  Changed: `src/resources/extensions/gsd/tests/reassess-detection.test.ts`,
  `src/resources/extensions/gsd/tests/uat-dispatch.test.ts`.
- 2026-08-06 — orchestrator Verify rerun (authoritative, isolated worktree): exit 0.
  Diff scope check: declared files plus the task file; zero paths outside `files`.
