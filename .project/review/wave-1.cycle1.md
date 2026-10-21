# Review — wave 1, cycle 1

Wave verdict: pass
Cycle: 1
Tasks reviewed: 4

## T001 — Re-run all four gates at clean HEAD and record evidence: pass

- ✅ `.project/plan/wave1-gate-baseline.md` exists and records command, exit code, and verdict for all four gates plus the fabricated-evidence check — `.project/plan/wave1-gate-baseline.md:10-84`: gate 1 FAIL exit 1 (line 10), gate 2 FAIL exit 1 (line 28), gate 3 FAIL exit 1 (line 35), gate 4 FAIL/honest ENOENT exit 1 (line 58), fabricated-evidence check exit 1 with fabrication path confirmed present in code but not reached (lines 68-84).
- ✅ The file contains exactly one `VERDICT: BASELINE ...` line — `grep -c "VERDICT: BASELINE"` = 1; `VERDICT: BASELINE RED — baseline:refactor:gate, baseline:refactor:phase0, gate:semantic-shadow-no-cutover` at line 88. RED verdict names the failing gates per step 3.
- ✅ No production source file is modified — commit `ecd912871c690d8fdf3c19c358ed1e076e18f3c2` touches only `.project/plan/wave1-gate-baseline.md` (new) plus an append-only Log entry in the task file.
- ✅ Verify command — ran the grep chain in the disposable worktree at base `254f51d046caa5863956f350210749b6daab680c` with the task patch applied: exit 0.

Warnings (non-blocking):
- Verify is presence-only greps; it cannot fail on missing exit codes or wrong verdicts. Criterion 1 was verified by reading the file instead (evidence above). Consider tightening the Verify command in future tasks.

Contract violations (blocking):
- none

## T002 — Map T07 deferred blockers and write the D005 supersede-for-filesystem-state-only milestone decision doc: pass

- ✅ `docs/dev/state-db-cutover-milestone-decision.md` exists and contains the D005 supersede-for-filesystem-state-only decision, explicitly scoped — lines 17-40: superseded for filesystem-state (markdown) read/write authority only; D005 remains in force for canonical lifecycle read authority under `gate:lifecycle-shadow-no-cutover`.
- ✅ Every blocker in the reconciled list appears with YES/NO classification and justification; all NO — classification table lines 50-60 covers all 9 dossier ids (`production-read-authority` … `compatibility-retirement`), each NO with a cited justification; task Log therefore correctly shows no BLOCKED mark.
- ✅ Count reconciliation (9 vs 13) stated explicitly with source — lines 62-100: 9 dossier JSON ids authoritative; 13-item research enumeration reconciled item-by-item (1:1 maps, folds, split, observation-coverage facts, closed prerequisite, governance precondition).
- ✅ No production code modified — commit `47d3ee1ab5f8ef9a688fb41ae3dd0e76ab7c3daf` touches only `docs/dev/state-db-cutover-milestone-decision.md` plus an append-only task Log entry.
- ✅ Verify command — all five greps exit 0 in the disposable worktree with the task patch applied.

Warnings (non-blocking):
- none

Contract violations (blocking):
- none

## T003 — Spike: pre-cutover binary vs. cut-over project fixture: pass

- ✅ Report exists with the classification line — `docs/dev/state-db-cutover-mixed-version-spike.md:80`: `observed behavior: silent divergence`.
- ✅ Before/after sha256 of `gsd.db` and of at least one projection file, and per-command exit codes — integrity table lines 71-73 (gsd.db + ROADMAP + PLAN, all unchanged); probe table lines 47-52 records exit codes 0/0/1/0 for the four probes.
- ✅ Observed behavior is `silent divergence`; the report names the guard change required and the Log marks the plan assumption amended — recommendation lines 90-115 name three guard changes (loud read-path refusal, projection-writer version gating, rebuild-path reason propagation) and re-scope wave-2 T005/T006; task Log records "PLAN ASSUMPTION AMENDED per acceptance criterion 3".
- ✅ No committed files other than the spike report; no disposable worktrees left behind — commit `2946a0f7ef6a433641b6e33c9c94a46aeb8ab0d9` touches only the report plus an append-only task Log entry; `.worktrees/` and `git worktree list` show no `spike-mixed-version` or other spike leftovers.
- ✅ Verify command — both greps exit 0 in the disposable worktree with the task patch applied.

Warnings (non-blocking):
- Step 1 prescribed the disposable worktree at `.worktrees/spike-mixed-version`; the coder relocated it to `$(mktemp -d)` because the v1.11.0 build's module resolution leaks into the primary checkout inside `.worktrees/**`. Deviation is documented in the report (lines 17-21) and the acceptance criteria are met; criterion wording ("disposable worktrees") tolerates it. Consider amending the step text if this recurs.

Contract violations (blocking):
- none

## T004 — Authoritative parsers-legacy importer union inventory with per-consumer dispositions: pass

- ✅ The inventory lists exactly the 16 production importers, each with a disposition of (a), (b), or (c) and a code-grounded justification — table `docs/dev/state-db-cutover-parsers-legacy-inventory.md:23-38`: 16 rows, (a) re-point ×11, (b) stamped projection-read ×2, (c) delete ×3. Spot-verified at base: the step-1 grep returns 18 hits; minus `parsers-legacy.ts` (self) and `files.ts` (comment-only matches confirmed at `src/resources/extensions/gsd/files.ts:56,61,67`) = 16, and the 16-entry `ALLOWED_IMPORTERS` set in `src/resources/extensions/gsd/tests/parsers-legacy-importers.test.ts:43-62` matches the grep-derived union 1:1 (diff empty modulo quoting).
- ✅ Every disposition names its executing task id — T010 ×5, T011 ×4, T014 ×1, T008 ×1, T013 ×2, T007/T022 ×1, T012 ×2 (table column "Executing task", lines 23-38).
- ✅ The grep vs allowlist vs research-count reconciliation is stated — lines 40-73, including the 15 (domain) + 1 (pitfalls, `github-sync/sync.ts`) research union and the excluded test-only importers.
- ✅ No production code modified — commit `ad1187974803678c68c03d2a30417745a1731653` touches only the inventory doc plus an append-only task Log entry.
- ✅ Verify command — all five greps exit 0 in the disposable worktree with the task patch applied.

Warnings (non-blocking):
- none

Contract violations (blocking):
- none

## Fixed since last cycle

- n/a (cycle 1)

## Summary for orchestrator

- blocked → fix tasks needed: none — wave verdict is pass.
- Plan-level note (not a task failure): T001's recorded ground truth is `VERDICT: BASELINE RED` — three of four gates fail at clean HEAD on the missing `@opengsd/contracts/dist` build. Per T001 step 3 the plan re-baselines (build contracts or extend `dist-redirect.mjs`) before wave 2.
- Plan-level note: T003 observed `silent divergence`; its Log marks PLAN ASSUMPTION AMENDED — wave-2 tasks T005/T006 must be re-scoped before they start (read-seam surfacing, projection-write version gating, rebuild-path error propagation).
- repeat offenders: none (cycle 1)
- warnings worth a human eye: T001 Verify greps are presence-only (cannot fail on missing exit codes); T003 spike worktree location deviated from step 1 with documented justification.
