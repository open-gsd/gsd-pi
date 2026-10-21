# Design: gsd-pi adopts gsd-core's flat-phase structure inside `.gsd/`

**Status:** Proposed (revised — supersedes the `.planning/`-adoption version)
**Date:** 2026-06-21
**Author:** Design session
**Worktree:** `gsd-pi-pi-adopts-planning-layout` on branch `feat/pi-adopts-planning-layout`
**Companion (shipped):** PR #802 — `.gsd/` ↔ `.planning/` compat bridge. That work becomes the migration mechanism for Stage 2.

---

## 1. Goal

A user can open any project in either gsd-core or gsd-pi, freely, with no bridge or drift detection. To get there in two stages:

- **Stage 1 (this spec, gsd-pi side):** gsd-pi keeps `.gsd/` as the directory but adopts gsd-core's **flat-phase internal structure** (`phases/NN-slug/NN-MM-PLAN.md`, tasks as checkboxes inside plan files). This is the bulk of the structural work.
- **Stage 2 (follow-up, gsd-core side, separate PR/repo):** gsd-core changes its default directory from `.planning/` to `.gsd/`. Its structure already matches (flat-phase), so Stage 2 is just a dir-name change + installer migration. Trivial by comparison.

End state: both tools read/write `.gsd/phases/NN-slug/NN-MM-PLAN.md`. One directory, one structure, both tools.

## 2. Decisions locked (from brainstorming)

1. **One unified layout.** Both tools read/write the same directory, same internal structure.
2. **The directory is `.gsd/`.** Both tools eventually standardize on it. (Reversed from an earlier `.planning/` decision after weighing ecosystem fit and staged risk.)
3. **The internal structure is gsd-core's flat-phase shape.** `phases/NN-slug/NN-MM-PLAN.md` with tasks as checkboxes inside `<tasks>` blocks. (Chosen over keeping gsd-pi's milestone-nested structure because flat is simpler, the tasks/ level is redundant, and deferring the structural change to Stage 2 would compound gsd-core's work.)
4. **Tasks dropped on disk.** Task files stop being written; task content lives as checkboxes inside plan files. The DB keeps the task table for dispatch; only the on-disk representation changes.
5. **DB stays as-is.** SQLite stays as gsd-pi's internal index/cache at `.gsd/gsd.db`. No schema change. Tables keep `milestone_id`/`slice_id`/`task_id` columns and names; code keeps those names internally.
6. **Staged rollout.** Stage 1 is gsd-pi only (this spec). Stage 2 is gsd-core only (separate effort). Each stage ships independently.
7. **Approach: layout-policy layer.** A single module owns the layout decisions; all 17 path resolvers delegate to it. The 580 call sites don't change (they call the same resolvers, which now return the flat-phase paths). Function names stay (`resolveMilestonePath` etc.); only their internals change.

## 3. Scope

### Stage 1 (this spec — gsd-pi side)

**In scope:**
- **Layout-policy module** (`layout-policy.ts`) — single source of truth for the segment names, file-naming, and root confirmation (`.gsd/`).
- **Path layer migration** — the 17 resolvers in `paths.ts` route through the policy to emit `phases/NN-slug/...` instead of `milestones/MID/slices/SID/...`. ~6 hardcoded literals in `paths.ts`, ~3 in `markdown-renderer.ts`, ~3 in `md-importer.ts` move behind the policy.
- **Tasks collapse** — task files (`TID-PLAN.md`, `TID-SUMMARY.md`) stop being written. Tasks become checkboxes inside plan files (`<tasks>` XML blocks). The DB keeps the task table; only the on-disk representation changes.
- **Startup auto-migration** — if gsd-pi detects the legacy nested structure (`.gsd/milestones/...`), it backs up, rewrites to flat-phase, and leaves the old dirs for one release as a safety net.
- **Prompt string update** — `auto-prompts.ts` (154 path references) and other prompt emitters produce flat-phase relative paths.
- **Compat-layer removal** — the `.gsd/.compat.json` marker, `external-markdown-edit`/`external-planning-edit` drift handlers, `/gsd sync`, and doctor compat-health from PR #802 are removed. That parity work becomes the Stage 2 migration mechanism for gsd-core.

