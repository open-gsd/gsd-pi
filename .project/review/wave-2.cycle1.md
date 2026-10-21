# Review — wave 2, cycle 1

Wave verdict: blocked
Cycle: 1
Tasks reviewed: 8

Verification environment (disposable worktree `.worktrees/review-wave-2`, per
task: checkout declared base, apply `commit^..commit` restricted to declared
product files, run task Verify there): `pnpm install --frozen-lockfile
--ignore-scripts` once; `pnpm run build:native:dev` + `build:native:test`
(fault-injection addon) built once; workspace package dists built as coders
documented. All SHAs verified valid (`git cat-file -t` = commit). Every product
commit's `--name-status` touches only declared `files` + its own task file;
every task-file diff inside a product commit is append-only Log lines (frontmatter
status/commit fields and Log entries only — no contract-body edits). The T005
planner contract-repair landed in orchestrator bookkeeping commits 50f88d435 /
d8b9784ce (task file + PLAN/check script only), not in T005's product commit —
not flagged, per the documented exception.

## T024 — @opengsd/contracts source redirect (35c4157a on base ff77ea38): pass

- ✅ Both resolve hooks redirect `@opengsd/contracts`; no other behavior changes — `dist-redirect.mjs` (exact + `dist/index.js` + subpath branches) and `dist-test-resolve.mjs` (`'contracts'` in WORKSPACE_ENTRIES/BUILT_PACKAGE_ENTRIES, `'@opengsd'` scope) confirmed in the applied patch; commit touches only the 3 declared files.
- ✅ `packages/contracts/dist` absent: `baseline:refactor:gate` executes (prompt-golden Phase-2 test name present, zero `ERR_MODULE_NOT_FOUND`) and `gate:semantic-shadow-no-cutover` runs Structural 8/8, Behavioral 14/15 — observed in the rerun (`/tmp` logs, GREPS-OK/GATE-LEG-OK/WITNESS-LEG-OK).
- ✅ Baseline doc `## Re-run after T024 contracts redirect` section records per-gate evidence, assigns both surviving red legs to T025 (6 mentions), and records the compiled-tier spot check (`.project/plan/wave1-gate-baseline.md`).
- ✅ No fixture/builder/gate-script/package.json changes — `--name-status`: dist-redirect.mjs, dist-test-resolve.mjs, wave1-gate-baseline.md, task file only.

Warnings (non-blocking):
- Verify greps are execution-proof-by-proxy (test-name substring), but I observed the full gate output; adequate.

## T025 — Re-baseline gates (dd330463 on base c6935a65): pass

- ✅ Leg 1 = evidence-backed reference update only: `phase2StartChars` 15400 → 15900 with old/new + both-SHA rendered-char rationale in the fixture comment (`src/tests/fixtures/prompt-golden-fixtures.ts:38-46`); 0.6 factor and gate logic untouched (no test-logic/builder change in the diff).
- ✅ Leg 2: loader prefers a present local addon (`packages/native/src/native.ts:29-69`); rerun at base+patch: `build:native:dev` OK, `baseline:refactor:gate` exit 0, `baseline:refactor:phase0` exit 0, `gate:semantic-shadow-no-cutover` exit 0 (Structural 8/8, Behavioral 15/15 incl. discard); `managed-projection-history.ts` not modified — fail-closed policy unchanged, no witness skipped.
- ✅ `.project/plan/wave2-gate-baseline.md` carries `VERDICT: BASELINE GREEN`; legacy probe semantics verified live: zero-counters file exit 0, nonexistent file exit 1 (ENOENT); no verify:pr weakening anywhere in the diff (no script/threshold changes).
- ✅ T015 fabrication-reachability flag recorded (`wave2-gate-baseline.md:107-114`).

Warnings (non-blocking): none.

## T005 — DB version stamps + refuse-newer + legacy-import realignment (92ce63b2 on base d8b9784c): pass

