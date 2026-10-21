<!-- Project/App: gsd-pi -->
<!-- File Purpose: ADR (proposed) for completing the flat-phase projection layout migration — records why the legacy/flat coexistence seam is the top recurring bug source, proposes single-sourced layout detection (Option B) as stage 1 toward a forced migration (Option A), and specifies the re-enable path for the disabled stale-render drift detector. -->

# ADR-045: Flat-Phase Layout Migration Completion

> **Disposition under [ADR-046](ADR-046-database-authoritative-workflow-lifecycle.md): Superseded before adoption.** Readable layout compatibility remains an explicit import, export, and projection concern. Startup layout detection, automatic filesystem migration, and either on-disk layout influencing runtime authority are superseded by database-only reads and one-way projections.

**Status:** Proposed — maintainer decision required before any code follows
**Date:** 2026-07-07
**Author:** GSD architecture review
**Related:** ADR-017 (state reconciliation, drift-driven), ADR-035 (projection dirty scope), `CONTEXT.md` Drift / Drift catalog / Worktree State Projection terms, and issues [#852](https://github.com/open-gsd/gsd-pi/issues/852), [#1303](https://github.com/open-gsd/gsd-pi/issues/1303), [#1305](https://github.com/open-gsd/gsd-pi/issues/1305), [#1313](https://github.com/open-gsd/gsd-pi/issues/1313), [#1316](https://github.com/open-gsd/gsd-pi/issues/1316)

## Context

The v1.4.0 "flat-phase" projection layout migration is still half-finished at
v1.8.1. Two on-disk projection layouts coexist:

- **Legacy:** `milestones/<MID>/…` (and nested `slices/<SID>/…`).
- **Flat-phase:** `phases/NN-slug/NN-CONTEXT.md`, `NN-ROADMAP.md`, etc.

The DB remains the single source of truth; both trees are projections of it
(ADR-017). The problem is not the two layouts — it is *how the code decides
which layout a project is in*, and the fact that that decision is neither
single-sourced nor reliable.

### The coexistence contract today

**1. One-time startup migration.** `flat-phase-migration.ts` runs on startup
"when the legacy structure is detected" and moves content from `milestones/…`
into `phases/…`. It is best-effort and non-mandatory: a project can run
indefinitely in the legacy layout, and a project can end up *partially*
migrated (some content moved, some not) if the migration is interrupted or the
detection misfires.

**2. Runtime filesystem-sniffed detection.** There is no persisted layout flag.
Every consumer re-derives the layout at runtime by looking at the disk. The
authority is `isLegacyMilestonesLayout(basePath)` in `paths.ts:659`, which
delegates to `legacyMilestonesHasSubdirs` (`paths.ts:598`): the project is
"legacy" iff `milestones/` exists and contains at least one *content-bearing*
subdirectory (`dirIsContentBearingLegacyMilestone`, `paths.ts:621`).

**3. The metadata-dir poisoning — and its partial mitigation.**
`git-service.ts` stores each milestone's integration-branch metadata at
`milestones/<MID>/<MID>-META.json` (`milestoneMetaPath`, `git-service.ts:392`)
and creates that directory with `mkdirSync(join(gsdRoot(basePath),
"milestones", milestoneId), { recursive: true })` (`git-service.ts:454`) —
**even in flat-phase projects.** Naively, that `milestones/<MID>/` directory
would flip `isLegacyMilestonesLayout` to `true` and route artifact resolution
to the wrong path (`milestones/<MID>/<MID>-CONTEXT.md` instead of
`phases/NN-slug/NN-CONTEXT.md`), trapping units in a finalize-retry loop
(the #852 follow-up).

A **partial mitigation already exists** in `paths.ts` and the ADR must be read
against the *current* state, not the pre-mitigation one:

- `dirIsContentBearingLegacyMilestone` (`paths.ts:621`) now excludes
  `*-META.json`-only directories (a `milestones/<MID>/` holding only metadata
  no longer counts as legacy content), and also excludes *empty* scaffolding
  subdirectories (e.g. an empty `slices/` created alongside the META file).
- `dirIsMetaOnlyLegacyMilestone` (`paths.ts:649`) lets
  `resolveProjectMilestonePath` skip META-only dirs during path resolution.

This mitigation reduces the poisoning but does not remove its root cause: the
integration-branch metadata still lives *inside* the `milestones/<MID>/` tree
whose presence is the layout-detection signal. Detection therefore remains a
heuristic sniff of a directory that a second, unrelated subsystem writes into.

**4. The drift alarm is switched off.** The architecture's core projection
drift detector, `detectStaleRenders` in `markdown-renderer.ts:1020`, is
hard-wired to `return []`. Its own TODO explains why (verbatim):

```ts
export function detectStaleRenders(basePath: string): StaleEntry[] {
  // TODO(flat-phase): stale-render detection is temporarily fully disabled.
  // The isLegacyMilestonesLayout gate is unreliable: git-service.ts creates
  // milestones/<mid>/ directories for integration-branch metadata even in
  // flat-phase projects, making the gate fire true and then producing false
  // stale-render drift in the second reconcile cycle → ReconciliationFailedError
  // → auto-mode blocked (exit 10) for multi-slice/remediation e2e scenarios.
  // Re-enable after path construction is unified and the metadata dir is
  // decoupled from the layout-detection signal.
  return [];
}
```

The real implementation survives as `detectStaleRendersImpl`
(`markdown-renderer.ts:1032`) but is never called from the reconcile path. Per
the Drift catalog, stale-render is a known-repairable Drift class; with the
detector stubbed, **projection drift between the DB and the `.planning/`/`.gsd/`
markdown is invisible** until a downstream failure surfaces it.

### The bug cluster this seam produces

The legacy/flat coexistence seam is the single largest recurring bug source in
recent history. Shipped fixes traceable to it, all within days of this ADR:

| Issue | Symptom | Seam mechanism |
|---|---|---|
| [#1316](https://github.com/open-gsd/gsd-pi/issues/1316) | `renderAssessmentFromDb` wrote a flat-phase filename into a legacy `slices/<SID>/` dir → reassess-roadmap verification broke | render target chose wrong layout |
| [#1313](https://github.com/open-gsd/gsd-pi/issues/1313) | Worktree sync missed the flat-phase `CONTEXT.md` → user re-interviewed, discuss-milestone re-fired | Worktree State Projection missed a flat-phase artifact path |
| [#1305](https://github.com/open-gsd/gsd-pi/issues/1305) | Marker-key mismatch → repeated whole-tree re-imports + leaked `.gsd-backups/migrate-*` dirs | migration re-fired; backup rollback reused/deleted dirs |
| [#1303](https://github.com/open-gsd/gsd-pi/issues/1303) | Re-import rewrote slice `completed_at` to import time | importer round-trip against the wrong layout |
| [#852](https://github.com/open-gsd/gsd-pi/issues/852) (follow-up) | META-only `milestones/<MID>/` flipped detection to legacy → finalize-retry loop | metadata dir poisoned layout detection |

### Inventory: how widely the layout branch spreads

The layout distinction is not localized. **13 non-test source files** under
`src/resources/extensions/gsd/` consult `isLegacyMilestonesLayout` /
`legacyMilestones*` independently (verified at commit `7cca07ae`; see the
Appendix for the per-file line-level breakdown). Each is an independent site
that can drift out of agreement with the others — which is exactly the failure
mode behind #1316 (renderer disagreed with the resolved dir).

## Decision (proposed)

Three options. The recommendation is **A-via-B**: adopt Option B now as a
mechanical, testable stage 1, and treat Option A as the release-gated stage 2
that B is a prerequisite for.

### Option A — Complete the migration (end state)

Make the startup migration **mandatory and verified**: on detecting a legacy
tree, migrate to flat-phase behind a success gate and a backup (reusing
`flat-phase-migration.ts` machinery), refusing to proceed on a failed/partial
migration rather than limping on in a mixed state. After N releases in which
every reachable project has been force-migrated, **delete the legacy branches**
across the 13 files and drop `parsers-legacy.js` from the hot path, then
re-enable `detectStaleRendersImpl` behind the e2e fixtures the TODO names.

- **Benefit:** one layout, one code path, detector re-enabled, the entire bug
  cluster's root cause removed.
- **Risk: HIGH.** Existing users have on-disk legacy trees. A forced migration
  cannot be rolled back casually. #1305 is the cautionary tale: its leaked and
  reused `.gsd-backups/migrate-*` dirs show exactly where a backup/rollback
  contract goes wrong. Option A **must** specify that contract (see
  Consequences) before any code.

### Option B — Single detection authority, keep coexistence (stage 1)

Do not delete anything yet. Instead:

1. **Extract ONE shared layout-detection module** that renderer, importer,
   git-service, doctor, and the auto path all call. `paths.ts` is the natural
   owner — `isLegacyMilestonesLayout` already lives there; the work is making
   the other 12 files route through a single entry point instead of each
   re-deriving from `legacyMilestonesDir` + `existsSync`.
2. **Move integration-branch META storage OUT of `milestones/<MID>/`** — e.g.
   to `.gsd/runtime/<MID>-META.json` or another dot-path the detector ignores —
   so metadata **can never** poison layout detection. This removes the root
   cause the `paths.ts` mitigation only papers over, and requires a small
   read-time fallback so existing on-disk META files are still found.
3. **Re-enable stale-render detection** once detection is single-sourced and
   the metadata dir is decoupled — the two preconditions the TODO names.

- **Benefit:** kills the poisoning root cause and the multi-site drift, is
  mechanical and unit-testable, and is a **prerequisite for A anyway** (A's
  "unify path construction" step is exactly B's step 1).
- **Risk: LOW–MEDIUM.** Mechanical refactor plus a metadata-location change
  with a read-time fallback; no forced data migration.

### Option C — Status quo

Keep the coexistence seam and the disabled detector. The bug list above is the
argument against it: the seam has produced at least five shipped fixes in days,
and the DB-is-source-of-truth invariant currently ships **without** its
projection drift detection. "Do nothing" means continuing to pay that tax and
continuing to fly blind on projection drift. Not recommended.

### Recommendation

**Adopt Option B now; stage Option A behind a maintainer-approved release
plan.** B is safe, testable, and required by A. A delivers the real end state
(one code path, detector on) but carries the on-disk-migration risk that needs
an explicit backup/rollback contract and a release-count decision only a
maintainer can make.

## Consequences

**Re-enabling `detectStaleRenders` restores the Drift catalog's stale-render
entry.** Projection drift between the DB and its `.planning/`/`.gsd/` markdown
becomes visible again and auto-repairable, instead of surfacing only as a
downstream failure. This is the invariant ADR-017 assumes and ADR-035 scopes.

**The false-positive risk the stub was hiding is real and must be fenced.** The
TODO's failure mode was: detector fires true on a poisoned layout →
false stale-render Drift in the second reconcile cycle → `ReconciliationFailedError`
→ auto-mode blocked (exit 10) for multi-slice and remediation scenarios.
Re-enable is therefore **gated on**:

- Detection single-sourced (Option B step 1), so the detector and the resolved
  render target can never disagree.
- Metadata decoupled from the detection signal (Option B step 2), so a
  `milestones/<MID>/` created for META never reads as legacy content.
- **E2e fixtures existing first** for the exact scenarios the TODO names:
  multi-slice reconcile and remediation reconcile, each asserting zero
  false-positive stale-render Drift across two reconcile cycles.

**Option A's forced migration needs a rollback/backup contract** — the
highest-value thing for a reviewer to scrutinize. Learning from #1305:

- Backups must be **uniquely named per attempt** and never reused across a
  re-fired migration (the #1305 marker-key/backup-reuse defect).
- A failed migration must roll back to the backup **without deleting a backup
  that a prior attempt still owns**, and must leave the project in a single,
  coherent layout — never a half-migrated tree.
- Leaked `.gsd-backups/migrate-*` dirs must be cleaned on success and
  detectable on failure.

## Trigger / staging

- **Stage 1 — Option B (mechanical, testable, no maintainer gate beyond
  approving this ADR).** Single detection authority + relocate git-service META
  storage + e2e fixtures + re-enable `detectStaleRendersImpl`. Each is
  separately plannable as a code plan.
- **Stage 2 — Option A (release-gated).** Mandatory verified migration, then —
  after the agreed release count — delete the legacy branches across the 13
  files and drop `parsers-legacy.js` from the hot path.

**Open questions a maintainer must answer before Stage 2:**

1. What is the minimum supported upgrade path — can a user on a pre-v1.4.0
   legacy tree upgrade directly, or is a stepping-stone release required?
2. How many releases must the forced migration ship (every project observed
   migrated) before legacy-branch deletion is safe?
3. Where does relocated integration-branch META live (`.gsd/runtime/` vs.
   another dot-path), and what is the read-time fallback window for existing
   on-disk `milestones/<MID>/<MID>-META.json` files?

## Appendix — Layout-branch inventory (verified at `7cca07ae`)

`grep -rln "isLegacyMilestonesLayout\|legacyMilestones"
src/resources/extensions/gsd --include="*.ts"` (excluding tests) → **13 files**.
Each is an independent site that re-derives or acts on the layout distinction:

| File | Line(s) | Decision it drives |
|---|---|---|
| `paths.ts` | 598, 621, 649, 659 | **Layout-detection authority** — `isLegacyMilestonesLayout`, the content-bearing/META-only heuristics, `legacyMilestonesDir` |
| `markdown-renderer.ts` | 179–182, 528–531, 1020, 1216–1217 | **Render target** — which layout to project into; also the disabled `detectStaleRenders` stub (1020) |
| `md-importer.ts` | 366 | **Import source** — reads legacy dir when importing markdown back to DB |
| `migrate/transformer.ts` | 426–432 | **Migration transform** — filters legacy milestones carrying phases |
| `auto.ts` | 3083–3084, 3098 | **Path resolution** — auto-loop resolves legacy base + layout flag |
| `auto-artifact-paths.ts` | 48–50 | **Path resolution** — worktree `.gsd` vs root anchoring (comment-documented divergence from `legacyMilestonesDir`) |
| `guided-flow.ts` | 413–415, 2162 | **Path resolution** — prefers legacy milestone dirs when present |
| `bootstrap/register-hooks.ts` | 865, 911 | **Path resolution** — hook artifact scanning across both layouts |
| `triage-resolution.ts` | 342 | **Path resolution** — legacy base for triage artifacts |
| `reopen-reason.ts` | 42 | **Gate** — returns null (skips) when a legacy tree exists |
| `escalation.ts` | 42 | **Gate** — returns null (skips) when a legacy tree exists |
| `doctor.ts` | 145–146, 247–248 | **Verification** — health checks probe both `milestonesDir` and `legacyMilestonesDir` |
| `doctor-state-checks.ts` | 338 | **Verification** — skips a state check unless a legacy dir exists |

Bug-history evidence (`git log --grep`): #1316 (`5b106193`), #1313 (`bef0e8ff`),
#1305 (`ae3fb966`), #1303 (`92efa014`), #852 (`fd9116e8` + follow-up guards in
`paths.ts`).
