# Review — wave 3, cycle 4

Wave verdict: blocked
Cycle: 4
Depth: full
Tasks reviewed: 21

Review base `648489b84597b3c8d5ca529a8433ac9134305603`, disposable worktree
`.worktrees/gsd-path-review3c4`. Both cycle-3 fix commits were resolved by SHA
from each task's `commit` field and diff-scope-checked: **each changed only
paths in its own `files` list plus its own task file — zero contract-body
edits, zero out-of-scope paths** (T037 `97f49b67f`: 1 test file; T038
`75c07cdbc`: 4 test files).

**Both cycle-3 fixes are genuinely closed.** Every byte-identity claim and
every mutation probe in their Logs was re-derived here, not read: I re-ran
eight of the eleven claimed mutations plus two of my own, each applied to a
pristine copy and reverted with `git diff --quiet` confirming restoration. All
five formerly-RED files are green (**95/95, 0 fail, 0 skipped**) and
non-vacuous.

**And the T011 blast radius is still not exhausted.** For the seventh cycle in
a row the same defect class produced new instances, and this time I found them
by running the CI legs rather than by grepping importers: **`pnpm run
verify:pr` is RED at this review base.** `test:unit:compiled` fails 5 tests in
4 files, in a leg no cycle has ever run. Two are T011 residue reached
*transitively* through `auto-dispatch.ts` — invisible to the orchestrator's
39-file direct-importer sweep and to a symbol sweep. One is T029 residue. One
is a T014 repo-invariant regression. The BOARD entry "branch no longer CI-red"
is not correct; only the `test:integration` leg was cleared.

CI-equivalent gate status measured at this base (all in a relocated copy of
this worktree — see "Process finding" below):

| Gate | Result |
|---|---|
| `pnpm run build:core` + `build:web-host` + `test:compile` | **pass** (exit 0) |
| `pnpm run typecheck:extensions` | **pass** (exit 0) |
| `pnpm run gate:lifecycle-shadow-no-cutover` | **pass** — Structural 8/8, Behavioral 15/15 |
| `pnpm run test:packages:compiled` | **pass** (exit 0) |
| `pnpm run test:integration` | **pass** — 1272 tests, 1266 pass, **0 fail**, 6 skipped |
| `pnpm run test:unit:compiled` | **FAIL** — 13992 pass, **5 fail**, 28 skipped |
| **`pnpm run verify:pr`** | **FAIL** (via its `test:unit` leg) |

---

## T037 — Reseed the workspace-index contract tests (T011 AC3/AC4): **pass**

- ✅ AC1 `web-state-surfaces-contract.test.ts` green here — 16/16 in the file,
  and 95/95 across all five formerly-RED files in one run.
- ✅ AC2 **both repaired tests independently proved failable**, by re-running
  three of the four claimed mutations of `workspace-index.ts` myself (each from
  a pristine copy; `git diff --quiet` clean after each):

  | Mutation on `workspace-index.ts` | Tests turned RED |
  |---|---|
  | `indexSlice:93` `if (isDbAvailable())` → `if (false && …)` | `:37` "extracts risk, depends, and demo" (15/16) |
  | `indexSlice:116` `depends: roadmapMeta?.depends` → `depends: []` | `:37` (15/16) |
  | `indexWorkspace:141` `done: s.status === "complete"` → `done: false` | `:90` "handles slices without risk/depends/demo" (15/16) |

  Two independent kills for `:37`, one for `:90`; every claimed kill reproduced
  exactly, including the pass/fail counts.
- ✅ AC3 risk/depends/demo assertions unchanged in substance — verified by
  reading the whole diff: `high` / `["S00"]` / `"users can see the dashboard"`
  and `low` / `[]` / `""` are byte-identical to the pre-fix file. Only a stale
  comment was reworded.
