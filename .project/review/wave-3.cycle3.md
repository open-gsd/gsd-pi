# Review — wave 3, cycle 3

Wave verdict: blocked
Cycle: 3
Depth: full
Tasks reviewed: 19

Review base `e922983be87a03482c2660e26fcc8bba8c66028c`, disposable worktree
`.worktrees/gsd-path-review3c3`. All three cycle-2 fix commits were resolved by
SHA from each task's `commit` field and diff-scope-checked: **every fix commit
changed only paths in its own `files` list plus its own task file — zero
contract-body edits, zero out-of-scope paths** (T034 `d9b5d70d6`: 2 test files;
T035 `6c06b3776`: `commands/handlers/core.ts`; T036 `b4c0bcfcb`:
`verify-artifact-tightened.test.ts`, `artifact-verification.ts`,
`docs/dev/state-db-cutover-milestone-decision.md`).

**All three cycle-2 findings are genuinely closed.** Each was re-verified against
its ORIGINAL criterion by independent mutation probe, not by reading the fix's
own Verify. Every claim the three coders made in their Logs that I re-ran held.

**One new blocking finding.** The standing risk this brief names — a deleted
markdown fallback leaving tests behind — has recurred a **sixth** time, and this
instance is worse than the previous five: it is not unfailable tests, it is
**15 tests that are RED at the review base**, in four files, all attributable to
T011 by single-file bisect. Two of those files run in CI's `test:integration`
leg (`.github/workflows/ci.yml:246`). Cycle 2 found this exact defect in two
files; T034 repaired those two; nobody swept for the rest.

---

## T034 — Repair the T011 residue (T011 AC3/AC4): **pass**

- ✅ AC1 `reassess-detection.test.ts` + `uat-dispatch.test.ts` + `auto-prompts-fallback.test.ts`
  re-run here: **20/20 pass, 0 fail, 0 skipped.**
- ✅ AC4 / byte-identity claim **verified**: `git rev-parse` of
  `src/resources/extensions/gsd/auto-prompts.ts` at `d9b5d70d6^`, `d9b5d70d6`
  and `HEAD` all yield blob `29af5990cee6d025b334fc40b46bf9fe87b14756`. The file
  is untouched; the fix is fixture-only, as claimed.
- ✅ AC2 **all six affected tests independently proved failable.** I re-ran the
  coder's mutations myself against `auto-prompts.ts` (each from a pristine copy,
  file restored and `git status` verified clean after each):
  | Mutation on `auto-prompts.ts` | Tests turned RED |
  |---|---|
  | A: disable `if (hasAssessment) return null;` (`:1662`) | `reassess-detection.test.ts:80`, `:135` (8/10) |
  | B: disable `if (!hasSummary) return null;` (`:1665`) | `reassess-detection.test.ts:116` (9/10) |
  | C: drop `\|\| !hasIncomplete` (`:1657`) | `reassess-detection.test.ts:171` (9/10) |
  | D: `return { sliceId: lastCompleted }` → `return null` | `reassess-detection.test.ts:97`, `:135` (8/10) |
  | F: wrapper body → `return null` (`:1700-1706`) | `uat-dispatch.test.ts:118` (4/5) |
  Five distinct mutations, six distinct kills, every test in both files covered.
  No test in either file survives all mutations. AC2 met.
- ✅ AC3 **the #1112 cache-race guard still exercises the race.**
  `reassess-detection.test.ts:135-164`: first `checkNeedsReassessment` call
  populates the caches and asserts `{ sliceId: "S01" }`; `writeAssessment` lands
  **after** that (`:149`); one `invalidateAllCaches()` mirroring
  `auto-post-unit.ts` (`:154`); second call asserts `null`. The assessment is
  written after cache population, and the test is killed by both probe A and
  probe D, so it discriminates the ASSESSMENT read, the positive dispatch, and
  the cache clear. The coder's "fixture problem, not a product defect"
  conclusion is consistent with what I measured.

Warnings (non-blocking):
- The coder's disclosed side finding is **confirmed, not refuted** — see
  "Unowned item 4" below.

