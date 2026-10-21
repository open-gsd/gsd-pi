---
pipeline: gsd-path/v1
project: gsd-pi
milestone: state-db-cutover # set by the grill; names the archive directory at ship
phase: build        # onboard | grill | research | synthesize | plan | build | review | shipped
                    # onboard only for brownfield projects; greenfield starts at grill
status: active      # active | done | blocked
branch: gsd-path/gsd-pi # bound once at build; reset for the next milestone
archive: null       # persisted archive transaction path; never recomputed
---

# Project State

One file, always current. The router reads this first; every phase updates
it on completion. If this file and the artifacts disagree, the artifacts win
— fix this file.

## Log

<!-- append one line per transition: date, phase, event -->
- 2026-08-01 — onboard — project initialized (brownfield: pnpm workspace + package.json + apps/packages + extensive git history)
- 2026-08-01 — onboard — done: evidence-codebase.md (10 findings) + DOCS-AUDIT.md (472 docs: 149 verified, 67 stale, 10 unverifiable, 279 descriptive) gated and accepted; disposable worktrees removed
- 2026-08-01 — grill — phase started (brownfield mode)
- 2026-08-01 — grill — done: INTENT.md approved by user ("approve"); milestone=state-db-cutover; doc rulings recorded in DOCS-AUDIT.md ## User rulings
- 2026-08-01 — research — phase started; question assignment: Q1 read-paths→domain, Q2 telemetry→pitfalls, Q3 migration-design→migration (5th dimension), Q4 gate-invariants→domain, Q5 plan-of-plans-status→domain
- 2026-08-01 — research — done: 5 evidence files gated (domain 10, stack 8, pitfalls 9, similar 10, migration 8 findings); all RESEARCH questions answered; key: markdownFallbackUsed telemetry never existed — evidence must be built or proof re-based on static no-caller analysis
- 2026-08-01 — synthesize — phase started
- 2026-08-01 — synthesize — SYNTHESIS.md gated: 9 decisions, 1 NEEDS-USER (downgrade window); awaiting user ruling
- 2026-08-01 — synthesize — done: user ruled downgrade window = 2 stable releases + ≥60 days (ADR-046, "your lean"); ruling recorded in SYNTHESIS.md ## User rulings; no unresolved NEEDS-USER
- 2026-08-01 — plan — phase started
- 2026-08-01 — plan — alignment queue: user accepted "all" 6 fix-doc items (ci-cd-pipeline.md + 5 ADR labels) into the plan
- 2026-08-01 — plan — PLAN.md + 23 tasks gated PASS (rows↔files 1:1, acyclic, no same-wave file overlap, decisions covered, vetoes untouched); awaiting approval
- 2026-08-02 — plan — done: user approved plan ("approve"); build authorized for all 4 waves (wave 4 holds at ADR-046 timebox STOP conditions)
- 2026-08-02 — build — build started; branch bound: gsd-path/gsd-pi created at origin/main SHA 331cee83a (main is strict ancestor of previous checkout; unrelated MCP-fix branch left unpolluted)
- 2026-08-02 — build — wave 1 done (4/4, review pass cycle 1); wave 2 done (9/9 incl. repairs T024/T025/T026/T027, review pass cycle 2); plan repaired twice (T024 split+T025 re-baseline, T005 expand+T026, T027 fix task)
- 2026-08-05 — build — wave 3 partial (T011, T012, T014 done); T010 BLOCKED a second time by coder (documented plan defect: Step 5 breaks pinned seam tests in recovery-verify-logs.test.ts, a path outside T010 files and owned by no task). No production diff either attempt; worktree .worktrees/gsd-path-T010 retained. Repeated block on one task — build stops for a user ruling on the milestone-semantics question (delete the pinned markdown-fallback recovery behavior vs narrow Step 5 to spare it).
- 2026-08-05 — build — T010 block resolved by planner repair against SYNTHESIS (c): deleted fallbacks must fail closed, not silently pass; the two DB-unavailable witnesses are re-expressed rather than deleted. User ruled repair-in-place. status blocked→active; wave 3 resumes.
- 2026-08-06 — build — wave 3 done (11/11 incl. T028 repair). parsers-legacy production importers 9 → 1 (gsd/state.ts only, removed by T022); registry allowlist reconciled 16 → 1. Wave-3 review cycle 1 dispatched.
- 2026-08-06 — build — wave-3 review cycle 1 blocked (7 pass / 4 fail); 5 fix tasks T029-T033 authored, dispatched and integrated (T029 blocked once on an orchestrator authoring error, repaired against a 24-file measured sweep). All 16 wave-3 tasks done. Legacy proof re-keyed on symbols per user ruling: now BLOCK with 8 offenders, and T020's deletion gate is unreachable until the 7 relocated-symbol modules are owned. Review cycle 2 dispatched.
- 2026-08-06 — build — review cycle 2 blocked (3 findings; all 4 cycle-1 failures verified closed by probe). Fix tasks T034-T036 integrated: three RED tests on the branch (T011 residue, missed by T011's Verify and by cycle 1) repaired as fixture-only with the #1112 guard preserved; help-menu regression fixed; six unfailable execute-task guards retired with the consequence recorded as R5. Wave 3 now 19/19. Review cycle 3 dispatched — final cycle before max_review_cycles=3.
- 2026-08-06 — build — REVIEW CAP REACHED. Cycle 3 blocked: all cycle-2 findings verified closed by probe, but 15 RED tests found in four files no cycle had swept, attributable to T011. Branch is CI-red (test:integration runs them; test:unit:compiled's glob does not). Build state set to blocked pending a human ruling on relax / redirect / raise-the-cap.
- 2026-08-07 — build — USER RULING at the review cap: raise max_review_cycles 3→4 and fix. Rationale recorded: the branch is CI-red (test:integration runs the 15 failing tests; test:unit:compiled's flat glob does not), and the reviewer found no design question — a mechanical DB reseed of the shape T034 already executed. status blocked→active. Sweeping all 39 in-repo test files importing a T011-touched module BEFORE authoring the fix tasks, per the reviewer's instruction, so the contracts cover the measured break set rather than the known 15.
- 2026-08-07 — build — T037/T038 integrated; all 16 RED tests green at HEAD (95/95 across the 5 files); branch no longer CI-red. Both fixes were fixture-only with production files proven byte-unchanged by hash. Wave 3 now 21/21. Review cycle 4 dispatched under the raised cap.
- 2026-08-07 — build — cycle 4 BLOCKED at the raised cap. test:integration clear (1272/0 fail) but test:unit:compiled red: 5 tests, 4 files, 3 owners (T011 x2, T029, T014). Cause of the repeated misses now established: two are transitive-only importers and one imports nothing at all (filesystem scanner), so no import-based sweep could find them — only running the legs. Build blocked pending a second human ruling.
- 2026-08-07 — build — SECOND USER RULING at the cap: land fix tasks T039-T041, then close wave 3 on a real verify:pr + test:integration run outside .worktrees/ rather than a 5th adversarial review cycle. Rationale recorded: four cycles each declared the blast radius closed and were wrong, and cycle 4 proved the residue is not reachable by import-based inspection at any depth — only by running the gates. status blocked→active.
- 2026-08-07 — build — WAVE 3 DONE (24/24) and closed on the gate run per user ruling: verify:pr green (13997/13997 effective; sole failure proven to be stale installed ~/.gsd ESM resources vs repo CJS native dist, passes 1/1 with clean GSD_HOME). Wave 4 (T020-T023) cannot complete: all three deletions are ADR-046 timebox-gated on a clock that starts at the cutover RELEASE, and T020 is additionally blocked by 7 unowned proof offenders. Proceeding to ship the cutover so the timebox can start.
- 2026-08-07 — build — CUTOVER SHIPPED TO MAIN. PR #1627 merged 2026-08-07T18:49Z (merge commit 185af73a5); PR #1605 (auto-mode milestone completion) merged 19:14Z. Verified on main: schemas/parsers.ts and the symbol-keyed legacy-state-path-proof are both present. Milestone branch merged with main (2 conflicts resolved: prompt-golden baseline 15900->16000, main's value from #1605's Tool Surface change now supersedes T025's; artifact-verification gained main's readTerminalTaskRecoveryAbort from #1622 — HEAD side was empty). Branch is 0 behind main, typecheck clean, all 37 recorded task SHAs still reachable.
- 2026-08-07 — build — WAVE 4 CLOCK HAS NOT STARTED. main is still version 1.12.0 at tag v1.12.0, which PREDATES the cutover merge. ADR-046 gates T020/T021/T022 on 2 stable releases + >=60 days measured from the cutover RELEASE, not the merge. A release must be cut before the window opens; wave 4 remains blocked until then, and T020 additionally needs owners for the 7 modules the symbol-keyed proof reports.
- 2026-08-08 — build — CUTOVER RELEASED as v1.13.0 (npm latest=1.13.0, all five @opengsd/engine-* at 1.13.0, tag v1.13.0, GitHub Release published 00:29:20Z, Docker pushed). ADR-046 DOWNGRADE WINDOW HAS NOW STARTED: it runs from this release — 2 stable releases + >=60 days, so the earliest wave-4 deletion date is 2026-10-07 AND requires one more stable release after 1.13.0. Release included the 15 fixes for live-1.12.0 bugs plus the DB-authority cutover (#1627).
- 2026-08-08 — build — WAVE 4 STATUS: T020/T021/T022 remain timebox-blocked until the window above elapses. T020 is ADDITIONALLY blocked and this has no deadline relief: the symbol-keyed proof reports 7 production modules that still parse legacy markdown via the relocated parseLegacy* functions, every one carrying `Retired by: none`. They need owners before T020's zero-offender gate can ever pass. T023 (closeout) depends on all three.
- 2026-08-12 — build — WAVE 4 DONE (T020–T023). User waived remaining ADR-046 calendar days. Proof PASS. `gate:lifecycle-shadow-no-cutover` PASS 7/7+11/11. Closeout docs updated. Branch `fix/wave-4-legacy-path-deletion`.
