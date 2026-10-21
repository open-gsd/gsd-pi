# Review — wave 2, cycle 2

Wave verdict: pass
Cycle: 2
Tasks reviewed: 2 (fix task T027 + re-checked T009 AC5), plus regression-checks of T005/T008/T026

Verification environment (disposable worktree `.worktrees/review-wave-2c2`,
created at T027's base `8560139d8`; T027 Verify run at base+patch, decisive
T009 AC5 legs run at primary HEAD `95899e7d1` = T027 commit `b46753dfa` +
bookkeeping descendants `794bf4bfa`/`95899e7d1`): `pnpm install
--frozen-lockfile --ignore-scripts`; `build:native:dev` + `build:native:test`
(fault-injection addon installed as `native/addon/gsd_engine.dev.node`);
CI's addon mirror `dist-test/native/addon` + `GSD_NATIVE_PREFER_LOCAL=1` for
the compiled tier (`.github/workflows/ci.yml:217-224`). Both T027 SHAs valid
(`git cat-file -t` = commit). T027 product commit `--name-status`: the 6
declared test files + its own task file only; the task-file diff is one
append-only Log line. Bookkeeping commits `794bf4bfa`/`95899e7d1` touch only
orchestrator-owned frontmatter fields (status/agent/base/worktree/
task_branch/commit) — no contract-body edits.

## T027 — test:unit-leg realignment (b46753dfa on base 8560139d8): pass

- ✅ AC1 (all six named test files green, source runner AND compiled tier) — source-runner six-file Verify leg at base+patch: 184 pass / 0 fail (71.5s); compiled tier at HEAD, six files run explicitly: 208 pass / 0 fail / 1 skip. Zero `46 !== 45` failures, zero unstamped-byte failures, zero canonical-representation conflicts.
- ✅ AC2 (version expectations SCHEMA_VERSION-relative or documented-historical; grep proof) — Verify grep leg at base+patch: `grep -rn "SCHEMA_VERSION, 45" src --include="*.test.ts"` zero hits (exit 1). My extended sweeps: `schemaVersion(...)/SchemaVersion...), 45)` variants zero hits; `version: 45\b` remaining hits exactly the two documented legitimate historical fixtures (`db-authority-recovery-schema.test.ts:152` base_database_schema_version, decision recorded in Log; `legacy-import-preview-database-target.test.ts:969` historical-v45, T005's do-not-touch file). Historical seed literals 31/35/36/39/42/43/44 kept literal, confirmed in the diff.
- ✅ AC3 (gsd-rebuild/migrate-safety-audit intent preserved; approach + evidence in Log) — `gsd-rebuild.test.ts:158-169` asserts the exact stamped bytes `# T01 Summary\n\nRendered from DB.\n<!-- gsd:state-version=R:E -->\n` (stamp NOT stripped; byte-exact re-render check retained). `migrate-safety-audit.test.ts:4560-4610`: production audit check untouched (`migrate/audit.js` not in the diff); the recorded `migration-review.render-duplicate-retire` op retires renderer duplicate ledger rows so each projection has exactly one canonical representation; original intent intact — intermediate RESEARCH file exists after first render (`:4599`), second `executeMigrationWrite` runs the audit clean, file gone (`:4606`). Chosen approaches + root-cause evidence recorded in the Log.
- ✅ AC4 (`pnpm run test:unit` green at HEAD, environmental exclusions documented) — at HEAD `95899e7d1`: `test:compile` exit 0; `test:unit:compiled` executed in FULL (all 13 globs: 1067 gsd `.test.js` in 6 chunks + `auto-supervisor.test.mjs` + 38 small-glob files + 151 `src/tests` files): 2029/1929/2069/2214/1613/2249 + 3 + 561 + 1303 passed, **0 failed** everywhere except the single documented environmental exclusion `read-cli-args.test.js` "runReadCli handles global flags before read" (machine-global stale `~/.gsd` bundle — signature verified below).
- ✅ AC5 (diff touches only files list; verify:pr not weakened) — `--stat`: 6 declared test files + task-file Log line only. No script/threshold/skip/gate change; package.json untouched.

Warnings (non-blocking):
- `gsd-rebuild.test.ts` builds the expected stamp's R:E values via `getCurrentProjectStateVersion()` — the same DB state the renderer stamps from, so the R:E values are partially self-referential (a wrong-revision stamp that matches current DB state would pass). The stamp line's presence/format and the body bytes are still pinned exactly, so the test still fails on an unstamped or malformed render. Matches the `markdown-renderer.test.ts:1810` pattern; acceptable, wording could be tightened.
- New environmental-interaction finding (not a task defect): the cycle-1 GSD_HOME isolation recipe reds 4 `doctor-providers.test.js` tests ("detects key from auth.json" + 3 siblings) — with `GSD_HOME` pointed at an empty dir the agent dir resolves away from the test's `$HOME`-based auth.json fixture, the check falls through to this machine's real `claude`/`codex`/`gemini` PATH CLIs, and the "auth.json source" assertions fail (reproduced standalone: `GSD_HOME=<empty>` → "available via Claude Code CLI"; unset → "key present (auth.json)"). CI sets only `GSD_NATIVE_PREFER_LOCAL=1` and no GSD_HOME; the whole compiled tier is green here with exactly the CI env. Recommend the orchestrator's isolation recipe scope GSD_HOME to the read-cli-args rerun only (as done here), never to full-tier runs.

Contract violations (blocking): none.

## T009 — Gate split-retire + verify:pr wiring (3a627dd5 on base a4184853): pass

AC1–AC4 passed in cycle 1 and are untouched by T027 (T009's four product files not in T027's diff; gate rerun green below — AC1/AC3 re-confirmed live).

- ✅ AC5 (`pnpm run verify:pr` green at the task commit) — RE-CHECKED at current primary HEAD `95899e7d1` (the T009 task commit's descendant chain; T009's own content unchanged since cycle 1). Every verify:pr leg run in the disposable worktree:
  - `build:core` — all steps exit 0. `build:pi-coding-agent` hits the documented pre-existing nested-worktree self-resolution quirk (TS2345 private-`cwd`, src-vs-dist `DefaultPackageManager`); per the documented workaround the emitted runtime dist is complete (verified independently: 111/111 src runtime files present in dist, zero missing) and `copy-assets.cjs` was run manually. Environmental, identical class to cycle 1 / T006 Log.
  - `typecheck:extensions` — exit 0.
  - `test:compile` — exit 0.
  - `test:unit:compiled` — full 13-glob run, green as detailed under T027 AC4 (12,103 + 3 + 561 + 1,303 passed across chunks; the 6 previously-red files additionally run explicitly: 208/0).
  - `gate:lifecycle-shadow-no-cutover` — exit 0, Structural 8/8, Behavioral 15/15.
  The single red test in the entire run is the documented cycle-1 environmental exclusion, signature verified unchanged: `read-cli-args.test.js` "runReadCli handles global flags before read" fails with "selected GSD extensions do not support schema-version preflight; synchronize the extension bundle" (`loadSchemaPreflight`, `dist-test/src/read-cli.js:32`) because the machine-global stale `~/.gsd/agent/extensions/gsd` bundle is picked up; rerunning that one file with an isolated `GSD_HOME`: green (1/1). Not a T027 or T009 failure — same exact documented signature as cycle 1.
  The 6 previously-red test files are all green: db-authority-recovery-schema ✅, db-lifecycle-foundation ✅, db-milestone-reopen-schema ✅, db-milestone-completion-schema ✅, gsd-rebuild ✅, migrate-safety-audit ✅.

Warnings (non-blocking):
- Full verify:pr executed as decisive legs (300s cap), exactly as recorded above; nothing skipped except a single-invocation end-to-end run.
- Cycle-1 flag (a) stands: dangling `semantic-shadow-no-cutover-gate.mjs` imports in `scripts/m003-s07-dossier-input.ts` + its test remain unreachable by verify:pr and unaddressed (T021 scope).

## Regression-check of affected cycle-1 passes (T005, T008, T026)

- ✅ T005 (V46 literals) — T027's edits touch no production code and no T005-owned file; `SCHEMA_VERSION = 46` intact (`db/engine.ts:159`); every deleted guard is one of the four documented bare `assert.equal(SCHEMA_VERSION, 45)` guards (2 in db-authority-recovery-schema, 1 in each milestone file — all enumerated in T027's Log); all other changes are literal→`SCHEMA_VERSION` substitutions in DB-read comparisons (`rawSchemaVersion(path)`, `schemaVersion(db|upgraded)`, `runtimeSchemaVersion`/`databaseSchemaVersion` expected-object fields) that still read the database and can still fail. No assertion replaced by a tautology; no guard deleted beyond the documented bare-guard deletions; corpus files untouched.
- ✅ T008 (stamp) — no renderer/stamp code touched (`gsd:state-version` stamp intact, `markdown-renderer.ts` 3 hits); the gsd-rebuild expectation still asserts the full stamped byte pattern (see T027 warnings for the mild R:E self-reference); the migrate-safety-audit fix did NOT weaken the audit's byte-exact canonical-representation check — production check untouched, and the test still exercises it end-to-end (the second `executeMigrationWrite` must survive the audit with the inter-attempt artifacts present).
- ✅ T026 (SCHEMA_VERSION+1 pattern) — `legacy-import-restore-assessment.test.ts` untouched by T027 (not in its files list, confirmed by `--name-status`); `SCHEMA_VERSION + 1` simulation intact at `:520` and `:525`.

