# Review — wave 3, cycle 1

Wave verdict: blocked
Cycle: 1
Depth: full
Tasks reviewed: 11

All eleven commits were resolved by SHA from each task's `commit` field, inspected
with `git show --format=fuller --stat --patch`, and diff-scope-checked: **every
commit changed only paths in its own `files` list plus its own task file — zero
contract-body edits, zero out-of-scope paths.** Verify commands were re-run at the
review base and pass. The failures below are all things the Verify commands cannot
see.

---

## T010 — Re-point doctor / reactive-graph / artifact-verification to DB reads: **fail**

- ✅ AC1 None of the five production files references `parsers-legacy`;
  `doctor-engine-checks.ts` parses via `parseLegacyPlan` from `./schemas/parsers.js`
  — confirmed at `doctor-engine-checks.ts:31`; `legacy-state-path-proof.mjs` and
  `parsers-legacy-importers.test.ts` both report `gsd/state.ts` as the only
  remaining production importer.
- ❌ AC2 "No markdown-fallback branch remains in reactive-graph or
  artifact-verification"
  found: two live markdown-fallback branches survive in
  `src/resources/extensions/gsd/artifact-verification.ts`, and **both return a
  verify-PASS when the DB is unavailable** — the exact defect class AC5 and
  SYNTHESIS clause (c) exist to close:
  1. `artifact-verification.ts:524-528` (`execute-task`):
     `if (isDbAvailable()) return false;` then
     `return hasLegacyCheckedTaskCompletion(base, mid, sid, tid);`. That helper
     (`artifact-verification.ts:156-165`) reads `PLAN.md` and regex-matches
     `- [x] **T0N:` — a markdown checkbox is accepted as proof of task completion
     whenever the DB is unavailable.
  2. `artifact-verification.ts:554-571` (`complete-milestone`): when
     `proveMilestoneCloseout` fails with `reason === "db-unavailable"`, `:566-568`
     returns `summaryOutcome !== "failure" && hasImplementationArtifacts(...) !== "absent"`
     — a markdown SUMMARY classification can turn a closeout-proof failure into a
     pass.
  Both predate the commit, but Step 5 is categorical ("delete the
  pre-migration/DB-unavailable fallback branches") and AC2 is categorical; the
  three sites Step 5 enumerated were examples, not an exhaustive carve-out. The
  coder fixed exactly the enumerated three and left these two, so the file now
  contains two fail-closed DB-unavailable branches (`:342-345`, `:541-550`) sitting
  beside two fail-OPEN ones — an incoherent state that a later reader will read as
  intentional.
  fix: apply the same treatment the coder applied at `:541-550` to both sites.
  For `execute-task`, delete the `hasLegacyCheckedTaskCompletion` branch and its
  helper (`:156-165`) and `logWarning("recovery", "verify-fail execute-task <id>: DB unavailable, cannot confirm task completion")` + `return false`.
  For `complete-milestone`, delete the `:566-568` escape and `return false` on any
  `!closeoutProof.ok`. Then invert/re-express every test that pins the old
  behaviour (grep `hasLegacyCheckedTaskCompletion` and `db-unavailable` under
  `src/resources/extensions/gsd/tests/`), the way `integration/idle-recovery.test.ts`
  was inverted in this commit.
- ✅ AC3 Updated tests pass; no surviving test asserts the removed fallbacks —
  spot-verified `recovery-verify-logs.test.ts` (14/14) and
  `integration/idle-recovery.test.ts` (24/24) green at review base.
- ✅ AC4 `baseline:refactor:phase0` green (orchestrator rerun, 34/34 + 139/139).
- ✅ AC6 `reactive-executor.test.ts` 24/24 reseeded, `integration/idle-recovery.test.ts`
  24/24 with the "lenient" test inverted and renamed to
  "complete-slice — unconfirmable completion fails closed (returns false)". The
  inversion is real and asserts `false` + a `/DB unavailable/` recovery warning.
- ✅ AC5 (for the two branches it names) complete-slice and parallel-research now
  fail closed: `artifact-verification.ts:342-345` and `:541-550`. Verified the
  fail-closed guard for parallel-research is placed *after* the roadmap-missing
  guard, so that witness survives.
- ✅ reactive-graph deletion is safe: `loadSliceTaskIO` now returns `[]`, and the
  sole dispatch consumer (`auto-dispatch.ts:1643-1646`) treats `taskIO.length < 2`
  as `return null` → sequential dispatch. Degrades conservatively; no verify-pass.

Warnings (non-blocking):
- `doctor.ts:148-153` and `doctor-state-checks.ts:194-210, 338-348` now read
  `getMilestoneSlices`/`getSliceTasks` unconditionally. With the DB unavailable
  these return `[]`, so doctor's slice/plan health checks silently produce no
  findings instead of markdown-derived ones. AC2's "doctor surfaces produce
  identical output from DB reads" holds only when the DB is available.
  `doctor-scope-db-unavailable.test.ts` is green (31/31) but does not cover this.
- Disclosed `git stash push`/`pop` during diagnosis (known issue (d)): confirmed
  non-impacting. The commit's diff scope is clean and byte-consistent with the Log.
  Recording it here so the role violation is not normalised — it recurs cheaply and
  the next occurrence may not be recoverable.

## T011 — Re-point display/prompt consumers: **fail**

- ✅ AC1 Zero `parsers-legacy` references in `workspace-index.ts`,
  `visualizer-data.ts`, `auto-prompts.ts`, `github-sync/sync.ts`.
- ❌ AC2 "Display, index, prompt-context, and sync outputs are byte-identical for
  equivalent project state"
  found: `auto-prompts.ts:1658-1669` `loadRoadmapCompletedSliceCandidates` replaced
  a roadmap-checkbox read with `getMilestoneSlices(mid).filter(s => s.status === "complete")`.
  These are **not** equivalent. The roadmap checkbox is rendered `[x]` by
  `markdown-renderer.ts:318` via `isClosedStatus(slice.status)`, whose closed set is
  `["complete", "done", "skipped", "closed"]` (`status-guards.ts:37`). `rowToSlice`
  does **not** normalise status on read (`db-task-slice-rows.ts:95`:
  `status: row["status"] as string`), and `status-guards.ts:30-36` states explicitly
  that `"done"`/`"closed"` still appear in real rows from older projects and imports.
  So on any migrated legacy project, a slice stored as `"done"` or `"closed"` was a
  UAT candidate before and is not now.
  This is not a display regression: the value flows
  `auto-dispatch.ts:920 → checkNeedsRunUat(...)`, and an empty/short candidate list
  makes `needsRunUat` null, so the `run-uat` unit is **never dispatched** for that
  slice. T011's own Context asserts "None makes dispatch/gate/completion decisions"
  — that assertion is false for this function, and the task was scoped on it.
  fix: in `auto-prompts.ts:1666`, replace `slice.status === "complete"` with a
  closed-but-not-skipped predicate built from the shared guards
  (`isClosedStatus(slice.status) && slice.status !== "skipped"`, importing from
  `./status-guards.js`), or normalise via `toStatus()` first. Add a case to
  `tests/auto-prompts-fallback.test.ts` seeding a slice row with status `"done"` and
  asserting it is returned as a candidate — the existing tests at `:109` and `:125`
  only seed `"complete"`, which is why this passed.
  Related, pre-existing and out of this commit's diff but the same predicate:
  `auto-prompts.ts:1637` (`checkNeedsReassessment`) filters `s.status === "complete"`
  too. Fold it into the same fix.
- ✅ AC3 No surviving test asserts markdown-fallback behaviour for these surfaces;
  DB-path coverage added in `auto-prompts-fallback.test.ts`, `visualizer-data.test.ts`,
  `github-sync/tests/sync-source.test.ts`.
- ✅ AC4 `baseline:refactor:phase0` green (140/140).

Warnings (non-blocking):
- `checkNeedsReassessment` (`auto-prompts.ts:1632-1654`) now returns `null` on a
  DB-unavailable project instead of falling back to roadmap checkboxes — i.e. the
  reassess-roadmap unit is silently never dispatched. Conservative direction
  (no false dispatch), but it is a dispatch decision, again contradicting the task's
  "no dispatch decisions" framing.

## T012 — Relocate shared parsers: **pass**

- ✅ AC1 Zero `parsers-legacy` references in `md-importer.ts`, `migration-auto-check.ts`.
- ✅ AC2 `parsers-legacy.ts` is a pure re-export shim carrying the exact DEPRECATED
  header; `parseLegacyRoadmap`/`parseLegacyPlan` live once, at
  `schemas/parsers.ts:412` and `:521`.
- ✅ AC3 `legacy-import-corpus.test.ts` behaviour unchanged (107/0 before and after
  per the Log; re-confirmed green in the wave run).
- ✅ AC4 No duplication: `schemas/parsers.ts:311` `parseRoadmap` is the unrelated
  validation parser returning `ParsedRoadmap`; the `Legacy` prefix is forced by that
  collision and is documented.

## T013 — Drift detectors → stamped projection-reads: **fail**

- ✅ AC1 Zero `parsers-legacy` references under `state-reconciliation/drift/`.
- ❌ AC2 "Stamp-matching projections skip content comparison; unstamped/mismatched
  projections behave exactly as before (tests prove both)" — the mechanism is
  implemented as written, but the premise it rests on is false, so it converts real
  drift into "no drift".
  found: `state-reconciliation/drift/roadmap.ts:58-66` + `:78` short-circuits
  `milestoneHasDivergence` to `false` whenever the ROADMAP's stamp equals
  `getCurrentProjectStateVersion()`. The doc-comment premise
  (`roadmap.ts:52-57`: "such a projection was rendered from exactly this DB state,
  so it cannot have drifted") does not hold, for two independent reasons:
  1. **The stamp does not track the mutations this detector checks.** The only
     production writer of `project_authority.revision` is the CAS at
     `db/domain-operation.ts:1176-1181`. Slice status/depends/sequence writes do not
     go through it — `gsd-db.ts:778 updateSliceStatus` → `db/writers/status.ts:213/248`
     is a plain `UPDATE` with no revision bump (`grep -n "revision" db/writers/status.ts`
     returns only unrelated `project_authority` sub-selects at `:63,77,91`). So:
     render ROADMAP at revision R → mutate slice state → revision is still R → the
     now-stale ROADMAP still stamps `R:E` == current → **divergence is declared
     absent and the file is never repaired.**
  2. **The stamp is a content byte, not a provenance token.** Anything bearing the
     current `R:E` bytes is accepted as fresh without ever being compared to the DB.
  This directly contradicts the invariant T008 landed in the same codebase, stated at
  `markdown-renderer.ts:1160-1166`: *"A projection whose stamp matches the current DB
  revision/epoch but whose content was hand-edited **IS drift**; a stamp-only
  difference is NOT."* T013 was named in that very comment as the task that wires the
  short-circuit, and it wired the opposite rule.
  **The new test pins the defect.** `tests/state-reconciliation-drift.test.ts:1671-1735`:
  `writeStampedRoadmap` deliberately writes `S02 ... depends:[S01]` while the DB seed
  at `:1695` has `depends: []` (the fixture's own comment says "Diverges from the DB
  below"), hand-forges a current stamp at `:1712-1716`, then asserts at `:1727-1735`
  that no `roadmap-divergence` is reported *and* that the file is left untouched.
  That is a drift-detect FAIL asserted as a PASS, in a test added by this commit.
  fix (one of two, planner's call — this is a plan defect, not only a coding one):
  (a) delete `projectionIsStampFresh` and its call (`roadmap.ts:58-66`, `:78`) and
  replace `tests/state-reconciliation-drift.test.ts:1699-1735` with a test asserting
  divergence IS detected and repaired for that fixture; or
  (b) keep the short-circuit but make the stamp trustworthy first — route every
  slice/task hierarchy mutation through the revision CAS so `project_authority.revision`
  advances on each, and re-express the test to mutate the DB after stamping and
  assert the stamp goes stale. Do not ship (b) without the CAS change; the current
  code is (b) minus its precondition.
  Note also `getCurrentProjectStateVersion()` returns `{0,0}` on a null DB
  (`markdown-renderer.ts:133-146`) and `project_authority` is seeded at `0,0`
  (`db-canonical-foundation-schema.ts:148-156`), so a projection stamped `0:0`
  matches a DB-unavailable read. `drift/roadmap.ts:114` guards with
  `if (!isDbAvailable()) return []`, so roadmap.ts is protected today;
  `stale-render.ts` has no such guard.
- ❌ AC2 (second half) "tests prove both" for `stale-render.ts`
  found: `stale-render.ts:70-72` filters `detectStaleRenders(basePath)` through
  `renderPathIsStampFresh` (`:52-67`). But `detectStaleRenders` is a hard stub:
  `markdown-renderer.ts:1202-1212` is `return [];` with a `TODO(flat-phase)`
  explaining detection is "temporarily fully disabled"; the real body,
  `detectStaleRendersImpl` (`:1214`), has zero callers. The filter is applied to a
  constant empty array — unreachable in production and untestable, and T013 added no
  test for it. When detection is re-enabled it inherits the AC2 unsoundness above,
  and `detectStaleRendersImpl` emits paths for legacy-layout PLAN/SUMMARY/UAT which
  are written unstamped (see T019 warnings), where the filter is a silent no-op.
  fix: delete `renderPathIsStampFresh` and the `.filter(...)` at `:70-72` while
  `detectStaleRenders` is stubbed, and record in the Log that the stale-render
  short-circuit is deferred until detection is re-enabled — or re-enable detection
  and cover it, under the same resolution chosen for the roadmap short-circuit.
- ✅ AC3 `sketch-flag.ts:71-76` correctly declines the stamp short-circuit with the
  required explanatory comment; pinned by `state-reconciliation-drift.test.ts:205`
  and by the new stamped-stub test.
- ⚠️ AC4 "Drift verdicts for equivalent states are unchanged" is technically true —
  it only constrains *equivalent* states, so it cannot catch AC2's defect. Verify
  (`! grep parsers-legacy` + three test files) likewise cannot fail on it: the
  offending behaviour is what the new tests assert. Criterion and Verify both need
  tightening.
  `state-reconciliation-drift.test.ts` + `roadmap-slices.test.ts` +
  `artifact-db-drift-memo.test.ts` re-run at review base: 104 tests / 100 pass /
  0 fail / 4 skipped.

## T014 — Backup-restore command: **fail**

- ❌ AC1 "The command exists, is consent-gated, verifies before restoring, runs
  inside the EXCLUSIVE claim, and persists a restore receipt"
  found: the *machinery* exists and is correct — `handleDbRestoreBackup` at
  `commands-maintenance.ts:1483`, consent at `:1610-1630`, ATTACH+quick_check
  verification at `:1595`, `withDatabaseMaintenanceClaim` at `:1764`, receipt via
  `_executeImportRestoreDomainOperation` + `insertImportRestoreReceipt`
  (`:1308-1309`, `:1397-1406`). But **there is no command**. Repo-wide,
  `handleDbRestoreBackup` has exactly two references: its own definition and
  `tests/backup-restore-command.test.ts`. `src/resources/extensions/gsd/commands/handlers/ops.ts:12`
  imports eight handlers from `commands-maintenance.js` and this is not one of them;
  no `if (trimmed === "db restore-backup" || trimmed.startsWith("db restore-backup "))`
  arm exists alongside the `recover`/`rebuild`/`sync` arms at `ops.ts:134-144`; and
  `commands/catalog.ts` has no `db` command family at all (`:20` command list, `:50`
  entries). `/gsd db restore-backup` is unreachable by a user, in every surface.
  The task Step 2 required "an explicit user-facing command surface"; the ruled
  downgrade story (2 stable releases + ≥60 days) depends on users being able to run
  it. This does not meet AC1. It is a plan defect — `ops.ts` and `catalog.ts` were
  outside T014's declared `files`, so the coder could not have routed it — but the
  criterion is unmet either way.
  fix: new task owning `src/resources/extensions/gsd/commands/handlers/ops.ts` and
  `src/resources/extensions/gsd/commands/catalog.ts` (neither owned by any wave-3/4
  task). Add the dispatch arm following the `recover` pattern at `ops.ts:134-137`
  (`handleDbRestoreBackup(ctx, projectRoot(), trimmed.replace(/^db restore-backup\s*/, "").trim())`),
  add `db` to the `:20` command string and a `db` → `restore-backup` entry to the
  subcommand catalog, and add a routing test that dispatches the literal string
  `db restore-backup --list` and asserts the handler ran. Note the arg parser must
  see `--backup`/`--list`/`--consent=...` — `handleDbRestoreBackup(ctx, basePath, args)`
  already takes a raw arg string, matching the `recover` shape.
- ✅ AC2 Corrupt-backup and no-consent/stale-consent invocations fail closed with
  the exact re-run token (`:1595`, `:1610-1630`); `backup-restore-command.test.ts`
  4/4.
- ✅ AC3 Zero `parsers-legacy` references in `commands-maintenance.ts` (confirmed by
  the T015 proof and the T016 registry).
- ✅ AC4 `legacy-import-restore-assessment.test.ts` 15/15; single-writer invariant
  untouched (restore runs under `withDatabaseMaintenanceClaim`).

Warnings (non-blocking):
- Step 4 made `handleCleanupBranches`'s stale-milestone check DB-only: branches with
  no DB milestone row (or no DB) are now *skipped*. Conservative for a destructive
  cleanup, so not a silent pass — but it means cleanup silently does nothing on a
  DB-unavailable project.

## T015 — Fail-closed evidence + static proof: **pass**

- ✅ AC1 `ensureTelemetryReport` is deleted; missing telemetry exits non-zero with
  `telemetry evidence missing — cannot prove zero usage`
  (`scripts/legacy-cleanup-gate.mjs:82-84`), pre-run/over-age `ts` exits stale
  (`:92-100`). Verified live.
- ✅ AC2 `legacy:cleanup:proof` exits 2 listing
  `parsersLegacyImporter src/resources/extensions/gsd/state.ts:25`; the fixture-driven
  offender and clean cases are asserted in `src/tests/legacy-cleanup-gate.test.ts:126-161`
  with exact `[kind, file, line]` triples. Regex-over-AST was explicitly permitted by
  Step 3 and is justified in a file comment.
- ✅ AC3 `LEGACY_COUNTERS` (`legacy-cleanup-gate.mjs:10-16`) unchanged against the
  commit parent; no new counter anywhere; gate composes telemetry + proof with
  `proofMissing` fail-closed (`:122,126,174-176`).
- ✅ AC4 `legacy-cleanup-evidence.test.ts` + `legacy-cleanup-gate.test.ts` 16/16, and
  the assertions are behavioural, not tautological.

Warnings (non-blocking — none defeat a written criterion, all three deserve a human):
- **The proof's green will be a rename artifact.** It matches the module specifier
  `parsers-legacy`, and wave 3 migrated consumers by rewriting
  `from './parsers-legacy.js'` → `from './schemas/parsers.js'` for *byte-identical*
  implementations (`parsers-legacy.ts` is now a pure re-export shim of exactly those
  two functions). Seven production modules still parse legacy markdown state and are
  invisible to the proof: `markdown-renderer.ts:52`, `md-importer.ts:50`,
  `migration-auto-check.ts:11`, `artifact-verification.ts:7`,
  `doctor-engine-checks.ts:31`, `drift/roadmap.ts:21`, `drift/sketch-flag.ts:18`.
  Once T022 removes `state.ts:25`, `legacy:cleanup:proof` reports zero while the
  legacy parsers are still in production use. The same critique applies to T016's
  registry (same specifier match). If the milestone intends the proof to stand for
  "the legacy state-read path is unused", it must key on the *symbols*
  (`parseLegacyRoadmap`/`parseLegacyPlan`) or on `schemas/parsers.js`'s legacy
  exports, not on the shim's filename. This is the single largest gap between what a
  wave-3 Verify proves and what its criterion is read to claim.
- **The evidence pipeline is now red by construction, with a one-flag forgery path.**
  `DEFAULT_EVIDENCE_COMMANDS = [["npm","run","baseline:refactor:gate"]]`
  (`legacy-cleanup-evidence.mjs:15`), but telemetry is only written by
  `persistLegacyTelemetry` (`legacy-telemetry.ts:45,86-95`), and none of the four
  test files in `baseline:refactor:gate` imports it. A bare `pnpm legacy:cleanup:evidence`
  can therefore only ever exit 1. Meanwhile nothing validates *provenance*:
  `loadTelemetryEvidence` accepts any JSON with a recent `ts` and five zero counters,
  and the new test at `src/tests/legacy-cleanup-evidence.test.ts:79-84` demonstrates
  the green path by passing a `--command` that writes exactly such a report. The
  fabrication moved from inside the script to the caller. INTENT success criterion 3
  requires `legacy:cleanup:evidence` to pass *green*; on this design it can only do
  so via a hand-written report unless a real telemetry producer is added.
- `ts` is bounded below (run start) and above only by `--max-age-ms`; a
  future-dated `ts` (e.g. `3000-01-01`) passes both checks. Verified live.
- Line-scoped regex misses `import './parsers-legacy.js';` (side-effect form, no
  `from`) and specifier-on-its-own-line forms; block comments produce false
  positives. The common multi-line `} from './parsers-legacy.js';` form *is* caught
  (that is how `state.ts:25` is found), so severity is low today.

## T016 — Importer-registry reconciliation: **pass**

- ✅ AC1 `parsers-legacy-importers.test.ts` green (3/3, re-run at review base). The
  scan walks all of `src/resources/extensions` (so `github-sync` is covered) and is
  not vacuous.
- ✅ AC2 `ALLOWED_IMPORTERS` contains exactly `gsd/state.ts`, justification names
  T022; an independent sweep confirms it is the only production importer.
- ✅ AC3 `BANNED_DECISION_PATHS` byte-unchanged (15 entries).

Warnings (non-blocking):
- Inherits the specifier-vs-symbol gap described under T015: the registry now reads
  "one importer left" while seven modules import the same functions from
  `schemas/parsers.js`.

## T017 — ci-cd-pipeline.md rewrite: **pass**

- ✅ AC1 Zero hits for `auto-?promot|automatic|promotion|promote`; the doc asserts
  the inverse at `docs/dev/ci-cd-pipeline.md:5-8` and `:31-32`.
- ✅ AC2 `npm-publish.yml` (`:8,79,148,200,237-242,255,257,272`), `workflow_dispatch`
  (`:8,21,79,81`), @dev-first → prod approval (`:25-28,79,167-176,280`).
- ✅ AC3 Zero `test:fixtures` / `tests/fixtures/record` / `GSD_FIXTURE_`; the only
  surviving "fixture" is the explicit negation at `:261`.
- ✅ AC4 Mechanically re-checked: all 16 `npm run`/bare script names resolve in
  `package.json`; all nine `*.yml` names exist in `.github/workflows/`; all cited
  scripts, ignore files and docs exist on disk. Zero misses. Every corrected factual
  claim (triggers, environments, inputs, backoff values, dist-tag escape hatch,
  `cache: pnpm`, five-binary matrix, weekly cleanup schedule) was verified against
  the workflow sources.

**Known issue (c) is refuted, not confirmed.** There was never a "Run CI-equivalent
checks" section in this file: `git log --all -S "CI-equivalent" -- docs/dev/ci-cd-pipeline.md`
returns zero commits. The `verify:pr`/`verify:merge` guidance was *already* only
under `## For Maintainers` before T017 (old `:77` and `:97`), and T017 left both
lines byte-identical (they appear as unchanged context in the diff; now `:90` and
`:112`, same headings). Step 3 was not violated and no accurate non-publish content
was dropped — the full heading diff shows three changes, all inside the authorised
publish/fixture scope. If a contributor-facing local-verification section is wanted,
that is a new doc request, not a T017 regression.

Warnings (non-blocking):
- The `ci.yml` "Gating Tests" list (`:142-146`) no longer mentions that `ci.yml`
  itself runs `pnpm run test:smoke` (`ci.yml:431-440`); the smoke bullet moved into
  the `npm-publish.yml` list at `:152`. Not a false statement, an incomplete list.

## T018 — ADR status-label downgrades: **pass**

- ✅ AC1 No Status line claims `Implemented`/`(implemented)`/`(mostly implemented)`;
  Verify exits 0 and is **not** vacuous — all five Status lines literally begin
  `**Status:**` at column 0 (`ADR-004:3`, `-009:3`, `-011:3`, `-013:12`, `-036:3`),
  so the anchored negative grep genuinely inspects them.
- ✅ AC2 All five labels use the fixed vocabulary
  (`landed under different names` ×2, `partially landed` ×3).
- ✅ AC3 Every load-bearing trace claim in the Log was independently re-verified at
  this HEAD and **all are true** — including the highest-risk one
  (`db-base-schema.ts:80 structured_fields` is inside the `memories` table at `:66-83`,
  not `decisions` at `:20-34`, exactly as the note says), the absence claim for
  ADR-009 (`grep -rn "OrchestrationKernel|PlanPlane|GitOpsPlane|AuditPlane|ExecutionPlane" src packages`
  → zero hits), the 15-file `uok/` inventory, `uok/kernel.ts:54,66,188`,
  `tool-surface-readiness.ts:32,356`, `stream-adapter.ts:68,2079`,
  `workflow-tools.ts:982`, `contracts/src/workflow.ts:302`, `auto-prompts.ts:2690`,
  `auto-dispatch.ts:1450`. Zero false or materially-off claims. The Implementation
  notes do not overstate.

Warnings (non-blocking):
- Markdown rendering defect in all five files: the `> Implementation note …` line is
  immediately followed by `**Date:**` with no blank line (`ADR-004:5→6`, `-009:5→6`,
  `-011:5→6`, `-013:14→15`, `-036:5→6`). CommonMark lazy continuation pulls the whole
  `Date/Revised/Deciders/Author/Related` metadata block *into* the blockquote. One
  blank line after each note line fixes it.
- `ADR-009:3` appends `; superseded by ADR-046` inside the `<where>` slot — a
  disposition, not a location, and already stated redundantly at `:5`.
- The Verify's phrase-whitelist half (`grep -lE ... | wc -l`) scans whole files, not
  the Status line, so a future edit could satisfy it from prose. It also does not see
  the surviving `**Implemented:**` metadata lines at `ADR-011:7` and `ADR-013:16`
  (both happen to be consistent with the traces).

## T019 — Projection contract + residual risks: **pass**

- ✅ AC1 Stamp format at `docs/dev/state-db-cutover-projection-contract.md:96`
  (regex `:102`) — verified byte-for-byte against `markdown-renderer.ts:119` and the
  emit at `:170`; frozen inventory `:46-89`; read-only rule `:12-32`; three reader
  surfaces `:167-179`.
- ✅ AC2 All four residual risks with mitigations in
  `docs/dev/state-db-cutover-milestone-decision.md:125-133` (R1), `:135-146` (R2),
  `:148-168` (R3), `:170-180` (R4).
- ✅ AC3 ADR-046 window quoted verbatim in both docs
  (`projection-contract:160-165`, `milestone-decision:182-190`).
- ✅ **Known issue (b) confirmed and correctly handled by the doc.** STATE.md is
  written by `workflow-projections.ts:406 renderStateProjection` → `:423` → `:438
  atomicWriteSync`, never through `writeAndStore`/`stampProjectionContent` — it is
  unstamped, as are DECISIONS.md and REQUIREMENTS.md (`db-writer.ts:430,492,642` via
  `saveFile`) and `.planning/`. Only T019's *task Context* was wrong; the shipped doc
  records the correction at `:54-56` and `:126-131`. Sweep result: **no other task
  file, plan, or production consumer depends on the false assumption** —
  `T008-renderer-stamp-db-reads.md:27` names STATE.md only as a reader surface;
  T004/T013/T027 are clean; no test asserts a stamp on STATE.md (stamp assertions in
  `projection-fidelity.test.ts:164`, `gsd-rebuild.test.ts:167`,
  `markdown-renderer.test.ts:1810-1858` all target genuinely stamped `writeAndStore`
  outputs). The T013 stamp short-circuits read ROADMAP and stale-render paths, not
  STATE.md, so the false assumption caused no code defect. Its independent problems
  are recorded under T013.
- ✅ Frozen-inventory claims verified: `GSD_ROOT_FILES` is at `paths.ts:352` with the
  eight files listed; the "ten `writeAndStore` render entry points" claim is correct
  (11 call sites across 10 distinct exported functions).

Warnings (non-blocking):
- §3.4 (`projection-contract:126-131`) lists only STATE.md, DECISIONS.md and
  `.planning/` as unstamped. Several projections have a *second, unstamped writer*:
  `workflow-projections.ts:116` (legacy-layout slice PLAN), `:172` (legacy-layout
  milestone ROADMAP), `:201` (top-level `.gsd/ROADMAP.md`), `:221` (`.gsd/QUEUE.md`
  — itself in the doc's §2.1 inventory), `:339` (milestone SUMMARY), plus
  PROJECT.md/REQUIREMENTS.md/KNOWLEDGE.md/OVERRIDES.md/CODEBASE.md. A reader
  following §3.4 would wrongly conclude a legacy-layout PLAN/ROADMAP is stamped.
- `docs/dev/state-db-cutover-parsers-legacy-inventory.md:35` (and its category-(b)
  definition at `:12-14`) still says `drift/sketch-flag.ts` validates against the
  stamp. The landed code deliberately does the opposite (`sketch-flag.ts:71-76`,
  T013 Step 4/AC3). Stale inventory row.
- `projection-contract:174` cites `packages/mcp-server/src/server.ts:1486` as a
  reader; that line is CLI help text, not a read site. The other two mcp-server refs
  (`:278`, `:308`), both daemon refs (`local-tool-executor.ts:285,322`) and both
  hermes refs verify.
- The doc names one "canonical regex" where the code has two with different
  semantics: `STATE_VERSION_STAMP_RE` (`markdown-renderer.ts:119`, unanchored — reads
  a stamp anywhere) vs `TRAILING_STATE_VERSION_STAMP_RE` (`:120`, strips only a
  trailing one).

## T028 — markdown-renderer parser re-home: **pass**

- ✅ AC1 Zero `parsers-legacy` references in `markdown-renderer.ts`; import at `:52`
  is `parseLegacyRoadmap` from `./schemas/parsers.js`.
- ✅ AC2 `roadmapRenderMarksSliceDone` and `renderAllFromDb` exports and signatures
  unchanged; no stamp or content change (verified in the diff — import + two call
  sites + two prose comments only).
- ✅ AC3 `markdown-renderer.test.ts` + `projection-fidelity.test.ts` green
  (39 / 29 pass / 0 fail / 10 skipped); only the import path changed in the test,
  local names preserved so no assertion moved.
- ✅ AC4 `node scripts/legacy-state-path-proof.mjs` lists `gsd/state.ts` as the sole
  remaining production importer — re-run and confirmed.

---

## Summary for orchestrator

- blocked → fix tasks needed (one per disjoint file scope):
  - **T010F1** — scope `src/resources/extensions/gsd/artifact-verification.ts` plus
    the tests that pin the two surviving fallbacks. Covers: `execute-task`
    markdown-checkbox pass at `:524-528` (+ helper `:156-165`) and
    `complete-milestone` DB-unavailable markdown pass at `:566-568`. Both must fail
    closed with a `recovery` warning, matching the pattern the same commit landed at
    `:342-345` / `:541-550`.
  - **T011F1** — scope `src/resources/extensions/gsd/auto-prompts.ts` and
    `src/resources/extensions/gsd/tests/auto-prompts-fallback.test.ts`. Covers: the
    `status === "complete"` predicate at `:1666` (and `:1637`) narrowing the
    roadmap-checkbox `isClosedStatus` set, silently suppressing `run-uat` dispatch
    for slices stored as `"done"`/`"closed"`; plus a test seeding a `"done"` row.
  - **T013F1** — scope `src/resources/extensions/gsd/state-reconciliation/drift/roadmap.ts`,
    `.../drift/stale-render.ts`, `src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts`.
    Covers: the unsound stamp short-circuit (the stamp does not advance on slice
    mutations — only `db/domain-operation.ts:1176` bumps revision), the test at
    `:1699-1735` that pins the resulting silent pass, and the dead filter over the
    stubbed `detectStaleRenders`. **Requires a planner decision first** (drop the
    short-circuit vs. make the revision trustworthy) — the contract as written is
    what produced the defect.
  - **T014F1** — scope `src/resources/extensions/gsd/commands/handlers/ops.ts` and
    `src/resources/extensions/gsd/commands/catalog.ts` (+ a routing test). Covers:
    routing and advertising `/gsd db restore-backup` so the shipped machinery is
    reachable. Neither file is owned by any wave-3 or wave-4 task.

- repeat offenders: **deleting a markdown fallback without checking what the empty
  DB result does to the return value.** This is the third distinct instance in T010
  alone (two caught during dispatch, two more found here) and the root cause of
  T013's defect too. It is a plan-authoring defect, not a coder defect: every wave-3
  consumer task was scoped from an importer inventory that enumerated *imports*, never
  the *return paths* those imports guarded. Any wave-4 deletion task (T020/T022
  especially) should carry an explicit step: "for each deleted branch, state what the
  function returns when the DB is unavailable or the query is empty, and prove it is
  not more permissive than before."

- warnings worth a human eye:
  1. **The static proof and the importer registry both key on the `parsers-legacy`
     specifier, which wave 3 emptied by renaming the import path.** Seven production
     modules still parse legacy markdown via byte-identical functions at
     `schemas/parsers.js`. After T022, `legacy:cleanup:proof` will report zero
     offenders while the legacy read path is still in production use — INTENT success
     criterion 3 would be satisfied by a rename. Decide before wave 4 whether the
     proof must key on symbols.
  2. **`legacy:cleanup:evidence` currently cannot go green honestly** — no command in
     `DEFAULT_EVIDENCE_COMMANDS` produces telemetry, and the only green path is a
     caller-supplied `--command` writing the report (which is what the new test
     does). INTENT success criterion 3 requires it green.
  3. `detectStaleRenders` has been a hard `return []` stub since before this wave;
     projection-fidelity drift detection via `detectProjectionDrift` has no production
     caller either. Two of the three "positive post-cutover checks" SYNTHESIS promised
     as the successor to the retired gate are not wired to anything.
  4. Known issue (c) is **false** — nothing was dropped from ci-cd-pipeline.md.
     Recorded here so it is not carried forward as an open item.
  5. Known issue (d) (the disclosed `git stash push`/`pop`) is confirmed harmless —
     clean diff scope, byte-identical tree — but it is a role-contract breach that
     should not be normalised by having been survivable.
  6. ADR blockquote lazy-continuation rendering defect in all five T018 files; one
     blank line each.
