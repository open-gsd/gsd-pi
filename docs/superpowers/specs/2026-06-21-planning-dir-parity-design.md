# Design: `.planning/` Round-Trip Parity for gsd-core ↔ gsd-pi

**Status:** Proposed (separate workstream from the `.gsd/` compat layer in PR #802)
**Date:** 2026-06-21
**Author:** Design session
**Depends on:** PR #802 (`.gsd/` compat layer — marker, drift handler, reconcile pipeline)
**Design spec index:** companion to `2026-06-21-gsd-core-pi-backwards-compat-design.md`

---

## 1. Context

The `.gsd/` compat layer shipped in PR #802 gives gsd-core (markdown-only) and gsd-pi (DB-authoritative) round-trip compatibility over `.gsd/*.md`. But gsd-core's **current canonical planning store is `.planning/`**, a different layout. PR #802 does nothing for `.planning/`.

Today gsd-pi treats `.planning/` as "v1 legacy" (`detection.ts:346`) and offers a **one-way, destructive** `/gsd migrate` (`migrate/safety.ts`) that copies `.gsd/` to `.gsd-backups/`, deletes it, and rebuilds `.gsd/` from `.planning/`. After migration, gsd-pi never reads `.planning/` again. If the user returns to gsd-core and edits `.planning/`, those edits are invisible to gsd-pi.

**Goal of this spec:** full bidirectional parity for `.planning/`, as a dedicated workstream. Users who keep their work in `.planning/` (the gsd-core native layout) can interleave with gsd-pi without losing edits in either direction.

## 2. Why this is a separate, harder workstream than `.gsd/` parity

The `.gsd/` layer (PR #802) was tractable because both tools already read/write the **same** `.gsd/` layout — the compat layer just tracks drift and re-imports. `.planning/` is fundamentally different:

1. **Different layout.** `.planning/` is flat (`phases/NN-name/NN-MM-PLAN.md`, root `ROADMAP.md`, `STATE.md`). `.gsd/` is milestone-nested (`milestones/M001/slices/S01/S01-PLAN.md`). A projection in both directions requires a deterministic mapping.
2. **Non-injective mapping.** `migrate/transformer.ts` collapses three distinct `.planning/` source layouts (legacy-milestone-dir, multi-milestone roadmap, flat phases) into one `.gsd/` shape. The original layout is lost. A reverse projection must **choose** a layout — and if it doesn't match what gsd-core wrote, the round-trip mutates structure.
3. **Un-modeled documents.** `.planning/` carries content `.gsd/` has no DB model for: phase-scoped `DISCUSSION-LOG.md`, `PATTERNS.md`, `REVIEWS.md`, `RESEARCH.md`; root `research/*.md` and `codebase/*.md`; `config.json`; workstream dirs.
4. **State schema mismatch.** gsd-core `STATE.md` uses phase-based progress (`total_phases`, `completed_phases`, `percent`). gsd-pi `STATE.md` uses milestone/slice/task status. Both derive from DB state, but the rendering differs.

These are design problems, not implementation details. This spec resolves them.

## 3. Scope

### In scope

- **Read:** gsd-pi imports `.planning/` edits into the DB on startup reconcile (parallel to `.gsd/` import).
- **Write:** gsd-pi projects DB state back to `.planning/` on every projection pass (parallel to `.gsd/` projection).
- **Drift detection:** a new drift kind `external-planning-edit` plus marker entries for `.planning/` files.
- **Layout provenance:** gsd-pi records which `.planning/` layout it read, so the projection writes back the same one.
- **Un-modeled docs:** a pass-through strategy for `DISCUSSION-LOG`, `PATTERNS`, `REVIEWS`, `RESEARCH`, `codebase/`, `research/`, `config.json`.
- **STATE.md projection:** render gsd-pi state in gsd-core's phase-progress schema when projecting to `.planning/`.
- **User doc:** extend `switching-between-gsd-tools.md` with the `.planning/` workflow.
- **Property tests:** round-trip suite for `.planning/` fixtures (parallel to the `.gsd/` round-trip suite).

### Out of scope

- **Workstreams.** gsd-core's `.planning/<project>/workstreams/<ws>/` is a parallel concept to gsd-pi's worktrees. Mapping them is a separate problem; this spec treats workstream dirs as pass-through (preserved, not interpreted).
- **gsd-core changes.** As with PR #802, all work is in gsd-pi. gsd-core stays oblivious.
- **Migration deprecation.** `/gsd migrate` remains for users who want to permanently move to `.gsd/`. This spec adds *coexistence*, not replacement.

### Non-goals

- Conflict-free concurrent writes. Same policy as PR #802: last-writer-per-entity, surfaced in reconcile output, git is the human safety net.
- Perfect byte-identical round-trips for un-modeled docs (see §6).

## 4. Architecture

### 4.1 Reuse, don't fork

The `migrate/` module already has a mature `.planning/` parser (`parser.ts`, `parsers.ts`) and transformer (`transformer.ts` → `transformToGSD`). **Reuse these for the read path.** The write path (`writer.ts` → `writeGSDDirectory`) is `.gsd/`-only; this spec adds a parallel `writePlanningDirectory`.

### 4.2 Layout provenance: `.gsd/.compat.json` extension

Extend the existing compat marker (PR #802) rather than introducing a second marker:

```json
{
  "schema": 2,
  "lastWriter": "gsd-pi",
  "lastProjectedAt": "...",
  "projections": {
    "milestones/M001/M001-ROADMAP.md": { "sha": "...", "entities": ["M001"] }
  },
  "planning": {
    "active": true,
    "layout": "flat-phases",
    "rootSlug": "01-governance-packaging-foundation",
    "projections": {
      "ROADMAP.md": { "sha": "...", "entities": ["M001"] },
      "phases/01-foo/01-01-PLAN.md": { "sha": "...", "entities": ["M001/S01"] }
    },
    "passthrough": {
      "phases/01-foo/01-DISCUSSION-LOG.md": { "sha": "...", "entities": [] },
      "codebase/STACK.md": { "sha": "...", "entities": [] }
    }
  },
  "piVersion": "1.4.0"
}
```

- `planning.active` — whether this project uses `.planning/` at all (set on first detect).
- `planning.layout` — one of `flat-phases` | `multi-milestone` | `legacy-milestone-dir`. Captured at first read so the projection writes back the same shape.
- `planning.projections` — sha map for the **modeled** `.planning/` files (roadmap, plans, summaries, state). These are re-imported on drift and re-rendered on projection.
- `planning.passthrough` — sha map for tracked-but-not-interpreted files (un-modeled docs). Same shape as `projections` (`{ sha, entities }`) so drift is detected, but `entities` is empty and repair only refreshes the sha — content is never parsed or re-rendered.

Marker schema bumps 1 → 2. The PR #802 marker reader already quarantines unknown schemas, so a v1 reader (pre-this-work gsd-pi) safely ignores a v2 marker and regenerates. Migration is implicit.

### 4.3 New drift kind: `external-planning-edit`

Parallel to `external-markdown-edit` (PR #802). Added to the `DriftRecord` union:

```ts
| {
    kind: "external-planning-edit";
    projectionPath: string;       // relative to .planning/, e.g. "phases/01-foo/01-01-PLAN.md"
    expectedSha: string;
    actualSha: string;
    entities: string[];
    passthrough: boolean;         // true = content-only copy, no re-import
  }
```

Detect compares `.planning/` file shas to `marker.planning.projections`. Repair:
- For modeled files: re-import via the existing parser + transformer, then run the hierarchy importer with checkbox status authority scoped to the milestone ids recorded for the drifted file.
- For passthrough files: no DB import (there's nothing to import into); just refresh the marker sha so the next detect treats it as current.

### 4.4 The projection writer: `writePlanningDirectory`

New function in `migrate/writer.ts` (or a sibling). Given the DB state and the recorded layout, emits:

- `PROJECT.md`, `REQUIREMENTS.md`, `ROADMAP.md`, `STATE.md` at root
- `phases/NN-<slug>/NN-MM-PLAN.md`, `NN-MM-SUMMARY.md`, `NN-CONTEXT.md`, `NN-RESEARCH.md` per the layout policy

Layout-specific emission:
- **`flat-phases`**: milestone M00N maps to phase NN; slice S0M maps to plan file NN-0M.
- **`multi-milestone`**: each roadmap milestone section maps to a phase group; naming follows gsd-core's convention.
- **`legacy-milestone-dir`**: reproduce `.planning/milestones/<mid>/phases/...`.

The writer consults `marker.planning.layout` and refuses to project if the layout is unset (forces a read first — can't write a layout you've never seen).

### 4.5 Reconcile flow (extended)

Startup reconcile now:

1. Read `.gsd/.compat.json` (schema 2).
2. If `planning.active` and `.planning/` exists, run `external-planning-edit` detection over `.planning/` files.
3. Repair: import modeled edits, refresh passthrough shas.
4. Re-project: `renderAllFromDb` (`.gsd/`) **and** `writePlanningDirectory` (`.planning/`) if `planning.active`.
5. Write fresh marker with both `projections` and `planning.projections`.

## 5. Layout Provenance Policy

The hard design decision. **Policy: capture-on-first-read, preserve-on-write.**

- On the **first** gsd-pi open of a `.planning/` project (no marker or `planning.layout` unset), the reader infers the layout from directory structure (heuristic in `parser.ts`, already present) and records it in `marker.planning.layout`.
- On **every subsequent** projection, the writer emits exactly that layout. It never reclassifies.
- If the user manually restructures `.planning/` (rare), the next reconcile detects the structure no longer matches the recorded layout and surfaces a **blocker** (`"planning layout changed since last sync — run /gsd sync to re-establish"`) rather than guessing.

This guarantees the round-trip preserves structure. The cost: a one-time re-read is required if the user restructures outside gsd-pi.

## 6. Un-modeled Documents Policy

`DISCUSSION-LOG.md`, `PATTERNS.md`, `REVIEWS.md`, `phase RESEARCH.md`, root `research/`, `codebase/`, `config.json` have no DB representation.

**Policy: pass-through with drift detection.**

- gsd-pi records their sha in `marker.planning.passthrough` but never parses or re-renders them.
- If gsd-core edits them, the drift handler fires (as `external-planning-edit` with `passthrough: true`), refreshes the sha, and **leaves the content untouched**.
- gsd-pi never writes these files. They are gsd-core-owned.

Rationale: trying to model these in the DB would be a much larger effort and the content is often free-form. Pass-through preserves the data and detects edits without pretending to understand them. If a future milestone needs DB-backed discussion logs, that's a separate spec.

**Exception:** if a passthrough file is missing on disk but present in the marker, gsd-pi does **not** restore it (it has no content copy). It logs a warning. The user is expected to recover from git. This is the same last-writer-per-entity policy as PR #802.

## 7. STATE.md Mapping

gsd-core `STATE.md` (YAML frontmatter + markdown) reports phase progress. gsd-pi derives equivalent info from DB status.

**Projection policy:** gsd-pi renders `.planning/STATE.md` from DB state, mapping:

| gsd-pi DB | gsd-core STATE.md |
|---|---|
| Active milestone id | `milestone` |
| Milestone title | `milestone_name` |
| Active phase / milestone status | `status` |
| Slice completion count | `completed_phases` / `total_phases` |
| Active slice id | `stopped_at` (rendered as "Phase NN — <slice title>") |
| Timestamp | `last_updated`, `last_activity` |

The mapping is one-way (DB → STATE.md). gsd-core edits to `STATE.md` are **not** re-imported into the DB (status is gsd-pi-authoritative); they're treated as passthrough for drift purposes only, so gsd-pi's next projection overwrites them. This is consistent with PR #802's "DB wins after import" for `.gsd/STATE.md`.

## 8. Files (new / changed)

| File | Change | Purpose |
|---|---|---|
| `compat/compat-marker.ts` | Extend `CompatMarker` with `planning?` field; bump schema 1→2 | Layout provenance + `.planning/` projection tracking |
| `state-reconciliation/types.ts` | Add `external-planning-edit` to `DriftRecord` union | New drift kind |
| `state-reconciliation/drift/external-planning-edit.ts` | **New** | Detect + repair for `.planning/` (parallel to `external-markdown-edit`) |
| `state-reconciliation/registry.ts` | Register the new handler | Wire into reconcile |
| `migrate/parser.ts` / `parsers.ts` | (verify, likely no change) | Read path already exists |
| `migrate/writer.ts` | Add `writePlanningDirectory` | New: DB → `.planning/` projection |
| `migrate/layout-detect.ts` | **New** | Heuristic that classifies a `.planning/` tree as `flat-phases` / `multi-milestone` / `legacy-milestone-dir` |
| `markdown-renderer.ts` | After `renderAllFromDb`, also call `writePlanningDirectory` if `planning.active` | Write-time projection to `.planning/` |
| `commands-maintenance.ts` | Extend `handleSync` to cover `.planning/` | `/gsd sync` covers both layouts |
| `commands-handlers.ts` | Extend doctor compat-health to report `.planning/` drift | Visibility |
| `tests/planning-round-trip-property.test.ts` | **New** | Round-trip suite for `.planning/` fixtures |
| `tests/__fixtures__/round-trip/planning-flat-phases/` | **New** | Flat-phases fixture |
| `tests/__fixtures__/round-trip/planning-multi-milestone/` | **New** | Multi-milestone fixture |
| `docs/user-docs/switching-between-gsd-tools.md` | Extend | `.planning/` workflow |

## 9. Success Criteria

1. A gsd-core user with a `.planning/`-only project opens it in gsd-pi, sees their phases/plans/state, and continues work — no migration step.
2. Edits made in gsd-core to `.planning/` are imported on the next gsd-pi open (with a visible log).
3. Edits made in gsd-pi are projected back to `.planning/` in the **same layout** gsd-core uses.
4. Un-modeled docs (discussion logs, codebase docs, research) survive round-trips unchanged.
5. `/gsd doctor` reports `.planning/` compat health separately from `.gsd/`.
6. The `.planning/` round-trip property suite is green in CI on at least two layout fixtures.

## 10. Open Questions (to resolve during implementation)

- **Layout detection heuristic robustness.** `parser.ts` already infers layout, but the capture-on-first-read policy depends on it being correct. Property tests with real gsd-core fixtures will stress this.
- **`.planning/` ↔ `.gsd/` dual-active projects.** What if a project has *both*? Policy proposal: `.gsd/` is canonical, `.planning/` is a projection (mirror of `.gsd/` parity). Confirm during implementation.
- **Passthrough file deletion.** If gsd-core deletes a passthrough file, should gsd-pi restore it or accept the deletion? Current policy (§6): accept + warn. Confirm.
- **Performance.** Double projection (`.gsd/` + `.planning/`) doubles write cost on every state change. May need a "project `.planning/` only on reconcile, not on every write" optimization. Defer unless benchmarks show a problem.
- **Marker schema 1→2 migration for existing PR #802 users.** The quarantine-on-unknown-schema policy means a v1 reader ignores v2 and regenerates — safe but loses `.planning/` tracking until both sides upgrade. Acceptable; document it.
