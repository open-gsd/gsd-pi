<!-- Project/App: gsd-pi -->
<!-- File Purpose: Milestone decision record for the state-DB cutover milestone. -->

# State-DB cutover milestone decision — D005 superseded for filesystem-state authority only

> **Status:** Active milestone decision. Recorded 2026-08-02 by the state-DB
> cutover milestone (wave 1, task T002). Governing inputs:
> [`.gsd/DECISIONS.md`](../../.gsd/DECISIONS.md) row D005,
> [`m003-s07-cutover-dossier.json`](m003-s07-cutover-dossier.json),
> [`M003-S07-T07-CUTOVER-DECISION-RESEARCH.md`](M003-S07-T07-CUTOVER-DECISION-RESEARCH.md),
> [`M003-S07-T07-DOSSIER-RESEARCH.md`](M003-S07-T07-DOSSIER-RESEARCH.md),
> [`M003-S07-T07-UAT-SHIP-RESEARCH.md`](M003-S07-T07-UAT-SHIP-RESEARCH.md),
> and `.project/research/SYNTHESIS.md` (decision "D005 standing NO-GO").
>
> **Amended 2026-10-02:** decision D012 supersedes D005 for canonical lifecycle
> read authority. The owner confirmed this decision on 2026-10-02. The D012
> database row is not written yet, so the ID is provisional. The cutover is not finished. See
> [Decision D012](#decision-d012--d005-superseded-for-canonical-lifecycle-read-authority-2026-10-02),
> [Compatibility Window](#compatibility-window-and-removal-gates) and
> [Tracking](#tracking-for-the-remaining-cutover-work).

## Decision

**D005 is superseded for filesystem-state (markdown) read/write authority
only.** For this milestone:

- gsd-db hierarchy reads are the database authority for project state;
- markdown files become pure, read-only projections of that database state;
- the legacy markdown fallback state-derivation path is deleted, not merely
  bypassed.

**D005 remains in force for canonical lifecycle read authority.** The canonical
*lifecycle* read-authority cutover — status-response authority and the public
response surface that the T07 dossier judged NO-GO — stays deferred under the
M003 semantic-shadow program. D005's rule, verbatim from
`.gsd/DECISIONS.md` row D005, still governs that surface:

> Keep legacy handler responses and reads authoritative; canonical lifecycle
> writes and comparisons remain shadow evidence.

The deferred lifecycle surface is protected by the successor gate
`gate:lifecycle-shadow-no-cutover`, which receives the lifecycle-shadow
invariants of the retired `gate:semantic-shadow-no-cutover` verbatim. A future
lifecycle read-authority cutover requires its own separate, explicit decision,
exactly as the T07 cutover decision research demands ("T07 may prove M003
semantic-shadow convergence and close S07, but it may not reverse D005. A
future cutover requires a separate, explicit decision").

## Deferred-blocker classification

Every blocker in the reconciled list (see count reconciliation below) is
classified for whether it touches deletion of the legacy filesystem-state
(markdown projection) path. **All nine are NO**: each blocker concerns
canonical-lifecycle read authority or lifecycle compatibility surfaces only, so
none blocks this milestone's filesystem-state deletion scope.

| Blocker (dossier id) | Touches filesystem-state deletion? | Justification |
|---|---|---|
| `production-read-authority` | NO | Research item 1: "Production status reads and public responses still intentionally originate from the legacy hierarchy" — a canonical-lifecycle status-read surface, not the markdown state files. |
| `canonical-dependency-eligibility` | NO | Research items 2–3: dependency/dispatch eligibility and retry suppression use legacy registry/hierarchy/dispatch ledgers, and legacy `skipped` must yield to the canonical Waiver — routing decisions, not filesystem-state reads. |
| `integrated-slice-source-uat-identity` | NO | Research item 7: slice completion does not yet bind one integrated Slice source snapshot and structured post-completion UAT identity is not part of `slice.completed` — a lifecycle closeout evidence surface. |
| `closeout-effects` | NO | Research item 6 (first half): prepared/settled closeout effects remain later work — a canonical lifecycle write-side surface. |
| `merge-publication-settlement` | NO | Research item 6 (second half): merge/publication settlement remains later work — lifecycle settlement, not markdown state. |
| `park-unpark-discard-adoption` | NO | Research item 5: park, unpark, and discard are named deferred lifecycle command surfaces (compatibility inventory: "Deferred surface"). |
| `projection-work-redesign` | NO | Research item 8: Projection-worker redesign and the 23 pending repair projection heads concern the DB-side lifecycle-shadow projection delivery machinery; the dossier separately forbids "Markdown fallback authority", so this id is a lifecycle projection surface, not the legacy filesystem-state read path. |
| `legacy-cascade-deletion` | NO | Research item 9 (first half): legacy cascade deletion is forbidden until a later deletion-safety gate — it names lifecycle cascade deletion, distinct from this milestone's explicit filesystem-state markdown fallback deletion scope. |
| `compatibility-retirement` | NO | Research items 4, 8, 9: unadopted import/reconcile retirement and compatibility projection retirement are ADR-046-window-timeboxed lifecycle compatibility surfaces. |

## Count reconciliation (9 vs 13)

The checked dossier JSON `docs/dev/m003-s07-cutover-dossier.json` lists **9**
`deferredCutoverBlockers` ids (the authoritative machine-readable inventory;
the dossier research at lines 574–579 enumerates the same nine names).
`M003-S07-T07-CUTOVER-DECISION-RESEARCH.md` "Deferred blockers requiring
NO-GO" enumerates **13** numbered items, and SYNTHESIS.md inherited the "13
named blockers" phrasing from that research list. The reconciliation:

- Research items 1, 2, 4, 5, 7 map one-to-one onto dossier ids
  (`production-read-authority`, `canonical-dependency-eligibility`,
  `compatibility-retirement`, `park-unpark-discard-adoption`,
  `integrated-slice-source-uat-identity`).
- Research item 3 (legacy `skipped` → canonical Waiver) folds into
  `canonical-dependency-eligibility` (compatibility inventory: "Deferred until
  Waiver-backed eligibility").
- Research item 6 splits into two dossier ids (`closeout-effects`,
  `merge-publication-settlement`); research items 8 and 9 contribute
  `projection-work-redesign` and `legacy-cascade-deletion`, sharing
  `compatibility-retirement` with item 4. These eight items thus produce the
  nine unique dossier ids.
- Research items 10–11 (zero live semantic-shadow observation audit rows;
  production observation source provenance `unavailable`) are **not** dossier
  blocker ids — they are observation-coverage facts, recorded in the dossier
  as `observationEvidencePlane: "capstone_fixture"` and corroborated by the
  project DB record: the live project database contains zero
  `lifecycle-shadow-observed`/`lifecycle-shadow-observation-loss` audit rows.
- Research item 12 (hosted checks and exact-merged DB UAT for T07) was a
  verification prerequisite, closed by the T07 ship; it is not a deferred
  cutover blocker.
- Research item 13 ("D005 has not been superseded by a separate explicit
  read-cutover decision") is a governance precondition, not a technical
  blocker; this document is precisely the explicit decision record for the
  filesystem-state portion of that precondition.

**Authoritative count: 9 deferred cutover blockers** (dossier JSON). The "13"
figure is the research doc's broader NO-GO enumeration, which additionally
lists two observation-provenance gaps, one since-closed verification
prerequisite, and one governance precondition.

## Unobservable out-of-repo reader risk — accepted

Projected state physically lives outside the repository: `<project>/.gsd` is a
symlink into `~/.gsd/projects/<hash>/` (ADR-002 amendment, ADR-031,
`repo-identity.ts`). The full set of readers behind that symlink — user-side
tools, `@opengsd/mcp-server` readers, `packages/daemon`,
`integrations/hermes`, and anything else traversing the symlink — is
**unobservable from the repo**, and no repo-side evidence can enumerate it.
This risk is **accepted** for this milestone via the frozen projection
contract: files become pure, read-only projections but stay **byte-compatible
with the pre-cutover format and location**, with additive-only changes (a DB
state-version stamp). Because the projection format does not change, no
external reader can break at the moment authority flips; the residual risk is
limited to readers that depended on *writing* markdown state, which the frozen
format makes visibly read-only rather than silently corruptible.

## Accepted residual risks

Five residual risks are accepted for this milestone. They are recorded here
rather than argued away: the synthesis rule is "do not promise proof that
cannot exist". The frozen projection format they all lean on is specified in
[`state-db-cutover-projection-contract.md`](state-db-cutover-projection-contract.md).

### R1 — No field telemetry for the installed base

There is no telemetry from installed gsd-pi versions, so no evidence exists
about how the installed base actually behaves at the moment authority flips.
**Mitigation (not proof):** static evidence instead of field evidence — the
structural no-authority-read proofs and the fail-closed shims, which make a
degraded read a loud failure rather than a plausible-looking empty answer. We
do not claim the installed base is verified; we claim the failure mode is
bounded and observable at the surface where it happens.

### R2 — Unobservable out-of-repo reader set

Projected state lives behind the `<project>/.gsd → ~/.gsd/projects/<hash>/`
symlink, so the full reader set — user-side tooling, `@opengsd/mcp-server`,
`packages/daemon`, `integrations/hermes`, and anything else traversing the
symlink — is unobservable from the repo (see "Unobservable out-of-repo reader
risk — accepted" above). **Mitigation:** the byte-compatible format freeze.
Projections stay byte-identical to their pre-cutover form apart from the
additive, ignore-safe `<!-- gsd:state-version=R:E -->` stamp, so a reader that
worked before the flip still works after it. Residual exposure is limited to
consumers that *wrote* markdown state; for them the projection layer becomes
visibly read-only rather than silently corruptible.

### R3 — Mixed-version worktree skew (observed, bounded)

T003 ran a pre-cutover v1.11.0 binary against a project whose `gsd.db` had been
bumped past its supported schema
([`state-db-cutover-mixed-version-spike.md`](state-db-cutover-mixed-version-spike.md)).
Observed behavior: **silent divergence, not corruption.** The engine
refuse-newer floor blocked every DB mutation and every pre-existing byte —
database and markdown projections alike — survived unchanged. But the CLI
surfaces automation consumes did not refuse loudly: `headless query` and
`read progress` exited 0 while reporting an empty project, `headless recover`
failed with a generic message that swallowed the version-skew reason, and
`graph build` wrote a new empty derived artifact without consulting the DB
version. **Mitigation:** the refuse-newer surfacing work (loud, non-zero
refusals on read paths, version-stamp checks in projection writers, reason
propagation through rebuild paths) plus the release-note directive to **upgrade
all linked worktrees together** — now empirically justified, since the skew
does not corrupt data but does silently blind older binaries. **Residual risk,
accepted:** a user who ignores the directive and keeps an older binary pointed
at a cut-over project can still read stale or empty state through any surface
not yet converted to a loud refusal. It is bounded by the downgrade window:
2 stable releases + ≥60 days (ADR-046 window, user ruling 2026-08-01).

### R4 — hermes (Python) coupling depth unverified

`integrations/hermes` is a Python consumer of `.gsd/` projections; its
documented contract requires `.gsd/STATE.md` to exist and be non-empty
(`integrations/hermes/docs/setup.md`). How deeply it parses those files beyond
that has **not** been verified in this milestone, and no repo-side test
exercises the coupling. **Accepted** because the format freeze makes the
question moot for this milestone: hermes reads the same bytes it read before
the cutover, so whatever its parse depth is, it is unchanged by this work. The
question must be reopened by whichever milestone proposes to version the
projection format.

### R5 — execute-task no longer verifies SUMMARY presence or checkbox state (#1500, #3607)

`verifyExpectedArtifact` for `execute-task` now reads exactly one thing: the
latest Task Attempt in the DB. With the DB open, a settled Attempt with a
Result decides the outcome; with the DB unavailable the unit fails closed. No
filesystem artifact is consulted on either path.

Two historical guards are **retired** as a direct consequence, and the tests
that asserted them were deleted rather than rewritten:

- **#3607 — checkbox discrimination.** The legacy branch that required a
  checked `- [x] **T0N:` checkbox in the slice PLAN (and rejected an unchecked
  checkbox, a bare `### T0N` heading, a missing plan, or a checkbox for a
  different task id) no longer exists. Nothing in the repo tests checkbox
  discrimination any more, because it is no longer a behaviour of the system.
- **#1500 — sibling flat-phase SUMMARY resolution.** The stale-sibling and
  foreign-milestone phase-dir cases can no longer change an `execute-task`
  verification result in either direction, so the team-suffix projection
  fallback in `findExistingSiblingPhaseArtifact`
  (`artifact-verification.ts`) was deleted as dead code along with its
  `allowSiblingTeamSuffixProjections` caller.

**Reason.** Under DB authority a settled Attempt record *is* the completion
fact (ADR-017). SUMMARY-file path resolution is a projection concern, not a
verification input. The alternative — bolting a filesystem artifact-existence
check back alongside the DB check — was rejected because it reintroduces a
markdown read into a path this cutover deliberately made DB-authoritative
(user ruling, 2026-08-06).

**Observable behaviour change, accepted:** a settled attempt whose SUMMARY file
has been deleted now verifies **true**. Verification will not notice the
missing SUMMARY, and auto mode will not re-dispatch the task to regenerate it.
A missing or misplaced SUMMARY is now a projection-repair concern
(`/gsd rebuild`), not a verification failure.

The six deleted tests were retired because each had become unfailable: with
DB-closed `execute-task` verification returning `false` unconditionally and
DB-open verification returning before any path resolution, no fixture on disk
could flip their result. A test that cannot fail reads as protection that does
not exist, which is worse than no test at all.

### Downgrade window

R1–R4 are scoped by the same window, ADR-046 verbatim: *"Explicit
legacy import/export compatibility remains for two stable releases and at least
60 days, whichever is longer, beginning when Import Preview and Import
Application ship."* This milestone's ruling (2026-08-01) restates it as the
downgrade window: **2 stable releases + ≥60 days**. Time alone is not a Removal
Gate; backups remain available through that window and at least one later
stable release.

## Gate retirement never contradicts D005 by silence

Retirement of `gate:semantic-shadow-no-cutover` is a split retirement, not a
removal: every lifecycle-shadow invariant (status-response authority,
disagreement witnesses, decision-boundary allowlists, validation-assessment
authority) moves verbatim into the successor gate
`gate:lifecycle-shadow-no-cutover`, where D005 remains explicitly in force.
Only filesystem-state invariants become positive post-cutover checks, per this
decision's scope. No invariant is dropped, and no gate change may be read as
implicitly reversing D005: D005 is superseded only where this document says so
(filesystem-state authority), and remains authoritative everywhere else until
a future separate, explicit lifecycle read-cutover decision.

## Closeout evidence

Recorded 2026-08-12 at wave-4 closeout (T023). Timebox waiver: cutover release
v1.13.0 (2026-08-08); subsequent stables v1.14.0 and v1.15.0; remaining ≥60-day
calendar window waived by the project owner ("finish all waves"). This waiver
measured the window from v1.13.0. The ADR-046 Compatibility Window starts at
v1.12.0; see [Compatibility Window](#compatibility-window-and-removal-gates).

| Command | Verdict |
|---|---|
| `pnpm run verify:pr` | `build:core` PASS; `typecheck:extensions` PASS; `gate:lifecycle-shadow-no-cutover` PASS. `test:unit` Wave 4 files green. This checkout's `.gsd/gsd.db` is schema v47 vs code `SCHEMA_VERSION` 46, so five command/read-cli tests throw `SchemaTooNew` locally; that is environmental, not a wave-4 regression. |
| `pnpm run baseline:refactor:gate` | PASS (34/34) |
| `pnpm run baseline:refactor:phase0` | PASS (140/140) |
| `pnpm run gate:lifecycle-shadow-no-cutover` | PASS (Structural 7/7, Behavioral 11/11) |
| `pnpm run legacy:cleanup:evidence --file <fresh>` then `legacy:cleanup:gate --file <same>` | PASS (all legacy counters 0; proof zero offenders) |
| `node scripts/legacy-state-path-proof.mjs` | PASS (zero offenders) |
| `pnpm run verify:fast` | PASS |

Deferred out of this milestone (unchanged): canonical lifecycle read-authority
cutover under M003/D005; Phase 5 DB split; separately sequenced product cleanup.

## Decision D012 — D005 superseded for canonical lifecycle read authority (2026-10-02)

**D012 supersedes D005 for read authority.** Canonical lifecycle rows become
the read authority for status, phase, dispatch, and dependency decisions.
D005 ("Keep legacy handler responses and reads authoritative; canonical
lifecycle writes and comparisons remain shadow evidence") stays in the record
as history. It no longer governs new work.

The owner confirmed this decision on 2026-10-02.

This is the separate, explicit decision that this document and the T07 cutover
decision research require before a lifecycle read-authority cutover.

D012 is a decision. It is not the cutover:

- Runtime behavior does not change with this record. Hierarchy reads still come
  from legacy database rows while the Authority Epoch of the Project is 0. Since
  2026-10-04 the first open of an existing project database advances its
  Authority Epoch (`authority-cutover-on-open.ts`) when
  `GSD_AUTHORITY_CUTOVER=1` is set. This is opt-in for now; `CONTEXT.md`
  (State layer) states when it becomes the default.
- `gate:lifecycle-shadow-no-cutover` stays in `verify:pr`. Its checks for a
  Project at Authority Epoch 0 are unchanged. Step 2 inverted its
  read-interface check (see below). The work that removes the legacy reads
  turns the gate into a structural "no legacy status read outside the read
  interface" gate. It does not delete the gate.
- The nine `deferredCutoverBlockers` in the dossier stay open. They are the
  Removal Gates listed below.
- Step 1 of the read cutover is done for these callers only. They ask their
  status questions through the read interface `db/lifecycle-read.ts`:
  `deriveState` (`state/derive/from-db.ts` and the
  active-milestone lookup in `state.ts`), the dispatch guard
  (`dispatch-guard.ts`), the milestone guard at the start of `resolveDispatch`
  and the slice-research rule in `auto-dispatch.ts`, the research check in
  `artifact-verification.ts`, the status response, progress, and the project
  snapshot.
- Step 1 changes one answer. A discarded Milestone is never done: it does not
  satisfy a dependent, and the Milestone counts of progress and of the project
  snapshot leave it out of `total` and `done`. All other answers are the same
  as the legacy reads.
- Since 2026-10-04 these dispatch and dependency sites also ask the read
  interface. Before that date they read legacy rows directly:
  - `auto-dispatch.ts`: the rule "complete → stop" and `findOpenSlices`.
  - `auto/dispatch.ts`: `getAlreadyClosedDispatchReason`. It now also stops a
    `complete-slice` unit for a deferred Slice, because the interface answers
    that a deferred Slice needs no further work.
  - `slice-parallel-eligibility.ts`: `getEligibleSlicesFromRows`. It takes the
    Slices of the interface and no longer reads a status.
  - `queue-order.ts`: the dependency graph, the dependency warnings, the
    rendered queue order, and the closed and discarded checks of
    `set-dependencies`.
  - `reactive-graph.ts`: the done flag of each Task.
  - `auto-start.ts`: the milestone branch audit, the lookup of a completed
    Milestone with an unmerged branch, the stale runtime unit cleanup, the
    preflight-stash audit and the queue pre-flight. A Milestone is complete
    there when the interface answers `done`. Before, only the raw status
    `complete` counted; the legacy aliases `done` and `closed` now count too.
  - `auto.ts`: the merge decision of `stopAuto`, the Slice count of the
    completion widget, and the terminal check of a paused session.
  - `state.ts`: `isGhostMilestone`.
- Since 2026-10-04 parallel eligibility (`parallel-eligibility.ts`) takes the
  Milestone universe from the registry of `deriveState`, which reads the
  database. It does not scan the milestone directories. A directory with no
  Milestone row is not listed; before, it was listed as ineligible. A
  Milestone row with no directory is a candidate, with one exception: a queued
  row that was never planned (no saved CONTEXT or CONTEXT-DRAFT, no Slices) is
  listed as ineligible with the reason "no planning data". `isGhostMilestone`
  answers this from rows.
- Since 2026-10-04 the closeout, recovery, post-unit and verification sites
  also ask the read interface. The interface has three more questions for
  them: one Slice (`readSlice`), one Task (`readTask`) and the ids of the
  closed Slices of a Milestone (`readClosedSliceIds`, which replaces
  `getClosedSliceIds` of `db/queries.ts`). A Slice of the interface also
  answers `closed`. Before the Cutover a deferred Slice is not closed (the
  legacy rule); after the Cutover `closed` is the same as `done`. The sites:
  - `auto/closeout.ts`: the skip of a terminal Milestone closeout.
  - `milestone-closeout.ts`: the terminal check for git cleanup, the closeout
    settle check, the GitHub close, and the closed check and the UAT sign-off
    Slices of the `complete-milestone` guard.
  - `closeout-consistency-gate.ts`: the open Milestone, open Slice and open
    Task checks, the pass-through validation check, and the task-scoped gates
    of a cancelled Task. The gate asks the interface whether the Milestone is
    discarded; before, it compared the legacy status with `skipped`. A
    Milestone whose legacy status is `cancelled` or `deferred` now counts as
    discarded too. The tasks of a Slice with the label `deferred` are still
    not checked.
  - `auto-recovery.ts`: the closed check of a Milestone with no lifecycle row.
  - `auto-post-unit.ts`: the incomplete-Slice check, the Tasks of the file
    change check, the rogue SUMMARY check for a Task and a Slice, the ROADMAP
    repair after `complete-slice`, the Tasks that the pre-execution checks
    receive (`pre-execution-checks.ts` applies the status vocabulary to the
    label of those Tasks), and the Task status of the hook retry. The hook
    retry compares the status label of the interface with the lifecycle row.
  - `auto-verification.ts`: the count of incomplete Slices and the completed
    Tasks that the post-execution checks receive.
  - `unit-runtime.ts`: the durable state of an `execute-task` unit.
  - `artifact-verification.ts`: the `reactive-execute` batch and the
    `complete-slice` result.
  - `unmerged-milestone-guard.ts`: the closed Milestones with an unmerged
    branch.
  - `milestone-actions.ts`: the parked and closed checks of park, unpark and
    discard, `isParked`, and the row loop of the discard operation. The loop
    keeps a Slice or a Task that the interface answers as closed and cancels
    the rest.
  - `closeout-wizard.ts`: the stranded Milestone check.
  - `interrupted-session.ts`: the stale scoped pause check.
  - `undo.ts`: the "already open" check of `/gsd undo`.
  - `tools/workflow-tool-executors.ts`: the duplicate `gsd_task_complete`
    check.
  - `uat-dispatch.ts`: the Slices that wait for a UAT verdict and the run-uat
    candidates.
  - `auto-prompts.ts`: `checkNeedsReassessment` and the completed-Slice
    candidates of run-uat.
  - `auto-dispatch.ts` and `auto-direct-dispatch.ts`: the closed Slices of the
    slice-discussion pause and of the direct `reassess` and `uat` dispatch.
  - `tools/plan-slice.ts`: the closed Milestone, closed Slice and closed Task
    checks of `gsd_plan_slice`.
  - `tools/plan-task.ts` and `tools/replan-task.ts`: the closed Slice and
    closed Task checks.
  - `tools/replan-slice.ts`: the closed Milestone and closed Slice checks, the
    completed blocker Task, the completed Tasks that a replan cannot change,
    and the `blocker-accepted` provenance of the blocker Task.
  - `tools/reassess-roadmap.ts`: the closed Milestone check, the completed
    Slice of the call, the completed Slices that a reassessment cannot
    change, and the completed Task of a removed Slice.
  - `milestone-planning-persistence.ts`: the closed Milestone check of
    `gsd_plan_milestone` and the state of each `depends_on` Milestone.
  - `tools/complete-task.ts`: the closed Milestone, Slice and Task checks of
    the legacy completion writer. After the Cutover every Task has a lifecycle
    row, and that writer runs only for a blocker report.
  - `tools/complete-milestone.ts`: the closed Milestone check that keeps the
    SUMMARY file of a superseded completion, and the closed Milestone, Slice
    and Task checks of the legacy completion.
  - `state-reconciliation/drift/artifact-db.ts`: the closed Milestone, Slice
    and Task checks of the two drift checks that block dispatch (a SUMMARY of
    open work, and a completed closeout dispatch of an open Milestone).
  - `doctor-engine-checks.ts`: the same two checks of doctor
    (`artifact_db_status_divergence`, `completed_milestone_reopened`), the
    closed Milestones of the validation source check, the discarded
    Milestones of the missing artifact file check, and the terminal Task of
    the stranded succeeded Attempt check.
  - `doctor-state-checks.ts`: the done Slices and Tasks and the pending and
    skipped Slice labels of the directory, plan and REPLAN checks, and the
    live Milestone of the `planning_blocked` check.
  - `milestone-implementation-evidence.ts`: the completed Tasks whose files
    attribute a commit with no trailer to a Milestone. This replaces
    `getCompletedMilestoneTaskFileHints` of `db/queries.ts`.
  - `parallel-merge.ts`: the complete Milestones of the merge order. It reads
    the project database through its own connection, so the interface has one
    question that takes a connection (`readMilestoneDoneIn`).
  - `commands-maintenance.ts`: the complete check of the stale milestone
    branch cleanup (`/gsd cleanup`).
  - `doctor.ts`: the default doctor scope.
  - `guided-flow.ts`: the complete Slices of the discuss flow, and the
    `queued` label of the stale pending auto-start check.
  Notes on these commands:
  - Where a command tells a completed row from a cancelled one, it applies
    the status vocabulary (`skipped`, `deferred`, `cancelled`,
    `blocker-accepted`) to the status label of the interface.
    `reassess-roadmap` keeps a Slice with the label `deferred` out of the
    completed Slices, because after the Cutover that Slice is closed.
  - A planning command adopts a missing lifecycle row from the status label.
    After the Cutover no row is without a lifecycle row, so this does not
    run.
  - When the legacy row and the lifecycle row of a Milestone disagree,
    `gsd_plan_milestone` passes its precondition from the lifecycle row. The
    status writer then refuses the write ("canonical and legacy status
    mismatch"). The refusal is loud and no status changes.
  - The stale-branch cleanup does not delete a branch today. `listWorktrees`
    reports a milestone branch with no worktree as an orphan entry, and the
    cleanup skips each branch that `listWorktrees` reports. The cleanup
    reaches the complete check only for a branch that a worktree outside the
    managed worktree directory has checked out (for example the project
    root), and git refuses to delete a checked-out branch. The test observes
    the refused delete.
  - Before the Cutover the answers do not change, with three exceptions. The
    stale-branch cleanup now also treats the legacy aliases `closed` and
    `blocker-accepted` of a Milestone as complete, as the interface does. The
    parallel merge now also treats `done`, `closed` and `blocker-accepted` as
    complete. The stranded succeeded Attempt check now also treats `done`,
    `skipped` and `closed` of a Task as terminal.
  - The legacy completion of `tools/complete-milestone.ts` runs only for a
    Milestone with no lifecycle row. After the Cutover the database refuses a
    hierarchy row with no lifecycle row (`db-lifecycle-coverage-schema.ts`),
    so it does not run, and it has no test after the Cutover. The same holds
    for the hook retry of a Task with no lifecycle row.
  - The doctor check `db_done_task_no_summary` is deleted. Its query named a
    `summary` column that the `tasks` table does not have, so the query
    failed and the check never reported.
  - The superseded completion test proves one direction only: the SUMMARY
    file of a Milestone that only the lifecycle row closes is kept. When only
    the legacy row is complete, the file is still there after the completion
    returns. The cause was not examined; the SUMMARY renderer reads legacy
    rows.
  The behavior tests are in `tests/lifecycle-read-cutover.test.ts`,
  `tests/lifecycle-read-cutover-decision-sites.test.ts`, and beside the
  tests of the same site in `tests/complete-milestone-projection-stale.test.ts`,
  `tests/post-unit-retry-on-orchestrator-bridge.test.ts`,
  `tests/auto-recovery.test.ts`,
  `tests/task-completion-compatibility-adapter.test.ts`,
  `tests/doctor-planning-blocked-2510.test.ts` and
  `tests/adopted-milestone-validation-waiver.test.ts`. A
  cut-over Project cannot reach three of the routed lines, so they have no
  test after the Cutover: the closed check of a Milestone with no lifecycle
  row in `milestone-closeout.ts` (`isCompletedMilestoneTerminal`) and in
  `auto-recovery.ts`, and the "validation required" check of
  `closeout-consistency-gate.ts` for such a Milestone. These routed lines
  have no test of their own; the test of the interface answer that they use
  covers them: the Slice check of `isCompletedMilestoneTerminal`, the settle
  check and the GitHub close in `milestone-closeout.ts`, the incomplete-Slice
  check and the Tasks of the file change check in `auto-post-unit.ts`, the
  two reads of `auto-verification.ts`, the closed Slices in
  `auto-dispatch.ts` and `auto-direct-dispatch.ts`, and the `queued` label
  of the stale pending auto-start check in `guided-flow.ts`.
- The Milestone readiness class in `state/derive/from-db.ts` (queued shell,
  needs discussion) uses the status label of the interface, because the
  lifecycle vocabulary has no word for queued. `auto/orchestrator.ts`,
  `guided-flow-queue.ts` and `guided-flow.ts` apply the status vocabulary to
  the registry of `deriveState`, which reads the interface.
- Since 2026-10-04 every reader that decides or reports takes the Milestone
  universe from `readListedMilestoneIds` of the read interface: the listed
  rows in workflow order, with no discarded Milestone. These readers do not
  scan the milestone directories:
  - `commands/handlers/auto.ts`: the target check of `/gsd auto <id>` and
    `/gsd next <id>`. A directory with no row is not a target, and a row with
    no directory is one.
  - `guided-flow.ts`: the first-Milestone decision of the `/gsd` entry and the
    greenfield decision of a new Milestone discussion. A Milestone row with no
    directory is a Milestone; before, such a project got the new-project
    prompt.
  - `guided-flow-queue.ts` (`/gsd queue`) and `rethink.ts` (`/gsd rethink`):
    the "no milestones" check and the Milestone list of the prompt.
  - `auto-start.ts`: the queue pre-flight message.
  - `auto-prompts.ts`: the prior Milestone summaries of the discuss-milestone
    and plan-milestone prompts.
- A scan of the milestone directories (`findMilestoneIds`) stays only where
  the directories are the subject:
  - Id reservation, so that a directory with no row keeps its id:
    `guided-flow.ts` (each call of `nextMilestoneIdReserved`),
    `commands-backlog.ts`, `tools/milestone-hierarchy.ts`, and the next-id hint
    in the `/gsd queue` add prompt (`guided-flow-queue.ts`). The reservation
    adds the database ids to the scan.
  - The `/gsd` entry check for a milestone directory that has entries and no
    recognized Milestone (#456, `guided-flow.ts`).
  - Doctor and drift checks, which compare the directories with the rows:
    `doctor-runtime-checks.ts` (orphan directories),
    `doctor-state-checks.ts` (only when the registry is empty),
    `state-reconciliation/drift/artifact-db.ts`,
    `state-reconciliation/drift/roadmap.ts`,
    `state-reconciliation/drift/project-md.ts`, and
    `migration-auto-check.ts` (markdown hierarchy scan).
  - `workspace-index.ts`: only when no database is open. With a database it
    reads the rows.
- Since 2026-10-04 the prompt builders of `auto-prompts.ts`, the
  discuss-slice prompt (`guided-flow.ts`) and the queue context
  (`guided-flow-queue.ts`) take ROADMAP, CONTEXT, CONTEXT-DRAFT, RESEARCH,
  PLAN and SUMMARY text from artifact rows (`getScopedArtifact`: Milestone,
  Slice or Task, and artifact type). They do not read the projection file.
  A file with no artifact row is not narrative: the prompt shows the same
  "not found" note as for a missing file. The Task SUMMARY list of a Slice
  comes from the rows; the tasks directory is not listed. The source path in
  the prompt is the path of the artifact row. With no artifact row it is the
  path where the projection file is rendered; for the Task plan of the
  execute-task and reactive-execute prompts it is then the text "durable
  task planning state".
  Behavior tests:
  `tests/prompt-narrative-gate-g1.test.ts` (Gate G1 for these prompts: the
  files deleted, and the files changed). The G2 prompt check and the G2
  projection read check of `tests/db-authority-gates.test.ts` are enforced.
- A SUMMARY follows the item row, not the artifact row alone. A Slice or Task
  that is not done has no SUMMARY narrative: a reopen removes the file and
  keeps the artifact row. One precedence rule applies to all narrative that
  has a carrier column (`tasks.full_plan_md`, `tasks.full_summary_md`,
  `slices.full_summary_md`): the carrier is the first source, because the
  Domain Operation writes it in the transaction of the lifecycle change and
  a reopen or a re-plan clears or replaces it. The artifact row is the
  second source: a projection drain writes it later, and it gives the text
  only when the carrier is empty (an imported summary). So a Task that
  `gsd_task_complete` just committed gives its summary to the next prompt
  before its projection is rendered, and the recovery re-plan prompt has the
  Task plan from the carrier. Narrative with no carrier (ROADMAP, CONTEXT,
  CONTEXT-DRAFT, RESEARCH, Slice PLAN) comes from the artifact row. A CONTEXT-DRAFT
  row is a discussion seed only while the Milestone has no saved CONTEXT:
  saving the final CONTEXT removes the draft file and keeps the draft row.
  Behavior tests: `tests/prompt-summary-narrative.test.ts` (the real
  completion and reopen handlers) and the draft seed tests of
  `tests/discuss-routing-fixes.test.ts`.
- These prompt inputs are still read from files: VALIDATION, slice
  ASSESSMENT, CONTINUE, RUNTIME.md, QUEUE.md, the DECISIONS.md register of
  the discuss prompts, and the file lists of the rewrite-docs prompt. The
  root file entries of the source file list (PROJECT, REQUIREMENTS, DECISIONS,
  QUEUE) are listed when the file exists. Display paths of an artifact with no
  row, and directory paths, come from the directory layout on disk; Gate G1
  for prompts therefore deletes the files and keeps the directories.
  `bootstrap/system-context.ts`, `preparation.ts` and the task graph of
  `reactive-graph.ts` also read PLAN and SUMMARY files.
- Since 2026-10-04 the progress widget (`auto-dashboard.ts`) and the dashboard
  overlay (`dashboard-overlay.ts`) take the Slices, the Tasks and their done
  flags from the read interface. A Slice or Task that needs no further work
  counts as done; before, only the raw statuses `complete` and `done` counted.
- Step 2 is done in the read interface (2026-10-04). The project Authority
  Epoch chooses the read source, in one function (`cutoverHasRun`) and per
  Project, never per item:
  - Epoch 0: the interface answers from legacy rows, as in step 1.
  - Epoch above 0 (the Cutover has run): the interface answers from the
    canonical lifecycle rows. An item is complete when its lifecycle is
    `completed` or `blocker-accepted`. A Milestone is done when it is
    complete, parked when its lifecycle is `paused`, and discarded when it is
    `cancelled`. A Slice or Task needs no further work when it is complete or
    its lifecycle is `cancelled`. A hierarchy row with no lifecycle row is
    pending; its legacy status does not answer for it.
  - After the Cutover a cancelled Slice releases the Slices that depend on it
    only when it has an active cancellation Waiver. The legacy `skipped` and
    `deferred` statuses do not release a dependent. A cancelled Milestone
    never satisfies a dependent Milestone, with or without a Waiver (the
    step 1 rule).
  - After the Cutover the status label of an item (`status`) is the legacy
    label when that label names the same lifecycle status, because the
    lifecycle vocabulary has no word for queued, active, parked or deferred.
    When the legacy row names another status, the label is the legacy name of
    the lifecycle status. The label decides nothing except the Milestone
    readiness class (queued shell, needs discussion) and the "active" count of
    progress.
  - A read that cannot query `project_authority` fails. It does not answer
    from either source.
- The gate check `read-interface-epoch-authority` is the inverse of the former
  `read-interface-legacy-authority` check. It fails when the read interface
  does not read the Authority Epoch, reads it in more than one function, does
  not query canonical lifecycle rows, or loses a legacy reader. The gate has
  five behavior witnesses for a cut-over Project in
  `tests/lifecycle-read-cutover.test.ts`. The same file has the behavior tests
  for the sites that were routed on 2026-10-04. The gate lists `readSlice`,
  `readTask` and `readClosedSliceIds` as entries of the interface.
- The legacy readers and the adopted/unadopted branches are not deleted. That
  is later work.
- The Cutover is refused while a hierarchy row has no lifecycle row
  (`db-lifecycle-coverage-schema.ts`). After the Cutover every hierarchy row
  has a lifecycle row, and a branch for a row with no lifecycle row does not
  run.
- These sites still read legacy rows directly (2026-10-04). The first one is
  not routed yet. The other three are deleted with the legacy path. On a
  cut-over Project the first two follow the legacy row when the rows
  disagree; the last two serve legacy data only:
  - `auto-prompts.ts`: the Slices whose summaries the `complete-milestone` and
    `validate-milestone` prompts inline, and the open Tasks that the
    `rewrite-docs` prompt lists. `guided-flow.ts`: the complete Slices whose
    summaries the slice-discussion prompt inlines. `rethink.ts`: the Slice
    counts in the rethink prompt. They choose prompt content. The prompt
    narrative cutover (#2630) took the text of these prompts from the
    database and did not change these status reads.
  - `db/writers/task-execution.ts` and `stageTaskCompletion` in
    `task-completion-compatibility-adapter.ts`: a staged completion refuses a
    Task whose legacy row is `complete`, `done` or `closed`. The check is a
    guard of the write to the legacy row, in the SQL of the writer. The
    refusal is loud. It is deleted with the legacy path.
  - `db/queries.ts`: the SQL for an escalation that was resolved before the
    database stored escalations (`findUnappliedEscalationOverride`,
    `listUnappliedLegacyEscalations`) requires an open Slice, an open
    Milestone and an open next Task by legacy status. It serves legacy data
    only. It is deleted with the legacy path.
  - `db/writers/cascades.ts`: `reopenMilestoneCascade` reopens a legacy
    closed Milestone. It refuses a Milestone that has a lifecycle row. After
    the Cutover every Milestone has one, so it does not run. It is deleted
    with the legacy path.
- These checks compare a projection file with the rows that its renderer
  reads. They read legacy rows, as the renderers do (see the next list), and
  they move to the lifecycle rows with the renderers. A check that reads
  other rows than its renderer reports a difference that a new render cannot
  remove. None of them is part of pre-dispatch reconciliation
  (`state-reconciliation/registry.ts`): they run in the Projection Worker or
  in doctor, and they do not block dispatch:
  - `state-reconciliation/drift/roadmap.ts`: the ROADMAP file against the
    Slice rows (presence, order, depends, checkbox), and the Milestones whose
    missing ROADMAP file a render restores (`isRoadmapRenderable`).
  - `state-reconciliation/drift/stale-render.ts`: `detectStaleRenders` of
    `markdown-renderer.ts`.
  - `doctor-engine-checks.ts`: the checkbox check
    (`checkbox_db_status_divergence`) and the Milestones whose files a render
    restores (`milestonesWithMissingFiles`).
  - `doctor-state-checks.ts`: the `missing_roadmap` check, which uses
    `isRoadmapRenderable`.
  `doctor-git-checks.ts` is not in this group: it applies the status
  vocabulary to the registry of `deriveState`, which reads the interface.
  Doctor reports each row whose legacy status and lifecycle status disagree
  (`lifecycle_shadow_mismatch`).
- These sites read legacy rows directly and stay as they are, because they
  only display or render a status, or they map a legacy status for adoption:
  - `markdown-renderer.ts`, `workflow-projections.ts`, `projection-worker.ts`,
    `state-contract.ts`, the PARKED marker and the park reason in
    `milestone-park-projection.ts`, the Milestone Sequence of PROJECT.md in
    `tools/workflow-tool-executors.ts`, the removal of stale PLAN files and
    the checkbox render after `tools/plan-slice.ts` and
    `tools/replan-slice.ts`, and the SUMMARY file removal in
    `tools/complete-milestone.ts`: they render projections.
  - `parallel-monitor-overlay.ts`
    (with `getParallelMonitorSliceProgress` and the completion list of
    `db/queries.ts`), `visualizer-data.ts`, `visualizer-views.ts`,
    `export.ts`, `export-html.ts` and `commands/handlers/core.ts`: they draw
    progress in the terminal, the visualizer and the exported reports.
  - `workspace-index.ts`: the `done` flags of the workspace index that the
    web interface shows. Its Milestone list and Milestone status come from
    the interface.
  - `auto-worktree-merge-message.ts`: the complete Slices and Tasks in the
    text of the milestone merge commit.
  - `forensics.ts`: the completion counts of the forensics report.
  - `discussion-handoff.ts` and `tools/milestone-hierarchy.ts`: the status in
    a message to the user.
  - `uok/plan-v2.ts`: the status in the metadata of a plan graph node.
  - `migration-auto-check.ts`, `flat-phase-migration.ts`, `migrate/` and the
    `legacy-import-preview-*.ts` files: they migrate or import files.
  - `milestone-summary-classifier.ts`: it reads the status of a SUMMARY file,
    not of a row.
  - `lifecycle-backfill-domain-operation.ts`, `db/writers/`, `gsd-db.ts`,
    `db/lifecycle-shadow-comparison.ts`, `state/project-snapshot.ts` and
    `state/external-reads-from-db.ts`: they map or write a legacy status.
  The files `custom-workflow-engine.ts`, `run-manager.ts`, `graph.ts`,
  `quality-gate-closure.ts` and `auto/unit-phase.ts` compare the status of a
  workflow step or of a gate row. That is not a hierarchy status.
  The other status helpers of `db/queries.ts` (`getHierarchyCompletionCounts`,
  `getMilestoneStatusCounts`, `getInFlightSliceCount`, `getSliceStatusSummary`,
  `getSliceTaskCounts`) answer the interface before the Cutover;
  `forensics.ts` also reads the first one. `TERMINAL_STATUS_SQL` of
  `db/sql-constants.ts` has no reader outside `db/` and `gsd-db.ts`.

**Database record — pending.** The project database is the source of truth for
decisions, and on 2026-10-02 it has no row for this decision: the last decision
is D011. Until the row exists, this decision is recorded in prose only.

- The row must be written with `gsd_decision_save` with `supersedes` set to
  D005. The tool marks D005 as superseded in the same operation.
- D012 is the predicted next ID, not an assigned ID. If a different decision is
  saved first, the tool assigns a different ID, and every "D012" in this
  document, `CONTEXT.md`, `.project/STATE.md`, and the plan-of-plans closeout
  must change to the assigned ID.
- The proof is a read-only query of the project database that returns a
  decision that names D005 as superseded. A repository test cannot make this
  proof, because the project database is not tracked in the repository.

This document does not replace that row.

## Compatibility Window and Removal Gates

ADR-046 starts the Compatibility Window "when Import Preview and Import
Application ship". The first stable release that contains both is **v1.12.0
(tag date 2026-08-03)**. v1.11.0 does not contain them.

| Condition | Value | State on 2026-10-02 |
|---|---|---|
| Window start | v1.12.0, 2026-08-03 | Recorded here |
| At least 60 days | 2026-08-03 + 60 days = 2026-10-02 | Met |
| Two stable releases | v1.13.0 (2026-08-08), v1.14.0 (2026-08-10) | Met |

Earlier text in this repository measured a "downgrade window" from the
v1.13.0 release and recorded an owner waiver on 2026-08-12. That waiver applied
to the wave-4 deletions only. It is not a Removal Gate for the remaining legacy
paths.

**Time alone is not a Removal Gate** (ADR-046). The window conditions are met,
and that fact permits no deletion by itself. Each legacy runtime path stays
until its own evidence passes. The open Removal Gates are the nine dossier
blockers:

1. `production-read-authority`
2. `canonical-dependency-eligibility`
3. `integrated-slice-source-uat-identity`
4. `closeout-effects`
5. `merge-publication-settlement`
6. `park-unpark-discard-adoption`
7. `projection-work-redesign`
8. `legacy-cascade-deletion`
9. `compatibility-retirement`

ADR-046 migration step 8 adds the general gates: fault and restore gates,
production routing closure, structural no-authority-read tests, telemetry
thresholds, and performance baselines.

## Dossier status: frozen record

[`m003-s07-cutover-dossier.json`](m003-s07-cutover-dossier.json) is a frozen
record of the M003/S07 NO_GO recommendation. Do not regenerate it. The
M003/S07/T07 exact-merged UAT evidence stores its `dossierHash`
(`exact-merged-uat-closure.ts`), and a regenerated file has a different hash.

The record lists references that were retired after it was written:

| Reference in the dossier | State |
|---|---|
| `tests/md-importer-adopted-authority.test.ts` | Deleted in wave 4 (commit `c8a4f5dc5`, 2026-08-12) |
| `tests/semantic-shadow-contract.test.ts` | Deleted in wave 4 (commit `c8a4f5dc5`, 2026-08-12) |
| `tests/semantic-shadow-mode-matrix.test.ts` | Deleted in wave 4 (commit `c8a4f5dc5`, 2026-08-12) |
| `tests/workflow-reconcile.test.ts` | Deleted in wave 4 (commit `c8a4f5dc5`, 2026-08-12) |
| `pnpm run gate:semantic-shadow-no-cutover` | Split-retired into `gate:lifecycle-shadow-no-cutover` |

The dossier counts (no-cutover behavioral 15/15, structural 8/8; authority
revision 195, epoch 0) describe the M003/S07 source revision, not current
`main`. `scripts/m003-s07-cutover-dossier.mjs` no longer emits the retired
gate command. The `scripts/m003-s07-dossier-input.ts` CLI fails closed with
"No-cutover report is required", because the gate that supplied its no-cutover
report is retired. `scripts/__tests__/m003-s07-cutover-dossier.test.mjs` fails when
the dossier lists a file or a pnpm script that does not exist and is not in
this table.

## Tracking for the remaining cutover work

The filesystem-state milestone removed the markdown fallback. It did not
complete the ADR-046 program. The open work is the ADR-046 program Milestones
3 to 11 (issue #1411): database-only runtime and durable Projection Work,
discovery and conversation, recovery and UAT, the Lifecycle Kernel, adapter
convergence and shared closeout, canonical status, canary and documentation,
retirement, and the final audit.

ADR-046 ("Implementation boundary") requires that this work exists as
database-backed Milestones before it starts. On 2026-10-02 the project
database has Milestones M001 to M004 only, and no decision row after D011.
These records are still required:

- the D012 decision row (see above);
- Milestones for the ADR-046 program Milestones 3 to 11, which own the nine
  Removal Gates above;
- one open tracking issue that links those Milestones. No open issue tracks
  the remaining cutover.

User reports that come from the unfinished cutover were closed as point fixes.
They belong to four classes of open work, and each class needs an owner
Milestone:

| Class | Examples |
|---|---|
| Root projections (STATE.md, KNOWLEDGE.md, DECISIONS.md) are stale or cannot be corrected through the database | #2360, #2422, #2424, #830, #169, #1956, #2215 |
| A projection failure or projection drift blocks work | #2449 |
| Legacy rows and canonical lifecycle rows disagree | #2440, #2126 |
| File presence is used as evidence | #2107, #2399, #2256 |
