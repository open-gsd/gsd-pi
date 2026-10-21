# Plan 007: Stabilize MCP-server to GSD-extension bridge seam (staged, phase 1)

> **Executor instructions**: Follow this plan step by step. Run every verification command and confirm the expected result before moving to the next step. If anything in the "STOP conditions" section occurs, stop and report — do not improvise. When done, update the status row for this plan in `plans/README.md`.
>
> **Drift check (run first)**: `git diff --stat 2c63ab9d..HEAD -- packages/mcp-server/src/workflow-tools.ts packages/mcp-server/src/workflow-tools.test.ts src/resources/extensions/gsd/mcp-bridge.ts`
> If any in-scope file changed since this plan was written, compare the "Current state" excerpts against the live code before proceeding; on a mismatch, treat it as a STOP condition.

## Status

- **Priority**: P2
- **Effort**: M
- **Risk**: MED
- **Depends on**: none
- **Category**: tech-debt
- **Planned at**: commit `2c63ab9d`, 2026-06-14
- **Issue**: (omit)

## Why this matters

`packages/mcp-server/src/workflow-tools.ts` reaches across the package boundary into `src/resources/extensions/gsd/` internals via `importLocalModule` with relative paths like `../../../src/resources/extensions/gsd/bootstrap/write-gate.js`. This bypasses the `packages/contracts` package and breaks the MCP server build silently when GSD extension file paths or module shapes change. A package in the workspace should consume a stable, typed bridge surface rather than extension internals.

A full bridge would cover 17+ distinct internal modules — too large for one safe change. This plan does **phase 1**: bridge the small set of high-churn core modules that are imported multiple times, and leave the long tail of tool-specific imports for a follow-up plan. This still removes the most brittle relative imports and establishes the bridge pattern.

## Current state

- `packages/mcp-server/src/workflow-tools.ts` uses `importLocalModule<any>("../../../src/resources/extensions/gsd/...")` across many distinct internal modules.
- The most frequently imported / highest-churn core modules are:
  - `bootstrap/write-gate.js`
  - `bootstrap/dynamic-tools.js`
  - `gsd-db.js`
  - `state.js`
  - `preferences.js`
  - `db-writer.js`
  - `doctor.js`
  - `journal.js`
  - `milestone-ids.js`
- `packages/mcp-server/src/workflow-tools.test.ts:15-24` imports directly from `src/resources/extensions/gsd/gsd-db.ts`.
- A stale `src/resources/extensions/gsd/mcp-bridge.d.ts` exists from an earlier attempt; it must be removed so the new `mcp-bridge.ts` is the single source of truth.
- `packages/contracts/src/workflow.ts` exports tool contracts but no runtime bridge API.
- `packages/mcp-server/tsconfig.json` sets `rootDir: "./src"`, so a static `import type *` from `src/resources/extensions/gsd/...` causes `TS6059` errors during `build:mcp-server`.

Repo conventions:
- Extension-first architecture; packages consume each other through declared exports.
- Use TypeScript strict mode and NodeNext resolution.
- Prefer small, typed seams over `any`.
- Tests use `node:test` and `node:assert/strict`.

## Commands you will need

| Purpose   | Command                  | Expected on success |
|-----------|--------------------------|---------------------|
| Typecheck | `pnpm run typecheck:extensions` | exit 0, no errors   |
| MCP tests | `pnpm --filter @opengsd/mcp-server run test` | all pass |
| Build     | `pnpm run build:mcp-server` | exit 0 |
| Unit suite | `pnpm run test:unit` | all pass |

## Scope

**In scope**:
- `packages/mcp-server/src/workflow-tools.ts` — replace imports from the 9 core modules listed above with imports from the bridge.
- `src/resources/extensions/gsd/mcp-bridge.ts` — new module re-exporting the bridged symbols.
- `packages/mcp-server/src/workflow-tools.test.ts` — update direct GSD imports to use the bridge.

