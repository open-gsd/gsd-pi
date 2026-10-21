// gsd-pi — Dispatch must not conclude "never discussed" while the layout migration
// is mid-flight.
//
// `migrateToFlatPhase` moves .gsd/milestones/ aside before rendering .gsd/phases/,
// so there is a window where slice plans exist in neither layout. A dispatch landing
// in that window sees no plans, `hasMilestonePassedDiscuss` returns false, and the
// `execution-entry phase (no context) → discuss-milestone` rule re-plans a milestone
// that was already fully planned — discarding the plan while the DB still holds it.
//
// Observed on every acceptance run (3/3) before the guard: auto mode re-planned the
// seeded milestone from scratch on startup.

import { test, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomUUID } from "node:crypto";

import {
  _setFlatPhaseMigrationBoundaryForTest,
  migrateToFlatPhase,
} from "../flat-phase-migration.ts";
import { resolveDispatch, DISPATCH_RULES, type DispatchContext } from "../auto-dispatch.ts";
import { openDatabase, closeDatabase, insertMilestone, insertSlice, insertTask } from "../gsd-db.ts";
import { convertDispatchRules, initRegistry, getRegistry, resetRegistry } from "../rule-registry.ts";
import type { GSDState } from "../types.ts";

const tmpDirs: string[] = [];

afterEach(() => {
  _setFlatPhaseMigrationBoundaryForTest(null);
  closeDatabase();
  for (const d of tmpDirs) { try { rmSync(d, { recursive: true, force: true }); } catch { /* */ } }
  tmpDirs.length = 0;
});

function seedLegacyProject(): string {
  const base = mkdtempSync(join(tmpdir(), `gsd-dispatch-mig-${randomUUID()}`));
  tmpDirs.push(base);
  mkdirSync(join(base, ".gsd", "milestones", "M001", "slices", "S01", "tasks"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Planned", status: "active" });
  insertSlice({
    milestoneId: "M001", id: "S01", title: "Slice", status: "active",
    risk: "low", depends: [], demo: "demo", sequence: 1,
  });
  insertTask({ milestoneId: "M001", sliceId: "S01", id: "T01", title: "Task", status: "pending", sequence: 1 });
  return base;
}

function executingState(): GSDState {
  return {
    activeMilestone: { id: "M001", title: "Planned" },
    activeSlice: { id: "S01", title: "Slice" },
    activeTask: null,
    phase: "executing",
    recentDecisions: [],
    blockers: [],
    nextAction: "",
    registry: [],
  } as unknown as GSDState;
}

test("dispatch inside the migration window does not re-dispatch discuss-milestone", async () => {
  const base = seedLegacyProject();

  let previousExists = false;
  try { getRegistry(); previousExists = true; } catch { previousExists = false; }
  initRegistry(convertDispatchRules(DISPATCH_RULES));

  let dispatchedUnit: string | undefined;
  let dispatchError: string | undefined;

  // Fire a dispatch at the exact moment the legacy tree has been moved aside and
  // phases/ has not yet been rendered — the window a real startup dispatch races.
  _setFlatPhaseMigrationBoundaryForTest((stage) => {
    if (stage !== "after-move" || dispatchedUnit !== undefined) return;
    dispatchedUnit = "(pending)";
    const ctx: DispatchContext = {
      basePath: base,
      mid: "M001",
      midTitle: "Planned",
      state: executingState(),
      prefs: undefined,
    };
    // The boundary hook is synchronous; capture the promise result out of band.
    void resolveDispatch(ctx).then(
      (r) => { dispatchedUnit = (r as { unitType?: string }).unitType ?? `(${r.action})`; },
      (e) => { dispatchError = e instanceof Error ? e.message : String(e); },
    );
  });

  await migrateToFlatPhase(base);
  await new Promise((r) => setTimeout(r, 50)); // let the out-of-band dispatch settle

  try {
    assert.equal(dispatchError, undefined, `dispatch threw: ${dispatchError}`);
    assert.notEqual(
      dispatchedUnit,
      "discuss-milestone",
      "a milestone planned in the DB must not be re-discussed because the migration " +
      "temporarily moved its plan files",
    );
  } finally {
    initRegistry(convertDispatchRules(DISPATCH_RULES));
    if (!previousExists) resetRegistry();
  }
});