**Out of scope (Stage 1):**
- **gsd-core changes.** Stage 2.
- **DB schema rename.** Tables stay `milestones`/`slices`/`tasks`.
- **Multi-milestone / legacy-milestone-dir `.planning/` layouts.** Those still import correctly (read path unchanged) but aren't reverse-projected.

### Stage 2 (separate spec — gsd-core side)

**In scope (Stage 2 only, not this spec):**
- gsd-core's installer/init/templates change `.planning/` → `.gsd/`.
- Existing gsd-core projects (`.planning/`) migrate to `.gsd/`.
- Documented as a follow-up; not designed here.

### Non-goals

- Conflict-free concurrent writes. Last-writer-per-entity still applies; git is the human safety net.
- Dropping the DB. The DB stays as the internal index.

## 4. Architecture

### 4.1 The layout-policy module

The keystone of the design. A single module owns the layout decisions:

```ts
// layout-policy.ts

// 1. Root directory name (stays .gsd — both tools standardize here)
export const LAYOUT_ROOT = ".gsd";

// 2. Segment names (the hierarchy levels)
export const LAYOUT_SEGMENTS = {
  level1: "phases",  // was "milestones"
  // plans are files inside level1 dirs, not a subdir — gsd-core flattens this
} as const;

// 3. File-naming policy (was M001-ROADMAP.md / S01-PLAN.md / T01-PLAN.md)
export function phaseDirName(phaseNum: number, slug: string): string {
  return `${pad(phaseNum)}-${slug}`;                    // "01-foundation"
}
export function planFileName(phaseNum: number, planNum: number, suffix: string): string {
  return `${pad(phaseNum)}-${pad(planNum)}-${suffix}.md`;  // "01-01-PLAN.md"
}

// 4. DB path (stays in .gsd/)
export function dbPath(basePath: string): string {
  return join(basePath, LAYOUT_ROOT, "gsd.db");
}

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}
```

The resolvers in `paths.ts` switch to reading from the policy:

```ts
// paths.ts — before
export function resolveMilestonePath(basePath, mid) {
  return join(gsdProjectionRoot(basePath), "milestones", mid);
}

// paths.ts — after (delegates to policy)
import { LAYOUT_SEGMENTS } from "./layout-policy.js";

export function resolveMilestonePath(basePath, mid) {
  return join(gsdProjectionRoot(basePath), LAYOUT_SEGMENTS.level1, mid);
}
```

**Function names stay** (`resolveMilestonePath`, `resolveSlicePath`, etc.). They're called from ~580 sites; renaming them is churn that doesn't serve the goal. Code still says "milestone" internally; disk says "phase."

### 4.2 The tasks collapse

This is the only structural hierarchy change. Today gsd-pi is three levels on disk:

```
.gsd/milestones/M001/slices/S01/tasks/T01/T01-PLAN.md
```

After, it's two levels, matching gsd-core:

```
.gsd/phases/01-foundation/01-01-PLAN.md
```