## T035 — Register `db` in the help menu (T014 AC1): **pass**

- ✅ AC1 `help-menu-coverage.test.ts` + `db-restore-backup-routing.test.ts`
  re-run here: 5/5 pass. **Assertion intact and still discriminating** —
  probed by deleting the added line from `core.ts:163`, which turns
  `every TOP_LEVEL_SUBCOMMAND appears in showHelp("full") output` RED (0/1).
  The commit touched `core.ts` only; the test file is byte-unchanged.
- ✅ AC2 `/gsd db restore-backup` is in the `fullLines` MAINTENANCE block at
  `commands/handlers/core.ts:163`, directly under `/gsd recover`.
- ✅ AC3 T032's registration is unchanged: `commands/catalog.ts` is blob
  `25a060efd…` at T032's commit, at T035's commit, and at HEAD.
- ✅ **`/gsd db restore-backup` still reachable** — `db-restore-backup-routing.test.ts`
  green; cycle 2's end-to-end `handleGSDCommand` probe stands, and this commit
  changed only a help string.
- ✅ **No other help/catalog test broke.** Ran the twelve repo test files
  referencing `showHelp` / `TOP_LEVEL_SUBCOMMANDS` / `catalog` plus
  `github-sync/tests/sync-source.test.ts`: **253/253 pass, 0 fail.**

## T036 — Retire the obsolete execute-task guards (T029 AC4): **pass**

- ✅ AC1 **ZERO unfailable tests remain in `verify-artifact-tightened.test.ts`.**
  17 tests → 11; the file is 11/11 green here. I proved **all eleven survivors
  failable by mutating production code**, not by reading the Log — six
  mutations of `artifact-verification.ts`, each applied from a pristine copy and
  reverted (`git status` clean after each):
  | Mutation | Tests turned RED |
  |---|---|
  | M1: execute-task fail-closed `return false` → `true` (`:506-517`) | both `[x]`/`[X]` fails-closed tests (9/11) |
  | M2: `readExecuteTaskArtifactReadiness(...) !== null` → `true` (`:352`) | all three DB-branch Attempt tests (8/11) |
  | M3: disable `phaseDirMatchesMilestoneId` filter (`:172`) | `#1500` plan-milestone team-suffix negative (10/11) |
  | M4: disable worktree→project-root fallback (`:377`) | both `#870` tests + `#852` fallback test (8/11) |
  | M6: terminal `return true` → `false` (`:558`) | all four `#852`/`#870` tests (7/11) |
  | M7: `!absPath` branch → unreachable (`:387`) | `#852` "neither worktree nor project root" (10/11) |
  Union of kills = 11/11. The coder's targeted-mutation claim for the `#852`
  null-path test (M7 rather than M5) is correct: M5 does not reach that fixture.
- ✅ AC2 **`allowSiblingTeamSuffixProjections` is gone with no live callers.**
  `grep -rn "allowSiblingTeamSuffixProjections\|allowTeamSuffixProjections" src packages scripts docs`
  returns exactly one hit — the prose reference in the decision doc at
  `docs/dev/state-db-cutover-milestone-decision.md:202`. Zero code references.
  The `allowTeamSuffixProjections` parameter, the `matchesFallback` arm, both
  call-site arguments and the now-unused `milestoneIdUniqueSuffix` import are
  all removed.
- ✅ AC3 **R5 states the consequence undiluted.** `state-db-cutover-milestone-decision.md:185-222`
  names #1500 and #3607, gives the reason (settled Attempt record IS the
  completion fact, ADR-017) and the rejected alternative, and states plainly:
  *"a settled attempt whose SUMMARY file has been deleted now verifies **true**.
  Verification will not notice the missing SUMMARY, and auto mode will not
  re-dispatch the task to regenerate it."* No hedging, no burial. The count
  update ("Four" → "Five") and the R1–R4 scoping of the downgrade-window
  sentence are both correct.
- ✅ AC4 **No production behaviour change beyond dead-code removal**, verified
  by reading the whole 26-line diff to `artifact-verification.ts`: an import
  narrowed, a defaulted parameter and its only-false-in-practice branch deleted,
  two call sites de-argumented. Nothing else changed.