- ✅ `SCHEMA_VERSION = 46`; `applyMigrationV46StateCutoverStamp` wired (`db/engine.ts:501,772`) stamping application_id + user_version on migrated and fresh DBs; V46 adds no tables (diff shows stamp-only migration step).
- ✅ Typed `SchemaTooNewError` thrown at the refuse-newer site; `openWorkflowDatabase` maps it to `reason: "schema-too-new"` with the error attached (`db-workspace.ts`); other failures keep `open-failed` (diff scoped to the catch branch).
- ✅ Newer-schema CLI refusal verified by the rerun: `headless-query-db-open.test.ts` / `read-cli-schema-too-new.test.ts` green (exact engine message, non-zero exit); DB-unavailable fixture keeps degraded path.
- ✅ No consumer outside the files list changed — `--name-status` all within declared files + corpus dir + task file; the five TS2322 files correctly untouched (they compile once the pin is 46).
- ✅ `pnpm run baseline:refactor:phase0` exit 0 at base+patch; `single-writer-invariant.test.ts` untouched.
- ✅ `pnpm run typecheck:extensions` exit 0 with `SCHEMA_VERSION = 46`.
- ✅ Corpus realigned: all 26 oracle.json `base_database_schema_version = 46` (scripted check, zero deviations); db-target-matrix has historical-v45 / current-v46 / future-v47 (historical-v44 deleted); Verify rerun 150/150 tests + 4 greps green.

Warnings (non-blocking):
- The V46 bump's stale-literal fallout escaped this task's latitude clause in two non-legacy-import files (see T009 AC5) — same defect class T026 repaired for restore-assessment; the schema-version-sensitive test inventory was incomplete.

## T006 — Cutover op + wedge fix + write-side skew protections (ffc8fca6 on base d5ad1524): pass

- ✅ Cutover op records `filesystemStateAuthority: "db"` (`project-authority-cutover-domain-operation.ts:135,552-559`), entry contention check via `assertStartupExclusiveOwnership` (`:621,652-661`) raising `PROJECT_AUTHORITY_CUTOVER_WRITER_CONTENTION`; `migrateToExternalState` calls `recoverFailedMigration` at entry (`migrate-external.ts:53`) so stale `.gsd.migrating` never blocks retry.
- ✅ `src/cli.ts:286` graph subcommand refuses `schema-too-new` with the exact message (build: no graph.json written; read-only subcommands warn); `src/headless-recover.ts:203` forwards the exact refuse-newer message for that reason only.
- ✅ Rollback + idempotent replay + loud epoch/key refusal covered in the new filesystem-state test file; legacy files not deleted — Verify rerun 27/27 green across the four declared test files.
- ✅ `pnpm run baseline:refactor:phase0` exit 0 at base+patch; no single-writer or D005 read-authority changes (diff scoped to the 8 declared files).

Warnings (non-blocking):
- Worktree-local package builds needed before the Verify (documented in the task Log); `build:pi-coding-agent` fails in nested disposable worktrees from a pre-existing self-resolution quirk — environmental, not this task's code.

## T007 — Derive-seam authority flip (6da17d40 on base 95bc1a5d): pass

- ✅ Post-cutover DB-authority proven by the new test: projection edits on disk leave derived state byte-identical (`derive-seam-authority.test.ts:108`).
- ✅ DB-unavailable fails closed; fs-read spy proves no markdown projection (STATE/ROADMAP/PLAN/SUMMARY/CONTEXT/REQUIREMENTS) is opened on the live path (`derive-seam-authority.test.ts:150,185-226`); no live markdown fallback exists to remove (audit confirmed by coder; my diff inspection: `state.ts`/`from-db.ts` changes are comment-only).
- ✅ `single-writer-invariant.test.ts` passes unweakened (file not modified); `handleAllSlicesDone`/validation-verdict untouched — Verify rerun 48/48 green (45 baseline + 3 new).
- ✅ No `markdownFallbackUsed`-class counter added (grep: 0 hits in both touched sources).

Warnings (non-blocking):
- Acceptance read as satisfied with comment-only production edits because the flip was already mechanical at `state/derive/index.ts` — reasonable satisfied reading; criterion wording could be tighter about what "make the flip real" requires.

## T026 — Restore-assessment future-schema fix (13e9bae1 on base 95bc1a5d): pass

- ✅ Test file runs 15/15 green incl. "unsupported database schema refuses before backup inspection" — rerun with `NODE_OPTIONS=--test-reporter=tap`: `# pass 15`, `# fail 0`.
- ✅ Simulation expressed as `SCHEMA_VERSION + 1` (grep confirmed in the test file).
- ✅ Diff touches only `legacy-import-restore-assessment.test.ts` (+ task file Log).

Warnings (non-blocking): none.

## T008 — Renderer stamp + DB-read merge paths (bb0ada2a on base 37aedafb): pass

