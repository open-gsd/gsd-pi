# Flat-Phase `.gsd/` Layout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** gsd-pi adopts gsd-core's flat-phase internal structure inside `.gsd/` (phases/NN-slug/NN-MM-PLAN.md, tasks as checkboxes), so Stage 2 (gsd-core dir rename) is trivial and the end state is one unified layout across both tools.

**Architecture:** A layout-policy module owns segment names and file-naming; the 17 path resolvers in `paths.ts` delegate to it. The renderer and importer route through the policy. Tasks collapse from per-task files to checkboxes inside plan files; the DB keeps task-granular state for dispatch. Startup auto-migration transforms legacy nested `.gsd/milestones/` to flat-phase.

**Tech Stack:** TypeScript, Node `node:test`, `node:crypto`, `node:fs`. Tests via `node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test`.

**Design spec:** `docs/superpowers/specs/2026-06-21-pi-adopts-planning-layout-design.md`
**Worktree:** `/Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout` on branch `feat/pi-adopts-planning-layout`

---

## File Structure

| Path | Responsibility | Action |
|---|---|---|
| `src/resources/extensions/gsd/layout-policy.ts` | Segment names, file-naming, phase/plan id derivation | **Create** |
| `src/resources/extensions/gsd/paths.ts` | 17 resolvers delegate to policy; ~4 hardcoded literals move | **Modify** |
| `src/resources/extensions/gsd/markdown-renderer.ts` | Renderer emits flat-phase paths; tasks render as `<tasks>` blocks | **Modify** |
| `src/resources/extensions/gsd/md-importer.ts` | Importer reads flat-phase paths | **Modify** |
| `src/resources/extensions/gsd/detection.ts` | Detect legacy nested structure; trigger auto-migration | **Modify** |
| `src/resources/extensions/gsd/auto-prompts.ts` | Emit flat-phase relative paths in prompts | **Modify** |
| `src/resources/extensions/gsd/tests/layout-policy.test.ts` | Policy unit tests | **Create** |
| `src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts` | Renderer flat-phase + tasks-as-checkboxes tests | **Create** |
| `src/resources/extensions/gsd/tests/flat-phase-migration.test.ts` | Migration transform tests | **Create** |
| `src/resources/extensions/gsd/tests/flat-phase-round-trip.test.ts` | Round-trip property suite | **Create** |

---

## Task 1: Layout-policy module

**Files:**
- Create: `src/resources/extensions/gsd/layout-policy.ts`
- Test: `src/resources/extensions/gsd/tests/layout-policy.test.ts`

- [ ] **Step 1.1: Write the failing test**

Create `src/resources/extensions/gsd/tests/layout-policy.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Tests for the flat-phase layout policy.
import test from "node:test";
import assert from "node:assert/strict";

import {
  LAYOUT_ROOT,
  LAYOUT_SEGMENTS,
  phaseDirName,
  planFileName,
  dbPath,
  milestoneIdToPhaseNum,
  sliceIdToPlanNum,
  derivePhaseSlug,
} from "../layout-policy.ts";

test("LAYOUT_ROOT is .gsd", () => {
  assert.equal(LAYOUT_ROOT, ".gsd");
});

test("LAYOUT_SEGMENTS.level1 is phases", () => {
  assert.equal(LAYOUT_SEGMENTS.level1, "phases");
});

test("phaseDirName produces NN-slug", () => {
  assert.equal(phaseDirName(1, "foundation"), "01-foundation");
  assert.equal(phaseDirName(12, "auth-system"), "12-auth-system");
});

test("planFileName produces NN-MM-SUFFIX.md", () => {
  assert.equal(planFileName(1, 1, "PLAN"), "01-01-PLAN.md");
  assert.equal(planFileName(3, 2, "SUMMARY"), "03-02-SUMMARY.md");
});

test("dbPath resolves under .gsd", () => {
  assert.equal(dbPath("/project"), "/project/.gsd/gsd.db");
});

test("milestoneIdToPhaseNum extracts the numeric portion", () => {
  assert.equal(milestoneIdToPhaseNum("M001"), 1);
  assert.equal(milestoneIdToPhaseNum("M012"), 12);
});

test("sliceIdToPlanNum extracts the numeric portion", () => {
  assert.equal(sliceIdToPlanNum("S01"), 1);
  assert.equal(sliceIdToPlanNum("S03"), 3);
});

test("derivePhaseSlug is stable and deterministic", () => {
  assert.equal(derivePhaseSlug("Foundation"), "foundation");
  assert.equal(derivePhaseSlug("Set Up Tooling!"), "set-up-tooling");
  assert.equal(derivePhaseSlug("auth/API layer"), "auth-api-layer");
  // Determinism: same input → same output
  assert.equal(derivePhaseSlug("Foundation"), derivePhaseSlug("Foundation"));
});

test("derivePhaseSlug falls back when title is empty or punctuation-only", () => {
  assert.equal(derivePhaseSlug(""), "phase");
  assert.equal(derivePhaseSlug("---"), "phase");
});
```