- ✅ **Nothing else called the deleted code.** `milestoneIdUniqueSuffix` retains
  live callers in `gsd-db.ts` / `paths.ts`; `phaseDirMatchesMilestoneId`'s own
  team-suffix parameter (`paths.ts:778`) is still used elsewhere and was
  correctly left alone. `recovery-verify-logs.test.ts` +
  `integration/idle-recovery.test.ts` re-run: 40/40, and the T029 DB-unavailable
  witness is failable (M1 turns exactly it RED, 39/40).

## T011 residue, round 2 — 15 RED tests in four unswept files: **fail**

This is not owned by any task. It is the same defect cycle 2 found, in the files
nobody looked at. **Wave-3 criterion failure**, not a closeout concern: two of
the four files run in CI (`pnpm run test:integration`, `.github/workflows/ci.yml:246`).

- ❌ T011 AC3 ("no surviving test asserts markdown-fallback behaviour for these
  surfaces") and AC4 (suite green)
  found: **15 tests are RED at the review base**, in four files that appear in
  no task's `files` list. Every one has a markdown-only fixture and reaches a
  branch T011 converted to DB-only.

  1. `src/tests/integration/web-state-surfaces-contract.test.ts:37`
     "indexWorkspace extracts risk, depends, and demo from roadmap" and `:90`
     "indexWorkspace handles slices without risk/depends/demo" —
     `TypeError: Cannot read properties of undefined (reading 'id' / 'risk')` at
     `:80` / `:113`, because `index.milestones[0].slices[0]` is undefined.
     Cause: `workspace-index.ts` `indexSlice` (`:88-104`) now populates `tasks`
     only from `getSliceTasks` under `isDbAvailable()`; the markdown fallback
     (`parsePlan`) was deleted by T011.
     **Attribution proved by single-file swap:** replacing only
     `src/resources/extensions/gsd/workspace-index.ts` with its `a27f96189^`
     content turns both tests green (16/16); restoring T011's version turns them
     red again (14/16).
  2. `src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts`
     — 5 RED in the `prompt-budget: inlineDependencySummaries truncation`
     describe block: `:108` ("should include full summary content"), `:120`
     ("should have truncation marker when over budget"), `:138` ("should include
     all sections"), `:155` ("should have S01 content"), `:187` (#4435 12-dep
     cap). Cause: `inlineDependencySummaries` (`auto-prompts.ts:1061-1080`) now
     sources `depends` from `getSlice(mid, sid)` only and returns
     `"- (no dependencies)"` when there is no DB row; the fixture
     (`setupDependencyFixture`) writes only a ROADMAP with `depends:[S01]`.
  3. `src/resources/extensions/gsd/tests/integration/run-uat.test.ts` — 6 RED:
     `:388` (m) non-artifact UAT skip, `:595` (r) no ASSESSMENT still dispatches,
     `:642` (s) ASSESSMENT without verdict does not skip, `:691` (t)
     browser-observable final-slice UAT dispatches with `uat_dispatch` off,
     `:839` (x) runtime-executable promotion, `:913` (x2) browser-executable
     stays unpromoted. All import `checkNeedsRunUat` from `../../auto-prompts.ts`
     — the same compatibility wrapper whose single test (`uat-dispatch.test.ts:118`)
     T034 just repaired — and all use markdown-only fixtures, so
     `loadRoadmapCompletedSliceCandidates` returns `[]` and the wrapper yields
     `null`. **These are live dispatch guards**, including "human-experience UAT
     dispatches so auto-mode can pause for manual review" and "browser-observable
     final-slice UAT must run before validation even when optional UAT dispatch
     is off".
  4. `src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts:241`
     "#4780 closer prompt: uses excerpts + lists on-demand slice SUMMARY paths"
     and `:322` "validate-milestone prompt uses slice excerpts and on-demand
     paths instead of full prior artifacts" — the rendered prompt no longer
     matches `/### S01 Summary \(excerpt\)/`, because
     `buildCompleteMilestonePrompt` / `buildValidateMilestonePrompt` now take the
     slice list from the DB and the fixture is markdown-only.

  **Attribution for 2–4 proved by single-file swap:** replacing only
  `src/resources/extensions/gsd/auto-prompts.ts` with its `a27f96189^` content
  makes all three files fully green (run-uat 29/29, prompt-budget 29/29,
  complete-milestone-excerpt 10/10). Restoring the current file returns all 13
  reds. `auto-prompts.ts` is byte-identical at T034^ and HEAD, so T030/T034 are
  neither cause nor cure — **T011 is the sole cause.**

  Not caused by cross-file interference: every failure reproduces with the file
  run standalone.

  Not caught by the wave because `test:unit:compiled`'s glob is
  `dist-test/src/tests/*.test.js` — it does not include `src/tests/integration/`
  — and no task's Verify runs `prompt-budget-enforcement`, `run-uat` or
  `complete-milestone-excerpt`. CI's separate `test:integration` job does run two
  of the four.

  fix: **two fix tasks, disjoint scopes.**
  (a) own `src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts`,
  `src/resources/extensions/gsd/tests/integration/run-uat.test.ts`,
  `src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts`.
  Reseed each fixture with DB rows the way T034 reseeded `reassess-detection` —
  `openDatabase(":memory:")`, `insertMilestone`, `insertSlice` with the
  `depends` array the ROADMAP fixture currently encodes (S02 depends on S01 for
  prompt-budget; the milestone's complete slices for run-uat; all slices for
  complete-milestone-excerpt), plus a `closeDatabase()` teardown. Do not delete
  the positive assertions — the behaviours they protect (dependency-summary
  inlining and truncation, UAT dispatch for human-experience and
  browser-observable slices, excerpt-based closer prompts) are all still
  required; only the source of truth moved. Do not touch `auto-prompts.ts`
  unless a genuine product defect is found, and say so in the Log if it is.
  (b) own `src/tests/integration/web-state-surfaces-contract.test.ts`. Same
  reseed for `indexWorkspace` (`insertMilestone` + `insertSlice` + `insertTask`
  T01), keeping the risk/depends/demo assertions — those still come from the
  roadmap projection via `roadmapMeta`, only `slice.tasks` moved to the DB.
  For both: prove each repaired test failable by mutating `auto-prompts.ts` /
  `workspace-index.ts`, and record the mutation per test, exactly as T034 did.

  **Before dispatching either, sweep the rest of the repo the same way** — run
  every test file that imports a T011-touched module (`auto-prompts.ts`,
  `workspace-index.ts`, `visualizer-data.ts`, `github-sync/sync.ts`) and every
  file under `src/tests/integration/`, not only the ones a task's Verify names.
  I swept the 52 unit files matching those modules plus the 5 integration files
  that reference wave-3 modules; the sweep found these four files and nothing
  else, but it was scoped by grep and is not a substitute for the CI legs.

## T029, T030, T031, T032, T033: **pass (regression-checked)**

Cycle-2 verdicts spot-checked, not re-derived. `verify-artifact-tightened` (11),
`recovery-verify-logs` + `integration/idle-recovery` (40),
`auto-prompts-fallback` (10), `state-reconciliation-drift` + `markdown-renderer`
+ `artifact-db-drift-memo` + `reactive-graph` + `visualizer-data` +
`visualizer-critical-path` + `parsers-legacy-importers` and 40 other wave-3-adjacent
files: **702 tests / 673 pass / 14 fail / 15 skipped** — every failure is one of
the 15 above (one describe-block wrapper counted once). No fix introduced a
regression outside its own scope.

## T010, T012, T013, T014, T015, T016, T017, T018, T019, T028: **pass**

Unchanged from cycles 1–2 except through the fixes, all of which were
regression-checked above. T011 alone is re-opened.

---

## Fixed since last cycle

- **T011 AC3/AC4 in `reassess-detection.test.ts` / `uat-dispatch.test.ts`** —
  confirmed fixed. Both files green (20/20 with `auto-prompts-fallback`); all six
  affected tests independently proved failable by five mutations of
  `auto-prompts.ts`; the #1112 guard still writes the ASSESSMENT after cache
  population and dies under two independent mutations; `auto-prompts.ts` is
  byte-identical (blob `29af5990c…`) before and after T034. **Not fixed, and
  newly found:** the same T011 change left 15 more tests RED in four other files
  (section above) — a second-order miss of the same defect, not a T034 regression.
- **T014 AC1 / T032 regression (`help-menu-coverage.test.ts`)** — confirmed
  fixed. Green with its assertion intact and still discriminating (deleting the
  new `core.ts:163` line turns it RED); `catalog.ts` unchanged; the routing test
  and 253 other help/catalog/github-sync tests green.
- **T029 AC4 (six unfailable tests + dead `allowSiblingTeamSuffixProjections`)** —
  confirmed fixed. Zero unfailable tests remain in the file: 11/11 survivors
  killed by six production mutations. The dead const, parameter, fallback arm and
  import are gone with zero code references repo-wide. R5 records the retirement
  and the observable consequence undiluted.

## Still open, unowned by any task (recorded, not fixed)

1. **INTENT success criterion 3 is not satisfiable as written.** Unchanged from
   cycle 2. `legacy:cleanup:gate` composes the static proof; the proof is BLOCK
   with 8 offender files, 7 of them `Retired by: none` and owned by no task. And
   the telemetry leg does not instrument the legacy filesystem-state path: the
   five `LEGACY_COUNTERS` (`legacy-cleanup-gate.mjs:10-16`) are
   `workflowEngineUsed`, `uokFallbackUsed`, `mcpAliasUsed`, `componentFormatUsed`,
   `providerDefaultUsed`, and SYNTHESIS ruled no `markdownFallbackUsed` counter
   would be built. Criterion 3 is carried entirely by the static proof. Needs a
   human ruling before wave 4, not after.
2. **`detectStaleRenders` is a `return []` stub; `detectProjectionDrift` has no
   production caller.** Unchanged. **Newly measured consequence:** the stub makes
   `markdown-renderer.test.ts:1571` "repairStaleRenders idempotency — fully
   synced returns 0" **unfailable** — I desynced the fixture (T01 `done` in DB,
   `[ ]` in the plan) and it still passes 26/26. All the *positive* stale-render
   tests are skip-gated instead (10 skips in `markdown-renderer.test.ts`,
   `state-reconciliation-drift.test.ts:1002`, `integration-proof.test.ts:437`),
   so the skips are visible but the one non-skipped survivor is not.
   **Milestone-scope, not wave 3:** the stub landed in `a336f878c` (2026-06-23),
   an ancestor of T010. Recording it so wave 4 does not count `repairStaleRenders`
   as covered.