Task content lives inside the plan file as a `<tasks>` XML block (gsd-core's native model):

```markdown
# 01-01: Set up tooling

<objective>
Set up the build tooling.
</objective>

<tasks>
- [ ] **T01**: Init repo _(30m)_
- [x] **T02**: Add CI _(15m)_
</tasks>

<verification>
Build runs and CI is green.
</verification>
```

What changes:
- `resolveTasksDir`, `resolveTaskFile` → deprecated (return null or removed).
- `renderTaskPlanFromDb` → removed. Task state renders inside `renderPlanFromDb`'s `<tasks>` block.
- `renderTaskSummary` → removed as a *separate file writer*. Task-level summary content (verification evidence, key files, key decisions) that dispatch uses stays in the DB; on disk it renders into the plan file's `<verification>` block or the phase SUMMARY. No data is lost — the DB remains the store; only the per-task-file projection goes away.
- `parsePlan` (legacy parser) already extracts `<tasks>` — the read path works as-is. Task completion status is parsed from checkbox state.
- The DB's task table stays. Auto-mode dispatch (`auto-dispatch.ts`) still assigns work at task granularity using DB state; it just no longer reads/writes individual task files. Task completion status on disk = checkbox state in the plan file, parsed back into the DB on import.

**Boundary:** DB = task-granular (authoritative for dispatch). Disk = plan-granular (gsd-core-compatible contract). The renderer translates DB → disk; the importer translates disk → DB.

### 4.3 Startup auto-migration (legacy nested → flat-phase)

On startup, gsd-pi checks for the legacy nested structure:

1. **Detect:** `.gsd/milestones/` exists (the old internal structure).
2. **Backup:** `cpSync` the affected subtree to `.gsd-backups/migrate-<ts>/` — full copy, reversible.
3. **Transform:** open the DB, read all milestones/slices/tasks, emit flat-phase `.gsd/phases/NN-slug/NN-MM-PLAN.md` via the renderer (now policy-backed).
4. **Verify:** re-parse the written `.gsd/phases/` and confirm milestone/slice/task counts match the DB. If mismatch, refuse and restore from backup.
5. **Remove old tree:** delete `.gsd/milestones/` only after step 4 verifies. The backup is the safety net.
6. **Leave `.gsd-backups/` for one release** as a safety net.
7. **Notice:** one-time user-facing message about the migration, the backup location, and that the old structure is gone.

No DB relocation needed — `gsd.db` stays at `.gsd/gsd.db`. This is simpler than the `.planning/`-adoption version because the root dir doesn't change.

The migration reuses existing infrastructure: the round-trip property suite from PR #802 validates the transform; if counts mismatch, it refuses and restores from backup.

### 4.4 Compat-layer removal

| Component | Fate |
|---|---|
| `compat/compat-marker.ts` + `.gsd/.compat.json` | **Removed** |
| `external-markdown-edit` drift handler | **Removed** |
| `external-planning-edit` drift handler | **Removed** |
| `planning-writer.ts` (the bridge writer) | **Kept** — its flat-phase emitter logic folds into the main renderer |
| `layout-detect.ts` | **Kept** — used by the gsd-core-side Stage 2 migration classifier |
| `/gsd sync` command | **Removed** |
| `/gsd doctor` compat-health line | **Removed** |
| Round-trip property suite (`.gsd/` fixtures) | **Replaced** — new fixtures are flat-phase only |
| `docs/user-docs/switching-between-gsd-tools.md` | **Replaced** — with "Unified `.gsd/` layout" doc |

The `state-reconciliation` drift pipeline stays — it's used for other drift kinds (stale-render, roadmap-divergence, etc.). Only the two external-edit handlers and the marker go.

## 5. Files (new / modified / removed)

### New

| File | Responsibility |
|---|---|
| `src/resources/extensions/gsd/layout-policy.ts` | Segment names, file-naming, DB path |

### Modified

| File | Change |
|---|---|
| `src/resources/extensions/gsd/paths.ts` | 17 resolvers delegate to layout-policy; ~6 literals move |
| `src/resources/extensions/gsd/markdown-renderer.ts` | Renderer emits flat-phase paths via policy; tasks render as `<tasks>` blocks inside plans; ~3 hardcodes move |
| `src/resources/extensions/gsd/md-importer.ts` | Importer reads flat-phase paths via policy; ~3 hardcodes move |
| `src/resources/extensions/gsd/auto-prompts.ts` | 154 path references: `milestones/MID/...` → `phases/NN-slug/...` |
| `src/resources/extensions/gsd/detection.ts` | Legacy nested detection → offer auto-migration to flat-phase |
| `src/resources/extensions/gsd/commands-maintenance.ts` | `handleSync` removed; migration flow added |
| `src/resources/extensions/gsd/commands-handlers.ts` | Doctor compat-health removed |
| `src/resources/extensions/gsd/state-reconciliation/registry.ts` | Remove the two external-edit handlers |
| `src/resources/extensions/gsd/state-reconciliation/types.ts` | Remove `external-markdown-edit` / `external-planning-edit` variants |

### Removed

| File | Reason |
|---|---|
| `src/resources/extensions/gsd/compat/compat-marker.ts` | No drift to track |
| `src/resources/extensions/gsd/compat/index.ts` | Empty |
| `src/resources/extensions/gsd/compat/planning-compat.ts` | Marker activation logic obsolete |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-markdown-edit.ts` | No external edits when layout is unified |
| `src/resources/extensions/gsd/state-reconciliation/drift/external-planning-edit.ts` | Same |
| `src/resources/extensions/gsd/tests/compat-marker.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/planning-marker.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/external-markdown-edit.test.ts` | Obsolete |
| `src/resources/extensions/gsd/tests/external-planning-edit.test.ts` | Obsolete |

## 6. Data Flow

**Normal operation (post-migration):**
1. gsd-pi reads/writes `.gsd/phases/NN-slug/NN-MM-PLAN.md` via the layout-policy-backed resolvers.
2. DB at `.gsd/gsd.db` is the internal index; dispatched from but not the on-disk contract.
3. Tasks live as checkboxes in plan files; parsed into the DB on import; rendered from DB on projection.
4. No compat marker, no drift detection for external edits — both tools write the same layout.

**Startup migration (one-time, for existing nested-structure users):**
1. Detect `.gsd/milestones/`.
2. Backup to `.gsd-backups/`.
3. Read DB, write flat-phase via renderer.
4. Remove old `.gsd/milestones/` tree.
5. Leave backup for one release.

**Cross-tool open (the goal state, after Stage 2):**
- gsd-core opens the project: reads `.gsd/phases/...`, works natively.
- gsd-pi opens the project: reads `.gsd/phases/...`, populates/refreshes DB, works natively.
- No conversion, no bridge, no drift.

## 7. Error Handling

- **Migration failure (counts mismatch):** refuse, restore from backup, surface error. Never leave a half-migrated project.
- **Migration failure (disk full / permission):** refuse, restore, surface. The backup is the safety net.
- **Missing `.gsd/phases/` after migration (user deleted it):** gsd-pi falls back to `.gsd-backups/` and re-migrates. If backup also missing, surface "project state lost — restore from git."
- **Concurrent same-entity edits:** last-writer-per-entity; git is the human safety net.

## 8. Testing

- **Layout-policy unit tests** — segment names, file naming, DB path.
- **Path-resolver tests** — the 17 resolvers return flat-phase paths.
- **Tasks-as-checkboxes tests** — `renderPlanFromDb` emits `<tasks>` blocks; `parsePlan` extracts them back; task status round-trips.
- **Migration tests** — nested fixture → migrate → flat-phase fixture; counts match; backup created; idempotent (second migration is a no-op).
- **Round-trip property suite** — flat-phase-only fixtures; import → render → import stable. Trivially stable because both directions use the same layout.
- **Regression:** `state-reconciliation-drift` (minus the removed handlers), `markdown-renderer`, `gsd-recover`, `gsd-rebuild` stay green.

## 9. Rollout

- **Behind no feature flag.** The layout-policy module is additive; migration is automatic on first startup.
- **One-release backup safety net.** `.gsd-backups/` stays for one release, then a follow-up release removes it.
- **Version bump.** This is a breaking change for existing gsd-pi users (internal structure changes). Minor version bump minimum; the migration is automatic but the change is visible.
- **Docs shipped alongside.** The unified-layout doc replaces the switching-between-tools doc.

## 10. Open Questions for Implementation

- **`auto-prompts.ts` churn (154 refs).** The largest single-file change. Decide whether to do it with a careful search-replace (risky — prompt strings have subtle formatting) or a layout-policy-backed helper that emits the relative path strings. Lean toward the helper to avoid touching 154 lines individually.
- **Tasks-as-checkboxes ↔ DB sync.** When a user checks a task box in gsd-core (editing the plan file), the importer must update the DB's task status. Confirm `parsePlan` → `migrateHierarchyToDb` already does this, or add the mapping.
- **Migration writer scope.** The flat-phase emitter (from `planning-writer.ts` in PR #802) handles basic cases. The migration must handle any gsd-pi project (milestone/slice/task hierarchy), so the emitter needs broadening to emit all milestones/slices as phases/plans with the tasks-collapse logic.
- **Phase numbering stability.** Milestone IDs are `M001`; phase numbers are `01` + a slug. The mapping M001 → 01 is deterministic, but slug derivation from milestone titles must be stable across runs (or the dirs churn on every projection). Decide the slug source.
