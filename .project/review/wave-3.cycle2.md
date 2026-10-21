# Review — wave 3, cycle 2

Wave verdict: blocked
Cycle: 2
Depth: full
Tasks reviewed: 16

Review base `d60409d1fbc3a3eae41076cb94af03424340e101`, disposable worktree
`.worktrees/gsd-path-review3c2`. All five fix commits were resolved by SHA from
each task's `commit` field and diff-scope-checked: **every fix commit changed
only paths in its own `files` list plus its own task file — zero contract-body
edits, zero out-of-scope paths.** All five Verify commands were re-run here and
exit 0. `baseline:refactor:phase0` is green (34/34 + 139/139).

The four cycle-1 failures are **all genuinely closed** — each was re-checked
against the ORIGINAL criterion by probe, not by reading the fix's own Verify.
Three new blocking findings surfaced: two coverage losses the fixes created or
left behind, and one regression a fix introduced outside its Verify.

---

## T029 — Fail-closed the two branches T010 missed (T010 AC2): **fail**

- ✅ AC1 (the two named branches) — both fail-open branches are gone.
  `execute-task` now logs a `recovery` warning and `return false` at
  `artifact-verification.ts:506-517`; `complete-milestone` fails on any
  `!closeoutProof.ok` at `:553-564`. `hasLegacyCheckedTaskCompletion` has zero
  repo-wide references; `classifyMilestoneSummaryContent` /
  `hasImplementationArtifacts` are no longer imported by the file.
- ✅ AC2 / AC3 — whole-file sweep performed independently (568 lines, every
  `return true` / `isDbAvailable()` site inspected). No branch converts a
  DB-authority fact (task completion, slice completion, milestone closeout)
  into a pass from markdown. The four fail-closed sites are coherent:
  `:324-327`, `:506-517`, `:519-538`, `:553-564`. Both new witnesses in
  `recovery-verify-logs.test.ts` pass (16/16); `integration/idle-recovery.test.ts`
  24/24.
- ❌ AC4 "no regression guard is lost to a deletion"
  found: **six of the seventeen tests in
  `src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts` can no
  longer fail.** `verifyExpectedArtifact` for `unitType === "execute-task"`
  with the DB closed has exactly one reachable outcome — `:352` requires
  `isDbAvailable()`, so control always reaches the unconditional
  `return false` at `:506-517` regardless of any fixture on disk. Probed
  live with an ideal passing fixture (checked `- [x] **T01:` PLAN + both
  sibling and canonical `T01-SUMMARY.md`): result `false`.
  Consequences, each verified:
  1. `:305` `#1500: execute-task accepts SUMMARY in stale sibling flat-phase dir`
     — **tautological, confirmed by probe.** Deleting the
     `writeFileSync(join(staleDir, "S04-T02-SUMMARY.md"), …)` line at `:320`
     leaves the file 17/17 green. The reseed asserts only that a seeded
     settled Attempt verifies; the #1500 subject (sibling-phase-dir SUMMARY
     resolution) is untested. The coder disclosed this in the Log and in an
     in-test caveat at `:328-336` — the disclosure is accurate and is the
     reason this is a finding and not a concealment, but the criterion is
     still unmet.
  2. `:389` `#1500: execute-task does NOT borrow a summary from a
     different-milestone same-phase dir` — `closeDatabase()` at `:390`, no DB
     opened, asserts `false`. Cannot fail; the borrow it guards against is
     unreachable in both directions.
  3. `:165`, `:184`, `:206`, `:218` — the four surviving #3607 negatives
     (unchecked `[ ]`, bare heading, missing plan, wrong task id). Each opens
     `closeDatabase()` and asserts `false`. The file's own header at `:1-13`
     still states its premise: "These tests exercise verifyExpectedArtifact
     directly for execute-task units when the DB is unavailable (legacy
     branch). Only a checked checkbox in the slice plan counts as evidence" —
     that premise is now void, and **nothing in the repo tests checkbox
     discrimination any more.**
  Not vacuous, and correctly retained: `:117` / `:145` (the two inverted
  #3607 tests — they assert the `recovery` warning text, so they pin the new
  behaviour), and `:237` / `:263` / `:280` (DB open, Attempt-readiness is the
  real subject).
  Also dead as a direct result: `allowSiblingTeamSuffixProjections`
  (`artifact-verification.ts:375`, set only for `execute-task`) can no longer
  change any return value — the `findExistingSiblingPhaseArtifact` team-suffix
  fallback at `:173-175` is unreachable for the only unit type that enables it.
  fix: own `src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts`
  plus `src/resources/extensions/gsd/artifact-verification.ts`. (a) Delete the
  four vacuous #3607 negatives at `:165`, `:184`, `:206`, `:218` and the vacuous
  `:389` negative, and rewrite the file header at `:1-13` — they assert a branch
  that no longer exists. (b) Either delete `allowSiblingTeamSuffixProjections`
  and the `allowTeamSuffixProjections` parameter of
  `findExistingSiblingPhaseArtifact` (`:150-185`) as dead code, or, if the
  #1500 sibling-resolution protection must remain real, replace `:305` with a
  direct unit test on `findExistingSiblingPhaseArtifact` /
  `resolveExpectedArtifactPath` that exercises the stale-sibling layout without
  going through `verifyExpectedArtifact`. Do not leave the current fixture
  labelled as a #1500 guard.