3. **T020 is unreachable as written** and its arbiter test
   (`src/tests/legacy-cleanup-gate.test.ts:187`) is itself pinned RED by design.
   Unchanged from cycle 2; needs a `justified-permanent` category or seven new
   tasks, plus ownership of that test file.
4. **NEW, assessed: `checkNeedsRunUat`'s `fallbackCandidates` argument is dead
   post-cutover — CONFIRMED.** `uat-dispatch.ts:144-176` consults
   `fallbackCandidates` only when `getDbCompletedSliceCandidates` returns `null`
   (no DB rows for the milestone, or DB unavailable). Both production callers —
   `auto-prompts.ts:1700-1706` and `auto-dispatch.ts:916-921` — pass
   `loadRoadmapCompletedSliceCandidates(...)`, which itself returns `[]` when the
   DB is unavailable and otherwise reads the same `getMilestoneSlices(mid)` rows
   that just came back empty. So whenever the fallback is consulted it is
   provably `[]`. Probed: replacing the wrapper's argument with a literal `[]`
   changes nothing (`uat-dispatch.test.ts` 5/5). The last test in that file,
   "checkNeedsRunUat uses roadmap fallback candidates when the DB has no slice
   rows", calls `uat-dispatch.checkNeedsRunUat` directly with hand-supplied
   candidates, so it is failable — but it pins a code path production can no
   longer reach. **Milestone-scope cleanup**, not a wave-3 criterion failure:
   fold the parameter's removal into T020/T021/T022 deletion scope, or record it
   as accepted dead code at closeout.