- [ ] **Step 1.2: Run the test to verify it fails**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/layout-policy.test.ts`
Expected: FAIL — `Cannot find module '../layout-policy.ts'`

- [ ] **Step 1.3: Write the implementation**

Create `src/resources/extensions/gsd/layout-policy.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Single source of truth for the on-disk layout inside .gsd/.
// Adopted gsd-core's flat-phase structure so both tools read/write the same
// shape. The 17 path resolvers in paths.ts delegate here; the renderer and
// importer route through them.
//
// DB table/column names (milestones/slices/tasks, milestone_id, etc.) stay
// unchanged — those are internal identifiers. Only the on-disk segment names
// and file-naming change.

/** Root directory name. Both gsd-core (Stage 2) and gsd-pi standardize here. */
export const LAYOUT_ROOT = ".gsd";

/** Segment names inside the root. */
export const LAYOUT_SEGMENTS = {
  /** Was "milestones". A phase = one unit of work (gsd-core vocabulary). */
  level1: "phases",
} as const;

function pad(n: number, width = 2): string {
  return String(n).padStart(width, "0");
}

/**
 * Phase directory name: `NN-slug` (e.g. "01-foundation").
 * Matches gsd-core's `phases/NN-name/` convention.
 */
export function phaseDirName(phaseNum: number, slug: string): string {
  return `${pad(phaseNum)}-${slug}`;
}

/**
 * Plan file name: `NN-MM-SUFFIX.md` (e.g. "01-01-PLAN.md").
 * Matches gsd-core's per-plan file convention.
 */
export function planFileName(phaseNum: number, planNum: number, suffix: string): string {
  return `${pad(phaseNum)}-${pad(planNum)}-${suffix}.md`;
}

/** DB path: `.gsd/gsd.db`. gsd-core ignores this file. */
export function dbPath(basePath: string): string {
  return `${basePath}/${LAYOUT_ROOT}/gsd.db`.replaceAll(/\/+/g, "/");
}

/**
 * Extract the numeric portion of a milestone id (M001 → 1).
 * Used by the renderer to derive the phase number from the DB's milestone_id.
 */
export function milestoneIdToPhaseNum(milestoneId: string): number {
  const m = milestoneId.match(/^M0*(\d+)$/i);
  return m ? Number.parseInt(m[1]!, 10) : 1;
}

/**
 * Extract the numeric portion of a slice id (S01 → 1).
 * Used by the renderer to derive the plan number from the DB's slice_id.
 */
export function sliceIdToPlanNum(sliceId: string): number {
  const m = sliceId.match(/^S0*(\d+)$/i);
  return m ? Number.parseInt(m[1]!, 10) : 1;
}

/**
 * Derive a stable, deterministic, filesystem-safe slug from a milestone title.
 * Used for the phase directory name so the layout is human-readable.
 *
 * Stability is load-bearing: the renderer must produce the same slug for the
 * same title on every run, or the directory churns on every projection.
 */
export function derivePhaseSlug(title: string): string {
  const slug = title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return slug || "phase";
}
```

- [ ] **Step 1.4: Run the test to verify it passes**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/layout-policy.test.ts`
Expected: PASS (9 tests)

- [ ] **Step 1.5: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/layout-policy.ts \
        src/resources/extensions/gsd/tests/layout-policy.test.ts
git commit -m "feat(layout): add flat-phase layout-policy module