- ✅ **`workspace-index.ts` byte-unchanged**: blob `e3ee87462de6ec84b1359d43f1bfe23c07219dc9`
  at `97f49b67f^`, `97f49b67f` and `HEAD` — and identical to T011's own
  `a27f96189` version, so the fix is fixture-only as claimed.

Warnings (non-blocking):
- The Log's rationale is factually wrong even though the fix is right.
  `roadmapMeta` no longer comes from "the roadmap projection": `indexWorkspace`
  (`workspace-index.ts:139-141`) builds it from `getMilestoneSlices()` DB rows.
  The consequence is that the test **name** — "indexWorkspace extracts risk,
  depends, and demo **from roadmap**" — now describes a path that does not
  exist, and the old parser-default coverage ("Parser defaults risk to low") is
  gone: `:141` defaults to `"medium"`, and the fixture seeds `"low"`
  explicitly. Rename the test at closeout, or it will mislead the next reader.

## T038 — Reseed the four auto-prompts test files (T011 AC3/AC4): **pass**

- ✅ AC1 all four files green — prompt-budget 29/29, run-uat 29/29,
  complete-milestone-excerpt 10/10, right-sized 11/11.
- ✅ AC2 **failability re-derived, not read.** I re-ran five of the seven
  claimed mutations of `auto-prompts.ts`; all five reproduced with the exact
  test sets and counts the Log claims:

  | Mutation on `auto-prompts.ts` | Tests turned RED |
  |---|---|
  | A: `inlineDependencySummaries:1071` `depends = slice.depends` → `[]` | prompt-budget ×5 — the whole RED set (24/29) |
  | C1: `checkNeedsRunUat` wrapper (`:1695-1706`) → `return null` | run-uat (m)(r)(s)(t)(x)(x2) — the whole RED set (23/29) |
  | C2: same wrapper → always `{sliceId:"S01"}` | run-uat (m) **(n) (q)** (t)(x)(x2) (23/29) |
  | D: both `.filter(s => s.status !== "skipped")` (`:3297`, `:3498`) → `.filter(() => false)` | complete-milestone-excerpt ×2 + the pre-existing Q3/Q4 test + right-sized "does not trust pass validation missing current summary coverage" (17/21) |
  | E: `isValidationFreshOrApplicable:302` `size === 0` → `size >= 0` | right-sized "trusts passing validation artifact", "trusts centralized markdown body pass verdict" (9/11) |

  C1 ∪ C2 kills all eight `checkNeedsRunUat` tests. Every one of the 14
  originally-RED tests appears in at least one row.
- ✅ AC3 **no test inverted or deleted.** Verified structurally, not by
  counting: the entire T038 diff to all four files is additive — a `gsd-db`
  import, a `seedSliceRows`/`seedRoadmapSlices` helper, calls to it, and DB
  close in teardown. **Not one `assert` line was changed** in any of the four
  files.
- ✅ AC4 **`auto-prompts.ts` byte-unchanged**: blob
  `29af5990cee6d025b334fc40b46bf9fe87b14756` at `75c07cdbc^`, `75c07cdbc` and
  `HEAD`. Confirmed independently by `git rev-parse`.
- ✅ **The vacuous tests are now genuinely killable.** The brief names three;
  there are in fact **four**, and all four discriminate now:
  - run-uat `(n)` and `(q)` — killed by C2 (they expect `null`; before the
    reseed they got `null` only because the wrapper found no candidates at all).
  - right-sized's two "trusts passing validation" positives — E is *not* a
    sufficient proof here (it forces the predicate false regardless of the
    fixture, so it would have killed them before the reseed too). I built an
    asymmetric probe that bites **only** when `currentArtifacts` is non-empty,
    which is exactly what the reseed supplies:
    `isValidationFreshOrApplicable:303-306` `.map(normalizeArtifactRef)` →
    `.map(a => normalizeArtifactRef(a) + "X")`. Result: **both positives RED**
    (9/11), negatives unaffected. Pre-reseed `currentArtifacts` was empty, so
    `.every()` was vacuously true and this mutation would have changed nothing.
    The vacuity is genuinely removed.