5. Cycle-2 warnings that remain open and unowned, all non-blocking:
   `plan-slice` is the last markdown-over-DB fallback in
   `artifact-verification.ts:443-499`; `"skipped"` slices are no longer run-uat
   candidates; two catches (`:301-303`, `:500-502`) swallow a DB error into a
   PASS; the `base` SHA recorded in T030–T033 is not those commits' actual
   parent; the live-repo proof test scans `process.cwd()`.

---

## Summary for orchestrator

**This is cycle 3 of a max-3 cycle wave. The verdict is `blocked`, so this goes
to the human.** What the human is being asked to decide is narrow: the three
cycle-2 findings are closed and verified; one wave-3 criterion (T011 AC3/AC4) is
still unmet, in files no cycle has swept, with 15 tests RED — 13 in the unit
tree, 2 in a CI-run integration file. It is a mechanical fixture-reseed of the
same shape T034 already executed successfully, not a design question. Everything
else on this list is milestone-scope and belongs at closeout.

- blocked → fix tasks needed (one per disjoint file scope):
  - **T034F3** — scope
    `src/resources/extensions/gsd/tests/prompt-budget-enforcement.test.ts`,
    `src/resources/extensions/gsd/tests/integration/run-uat.test.ts`,
    `src/resources/extensions/gsd/tests/complete-milestone-excerpt.test.ts`.
    Covers 13 RED tests caused by T011's `auto-prompts.ts` change (attribution
    proved by single-file swap to `a27f96189^`). Reseed with DB rows; keep every
    positive assertion; prove each repaired test failable by mutation.
  - **T034F3b** — scope `src/tests/integration/web-state-surfaces-contract.test.ts`.
    Covers 2 RED tests caused by T011's `workspace-index.ts` change (same proof
    method). Seed milestone/slice/task rows; keep the risk/depends/demo
    assertions, which still come from the roadmap projection.
  - Both fix tasks' Verify must run the whole file, and the wave must add a
    repo-wide sweep step before it closes: **run every test file importing a
    T011-touched module and every file under `src/tests/integration/`**, because
    `test:unit:compiled`'s glob excludes `src/tests/integration/` and CI's
    `test:integration` job is the only thing that would have caught finding (1).