- ✅ Reseeds #1703 / #4699 (probe (d)) — **both still assert their original
  subject.** Probed by deleting the implementation evidence from each fixture:
  - `auto-recovery.test.ts:2049` (#1703) — with `src/app.ts` and its commit
    replaced by an empty commit, the test FAILS (85/86). The closeout proof
    carries `implementationEvidence: { requirement: "not-absent" }`
    (`artifact-verification.ts:548-551`), so implementation evidence is still
    load-bearing.
  - `auto-recovery.test.ts:2082` (#4699) — with `src/app.ts` omitted, the test
    FAILS (85/86).
  - The `integration/auto-recovery.test.ts` #1703 twin has the same shape.
  Only the #1500 reseed is tautological.

Warnings (non-blocking):
- **The one remaining markdown-over-DB fallback in the file is `plan-slice`
  (`artifact-verification.ts:443-499`).** When the DB is unavailable — or
  available with zero task rows for the slice, i.e. "a required row is
  absent" — `dbPrimary` stays false, `taskIds` is taken from
  `parseLegacyPlan(planContent)` at `:453`/`:480` gated on a
  `- [x] **T\d+` / `### T\d+` match at `:474-475`, and the function falls
  through to `return true` at `:567`. The `:495` branch is explicitly
  conditioned on `!dbPrimary`. I am passing AC2 on the "content-validation
  parse that makes no authority judgment" carve-out — `plan-slice` asserts
  that a PLAN artifact declares tasks and their artifacts exist, not that
  anything completed — but the carve-out is doing real work here and a wave-4
  reader will not find it obvious. Decide explicitly before T020/T022 whether
  `plan-slice` is in or out of the "no markdown fallback" rule; do not let it
  be swept in silently on the strength of "T029 closed the file".
- Two catches swallow a DB error and fall through to a PASS:
  `:301-303` (`gate-evaluate` — `getPendingGatesForTurn` throwing yields
  `return true` at `:304`) and `:500-502` (`plan-slice`). Neither is markdown-
  derived, both predate wave 3, both are fail-open on DB failure.
- `isClosedStatus` at `artifact-verification.ts:19` is an unused import
  (pre-existing at T029's parent, not introduced here).
- `auto-recovery.test.ts`'s two reseeded tests open a DB in a `try` whose
  `finally` calls `cleanup(base)` without `closeDatabase()` — unlike the
  integration twin, which T029 correctly fixed. The file is green today;
  ordering-sensitive.

## T030 — Closed-status predicate in auto-prompts (T011 AC2): **pass**

- ✅ AC1/AC2 Both sites use the shared guard, no local closed-set literal.
  `isCompletedSliceStatus` (`auto-prompts.ts:1630-1632`) is
  `isClosedStatus(status) && status !== "skipped"`, importing `isClosedStatus`
  from `./status-guards.js` (`:74`); applied at
  `loadRoadmapCompletedSliceCandidates` (`:1684`) and `checkNeedsReassessment`
  (`:1657`). `grep -nE 'status === "complete"'` over the file returns nothing.
  `RAW_CLOSED_STATUSES` (`status-guards.ts:38`) is the same set
  `markdown-renderer.ts:317` renders `[x]` from, so `"done"` and `"closed"`
  rows are candidates again.
- ✅ AC3 Probed: reverting `isCompletedSliceStatus` to `status === "complete"`
  turns two of the three new tests RED
  (`auto-prompts-fallback.test.ts` 8/10). The predicate is genuinely pinned.
- ✅ `hasIncomplete` was correctly widened to `!isClosedStatus(s.status)`
  (`:1658`), matching the checkbox: a milestone whose remaining slices are all
  closed no longer looks incomplete.
- ✅ The DB-unavailable path is now explicit (`:1652`, early `return null` with
  a written rationale) rather than an accidental fall-through.

Warnings (non-blocking):
- `"skipped"` handling is **deliberately not** equivalent to the checkbox.
  Pre-wave-3, `loadRoadmapCompletedSliceCandidates` fed on
  `parseRoadmap(...).slices.filter(s => s.done)`, and the renderer marks
  `skipped` `[x]` — so a skipped slice WAS a run-uat candidate and now is not.
  Cycle 1's own fix direction prescribed the exclusion and T030 AC1 encodes it,
  so this is an accepted narrowing, not a defect — but it is a live dispatch
  behaviour change against pre-migration semantics and is worth stating once in
  the milestone record rather than discovering later.

## T011 residue — reassess/UAT dispatch is RED at the review base: **fail**

This is not owned by any task. It is a wave-3 regression cycle 1 marked pass
without running the files.

- ❌ T011 AC3 "No surviving test asserts markdown-fallback behaviour for these
  surfaces" and AC4 (suite green)
  found: three tests are RED at review base, in two files neither T011 nor T030
  listed:
  - `src/resources/extensions/gsd/tests/reassess-detection.test.ts:77`
    "checkNeedsReassessment returns sliceId when assessment is missing" —
    `actual: null, expected: { sliceId: 'S01' }`.
  - `src/resources/extensions/gsd/tests/reassess-detection.test.ts:113`
    "checkNeedsReassessment detects assessment written after initial cache
    population" — the #1112 cache-race regression guard —
    `actual: null, expected: { sliceId: 'S01' }`.
  - `src/resources/extensions/gsd/tests/uat-dispatch.test.ts:118`
    "auto-prompts keeps the compatibility checkNeedsRunUat wrapper" —
    `actual: null, expected: { sliceId: 'S01', uatType: 'human-experience' }`.
  Attribution established by swapping `auto-prompts.ts` alone at three points
  and re-running:
  - pre-wave-3 (`a27f96189^`): reassess 5/5 green, uat-dispatch 5/5 green.
  - post-T011 / pre-T030 (`942d048d7`): reassess 3/5, uat-dispatch 4/5.
  - review base: identical to post-T011.
  So **T011 broke them and T030 neither fixed nor worsened them.** All three
  fixtures are markdown-only (`writeRoadmap` + `writeSummary`, no DB), so the
  removed roadmap-checkbox fallback is exactly what they asserted.
  Additionally the three still-green tests in `reassess-detection.test.ts`
  (`:60`, `:94`, `:141`) are now **vacuous** — they assert `null`, and
  `checkNeedsReassessment` returns `null` unconditionally without a DB
  (`auto-prompts.ts:1652`). The whole file tests nothing.
  fix: own `src/resources/extensions/gsd/tests/reassess-detection.test.ts` and
  `src/resources/extensions/gsd/tests/uat-dispatch.test.ts`. Reseed all five
  reassess fixtures and the `:118` uat fixture with a DB (`openDatabase`,
  `insertMilestone`, `insertSlice` with S01 `complete`/S02 `pending`) so they
  exercise the DB path they now depend on, keeping the #1112 cache-race
  assertion at `:113` intact — that guard must survive, it is the only coverage
  of the post-write cache staleness fallback. Add a `closeDatabase()`
  teardown. Do not delete the positive assertions: the behaviour they protect
  (reassess/run-uat still dispatch) is still required, only its source of truth
  moved.

## T031 — Revert the unsound stamp short-circuit (T013 AC2): **pass**

- ✅ AC1 `projectionIsStampFresh` and `renderPathIsStampFresh` are gone;
  `grep -rn "getCurrentProjectStateVersion" state-reconciliation/drift/` is
  empty. `drift/roadmap.ts:46-52` and `drift/stale-render.ts:38-41` carry
  explanatory comments recording why a stamp is not a freshness signal.
  `milestoneHasDivergence` (`roadmap.ts:53-90`) parses and compares on every
  call. `detectStaleRenderDriftFromBasePath` (`stale-render.ts:42`) applies no
  filter.
- ✅ AC2 The forged-stamp no-drift test is deleted. The replacement inverse pin
  is real — **probed (b):** re-introducing the short-circuit into
  `milestoneHasDivergence` (read content → `readProjectionStateVersion` →
  compare to `getCurrentProjectStateVersion()` → `return false`) turns
  `state-reconciliation-drift.test.ts` RED on exactly the new test,
  "T031: a roadmap stamped with the CURRENT state version still reports
  diverging content as drift" (62/63). The pin asserts both halves — a
  `roadmap-divergence` record IS repaired, and the file is re-rendered from DB
  `depends:[]`. No remaining test asserts that a current-stamp diverging
  projection is drift-free.
- ✅ AC3 Zero `parsers-legacy` references under `state-reconciliation/drift/`;
  `roadmap.ts:17` and `sketch-flag.ts:18` still import from
  `../../schemas/parsers.js`. T013's re-homing is intact.
- ✅ AC4 `state-reconciliation-drift.test.ts` + `roadmap-slices.test.ts`:
  93 tests / 89 pass / 0 fail / 4 skipped. `markdown-renderer.test.ts`,
  `projection-fidelity.test.ts`, `artifact-db-drift-memo.test.ts`,
  `integration/integration-proof.test.ts` all green here too.

## T032 — Route `/gsd db restore-backup` (T014 AC1): **fail**

- ✅ AC1/AC2/AC3, and **the original T014 AC1 now holds: the command is
  reachable end to end.** Probed through the full dispatcher, not just
  `handleOpsCommand`: `handleGSDCommand("db restore-backup", ctx, pi)` on a
  real git+`.gsd` fixture produced the handler's own output
  (`"gsd db restore-backup: no gsd.db.backup-v* candidates found beside
  …/.gsd/gsd.db"`, level `info`) and never fell through to
  `Unknown: /gsd …`. The three pre-handler guards do not block it:
  `db` is absent from `VALIDATION_BLOCKED_COMMANDS`
  (`validation-block-guard.ts:25`) and from `BLOCKED_COMMANDS`
  (`unmerged-milestone-guard.ts:34`), and no earlier handler in
  `dispatcher.ts:48-55` claims the string. Argument remainder survives the
  prefix trim (`ops.ts:143`).
- ❌ **Regression: `src/resources/extensions/gsd/tests/help-menu-coverage.test.ts`
  is RED at the review base**, caused by this commit.
  found: `every TOP_LEVEL_SUBCOMMAND appears in showHelp("full") output` fails
  with `Commands registered in TOP_LEVEL_SUBCOMMANDS but missing from
  /gsd help full: ['db']`. T032 added `{ cmd: "db", … }` to
  `commands/catalog.ts:51`, but the `/gsd help full` body is hand-written in
  `commands/handlers/core.ts:100-174` and its generated tail
  (`buildAdditionalCommandsHelpLines`, `:183-196`) is built from
  `GSD_CORE_IMPLEMENTED_CATALOG` / `GSD_CORE_ALIAS_CATALOG`, **not** from
  `TOP_LEVEL_SUBCOMMANDS`. The test was green before this commit (`db` was not
  in the catalog). `core.ts` was outside T032's `files`, so the coder could not
  have fixed it — same plan-defect shape as T014 itself.
  fix: new task owning `src/resources/extensions/gsd/commands/handlers/core.ts`.
  Add one line to the `fullLines` maintenance block beside `/gsd rebuild` /
  `/gsd recover` (`core.ts:159-162`), e.g.
  `"  /gsd db restore-backup  List or restore a verified pre-migration database backup (destructive)"`,
  and re-run `help-menu-coverage.test.ts`. No other file needs touching.

## T033 — Re-key proof and registry on parser symbols: **pass**

- ✅ AC1/AC4 `node scripts/legacy-state-path-proof.mjs` → `Status: BLOCK`,
  exit 2, **8 offender files / 12 offender lines**, exactly as the Log claims
  (7 `legacyParserSymbol` modules + `state.ts:25` shim import). Re-run live
  here. Greenness was not engineered away.
- ✅ AC2 Side-effect (`import './parsers-legacy.js';`) and own-line specifier
  forms are detected — `PARSERS_LEGACY_SPECIFIER_RE`
  (`legacy-state-path-proof.mjs:29`) matches the specifier in any string
  literal. Block comments no longer false-positive.
  **The comment-stripper creates zero false negatives in this tree — measured,
  not asserted.** I ran the ban regex over raw lines and over
  `stripComments` output for every scanned file and diffed: exactly 5 lines
  are suppressed, and all 5 are genuine comments —
  `artifact-verification.ts:69` (JSDoc prose), `doctor-engine-checks.ts:145`
  (`//` prose), `parsers-legacy.ts:20`, `schemas/parsers.ts:8` (prose), and
  `markdown-renderer.ts:1233`. **The `:1233` judgement is correct**: it sits
  inside the `/* … */` block that comments out the roadmap-checkbox arm of
  `detectStaleRendersImpl` (opened at `markdown-renderer.ts:1230`, under the
  `TODO(flat-phase)` at `:1203`). It is not executing code, and un-commenting
  it would restore the offender report.
- ✅ AC3 Proof and registry agree by construction and in fact: the registry's
  `ALLOWED_IMPORTERS` (`parsers-legacy-importers.test.ts:65-82`) lists the same
  8 files, `gsd/state.ts` keeps its `T022` justification and the other seven
  each carry `Retired by: none`. `BANNED_DECISION_PATHS` byte-unchanged
  (15 entries). `SELF_PATHS` mirrors the proof's two exemptions.
- ✅ AC5 `parsers-legacy-importers.test.ts` + `src/tests/legacy-cleanup-gate.test.ts`
  → 22/22 with `backup-restore-command.test.ts` and the routing test.
- ✅ `legacy:cleanup:gate` fails closed with no telemetry file (exit 1,
  "No telemetry file provided") — T015's AC1 still holds.

Warnings (non-blocking — these decide what wave 4 can honestly claim):
- **The proof is still satisfiable by one more rename, and only the new
  live-repo test stops it.** `LEGACY_PARSER_HOME` (`gsd/schemas/parsers.ts`) is
  exempt from symbol matching (`legacy-state-path-proof.mjs:39`, `:183`).
  Probed on a synthetic root: adding
  `export const parseProjectionRoadmap = parseLegacyRoadmap;` to
  `schemas/parsers.ts` and switching one consumer to the alias yields
  `Status: PASS` while the identical legacy parse runs. The exemption is
  necessary (the declaration site cannot be its own offender), so this hole is
  structural. The mitigation works — `legacy-cleanup-gate.test.ts:187`
  asserts `result.ok === false` on the live repo, so an aliasing rename turns
  that test RED rather than the gate green. Claim verified.
- **That tripwire is also a future blocker nobody owns.**
  `legacy-cleanup-gate.test.ts:187` "the live repository proof is red" REQUIRES
  the proof to stay BLOCK. The moment wave 4 legitimately clears the offenders,
  that test fails and must be deleted or inverted. No task's `files` includes
  `src/tests/legacy-cleanup-gate.test.ts` except T033. Put it in T020's scope.
- The live-repo test scans `process.cwd()`; run from any other directory the
  scan dir is missing, offenders are zero, and the test fails for the wrong
  reason.

## T010, T012, T013, T014, T015, T016, T017, T018, T019, T028: **pass (regression-checked)**

Unchanged from cycle 1 except where the fixes touched them; cycle-1 verdicts
re-confirmed at this base for every surface a fix could have disturbed.
`reactive-graph.test.ts`, `visualizer-data.test.ts`,
`visualizer-critical-path.test.ts`, `md-importer.test.ts`,
`migration-auto-check.test.ts`, `roadmap-parse-regression.test.ts`,
`reassess-roadmap-domain-operation.test.ts`, `doctor-scope-db-unavailable.test.ts`,
`doctor-providers.test.ts`, `backup-restore-command.test.ts`,
`legacy-import-restore-assessment.test.ts`, `zero-slice-roadmap-guided.test.ts`
→ 159/159 + 93/93. T013's remaining live risk is the `detectStaleRenders` stub,
recorded below as an unowned item rather than as a T013 failure — T031 removed
the dead filter over it, which was the actionable half.

---

## Fixed since last cycle

- **T010 AC2** (fail-open `execute-task` markdown checkbox at old `:524-528`,
  and `complete-milestone` SUMMARY rescue at old `:566-568`) — confirmed fixed.
  Both branches now log a `recovery` warning and `return false`
  (`artifact-verification.ts:506-517`, `:553-564`); the checkbox helper and its
  `escapeRegExp` are deleted with zero repo-wide references remaining; the two
  new DB-unavailable witnesses in `recovery-verify-logs.test.ts` pass. Whole-file
  sweep found no further branch that turns a DB-authority fact into a pass.
- **T011 AC2** (closed-status predicate) — confirmed fixed at BOTH sites for
  `"done"` and `"closed"`; probed regression-sensitive. `"skipped"` is
  deliberately excluded, per cycle 1's own prescription (warning above).
  **Not fixed, and newly found:** the same T011 change left three tests RED
  (see the T011-residue section) — a cycle-1 miss, not a regression from T030.
- **T013 AC2** (unsound stamp short-circuit) — confirmed reverted at both
  detectors, forged-stamp test deleted, replacement pin probed and it genuinely
  fails when the short-circuit is re-introduced, `schemas/parsers.js` re-homing
  intact.
- **T014 AC1** (`/gsd db restore-backup` unreachable) — confirmed reachable end
  to end through `handleGSDCommand`, past all three pre-handler guards.
  **Regression introduced:** `help-menu-coverage.test.ts` is now RED.
- **Cycle-1 warning 1** (proof keys on the specifier) — confirmed addressed;
  the proof is honestly red with 8 files, and the rename escape is closed by a
  live-repo tripwire (verified).
- **Cycle-1 warning 2 is REFUTED on its central claim.** `legacy:cleanup:evidence`
  DOES have a real telemetry producer: `legacy-telemetry.ts:44`
  `process.once("beforeExit", persistLegacyTelemetry)` writes the report from
  any process that loads the module with `GSD_LEGACY_TELEMETRY_FILE` set, and
  `baseline:refactor:gate` loads it transitively. Measured live: with the env
  var set, `node scripts/legacy-cleanup-evidence.mjs` wrote a fresh report
  (`ts` 2026-08-06T18:18:07Z, all five counters 0) and the gate consumed it —
  it exited 2 solely because of the static proof, not for missing telemetry.
  See the unowned-items section for what this does and does not prove.

## Still open, unowned by any task (assessed, not fixed)

1. **INTENT success criterion 3 is NOT satisfiable as written in this
   milestone.** Two independent reasons, both measured:
   - `legacy:cleanup:gate` composes the static proof, and the proof is red
     with 8 offender files. Seven of the eight carry `Retired by: none` in
     `parsers-legacy-importers.test.ts:70-81`. **No task in the plan owns
     re-homing or deleting them** (T020 owns only `parsers-legacy.ts` + the
     registry; T022 owns `_deriveStateImpl`). Until they are owned, both
     `legacy:cleanup:gate` and `legacy:cleanup:evidence` are BLOCK by design,
     as the user accepted when ruling on T033.
   - Even once green, the telemetry half does not demonstrate what criterion 3
     claims. The five `LEGACY_COUNTERS` are `workflowEngineUsed`,
     `uokFallbackUsed`, `mcpAliasUsed`, `componentFormatUsed`,
     `providerDefaultUsed` (`legacy-cleanup-gate.mjs:10-16`) — **none of them
     instruments the legacy filesystem-state read path this milestone deletes**,
     and SYNTHESIS ruled that no `markdownFallbackUsed` counter would be built.
     The report is also written unconditionally on `beforeExit` whether or not
     any legacy path was exercised, so all-zero counters are guaranteed by
     construction for any process that merely imports the module. The gate
     never validates that the run touched a legacy path. Criterion 3's
     "telemetry/tests demonstrate the legacy filesystem-state path is unused"
     is therefore carried entirely by the static proof; the telemetry leg is
     decorative. Recommend the final review record criterion 3 as met-by-proof
     or restate it, rather than treating a green counter block as evidence.
2. **Two of SYNTHESIS's three promised positive post-cutover checks are inert.**
   `detectStaleRenders` (`markdown-renderer.ts:1202-1212`) is `return []` with
   a `TODO(flat-phase)`; the real body `detectStaleRendersImpl` (`:1214`) has
   zero callers. `detectProjectionDrift` (`:1170`) has zero production callers
   repo-wide (`grep -rn detectProjectionDrift src packages` outside tests
   returns only its own declaration). So the entire `stale-render` drift
   handler — detect, dedupe, repair dispatcher, blocker, and the legacy
   `repairStaleRenders` bulk entry — runs over a constant empty array in
   production. T031 correctly removed the dead stamp filter over it, but the
   underlying inertness is untouched and out of every task's scope. Whatever
   wave 4 claims as the successor to the retired `semantic-shadow-no-cutover`
   gate (INTENT criterion 2, "an explicit post-cutover home as a runnable
   check") must not count these two.
3. **The seven `Retired by: none` modules make wave-4 T020 unreachable as
   written.** T020 Step 2/Step 5 use the registry and the proof as arbiters and
   both now report 8 offenders. T020 also has no `files` entry for
   `src/tests/legacy-cleanup-gate.test.ts`, whose new live-repo test hard-pins
   the proof RED — so even a hypothetical wave-4 pass that cleared all eight
   offenders would leave that test failing. T020 needs, before dispatch:
   (a) a decision per module (artifact-verification, doctor-engine-checks,
   markdown-renderer, md-importer, migration-auto-check, drift/roadmap,
   drift/sketch-flag) on whether it is a legitimate permanent markdown parser
   — md-importer and migration-auto-check plainly are, by design — and if so a
   `justified-permanent` category in both the registry and the proof so
   "offender" stops meaning two different things; and (b) ownership of
   `legacy-cleanup-gate.test.ts:187`.

---

## Summary for orchestrator

- blocked → fix tasks needed (one per disjoint file scope):
  - **T029F2** — scope
    `src/resources/extensions/gsd/tests/verify-artifact-tightened.test.ts` and
    `src/resources/extensions/gsd/artifact-verification.ts`. Covers: six tests
    that can no longer fail (`:165`, `:184`, `:206`, `:218`, `:305`, `:389`)
    because DB-closed `execute-task` verification is unconditionally `false`
    (`artifact-verification.ts:352` + `:506-517`, probed); the void file header
    at `:1-13`; and the now-dead `allowSiblingTeamSuffixProjections`
    (`:375`) / `findExistingSiblingPhaseArtifact(..., allowTeamSuffixProjections)`
    (`:150-185`). Either restore the #1500 sibling-resolution guard as a direct
    resolver test or delete the fallback — do not leave a fixture labelled as a
    guard it does not provide.
  - **T030F2** — scope
    `src/resources/extensions/gsd/tests/reassess-detection.test.ts` and
    `src/resources/extensions/gsd/tests/uat-dispatch.test.ts`. Covers: three
    RED tests (`reassess-detection.test.ts:77`, `:113`,
    `uat-dispatch.test.ts:118`) and two more vacuous ones (`:60`, `:94`,
    `:141` all assert `null` against a null-returning function). Reseed with DB
    rows; the #1112 cache-race assertion at `:113` must survive. Attribution is
    T011, verified by three-point bisect of `auto-prompts.ts`.
  - **T032F2** — scope
    `src/resources/extensions/gsd/commands/handlers/core.ts`. Covers: one line
    in the `/gsd help full` maintenance block so
    `help-menu-coverage.test.ts` goes green again after T032 added `db` to
    `TOP_LEVEL_SUBCOMMANDS`.

- repeat offenders (criteria failing across cycles — plan defect):
  1. **A deleted fallback leaves behind tests that now assert nothing.** Cycle 1
     found this once (idle-recovery "lenient"); cycle 2 finds it three more
     times, in three different files, from two different tasks. The tests do
     not go red — they go *unfailable*, so no Verify and no orchestrator rerun
     can see them. Every remaining deletion task (T020, T021, T022) must carry
     an explicit step: "for each deleted branch, list the tests that reached it,
     and for each one state whether it still discriminates — prove it by
     mutating the fixture, not by observing green."
  2. **Fix-task `files` lists keep omitting the file the change actually
     breaks.** T014 → `ops.ts`/`catalog.ts` (cycle 1); T029 → `auto-recovery.test.ts`
     (mid-task block); T032 → `core.ts` (this cycle). Three instances. Scope a
     fix task from the *consumers* of the symbol being changed, not from the
     symbol's own file.

- warnings worth a human eye:
  1. INTENT criterion 3 is not satisfiable as written — see unowned item 1.
     Needs a ruling before wave 4 is dispatched, not after.
  2. Seven production modules parse legacy markdown with `Retired by: none` and
     no owning task; T020 is unreachable and its arbiter test is itself pinned
     red. Needs a `justified-permanent` category or seven new tasks.
  3. `detectStaleRenders` / `detectProjectionDrift` are inert; do not count them
     toward INTENT criterion 2.
  4. `plan-slice` (`artifact-verification.ts:443-499`) is the last
     markdown-over-DB fallback in that file; passed here on the
     content-validation carve-out, but decide it explicitly.
  5. `"skipped"` slices are no longer run-uat candidates (T030), a deliberate
     divergence from the roadmap checkbox that pre-migration behaviour had.
  6. The `base` SHA recorded in T030–T033 (`ac2717d34…`) is not the actual
     parent of any of those commits (parents are `f3bb4ca2f`, `99358785a`,
     `417c10006`, `ecd2e8136` respectively — the fix tasks were built
     sequentially, not from a common base). Product content is unaffected and
     every Verify was re-run at the review base, but the field is inaccurate
     and a future reviewer following the contract literally would apply the
     wrong patch.
  7. Cycle 1's warnings 3–6 (ADR blockquote rendering, known issue (c) refuted,
     known issue (d) role breach, stale inventory rows in
     `state-db-cutover-parsers-legacy-inventory.md:35`) are all still open and
     unowned; none is blocking.