**Out of scope**:
- Bridging tool-specific imports (`tools/plan-task.js`, `tools/skip-slice.js`, `tools/exec-tool.js`, etc.) — phase 2.
- Refactoring GSD extension internals.
- Changing MCP server behavior or tool surface.

## Git workflow

- Branch: `refactor/mcp-server-gsd-bridge-phase1`
- Commit message style: `refactor(mcp-server): introduce GSD mcp-bridge for core runtime modules`
- Do not push or open a PR unless instructed.

## Steps

### Step 1: Inventory the core imports

Open `packages/mcp-server/src/workflow-tools.ts` and locate every `importLocalModule` call targeting these 9 modules:
- `bootstrap/write-gate.js`
- `bootstrap/dynamic-tools.js`
- `gsd-db.js`
- `state.js`
- `preferences.js`
- `db-writer.js`
- `doctor.js`
- `journal.js`
- `milestone-ids.js`

For each, note the imported symbol(s) and the call site(s).

**Verify**: the inventory lists all occurrences of these 9 paths in `workflow-tools.ts`.

### Step 2: Create `src/resources/extensions/gsd/mcp-bridge.ts`

First, delete any existing `src/resources/extensions/gsd/mcp-bridge.d.ts` (or any other `mcp-bridge.*` artifact) so the new `.ts` file is the only module with that base name. The old `.d.ts` is a stale declaration file and would conflict with the new source.

Create a new file at `src/resources/extensions/gsd/mcp-bridge.ts`. Re-export the exact symbols used by `workflow-tools.ts` and `workflow-tools.test.ts` from the 9 core modules. Use explicit named re-exports.

Current bridge contents (verify against inventory):

```ts
// mcp-bridge.ts — stable runtime seam for MCP server consumption (phase 1).
export {
  loadWriteGateSnapshot,
  shouldBlockPendingGateInSnapshot,
  shouldBlockQueueExecutionInSnapshot,
} from "./bootstrap/write-gate.js";
export { ensureDbOpen } from "./bootstrap/dynamic-tools.js";
export {
  _getAdapter,
  checkpointDatabase,
  closeDatabase,
  getAllMilestones,
  getDb,
  getGateResults,
  getMilestoneSlices,
  getPendingGates,
  getSliceTasks,
  insertDecision,
  insertMilestone,
  insertSlice,
  openDatabase,
  upsertMilestonePlanning,
} from "./gsd-db.js";
export { invalidateStateCache, isReusableGhostMilestone } from "./state.js";
export { loadEffectiveGSDPreferences } from "./preferences.js";
export {
  saveDecisionToDb,
  saveRequirementToDb,
  updateRequirementInDb,
} from "./db-writer.js";
export { rebuildState } from "./doctor.js";
export { queryJournal } from "./journal.js";
export {
  claimReservedId,
  findMilestoneIds,
  getReservedMilestoneIds,
  milestoneIdSort,
  nextMilestoneId,
} from "./milestone-ids.js";
```

**Verify**: `pnpm run typecheck:extensions` exits 0 (or shows only pre-existing unrelated errors).

### Step 3: Add a local bridge interface and typed dynamic loader in `workflow-tools.ts`

Because `packages/mcp-server/tsconfig.json` restricts `rootDir` to `./src`, do **not** add `import type * from "../../../src/resources/extensions/gsd/mcp-bridge.js"`. Instead, define a local interface that mirrors the bridge shape, and load the bridge dynamically through the existing `importLocalModule` helper.

Add near the top of `packages/mcp-server/src/workflow-tools.ts`:

```ts
/** Local mirror of src/resources/extensions/gsd/mcp-bridge.ts.
 *  Kept here so packages/mcp-server/tsconfig.json rootDir boundary is not crossed.
 */
interface GsdMcpBridge {
  loadWriteGateSnapshot: (...args: any[]) => any;
  shouldBlockPendingGateInSnapshot: (...args: any[]) => any;
  shouldBlockQueueExecutionInSnapshot: (...args: any[]) => any;
  ensureDbOpen: (...args: any[]) => any;
  _getAdapter: (...args: any[]) => any;
  checkpointDatabase: (...args: any[]) => any;
  closeDatabase: (...args: any[]) => any;
  getAllMilestones: (...args: any[]) => any;
  getDb: (...args: any[]) => any;
  getGateResults: (...args: any[]) => any;
  getMilestoneSlices: (...args: any[]) => any;
  getPendingGates: (...args: any[]) => any;
  getSliceTasks: (...args: any[]) => any;
  insertDecision: (...args: any[]) => any;
  insertMilestone: (...args: any[]) => any;
  insertSlice: (...args: any[]) => any;
  openDatabase: (...args: any[]) => any;
  upsertMilestonePlanning: (...args: any[]) => any;
  invalidateStateCache: (...args: any[]) => any;
  isReusableGhostMilestone: (...args: any[]) => any;
  loadEffectiveGSDPreferences: (...args: any[]) => any;
  saveDecisionToDb: (...args: any[]) => any;
  saveRequirementToDb: (...args: any[]) => any;
  updateRequirementInDb: (...args: any[]) => any;
  rebuildState: (...args: any[]) => any;
  queryJournal: (...args: any[]) => any;
  claimReservedId: (...args: any[]) => any;
  findMilestoneIds: (...args: any[]) => any;
  getReservedMilestoneIds: (...args: any[]) => any;
  milestoneIdSort: (...args: any[]) => any;
  nextMilestoneId: (...args: any[]) => any;
}

async function importBridgeModule(): Promise<GsdMcpBridge> {
  return importLocalModule<GsdMcpBridge>("../../../src/resources/extensions/gsd/mcp-bridge.js");
}
```

Use `any` for arguments/returns in the local interface to avoid needing GSD-internal types. The runtime behavior is unchanged because the bridge module provides the real implementations.

**Verify**: `pnpm run typecheck:extensions` has no new errors in `packages/mcp-server/src/workflow-tools.ts`.

### Step 4: Replace the 9 core relative imports with bridge imports

For each inventory entry, change the call site to go through `importBridgeModule()`. Share one `bridge = await importBridgeModule()` call per function/scope where multiple bridged symbols are used together. Do not bridge tool-specific imports in this phase.

Examples:

Write-gate candidate path:
```ts
// Before:
...buildBridgeImportCandidates("../../../src/resources/extensions/gsd/bootstrap/write-gate.js")

// After:
...buildBridgeImportCandidates("../../../src/resources/extensions/gsd/mcp-bridge.js")
```

Dynamic DB bootstrap:
```ts
// Before:
const { ensureDbOpen } = await importLocalModule<any>(
  "../../../src/resources/extensions/gsd/bootstrap/dynamic-tools.js",
);

// After:
const bridge = await importBridgeModule();
const { ensureDbOpen } = bridge;
// or directly: bridge.ensureDbOpen(...)
```

GSD DB helpers:
```ts
// Before:
const { getAllMilestones } = await importLocalModule<any>("../../../src/resources/extensions/gsd/gsd-db.js");

// After:
const bridge = await importBridgeModule();
const { getAllMilestones } = bridge;
```

Preferences, state, db-writer, doctor, journal, and milestone-ids imports follow the same pattern.

**Verify**: `rg "src/resources/extensions/gsd/(bootstrap/write-gate|bootstrap/dynamic-tools|gsd-db|state|preferences|db-writer|doctor|journal|milestone-ids)\.js" packages/mcp-server/src/workflow-tools.ts` returns no matches.

### Step 5: Update `workflow-tools.test.ts`

Open `packages/mcp-server/src/workflow-tools.test.ts`. Replace the direct import from `src/resources/extensions/gsd/gsd-db.ts` with an import from `../../../src/resources/extensions/gsd/mcp-bridge.ts`. Update any referenced symbols accordingly.

