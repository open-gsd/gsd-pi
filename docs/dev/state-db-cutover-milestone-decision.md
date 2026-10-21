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
calendar window waived by the project owner ("finish all waves").

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