- ✅ Every rendered projection carries `<!-- gsd:state-version=R:E -->` via `stampProjectionContent` (`markdown-renderer.ts:166-167,266`); byte-compat pinned by the diff test (frozen pre-stamp bytes + one stamp line) — Verify rerun 29 pass / 0 fail / 10 skips.
- ✅ Plan-checkbox stale check no longer parses the PLAN file (DB-vs-render-intent via `detectProjectionDrift`, `:1170`); only pre-existing `parseRoadmap` parsers-legacy import remains (`:52`), no new import.
- ✅ `projection-fidelity.test.ts` green: stamps match DB revision/epoch, content tamper detected, stamp-only diff not drift.
- ✅ `renderAllFromDb` / `roadmapRenderMarksSliceDone` / `detectStaleRenders` signatures unchanged for callers (diff inspection).

Warnings (non-blocking):
- 10 runtime skips in `markdown-renderer.test.ts` are pre-existing (12 static skip markers in the file both before and after the patch — not introduced here).
- The stamp changed rendered bytes repo-wide; fallout escaped this task's files list in two unowned test files (see T009 AC5): `gsd-rebuild.test.ts:160` expects unstamped bytes; `migrate-safety-audit.test.ts:4560` trips "conflicting canonical projection representations" (both green at T008's base, red at HEAD — confirmed by re-running both at base 37aedafb).

## T009 — Gate split-retire + verify:pr wiring (3a627dd5 on base a4184853): fail