- repeat offenders (criteria failing across cycles — plan defect):
  1. **A deleted fallback leaves tests behind — six waves of it now.** Cycle 1:
     1 instance. Cycle 2: 6. Cycle 3: 15, and this time they are RED rather than
     unfailable, which means the wave has been shipping a red branch for three
     cycles. Root cause is unchanged and structural: **fix-task `files` lists are
     scoped from the symbol's own file, never from its consumers.** T011 changed
     four production modules and listed three test files; nine other test files
     import those modules. Every remaining deletion task (T020, T021, T022) must
     carry a mandatory step: *enumerate every test file that imports the changed
     module, run all of them, and for each one state whether it still
     discriminates — proved by mutation, not by observing green.*
  2. **Verify commands are per-file and the wave has no suite-level gate.** No
     task's Verify would have caught any of the 15. Consider requiring
     `pnpm run test:integration` (or at minimum the affected globs) as the
     wave-level Verify before closeout.

- warnings worth a human eye:
  1. INTENT criterion 3 not satisfiable as written (unowned item 1) — ruling
     needed before wave 4 dispatch.
  2. Seven `Retired by: none` modules; T020 unreachable and its arbiter test
     pinned red (unowned item 3).
  3. `detectStaleRenders` inert; `markdown-renderer.test.ts:1571` is unfailable
     as a result (unowned item 2). Pre-existing, but do not count
     `repairStaleRenders` as covered.
  4. `checkNeedsRunUat`'s `fallbackCandidates` is confirmed dead (unowned
     item 4) — fold into a deletion task or accept explicitly at closeout.
  5. R5 in the decision doc is well written and honest; it is the model the
     remaining retirements should follow.