**Verify**: `pnpm --filter @opengsd/mcp-server run test` exits 0.

### Step 6: Add a structural guard for new core imports

Add a simple grep-based check that fails CI if a new `importLocalModule` call targets one of the 9 bridged modules.

Add a new file `scripts/check-mcp-bridge-boundary.sh`:

```bash
#!/usr/bin/env bash
set -euo pipefail
for mod in bootstrap/write-gate bootstrap/dynamic-tools gsd-db state preferences db-writer doctor journal milestone-ids; do
  if rg -q "src/resources/extensions/gsd/$mod\.js" packages/mcp-server/src/; then
    echo "ERROR: packages/mcp-server/src/ imports from $mod directly; use mcp-bridge.ts instead"
    exit 1
  fi
done
echo "OK: packages/mcp-server/src/ uses mcp-bridge.ts for core GSD modules"
```

Make it executable: `chmod +x scripts/check-mcp-bridge-boundary.sh`.

Then add it to `package.json` scripts. Find the `verify:pi-boundary` script and append `&& bash scripts/check-mcp-bridge-boundary.sh`, or add a new script `verify:mcp-bridge-boundary` and append it to `verify:fast`. The simplest approach: append to `verify:fast` if `verify:pi-boundary` is already part of it.

**Verify**: `bash scripts/check-mcp-bridge-boundary.sh` exits 0 on the refactored code and would exit 1 if a direct import were reintroduced.

### Step 7: Run full verification

Run typecheck, MCP server build, MCP server tests, and the unit suite.

**Verify**:
- `pnpm run typecheck:extensions` exits 0 (or only pre-existing unrelated errors).
- `pnpm run build:mcp-server` exits 0.
- `pnpm --filter @opengsd/mcp-server run test` exits 0.
- `pnpm run test:unit` exits 0 (or failures are pre-existing/unrelated).

## Test plan

- Update `packages/mcp-server/src/workflow-tools.test.ts` to import via the bridge.
- Add `scripts/check-mcp-bridge-boundary.sh` and wire it into CI.
- Existing tests to preserve:
  - all MCP server tests.
  - all tests that exercise workflow tool execution through the MCP server.

## Done criteria

- [ ] Any stale `src/resources/extensions/gsd/mcp-bridge.d.ts` has been removed.
- [ ] `src/resources/extensions/gsd/mcp-bridge.ts` exists and re-exports the bridged symbols.
- [ ] `packages/mcp-server/src/workflow-tools.ts` no longer imports directly from the 9 bridged core modules.
- [ ] `pnpm run build:mcp-server` exits 0.
- [ ] `pnpm --filter @opengsd/mcp-server run test` exits 0.
- [ ] `pnpm run test:unit` exits 0 (or failures are pre-existing/unrelated).
- [ ] `scripts/check-mcp-bridge-boundary.sh` exists, is executable, and passes.
- [ ] No files outside the in-scope list are modified (`git status`).
- [ ] `plans/README.md` status row for plan 007 updated to DONE.

## STOP conditions

Stop and report back if:
- A circular dependency prevents creating `mcp-bridge.ts`.
- A bridged symbol cannot be re-exported without exposing GSD internals (e.g., it depends on a private type).
- `build:mcp-server` fails due to package resolution after using the local interface approach.
- Replacing a core import changes runtime behavior and MCP tests fail.

## Maintenance notes

- Phase 2 should bridge the remaining tool-specific imports. The bridge seam should remain the only MCP-server entry point for new core runtime helpers.
- Reviewers should verify the bridge exports are typed and do not re-export `any`.
- Document the phased approach in the PR so phase 2 is not forgotten.

## Follow-up

- Plan 007-phase-2: bridge the remaining tool-specific imports (`tools/plan-task.js`, `tools/skip-slice.js`, `tools/exec-tool.js`, `tools/exec-search-tool.js`, `tools/resume-tool.js`, memory tools, graph tools, etc.) and extend `scripts/check-mcp-bridge-boundary.sh`.