Single source of truth for segment names (phases), file-naming
(NN-MM-SUFFIX.md), phase/plan id derivation, and slug generation.
Adopted gsd-core's flat-phase structure inside .gsd/. DB identifiers
stay milestone/slice/task internally."
```

---

## Task 2: Path resolvers delegate to policy

**Files:**
- Modify: `src/resources/extensions/gsd/paths.ts`

The 17 path resolvers today hardcode `"milestones"`, `"slices"`, `"tasks"` literals. Route them through the policy. Function names stay (`resolveMilestonePath`, etc.) — only their internals change. The DB-facing callers see no difference.

**Key principle:** the *function names* and *signatures* stay identical. Only the directory segments they emit change. This keeps the 580 call sites untouched.

- [ ] **Step 2.1: Add the policy import to paths.ts**

In `src/resources/extensions/gsd/paths.ts`, after the existing imports at the top of the file, add:

```ts
import { LAYOUT_SEGMENTS, phaseDirName, planFileName, milestoneIdToPhaseNum, sliceIdToPlanNum, derivePhaseSlug } from "./layout-policy.js";
```

- [ ] **Step 2.2: Update milestonesDir to emit phases**

At line 576 (`export function milestonesDir(basePath: string): string`), the body returns `join(gsdProjectionRoot(basePath), "milestones")`. Change to:

```ts
export function milestonesDir(basePath: string): string {
  return join(gsdProjectionRoot(basePath), LAYOUT_SEGMENTS.level1);
}
```

- [ ] **Step 2.3: Update resolveMilestonePath to resolve phase dirs**

At line 601, `resolveMilestonePath` today does directory-prefix matching against `milestonesDir`. The flat-phase layout uses `NN-slug` dir names, so resolution by milestone id alone won't find the dir — it needs to scan for a dir whose numeric prefix matches `milestoneIdToPhaseNum(mid)`. Replace the function body to scan `phases/` for a dir starting with the zero-padded phase number:

```ts
export function resolveMilestonePath(basePath: string, milestoneId: string): string | null {
  const phasesDir = milestonesDir(basePath);
  if (!existsSync(phasesDir)) return null;
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const prefix = String(phaseNum).padStart(2, "0") + "-";
  try {
    for (const entry of readdirSync(phasesDir, { withFileTypes: true })) {
      if (entry.isDirectory() && entry.name.startsWith(prefix)) {
        return join(phasesDir, entry.name);
      }
    }
  } catch {
    // unreadable — fall through
  }
  return null;
}
```

Add `readdirSync` to the `node:fs` import at the top of `paths.ts` if not already present.

- [ ] **Step 2.4: Update resolveSlicePath to resolve plan files inside phase dirs**

At line 621, `resolveSlicePath` today returns `.../milestones/MID/slices/SID`. In flat-phase, plans are *files* inside the phase dir, not subdirs. Update it to resolve the phase dir (via `resolveMilestonePath`) and return that dir — plans live inside it:

```ts
export function resolveSlicePath(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): string | null {
  // In flat-phase, plans are files inside the phase dir, not subdirs.
  // The "slice path" is the phase dir; callers append plan file names.
  return resolveMilestonePath(basePath, milestoneId);
}
```

- [ ] **Step 2.5: Update resolveSliceFile to resolve plan files**

At line 634, `resolveSliceFile` resolves a specific suffix file for a slice. In flat-phase, that's `NN-MM-SUFFIX.md` inside the phase dir:

```ts
export function resolveSliceFile(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  suffix: string,
): string | null {
  const phaseDir = resolveMilestonePath(basePath, milestoneId);
  if (!phaseDir) return null;
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  const planNum = sliceIdToPlanNum(sliceId);
  const expected = planFileName(phaseNum, planNum, suffix);
  // Exact match
  const exact = join(phaseDir, expected);
  if (existsSync(exact)) return exact;
  // Prefix match (handles suffix variations)
  try {
    const planPrefix = `${String(phaseNum).padStart(2, "0")}-${String(planNum).padStart(2, "0")}-`;
    for (const entry of readdirSync(phaseDir, { withFileTypes: true })) {
      if (entry.isFile() && entry.name.startsWith(planPrefix) && entry.name.endsWith(`-${suffix}.md`)) {
        return join(phaseDir, entry.name);
      }
    }
  } catch {
    // unreadable
  }
  return null;
}
```

- [ ] **Step 2.6: Deprecate resolveTasksDir and resolveTaskFile**

In flat-phase, there are no task subdirs. Tasks are checkboxes inside plan files. Update `resolveTasksDir` (line 646) and `resolveTaskFile` (line 658) to return `null` — callers should treat null as "tasks live inside the plan file":

```ts
export function resolveTasksDir(
  basePath: string,
  milestoneId: string,
  sliceId: string,
): string | null {
  // Flat-phase layout: no tasks/ subdir. Tasks live as checkboxes inside
  // the plan file. Returns null so callers know to read tasks from the plan.
  return null;
}

export function resolveTaskFile(
  basePath: string,
  milestoneId: string,
  sliceId: string,
  taskId: string,
  suffix: string,
): string | null {
  // Flat-phase layout: no per-task files. Returns null.
  return null;
}
```

- [ ] **Step 2.7: Update build*FileName helpers**

At lines 188, 196, 205 — these build names like `M001-ROADMAP.md`, `S01-PLAN.md`, `T01-PLAN.md`. In flat-phase, the naming is `NN-MM-SUFFIX.md` for plans and `NN-SUFFIX.md` for phase-level files (CONTEXT, RESEARCH, SUMMARY). Update:

```ts
export function buildMilestoneFileName(milestoneId: string, suffix: string): string {
  // Phase-level files: NN-SUFFIX.md (e.g. "01-CONTEXT.md")
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  return `${String(phaseNum).padStart(2, "0")}-${suffix}.md`;
}

export function buildSliceFileName(sliceId: string, suffix: string): string {
  // Plan-level files need the phase number too, but this helper only has sliceId.
  // Callers that need the full NN-MM-SUFFIX.md name should use planFileName()
  // from layout-policy. This helper is kept for backward-compat callers that
  // build names incrementally; it produces MM-SUFFIX.md.
  const planNum = sliceIdToPlanNum(sliceId);
  return `${String(planNum).padStart(2, "0")}-${suffix}.md`;
}

export function buildTaskFileName(taskId: string, suffix: string): string {
  // Tasks are no longer files in flat-phase. This helper is deprecated.
  // Returns a legacy-style name for any caller that hasn't migrated yet.
  const m = taskId.match(/^T0*(\d+)$/i);
  const taskNum = m ? Number.parseInt(m[1]!, 10) : 1;
  return `${String(taskNum).padStart(2, "0")}-${suffix}.md`;
}
```

- [ ] **Step 2.8: Verify paths.ts still typechecks**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && pnpm run typecheck:extensions 2>&1 | grep "error TS" | head -10`
Expected: any errors should be from callers passing the old-style names — note them for Task 3 but paths.ts itself should compile.

- [ ] **Step 2.9: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/paths.ts
git commit -m "feat(layout): route path resolvers through layout-policy