Warnings (non-blocking):
- The disclosed unfailable test is **confirmed** — see "Disclosed items" below.

## T011 residue, round 3 — 2 RED tests reached transitively: **fail**

- ❌ T011 AC3 ("no surviving test asserts markdown-fallback behaviour for these
  surfaces") and AC4 (suite green)
  found: **two more tests are RED at the review base**, both in
  `test:unit:compiled` — the CI leg no cycle has run:

  1. `src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts`
     — "run-uat browser preflight uses registered tools when the active surface
     is scoped". Expected `'dispatch'`, actual `undefined`.
  2. `src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts`
     — "run-uat dispatch stops after three attempts without a verdict".
     Expected `'stop'`, actual `undefined`.

  **Attribution proved by single-file swap**, the same method cycle 3 used:
  replacing only `src/resources/extensions/gsd/auto-prompts.ts` with its
  `a27f96189^` content turns both green (28 tests / 27 pass, the only remaining
  failure being the unrelated T029 one below); restoring HEAD's version turns
  them red again. Both use markdown-only fixtures, so
  `loadRoadmapCompletedSliceCandidates` yields `[]` and the dispatch resolver
  returns nothing. These are live dispatch guards — a browser-tool preflight
  contract and the three-attempt replay cap.

  **Why every sweep so far missed them, and this is the generalizable part:**
  neither file imports a T011-touched module. Both import
  `DISPATCH_RULES` from `../auto-dispatch.ts`, which is a *transitive*
  consumer of `auto-prompts.ts`. The orchestrator's 39-file sweep keyed on
  direct importers; I also ran a symbol sweep (29 files referencing
  `checkNeedsRunUat`, `indexWorkspace`, `inlineDependencySummaries`,
  `buildCompleteMilestonePrompt`, … ) and **it missed them too**. Only running
  the leg found them.

  fix: one fix task owning
  `src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts`
  and `src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts`. Reseed
  each fixture with `openDatabase(":memory:")` + `insertMilestone` +
  `insertSlice` rows matching the ROADMAP the fixture already writes (the
  completed slice the run-uat rule is meant to fire on), exactly as T038 did in
  `integration/run-uat.test.ts`; close the DB in teardown. Keep every
  assertion. Prove each repaired test failable by mutating `auto-prompts.ts`
  (mutation C1 above is the natural probe) and record it per test.
  `auto-prompts.ts` must stay byte-identical to `29af5990c…`.

## T029 residue — 1 RED test pinning the removed markdown closeout fallback: **fail**

- ❌ T029 AC1/AC3/AC4 ("no regression guard is lost to a deletion"; the wave's
  standing requirement that a deleted fallback leaves no test behind)
  found: `src/resources/extensions/gsd/tests/journal-integration.test.ts:381`
  — "runDispatch retries when complete-milestone summary exists on disk and
  stuck recovery can proceed (#4289)" is **RED** (`'next' !== 'continue'`).
  The fixture (`:390-403`) writes `M001-SUMMARY.md` to disk with **no DB** and
  asserts auto mode proceeds — i.e. it pins the exact markdown-SUMMARY closeout
  escape T029 deliberately deleted from `artifact-verification.ts`.

  **Attribution proved by file bisect** on `artifact-verification.ts` alone
  (file swapped, test re-run, file restored, `git diff --quiet` clean):

  | `artifact-verification.ts` from | journal-integration result |
  |---|---|
  | `331cee83a` (branch base) | 25 pass / 0 fail |
  | `27c224fe1` (T010) | 25 pass / 0 fail |
  | `942d048d7` (T029) | 24 pass / **1 fail** |
  | `b4c0bcfcb` (T036) | 24 pass / **1 fail** |

  So T029 is the sole cause, T010 is not, and T036 neither caused nor cured it.
  `journal-integration.test.ts` appears in no task's `files` list.

  This is a **wave-3 criterion failure, not a closeout concern**: T029 exists
  precisely to make this class fail closed, and cycle 2 accepted its AC3 ("no
  surviving test asserts the removed fallbacks") on a per-file basis that never
  covered this file.

  fix: one fix task owning
  `src/resources/extensions/gsd/tests/journal-integration.test.ts`. This one is
  **not** a pure reseed — decide deliberately and record the decision:
  either seed the DB rows that make the closeout proof legitimately succeed
  (keeping the #4289 stuck-recovery subject intact), or re-express the test the
  way `integration/idle-recovery.test.ts` was inverted in T010 — asserting that
  an unconfirmable closeout now fails closed and emits the `recovery` warning.
  Do not delete it: #4289 is a live stuck-recovery guard. Prove the result
  failable by mutating `artifact-verification.ts`.

## T014 residue — repo-invariant test RED: **fail**

- ❌ T014 AC4 ("new tests pass; single-writer invariant untouched") read against
  the wave's standing requirement that a task not leave a repo invariant red
  found: `src/resources/extensions/gsd/tests/silent-catch-diagnostics.test.ts`
  — "no empty catch blocks remain in migrated files" is **RED**, reporting 10
  empty catch blocks in `commands-maintenance.ts` at lines 1228, 1230, 1250,
  1252, 1459, 1463, 1464, 1465, 1500, 1783.

  **Attribution is unambiguous.** `git blame` puts **all ten** lines on
  `ef879f79b` ("T014: Backup-restore command + DB-only cleanup-branches
  check"), and a file swap confirms it: `commands-maintenance.ts` at
  `ef879f79b^` → 2 pass / 0 fail; at `ef879f79b` → 1 pass / **1 fail**.

  The invariant is the #3348/#3345 workflow-logger migration: files on the
  migrated list must route catch bodies through `logWarning`/`logError` rather
  than swallowing silently. T014 added ten silent swallows to a migrated file.
  This also cuts against the milestone's own "fail loud" posture — several of
  the ten (`:1459` "leave the replacement fence for the next run to converge",
  `:1500` "the project database may not exist yet") swallow errors on the new
  restore path.

  fix: one fix task owning
  `src/resources/extensions/gsd/commands-maintenance.ts`. Replace each of the
  ten empty catch bodies with a `logWarning("maintenance", …)` (or `logError`
  where the failure is not best-effort), matching the pattern the rest of the
  file already uses. Do not add `commands-maintenance.ts` to the test's exempt
  list — that would weaken the invariant, which the INTENT vetoes forbid. Verify
  with `silent-catch-diagnostics.test.ts` plus
  `backup-restore-command.test.ts` and `db-restore-backup-routing.test.ts`.

## `verify:pr` is RED at the review base: **fail**

- ❌ INTENT success criterion 5 / PLAN "Project verify: `pnpm run verify:pr`",
  and T011 AC4 read literally
  found: `verify:pr` = `build:core && typecheck:extensions && test:unit &&
  gate:lifecycle-shadow-no-cutover`. Three of the four legs pass; **`test:unit`
  fails** — 13992 pass / **5 fail** / 28 skipped, deterministic and reproduced
  standalone (the four files run alone give 26 pass / 4 fail; the fifth failure
  is the `workflow-logger coverage (#3348)` describe-block wrapper counted
  separately). The five are exactly the ones above.

  This is the wave's structural blind spot showing up one level higher than
  cycle 3 found it. Cycle 3 correctly diagnosed that `test:unit:compiled`'s
  glob does not reach `src/tests/integration/`, and the orchestrator cleared
  `test:integration` (which I confirm: **1266/1272, 0 fail**). But nobody ran
  `test:unit:compiled` itself. Two of the five failures predate cycle 1.

  fix: the three fix tasks above close all five. Before this wave closes,
  **run `pnpm run verify:pr` end to end** — not a per-file Verify, not a glob
  subset — and record its exit code in the Log.

## T010, T012, T013, T015, T016, T017, T018, T019, T028, T030–T036: **pass (regression-checked)**

Cycle 1–3 verdicts spot-checked rather than re-derived, per the brief. The
regression check here is the strongest one the wave has had: the full
`test:integration` leg (1272 tests, 0 fail), the full `test:packages:compiled`
leg (exit 0), `typecheck:extensions` (exit 0), the successor gate (8/8
structural, 15/15 behavioral), and `test:unit:compiled` in which **every one of
the 13997 tests except the five above passes**. No fix in this cycle introduced
a regression: the five failures are all attributable to commits that predate
T037/T038, and both cycle-4 commits are test-file-only with production blobs
proven unchanged by hash.

Contract violations (blocking): none. Both cycle-4 commits stayed inside their
declared `files` plus their own task file.

---

## Fixed since last cycle

- **T011 AC3/AC4 in `web-state-surfaces-contract.test.ts`** — confirmed fixed.
  16/16 green; both repaired tests killed by three independent mutations of
  `workspace-index.ts`; risk/depends/demo assertions byte-unchanged;
  `workspace-index.ts` blob identical before and after (`e3ee87462…`).
- **T011 AC3/AC4 in `prompt-budget-enforcement.test.ts`,
  `integration/run-uat.test.ts`, `complete-milestone-excerpt.test.ts`,
  `right-sized-workflow-prompts.test.ts`** — confirmed fixed. All 14 previously
  RED tests green and each killed by at least one of five mutations I re-ran;
  zero assertions altered anywhere in the diff; `auto-prompts.ts` blob
  identical before and after (`29af5990c…`).
- **The four vacuous tests** — confirmed genuinely killable, including the two
  right-sized positives, for which I had to build a sharper probe than the one
  in the Log (see T038 above).
- **The `test:integration` leg** — confirmed cleared: 1272 tests, 1266 pass,
  **0 fail**. Cycle 3's 15 RED are gone and nothing replaced them there.
- **Not fixed, and newly found:** five RED tests in the `test:unit:compiled`
  leg — two more T011 instances (reached transitively), one T029 instance, one
  T014 repo-invariant regression. This is the **seventh** appearance of the
  standing risk and the second consecutive cycle in which the branch is CI-red,
  now in a different leg than last time.

## Disclosed items — verified

- **`complete-milestone-excerpt.test.ts` "caps repeated inlined context around
  20k chars" is unfailable — CONFIRMED, and correctly out of scope.** I removed
  the cap entirely (`capPreamble` body → `return preamble`) and the file stayed
  **10/10 green**. The measured inlined-context slice is far under the 21K
  bound because the closer keeps CONTEXT/KNOWLEDGE on-demand. `capPreamble` is
  untouched by T011 and the test was never in the RED set, so T038 was right to
  leave it and disclose it. **Record, do not block.**
- **Is any other budget/cap test similarly vacuous? No — and the capability
  itself is not uncovered.** I ran the same cap-removal mutation against every
  cap/budget-adjacent prompt test in the repo (10 files, 126 tests). Two tests
  kill it: `guided-discuss-milestone-prompt-rendering.test.ts` "guided milestone
  prompt builder caps prior draft seed before interpolation", and
  `prompt-budget-enforcement.test.ts` "caps the inlined block — roadmap
  survives first, the trailing decisions register truncates". So the 20K test is
  **redundant and vacuous**, not a coverage hole. Closeout should retitle or
  retire it rather than treat `capPreamble` as untested.

## Still open, unowned by any task (recorded, not fixed)

All four re-checked at this base; all unchanged from cycle 3.

1. **INTENT success criterion 3 is not satisfiable as written.** Re-ran the
   static proof here: `Status: BLOCK`, **8 offender files / 12 lines** — 11
   `legacyParserSymbol` hits across `artifact-verification.ts`,
   `doctor-engine-checks.ts`, `markdown-renderer.ts`, `md-importer.ts`,
   `migration-auto-check.ts`, `state-reconciliation/drift/roadmap.ts`,
   `state-reconciliation/drift/sketch-flag.ts`, plus the
   `parsersLegacyImporter` in `state.ts`. Seven of the eight are `Retired by:
   none`. `LEGACY_COUNTERS` still contains no `markdownFallbackUsed`
   (`legacy-cleanup-gate.mjs:10-16`), and with no telemetry file the gate exits
   0 with "No telemetry file provided" rather than proving anything. Needs a
   human ruling before wave 4.
2. **`detectStaleRenders` is a `return []` stub** (`markdown-renderer.ts:1202-1213`,
   with `detectStaleRendersImpl` intact but unreachable) and
   **`detectProjectionDrift` (`:1170`) has no production caller** — confirmed by
   repo-wide grep. Milestone-scope, pre-existing. Do not count
   `repairStaleRenders` as covered.
3. **T020 is unreachable as written** and its arbiter test
   (`src/tests/legacy-cleanup-gate.test.ts:187`, "the live repository proof is
   red") is pinned RED by design and passes only because the proof is BLOCK.
   Wave 4 needs either seven new owning tasks or a `justified-permanent`
   category.
4. **`checkNeedsRunUat`'s `fallbackCandidates` is dead post-cutover** —
   `uat-dispatch.ts:148,173` unchanged; both production callers still pass a
   value provably `[]` whenever the fallback is consulted. Milestone-scope
   cleanup.

## Process finding (blocking for how the wave collects evidence, not for a task)

**`pnpm run build:core` cannot run inside `.worktrees/`, and that is why no
cycle ever ran a suite-level gate.** In this disposable worktree `build:core`
fails at `@gsd/pi-coding-agent` with three `TS2345` errors whose message names
`/Users/jeremymcspadden/github/open-gsd/gsd-pi/packages/pi-coding-agent/dist/…`
— the **primary checkout**. The disposable worktrees are nested inside the repo,
so TypeScript's module resolution walks up out of the worktree and binds
`@gsd/pi-coding-agent` to the primary checkout's `dist`. Proven: with the
worktree's own `packages/pi-coding-agent/dist` removed, resolution leaks to the
primary path; after `rsync --link-dest`-copying the identical tree to a
directory **outside** the repo, `build:core` + `build:web-host` +
`test:compile` all exit 0. **This is environmental, not a branch defect** — the
branch touches exactly one file under `packages/` (`native/src/native.ts`), and
`packages/pi-coding-agent` is untouched since `8ac970e02`, long before the
milestone. All gate results in the table above were measured in the relocated
copy at the same content.

Two other environmental prerequisites the wave's Verify commands never
established, both of which produce *false* failures if skipped:
`pnpm run build:native:test` (without the addon, `gate:lifecycle-shadow-no-cutover`
reports `discard: FAIL` and `test:integration` fails on "native projection root
identity locking is unavailable"), and mirroring `native/addon/*.node` into
`dist-test/native/addon/` as `ci.yml:220` does.

## Summary for orchestrator

**This is cycle 4 of a cap raised to 4. The verdict is `blocked`, so this goes
to the human a second time.** What is different from cycle 3 is worth stating
plainly, because it changes the decision:

- Cycle 3's finding is **fully closed and independently verified** — 16 RED
  tests plus 4 vacuous ones, all green and all proven killable. Both fixes were
  fixture-only with production blobs proven byte-identical by hash. T037 and
  T038 did their jobs exactly.
- The `test:integration` leg the cap was raised to clear **is clear**: 0 fail.
- But `verify:pr` — the milestone's own project verify and INTENT criterion 5 —
  **is red at this base**, in the `test:unit` leg, which no cycle has ever run.
  Five tests, four files, three distinct owners. Two of the five predate cycle
  1 and have been red through every cycle of this review.
- The remaining work is again mechanical (two DB reseeds, one deliberate
  re-expression, ten `logWarning` calls). There is one small judgment call —
  whether #4289 gets reseeded or inverted — and it is the same call T010
  already made once for `idle-recovery`.

- blocked → fix tasks needed (one per disjoint file scope):
  - **T011F4** — scope
    `src/resources/extensions/gsd/tests/dispatch-run-uat-browser-tools.test.ts`,
    `src/resources/extensions/gsd/tests/run-uat-replay-cap.test.ts`.
    Covers 2 RED tests caused by T011's `auto-prompts.ts` change (attribution
    proved by single-file swap to `a27f96189^`). Reseed with DB slice rows as
    T038 did; keep every assertion; prove each failable by mutating
    `auto-prompts.ts`; leave `auto-prompts.ts` at blob `29af5990c…`.
  - **T029F1** — scope
    `src/resources/extensions/gsd/tests/journal-integration.test.ts`.
    Covers 1 RED test caused by T029's `artifact-verification.ts` change
    (attribution proved by four-point file bisect). Either seed the rows that
    make the closeout proof legitimately succeed, or invert it to assert
    fail-closed with the `recovery` warning — state which and why in the Log.
    Do not delete #4289's guard. `artifact-verification.ts` must not change.
  - **T014F1** — scope
    `src/resources/extensions/gsd/commands-maintenance.ts`.
    Covers the `silent-catch-diagnostics` repo-invariant regression: replace
    the ten empty catch bodies T014 introduced with `logWarning`/`logError`.
    Do **not** add the file to `EXEMPT_FILES` — weakening the invariant to get
    green is exactly what the INTENT vetoes forbid.
  - **Wave-level gate before closeout:** `pnpm run verify:pr` end to end, run
    **outside** `.worktrees/` (see Process finding), plus
    `pnpm run test:integration` and `pnpm run test:packages`. Record exit codes.
    Per-file Verify commands have now failed to catch this defect class seven
    times.

- repeat offenders (criteria failing across cycles — plan defect):
  1. **A deleted fallback leaves tests behind — seventh instance.** The root
     cause has now shifted one level: cycle 3 fixed *which files* the sweep
     enumerates, but the sweep is still **import-graph-shaped**. Both new T011
     instances import only `auto-dispatch.ts`; a direct-importer sweep and a
     symbol sweep both miss them, and `silent-catch-diagnostics.test.ts` imports
     nothing from the product at all — it scans the filesystem, so no
     import-based sweep of any depth could ever find it. **The only sound sweep
     is running the legs.** Every remaining deletion task (T020, T021, T022)
     must carry a full-leg run, not an enumeration.
  2. **The wave still has no suite-level gate.** Cycle 3 recommended adding
     `test:integration`; the orchestrator ran it and cleared it, and the wave
     was still red — because `test:unit:compiled` was never run either. Require
     `verify:pr` itself.
  3. **Environmental prerequisites are not part of any Verify.** Three of the
     six gates report false failures without `build:native:test`, the dist-test
     addon mirror, or a non-nested working directory. Any future "gate X is
     red/green" claim from this wave should state which of the three were in
     place.

- warnings worth a human eye:
  1. `verify:pr` red is the headline — INTENT criterion 5 says it must be green
     "at the cutover commit, with `verify:pr` unweakened".
  2. T014's ten silent catches are on the **new restore path**; they are a
     product concern, not only a test concern.
  3. INTENT criterion 3 still not satisfiable as written (unowned item 1) —
     ruling needed before wave 4 dispatch.
  4. The 20K cap test is vacuous but `capPreamble` is covered by two other
     tests — retitle/retire rather than treat as a gap.
  5. T037's test name ("extracts risk, depends, and demo **from roadmap**") now
     describes a path that no longer exists.
  6. Seven `Retired by: none` modules; T020 unreachable (unowned item 3);
     `detectStaleRenders` inert (item 2); `fallbackCandidates` dead (item 4).