- ✅ AC1: `scripts/lifecycle-shadow-no-cutover-gate.mjs` exists and passes — at base+patch: Structural 8/8, Behavioral 15/15, exit 0; again at HEAD ede084ce5: exit 0, 8/8 + 15/15. Full structural/witness mapping enumerated in the task Log.
- ✅ AC2: all four timeboxed witnesses carry the `// ADR-046 timebox: delete after 2 stable releases + >=60 days post-cutover release (T021)` comment (4 grep hits) and run (15/15 = 11 lifecycle + 4 timeboxed).
- ✅ AC3: `verify:pr` = `build:core && typecheck:extensions && test:unit && gate:lifecycle-shadow-no-cutover` (successor appended, nothing else altered); old gate script deleted and its package.json entry gone (zero `semantic-shadow` hits in package.json).
- ✅ AC4: `tests/semantic-shadow-no-cutover.test.ts` no longer imports the deleted gate script; the five behavioral witness tests pass by title (5/5 rerun at base+patch).
- ❌ AC5 (`pnpm run verify:pr` green at the task commit) — found: red at the task commit (checked at HEAD ede084ce5 = 3a627dd5 + its two bookkeeping descendants). I ran every verify:pr leg in the disposable worktree: `build:core` all steps exit 0 (pi-coding-agent required a documented nested-worktree self-resolution workaround — environmental), `typecheck:extensions` exit 0, `test:compile` exit 0, `gate:lifecycle-shadow-no-cutover` exit 0, and `test:unit:compiled` executed in full (all 13 globs, 1177 files, run in 9 chunks under the 300s execution cap with CI's addon mirror `dist-test/native/addon` + `GSD_NATIVE_PREFER_LOCAL=1`). Deterministic isolated-red tests at the task commit:
  - `db-authority-recovery-schema.test.ts:256` — "a fresh v45 database exposes the minimum authority recovery receipts" and "a genuine v44 migration backs up, rolls back on fault, and retries without data loss" (`assert.equal(SCHEMA_VERSION, 45)` vs 46 — T005 V46 fallout; file unowned by any wave-2 task).
  - `db-lifecycle-foundation.test.ts:501` — "v40 upgrade authorizes Slice cancellation in both Attempt settlement triggers" (expects `databaseSchemaVersion`/`runtimeSchemaVersion` 45, got 46 — same T005 fallout; sibling v42/v43 tests in this file also fail 46!==45 under full-run load, passing in isolation).
  - `gsd-rebuild.test.ts:160` — "handleRebuild re-renders missing task summary projections from DB" (expects unstamped bytes `# T01 Summary\n\nRendered from DB.\n`, actual carries `<!-- gsd:state-version=0:0 -->` — T008 stamp fallout; green at T008's base, confirmed).
  - `migrate-safety-audit.test.ts:4560` — "managed-output history removes artifacts rendered between migration attempts" ("conflicting canonical projection representations at milestones/M001/M001-CONTEXT.md", `migrate/audit.js:299` — T008 stamp-era fallout; green at T008's base, confirmed).
  None of these is caused by T009's diff (they fail identically at its base; T009 touches only scripts/, package.json, one test file), but AC5's text requires a green verify:pr at the task commit and it is not green.
  fix: wave-2 repair task (T026 pattern) realigning the stale expectations: v45 literals → `SCHEMA_VERSION`-relative in `db-authority-recovery-schema.test.ts` and `db-lifecycle-foundation.test.ts` (incl. the v42/v43 load-sensitive assertions); stamp-aware byte expectations in `gsd-rebuild.test.ts`; and reconcile stamped re-renders with the migrate audit's canonical-representation check in `migrate-safety-audit.test.ts` (either stamp-insensitive comparison or expectation update). Alternatively the planner explicitly re-scopes verify:pr redness ownership to a named wave-3 task and loosens AC5's wording — but as written it fails.

Warnings (non-blocking):
- Flag (a) CONFIRMED REAL but criterion-neutral: `scripts/m003-s07-dossier-input.ts:21` and `scripts/__tests__/m003-s07-dossier-input.test.ts:16` still import the deleted `scripts/semantic-shadow-no-cutover-gate.mjs`. Verified unreachable by every verify:pr leg: `tsconfig.extensions.json` includes only `src/resources/extensions` + `extensions`; root `tsconfig.json` includes only `src` (scripts/ excluded); `test:compile` is an esbuild per-file transform (no import resolution — stays green); `test:unit:compiled` globs cover only `dist-test/src/**`, never `dist-test/scripts/**`. Defeats no T009 criterion, but it is a live landmine: running `scripts/m003-s07-cutover-dossier.mjs` or its `.mjs` test crashes on the missing module. Recommend a follow-up (fits T021's retirement scope).
- Flag (b): full verify:pr executed as decisive legs (budget) — exactly what was run is recorded under AC5; nothing was skipped except a single-invocation end-to-end run (300s cap), replaced by complete per-glob coverage.
- Environmental reds observed and excluded from all verdicts, with proof: `read-cli-args.test.ts` "runReadCli handles global flags before read" fails only because the machine-global stale `~/.gsd/agent/extensions/gsd` bundle (SCHEMA_VERSION=45, no SchemaTooNewError) is picked up by `shouldUseAgentExtensionsDir` — green with an isolated `GSD_HOME`; ~111 compiled-tier native-lock failures occur only without CI's `dist-test/native/addon` mirror + `GSD_NATIVE_PREFER_LOCAL=1`; 24 fault-injection failures occur only with the dev (non-test) addon; `workflow-authority-baseline.test.ts` "controlled sabotage" flaked once under chunk load (green 3/3 in isolation with and without overrides).

Contract violations (blocking): none in any task — all commits confined to declared files + task file; task-file diffs append-only Log; the T005 contract-repair stayed in orchestrator bookkeeping commits.

## Summary for orchestrator

- blocked → fix tasks needed: T009F1: realign stale schema-version/stamp test expectations so `verify:pr`'s test:unit leg is green at HEAD — files: `src/resources/extensions/gsd/tests/db-authority-recovery-schema.test.ts` (2 tests, `SCHEMA_VERSION, 45` literals at :256/:501), `db-lifecycle-foundation.test.ts` (v40 test at :501 + v42/v43 load-sensitive siblings), `gsd-rebuild.test.ts:160` (stamp-aware bytes), `migrate-safety-audit.test.ts:4560` (canonical-representation conflict vs stamped re-render). All failures reproduce at HEAD in isolation; attribution confirmed by re-runs at T008's base (37aedafb).
- repeat offenders: T005's V46 bump has now produced stale-literal fallout three times (T026 repaired one file; two more files found here) — the plan's schema-version-sensitive test inventory is incomplete; T008's stamp similarly escaped its blast-radius estimate in two files. Consider a planner sweep for `SCHEMA_VERSION, 45` / `version: 45` literals and exact-byte projection assertions before wave 3.
- warnings worth a human eye: dangling `semantic-shadow-no-cutover-gate.mjs` imports in `scripts/m003-s07-dossier-input.ts` + its test (unreachable by verify:pr but crash if those scripts run — fold into T021); the machine-global `~/.gsd/agent` stale bundle makes `read-cli-args` red on developer machines regardless of repo state.