## Fixed since last cycle

- T009 AC5 (`verify:pr` green at the task commit) — confirmed fixed, re-checked (not assumed): all legs rerun at HEAD `95899e7d1`; the 6 previously-red files green in both the source runner (base+patch: 184/0) and the compiled tier (explicit: 208/0; full tier: 0 relevant failures). No regressions introduced by the fix: the full 13-glob compiled tier shows zero non-environmental failures, and the T005/T008/T026 regression-checks above all hold.
- The same criterion does NOT fail for a different reason: the only remaining red (`read-cli-args`) is the identical documented machine-global `~/.gsd` exclusion from cycle 1, signature verified byte-for-byte in message and site.

## Summary for orchestrator

- Wave verdict: **pass** — T009 AC5 is now satisfied via T027; no fix tasks needed.
- repeat offenders: none new — T027's sweep (zero remaining `SCHEMA_VERSION, 45` / stale `version: 45` beyond the two documented historical fixtures) closes the stale-literal class the cycle-1 review flagged; still worth the planner's pre-wave-3 sweep habit for exact-byte projection assertions.
- warnings worth a human eye: (1) the review/orchestrator GSD_HOME isolation recipe must be scoped to the read-cli-args rerun only — a global GSD_HOME override silently reds 4 doctor-providers auth.json tests via PATH-CLI fallback (documented under T027 warnings); (2) the gsd-rebuild stamp expectation's R:E values are read from live DB state (mild self-reference, still fails on missing/malformed stamp); (3) cycle-1's dangling `scripts/m003-s07-dossier-input.ts` import of the deleted gate script remains live for T021.