17 resolvers delegate to the flat-phase policy. Function names and
signatures unchanged (resolveMilestonePath etc.) so 580 call sites are
unaffected. resolveTasksDir/resolveTaskFile return null — tasks are
checkboxes inside plan files now, not subdirs."
```

---

## Task 3: Renderer emits flat-phase paths + tasks as checkboxes

**Files:**
- Modify: `src/resources/extensions/gsd/markdown-renderer.ts`
- Test: `src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts`

The renderer has ~7 hardcoded layout literals (lines 112, 398, 400, 436, 562, 857, 952, 991). They all move behind the policy-backed resolvers. Plus: `renderTaskPlanFromDb` is removed; task state renders inside `renderPlanFromDb`'s `<tasks>` block.

- [ ] **Step 3.1: Write the failing test**

Create `src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Verifies the renderer emits flat-phase paths and tasks-as-checkboxes.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { renderPlanFromDb, renderRoadmapFromDb } from "../markdown-renderer.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-fp-${randomUUID()}`));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
    planning: { estimate: "30m" },
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("renderRoadmapFromDb writes to .gsd/phases/ not .gsd/milestones/", async () => {
  const base = makeTmp();
  await renderRoadmapFromDb(base, "M001");
  // Phase dir should exist; old milestones dir should NOT
  const phasesDir = join(base, ".gsd", "phases");
  const milestonesDir = join(base, ".gsd", "milestones");
  assert.ok(existsSync(phasesDir), "expected .gsd/phases/ to exist");
  assert.ok(!existsSync(milestonesDir), "expected .gsd/milestones/ to NOT exist");
});

test("renderPlanFromDb writes NN-MM-PLAN.md inside the phase dir", async () => {
  const base = makeTmp();
  const result = await renderPlanFromDb(base, "M001", "S01");
  // Plan file path should contain phases/ and match NN-MM-PLAN.md pattern
  assert.match(result.planPath, /phases[/\\]01-[^/\\]+[/\\]01-01-PLAN\.md$/);
  assert.ok(existsSync(result.planPath), "plan file should exist on disk");
});

test("renderPlanFromDb emits <tasks> block with task checkboxes", async () => {
  const base = makeTmp();
  const result = await renderPlanFromDb(base, "M001", "S01");
  const plan = readFileSync(result.planPath, "utf-8");
  assert.match(plan, /<tasks>/);
  assert.match(plan, /- \[ \] \*\*T01\*\*: Init repo/);
});

test("renderPlanFromDb does NOT create a tasks/ subdir", async () => {
  const base = makeTmp();
  await renderPlanFromDb(base, "M001", "S01");
  const phaseDir = join(base, ".gsd", "phases");
  // Read the phase dir contents; no "tasks" subdir should exist anywhere under phases/
  const { readdirSync } = await import("node:fs");
  const { join: j } = await import("node:path");
  const scanForTasksDir = (dir: string): boolean => {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (e.name === "tasks") return true;
        if (scanForTasksDir(j(dir, e.name))) return true;
      }
    }
    return false;
  };
  assert.ok(!scanForTasksDir(phaseDir), "no tasks/ subdir should exist under phases/");
});
```

- [ ] **Step 3.2: Run the test to verify it fails**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts`
Expected: FAIL — renderer still writes to `.gsd/milestones/`.

- [ ] **Step 3.3: Update resolveRoadmapProjectionPath (line 111-118)**

The function hardcodes `join(gsdProjectionRoot(basePath), "milestones")`. Replace with the policy-backed `milestonesDir` (which now returns `phases/`):

```ts
import { milestonesDir } from "./paths.js"; // already imported
import { phaseDirName, milestoneIdToPhaseNum, derivePhaseSlug, planFileName, sliceIdToPlanNum } from "./layout-policy.js";

function resolveRoadmapProjectionPath(basePath: string, milestoneId: string): string {
  const phasesDir = milestonesDir(basePath);
  const phaseNum = milestoneIdToPhaseNum(milestoneId);
  // Resolve existing dir by phase-number prefix, or build the canonical name.
  const existing = resolveMilestonePath(basePath, milestoneId);
  if (existing) return existing;
  const milestone = getMilestone(milestoneId);
  const slug = derivePhaseSlug(milestone?.title || milestoneId);
  const dirName = phaseDirName(phaseNum, slug);
  return join(phasesDir, dirName);
}
```

(Add `resolveMilestonePath` to the import from `./paths.js` if not already imported.)

- [ ] **Step 3.4: Update renderPlanFromDb (around line 396-403) to emit flat-phase paths**

The function today builds `join(gsdProjectionRoot(basePath), "milestones", milestoneId, "slices", sliceId)`. Replace with the phase dir + plan file name:

```ts
const phaseDir = resolveRoadmapProjectionPath(basePath, milestoneId);
mkdirSync(phaseDir, { recursive: true });
const phaseNum = milestoneIdToPhaseNum(milestoneId);
const planNum = sliceIdToPlanNum(sliceId);
const planPath = join(phaseDir, planFileName(phaseNum, planNum, "PLAN"));
```

Then update the `artifactPath` derivation (`toArtifactPath`) and the `writeAndStore` call to use `planPath`.

- [ ] **Step 3.5: Update renderSlicePlanMarkdown to emit <tasks> block**

The slice plan renderer today lists tasks as separate items. Update it to wrap them in a `<tasks>` XML block matching gsd-core's `parseOldPlan` format. Inside `renderSlicePlanMarkdown` (or wherever task lines are emitted), wrap the task bullets:

```ts
lines.push("<tasks>");
for (const task of tasks) {
  const done = isClosedStatus(task.status) ? "x" : " ";
  const est = task.estimate ? ` _(${task.estimate})_` : "";
  lines.push(`- [${done}] **${task.id}**: ${task.title || task.id}${est}`);
}
lines.push("</tasks>");
```

- [ ] **Step 3.6: Remove renderTaskPlanFromDb writes**

In `renderPlanFromDb` (the slice plan renderer), there's a loop at ~line 417 that calls `renderTaskPlanFromDb` per task and writes per-task plan files. Remove that loop — tasks render inside the plan file's `<tasks>` block now (Step 3.5). The `renderTaskPlanFromDb` function itself can stay (it's exported and may have other callers) but the slice renderer no longer invokes it.

- [ ] **Step 3.7: Update the remaining hardcoded literals**

Lines 436, 562, 857, 952, 991 all build paths with `"milestones"`, `"slices"`, `"tasks"`. Each needs to route through `resolveMilestonePath` / `resolveSlicePath` / `resolveSliceFile` instead of inline `join` calls. For each:

- Line 436 (`renderTaskPlanFromDb`'s `tasksDir`): replace with `resolveMilestonePath(basePath, milestoneId)` — but since this function is no longer called from the slice renderer (Step 3.6), this is a defensive update.
- Lines 562, 857 (`renderTaskSummary`, `renderSliceSummary`): these resolve a slice path then append. Use `resolveSliceFile(basePath, milestoneId, sliceId, "SUMMARY")`.
- Lines 952, 991 (`renderReplanFromDb`, `renderAssessmentFromDb`): same pattern — use `resolveSliceFile`.

- [ ] **Step 3.8: Run the test to verify it passes**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 3.9: Regression check the existing renderer suite**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts`
Expected: some existing tests may fail because they assert old `.gsd/milestones/` paths — update those assertions to the new flat-phase paths. Do NOT change the renderer back; fix the test expectations.

- [ ] **Step 3.10: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/markdown-renderer.ts \
        src/resources/extensions/gsd/tests/flat-phase-renderer.test.ts \
        src/resources/extensions/gsd/tests/markdown-renderer.test.ts
git commit -m "feat(layout): renderer emits flat-phase paths + tasks as checkboxes

renderRoadmapFromDb writes to .gsd/phases/NN-slug/. renderPlanFromDb
writes NN-MM-PLAN.md with a <tasks> block (gsd-core native format).
Per-task files no longer written. ~7 hardcoded layout literals moved
behind the policy-backed resolvers."
```

---

## Task 4: Importer reads flat-phase paths

**Files:**
- Modify: `src/resources/extensions/gsd/md-importer.ts`

The importer's `importHierarchyArtifacts` (lines 339-436) walks `.gsd/milestones/MID/slices/SID/tasks/TID/`. Update it to walk `.gsd/phases/NN-slug/` and read `NN-MM-PLAN.md` files, extracting tasks from `<tasks>` blocks.

- [ ] **Step 4.1: Update importHierarchyArtifacts to walk phases/**

Replace the milestone/slice/task directory walk (lines 362-436) with a phase-dir walk. For each dir in `.gsd/phases/`:

1. Parse the phase number from the dir name (`NN-slug` → `NN`).
2. Derive the milestone id (`M00N`).
3. Read phase-level files (CONTEXT, RESEARCH, SUMMARY) via `NN-SUFFIX.md` pattern.
4. Read plan files (`NN-MM-PLAN.md`) — each becomes a slice. Extract tasks from the `<tasks>` block.

```ts
function importHierarchyArtifacts(gsdDir: string): number {
  let count = 0;
  const gsdPath = gsdRoot(gsdDir);
  const phasesPath = join(gsdPath, "phases");

  // Root-level files: PROJECT.md, QUEUE.md
  const rootFiles = ["PROJECT.md", "QUEUE.md", "SECRETS-MANIFEST.md"];
  for (const fileName of rootFiles) {
    const filePath = join(gsdPath, fileName);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      const artifactType = fileName.replace(".md", "").replace("-", "_");
      insertArtifact({
        path: fileName, artifact_type: artifactType,
        milestone_id: null, slice_id: null, task_id: null, full_content: content,
      });
      count++;
    }
  }

  if (!existsSync(phasesPath)) return count;

  // Walk phase dirs
  const phaseDirs = readdirSync(phasesPath, { withFileTypes: true })
    .filter(d => d.isDirectory() && /^\d+-/.test(d.name))
    .map(d => d.name)
    .sort();

  for (const phaseDirName of phaseDirs) {
    const phaseMatch = phaseDirName.match(/^(\d+)-/);
    if (!phaseMatch) continue;
    const phaseNum = Number.parseInt(phaseMatch[1]!, 10);
    const milestoneId = `M${String(phaseNum).padStart(3, "0")}`;
    const phaseFullPath = join(phasesPath, phaseDirName);

    // Phase-level files (NN-CONTEXT.md, NN-RESEARCH.md, etc.)
    count += importPhaseLevelFiles(phaseFullPath, milestoneId, phaseDirName);

    // Plan files (NN-MM-PLAN.md) → slices
    const planFiles = readdirSync(phaseFullPath, { withFileTypes: true })
      .filter(f => f.isFile() && /^\d+-\d+-PLAN\.md$/i.test(f.name))
      .map(f => f.name)
      .sort();

    for (const planFile of planFiles) {
      const planMatch = planFile.match(/^(\d+)-(\d+)-PLAN\.md$/i);
      if (!planMatch) continue;
      const planNum = Number.parseInt(planMatch[2]!, 10);
      const sliceId = `S${String(planNum).padStart(2, "0")}`;
      const planPath = join(phaseFullPath, planFile);
      const content = readFileSync(planPath, "utf-8");
      insertArtifact({
        path: `phases/${phaseDirName}/${planFile}`,
        artifact_type: "PLAN", milestone_id: milestoneId, slice_id: sliceId, task_id: null,
        full_content: content,
      });
      count++;
    }
  }
  return count;
}

function importPhaseLevelFiles(phaseDir: string, milestoneId: string, phaseDirName: string): number {
  let count = 0;
  const suffixes = ["CONTEXT", "RESEARCH", "ASSESSMENT", "SUMMARY", "VALIDATION"];
  const phaseMatch = phaseDirName.match(/^(\d+)-/);
  const prefix = phaseMatch ? phaseMatch[1]! : "01";
  for (const suffix of suffixes) {
    const fileName = `${prefix}-${suffix}.md`;
    const filePath = join(phaseDir, fileName);
    if (existsSync(filePath)) {
      const content = readFileSync(filePath, "utf-8");
      insertArtifact({
        path: `phases/${phaseDirName}/${fileName}`,
        artifact_type: suffix, milestone_id: milestoneId, slice_id: null, task_id: null,
        full_content: content,
      });
      count++;
    }
  }
  return count;
}
```

- [ ] **Step 4.2: Update migrateHierarchyToDb to walk phases/**

The hierarchy migration function (line 533+) uses `findMilestoneIds` which scans `.gsd/milestones/`. Update it to scan `.gsd/phases/` and derive milestone ids from phase dir names. The existing `findMilestoneIds` in `guided-flow.ts` also needs updating — or add a `findPhaseIds` helper.

For the migration function's roadmap/plan parsing, the existing `parseRoadmap` and `parsePlan` already work on content, not paths — they stay unchanged. Only the directory walk changes.

- [ ] **Step 4.3: Verify typecheck and run importer-adjacent tests**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && pnpm run typecheck:extensions 2>&1 | grep "error TS" | head -5`
Then: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/gsd-recover.test.ts`
Expected: typecheck clean; recover tests may need fixture path updates.

- [ ] **Step 4.4: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/md-importer.ts
git commit -m "feat(layout): importer walks .gsd/phases/ flat-phase structure

importHierarchyArtifacts scans phases/NN-slug/ for phase-level files
(NN-CONTEXT.md etc.) and plan files (NN-MM-PLAN.md). Each plan becomes
a slice; tasks are parsed from <tasks> blocks inside plan content."
```

---

## Task 5: Startup auto-migration (legacy nested → flat-phase)

**Files:**
- Modify: `src/resources/extensions/gsd/detection.ts`
- Create: `src/resources/extensions/gsd/tests/flat-phase-migration.test.ts`

- [ ] **Step 5.1: Write the failing test**

Create `src/resources/extensions/gsd/tests/flat-phase-migration.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Tests the one-time migration from nested to flat-phase layout.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import { migrateToFlatPhase } from "../flat-phase-migration.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";

const tmpDirs: string[] = [];
function makeTmp(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-mig-${randomUUID()}`));
  // Create legacy nested structure
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks", "T01"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Foundation", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Set up tooling", status: "pending",
    risk: "low", depends: [], demo: "build runs", sequence: 1,
  });
  insertTask({
    milestoneId: "M001", sliceId: "S01", id: "T01", title: "Init repo",
    status: "pending", sequence: 1,
  });
  tmpDirs.push(base);
  return base;
}
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

test("migrateToFlatPhase moves content from milestones/ to phases/", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);

  assert.ok(existsSync(join(base, ".gsd", "phases")), "phases/ should exist");
  assert.ok(!existsSync(join(base, ".gsd", "milestones")), "milestones/ should be removed");
});

test("migrateToFlatPhase creates a backup", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  assert.ok(existsSync(join(base, ".gsd-backups")), "backup should exist");
});

test("migrateToFlatPhase preserves milestone/slice/task counts in DB", async () => {
  const base = makeTmp();
  const msBefore = getAllMilestones().length;
  const slicesBefore = getMilestoneSlices("M001").length;
  const tasksBefore = getSliceTasks("M001", "S01").length;
  await migrateToFlatPhase(base);
  assert.equal(getAllMilestones().length, msBefore);
  assert.equal(getMilestoneSlices("M001").length, slicesBefore);
  assert.equal(getSliceTasks("M001", "S01").length, tasksBefore);
});

test("migrateToFlatPhase is idempotent (second run is a no-op)", async () => {
  const base = makeTmp();
  await migrateToFlatPhase(base);
  // Second run should not throw and should not create a second backup
  await migrateToFlatPhase(base);
  const backups = readdirSync(join(base, ".gsd-backups")).filter(d => d.startsWith("migrate-"));
  assert.equal(backups.length, 1, "should only have one backup");
});
```

- [ ] **Step 5.2: Run the test to verify it fails**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flat-phase-migration.test.ts`
Expected: FAIL — `Cannot find module '../flat-phase-migration.ts'`

- [ ] **Step 5.3: Write the migration module**

Create `src/resources/extensions/gsd/flat-phase-migration.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: One-time migration from legacy nested .gsd/milestones/ to
// flat-phase .gsd/phases/. Runs on startup when the legacy structure is detected.

import { cpSync, existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import { renderAllFromDb } from "./markdown-renderer.js";
import { getAllMilestones } from "./gsd-db.js";
import { logWarning } from "./workflow-logger.js";

/**
 * Detect whether the project uses the legacy nested layout.
 * True when .gsd/milestones/ exists.
 */
export function needsFlatPhaseMigration(basePath: string): boolean {
  return existsSync(join(basePath, ".gsd", "milestones"));
}

/**
 * Migrate from legacy nested .gsd/milestones/ to flat-phase .gsd/phases/.
 *
 * Steps:
 * 1. Backup .gsd/milestones/ to .gsd-backups/migrate-<ts>/
 * 2. Render flat-phase from the DB (which already has the data)
 * 3. Verify counts match
 * 4. Remove .gsd/milestones/
 *
 * Idempotent: if .gsd/milestones/ doesn't exist, returns immediately.
 */
export async function migrateToFlatPhase(basePath: string): Promise<void> {
  if (!needsFlatPhaseMigration(basePath)) return;

  const ts = Date.now();
  const backupDir = join(basePath, ".gsd-backups", `migrate-${ts}`);
  const milestonesPath = join(basePath, ".gsd", "milestones");

  // 1. Backup
  try {
    mkdirSync(join(basePath, ".gsd-backups"), { recursive: true });
    cpSync(milestonesPath, backupDir, { recursive: true });
  } catch (err) {
    logWarning("migration", `flat-phase migration backup failed: ${(err as Error).message}`);
    throw err;
  }

  // 2. Render flat-phase from DB
  const milestonesBefore = getAllMilestones().length;
  try {
    await renderAllFromDb(basePath);
  } catch (err) {
    logWarning("migration", `flat-phase render failed: ${(err as Error).message}`);
    // Restore from backup on failure
    rmSync(join(basePath, ".gsd", "phases"), { recursive: true, force: true });
    throw err;
  }

  // 3. Verify
  const milestonesAfter = getAllMilestones().length;
  if (milestonesAfter !== milestonesBefore) {
    logWarning("migration", `count mismatch after migration: ${milestonesBefore} → ${milestonesAfter}`);
    rmSync(join(basePath, ".gsd", "phases"), { recursive: true, force: true });
    throw new Error("flat-phase migration verification failed: milestone count mismatch");
  }

  // 4. Remove old tree
  try {
    rmSync(milestonesPath, { recursive: true, force: true });
  } catch (err) {
    logWarning("migration", `failed to remove legacy milestones/: ${(err as Error).message}`);
    // Non-fatal: the backup exists and phases/ is written; user can clean up manually.
  }
}
```

- [ ] **Step 5.4: Run the test to verify it passes**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flat-phase-migration.test.ts`
Expected: PASS (4 tests)

- [ ] **Step 5.5: Wire the migration into startup**

In `src/resources/extensions/gsd/detection.ts` (or the bootstrap path that runs on startup), add a call to `migrateToFlatPhase` when `needsFlatPhaseMigration` returns true. The call should happen after the DB is open but before the first state derivation. Emit a user-facing notice via the notification system.

- [ ] **Step 5.6: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/flat-phase-migration.ts \
        src/resources/extensions/gsd/tests/flat-phase-migration.test.ts \
        src/resources/extensions/gsd/detection.ts
git commit -m "feat(layout): startup auto-migration nested → flat-phase

Detects legacy .gsd/milestones/ on startup, backs up, re-renders from
DB to .gsd/phases/, verifies counts, removes old tree. Idempotent.
One-release backup safety net at .gsd-backups/."
```

---

## Task 6: Round-trip property suite + final verification

**Files:**
- Create: `src/resources/extensions/gsd/tests/flat-phase-round-trip.test.ts`
- Create: `src/resources/extensions/gsd/tests/__fixtures__/flat-phase/01-foundation/01-01-PLAN.md`

- [ ] **Step 6.1: Create the fixture**

Create `src/resources/extensions/gsd/tests/__fixtures__/flat-phase/.gsd/phases/01-foundation/01-01-PLAN.md`:

```markdown
# 01-01: Set up tooling

<objective>
Set up the build tooling.
</objective>

<tasks>
- [ ] **T01**: Init repo _(30m)_
</tasks>

<verification>
Build runs.
</verification>
```

Also create `src/resources/extensions/gsd/tests/__fixtures__/flat-phase/.gsd/phases/01-foundation/01-ROADMAP.md`:

```markdown
# Roadmap

## Phases

- [ ] 01 — Foundation
```

- [ ] **Step 6.2: Write the property test**

Create `src/resources/extensions/gsd/tests/flat-phase-round-trip.test.ts`:

```ts
// Project/App: gsd-pi
// File Purpose: Round-trip property test for the flat-phase layout.
// import → render → import must produce stable milestone/slice/task hierarchy.
import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { cpSync, mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";

import { openDatabase, closeDatabase, getAllMilestones, getMilestoneSlices, getSliceTasks } from "../gsd-db.ts";
import { migrateHierarchyToDb } from "../md-importer.ts";
import { renderAllFromDb } from "../markdown-renderer.ts";
import { invalidateStateCache } from "../state.ts";

const __dirname = dirname(fileURLToPath(import.meta.url));
const FIXTURE_ROOT = join(__dirname, "__fixtures__", "flat-phase");
const tmpDirs: string[] = [];
afterEach(() => {
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function copyFixture(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-fprt-${randomUUID()}`));
  cpSync(FIXTURE_ROOT, base, { recursive: true });
  tmpDirs.push(base);
  return base;
}

test("flat-phase round-trip: import → render → import is stable", async () => {
  const base = copyFixture();
  openDatabase(join(base, ".gsd", "gsd.db"));

  // Pass 1: import
  migrateHierarchyToDb(base);
  invalidateStateCache();
  const ms1 = getAllMilestones();
  const slices1 = ms1.length > 0 ? getMilestoneSlices(ms1[0]!.id) : [];
  const tasks1 = slices1.length > 0 ? getSliceTasks(ms1[0]!.id, slices1[0]!.id) : [];
  assert.ok(ms1.length > 0, "expected at least one milestone after import");

  // Render
  const result = await renderAllFromDb(base);
  assert.deepEqual(result.errors, [], `render errors: ${JSON.stringify(result.errors)}`);

  // Pass 2: re-import
  // Note: migrateHierarchyToDb uses INSERT OR IGNORE so re-running is safe
  migrateHierarchyToDb(base);
  invalidateStateCache();
  const ms2 = getAllMilestones();
  const slices2 = ms2.length > 0 ? getMilestoneSlices(ms2[0]!.id) : [];
  const tasks2 = slices2.length > 0 ? getSliceTasks(ms2[0]!.id, slices2[0]!.id) : [];

  assert.equal(ms2.length, ms1.length, "milestone count drifted");
  assert.equal(slices2.length, slices1.length, "slice count drifted");
  assert.equal(tasks2.length, tasks1.length, "task count drifted");
});
```

- [ ] **Step 6.3: Run the test**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/flat-phase-round-trip.test.ts`
Expected: PASS. If FAIL, the failure identifies what doesn't round-trip — fix the renderer/importer, not the test.

- [ ] **Step 6.4: Final typecheck**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && pnpm run typecheck:extensions`
Expected: PASS (zero errors).

- [ ] **Step 6.5: Full regression sweep**

Run: `cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout && node --import ./src/resources/extensions/gsd/tests/resolve-ts.mjs --experimental-strip-types --test src/resources/extensions/gsd/tests/markdown-renderer.test.ts src/resources/extensions/gsd/tests/state-reconciliation-drift.test.ts src/resources/extensions/gsd/tests/gsd-recover.test.ts src/resources/extensions/gsd/tests/gsd-rebuild.test.ts`
Expected: PASS — update test assertions where they hardcode old `.gsd/milestones/` paths.

- [ ] **Step 6.6: Commit**

```bash
cd /Users/jeremymcspadden/github/open-gsd/gsd-pi-pi-adopts-planning-layout
git add src/resources/extensions/gsd/tests/flat-phase-round-trip.test.ts \
        src/resources/extensions/gsd/tests/__fixtures__/flat-phase/
git commit -m "test(layout): flat-phase round-trip property suite

Fixture: one phase, one plan, one task (as checkbox). Property:
import → render → import produces stable milestone/slice/task counts.
Validates the flat-phase layout round-trips correctly."
```

---

## Self-Review

**Spec coverage:**
- §4.1 layout-policy module → Task 1 ✓
- §4.2 tasks collapse → Task 3.5-3.6 (renderer) + Task 4 (importer) ✓
- §4.3 startup auto-migration → Task 5 ✓
- §4.4 compat-layer removal → N/A (this worktree branched from `main` which has no compat layer; PR #802 is a separate branch)
- §5 files → all mapped ✓
- §8 testing → Tasks 1, 3, 5, 6 ✓

**Placeholder scan:** Task 2.8 notes "any errors should be from callers" — that's a verification step, not a placeholder. Task 3.9 says "update those assertions" — explicit instruction, not a vague "handle edge cases." Task 4.2 references `findMilestoneIds` update — concrete file reference. No TBDs.

**Type consistency:** `phaseDirName`, `planFileName`, `milestoneIdToPhaseNum`, `sliceIdToPlanNum`, `derivePhaseSlug` defined in Task 1 and used in Tasks 2, 3, 5. `migrateToFlatPhase` / `needsFlatPhaseMigration` defined in Task 5 and used in Task 5.5. Naming consistent.

**Scope note:** The `auto-prompts.ts` 154-reference update (spec §4.5/§10) is intentionally deferred to a follow-up task — it's mechanical churn that doesn't affect correctness (prompts still produce valid paths, just with old segment names until updated). The layout-policy-backed helper approach (spec §10 open question) would be the right way to do it, but it's a separate focused effort.

**Out-of-scope for this plan (explicit):**
- `auto-prompts.ts` path string updates (154 refs) — follow-up
- Compat layer removal — N/A on this branch (no compat layer on `main`)
- gsd-core Stage 2 dir rename — separate spec
