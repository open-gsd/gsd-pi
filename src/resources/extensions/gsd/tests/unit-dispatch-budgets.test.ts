// gsd-pi + Unit budget tests: retry budgets live on the unit_dispatches row (ADR-048)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { AutoSession } from "../auto/session.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import { markFailed, recordDispatchClaim } from "../db/unit-dispatches.ts";
import {
  readUnitBudget,
  resetUnitBudget,
  spendUnitBudget,
  type UnitBudgetRef,
} from "../db/unit-dispatch-budgets.ts";

const PLAN_SLICE_PRE_EXEC: UnitBudgetRef = { unitType: "plan-slice", unitId: "M001/S01", kind: "pre-exec" };

interface Project {
  dbPath: string;
  claim: (unitType: string) => number;
}

function openProject(t: { after: (fn: () => void) => void }): Project {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatch-budgets-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  t.after(() => {
    try { closeDatabase(); } catch { /* noop */ }
    rmSync(base, { recursive: true, force: true });
  });
  const dbPath = join(base, ".gsd", "gsd.db");
  openDatabase(dbPath);
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected test lease");
  return {
    dbPath,
    claim: (unitType) => {
      const claim = recordDispatchClaim({
        traceId: "trace",
        workerId,
        milestoneLeaseToken: lease.token,
        milestoneId: "M001",
        sliceId: "S01",
        unitType,
        unitId: "M001/S01",
      });
      if (!claim.ok) throw new Error(`expected dispatch claim: ${claim.error}`);
      return claim.dispatchId;
    },
  };
}

test("a restart reads the budget the unit used before the process died", (t) => {
  const project = openProject(t);
  project.claim("plan-slice");

  const beforeKill = new AutoSession();
  assert.equal(spendUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 1);
  assert.equal(spendUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 2);
  assert.equal(beforeKill.unclaimedUnitBudgets.size, 0, "a claimed unit keeps nothing in session memory");

  // Kill: the session is gone and the database file is opened again.
  closeDatabase();
  openDatabase(project.dbPath);
  const afterRestart = new AutoSession();

  assert.equal(readUnitBudget(afterRestart.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 2);
  assert.equal(spendUnitBudget(afterRestart.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 3);
});

test("a retry dispatch of the same unit continues the stored budget", (t) => {
  const project = openProject(t);
  const firstDispatch = project.claim("plan-slice");
  spendUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC);

  markFailed(firstDispatch, { errorSummary: "pre-exec failed" });
  project.claim("plan-slice");

  assert.equal(readUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 1);
  assert.equal(spendUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 2);
  assert.equal(readUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 2);
});

test("a reset gives the unit a full budget and a restart does not undo it", (t) => {
  const project = openProject(t);
  const firstDispatch = project.claim("plan-slice");
  spendUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC);
  markFailed(firstDispatch, { errorSummary: "pre-exec failed" });
  project.claim("plan-slice");
  assert.equal(spendUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 2);

  resetUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC);

  closeDatabase();
  openDatabase(project.dbPath);
  assert.equal(readUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 0);
  assert.equal(spendUnitBudget(new Map(), PLAN_SLICE_PRE_EXEC), 1);
});

test("budgets are separate per unit type and per kind", (t) => {
  const project = openProject(t);
  const planDispatch = project.claim("plan-slice");
  const memory = new Map<string, number>();
  spendUnitBudget(memory, PLAN_SLICE_PRE_EXEC);
  spendUnitBudget(memory, { ...PLAN_SLICE_PRE_EXEC, kind: "zero-tool" });
  spendUnitBudget(memory, { ...PLAN_SLICE_PRE_EXEC, kind: "zero-tool" });

  // research-slice shares the unit id "M001/S01" with plan-slice.
  markFailed(planDispatch, { errorSummary: "done with this dispatch" });
  project.claim("research-slice");
  const researchZeroTool: UnitBudgetRef = { unitType: "research-slice", unitId: "M001/S01", kind: "zero-tool" };

  assert.equal(readUnitBudget(memory, researchZeroTool), 0);
  assert.equal(spendUnitBudget(memory, researchZeroTool), 1);
  assert.equal(readUnitBudget(memory, PLAN_SLICE_PRE_EXEC), 1);
  assert.equal(readUnitBudget(memory, { ...PLAN_SLICE_PRE_EXEC, kind: "zero-tool" }), 2);
  assert.equal(readUnitBudget(memory, { ...PLAN_SLICE_PRE_EXEC, kind: "tool-unavailable" }), 0);
});

test("a unit with no dispatch row keeps its budget for the process only", (t) => {
  openProject(t);
  const beforeKill = new AutoSession();

  assert.equal(spendUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 1);
  assert.equal(spendUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 2);
  resetUnitBudget(beforeKill.unclaimedUnitBudgets, { ...PLAN_SLICE_PRE_EXEC, kind: "zero-tool" });
  assert.equal(readUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 2);

  assert.equal(readUnitBudget(new AutoSession().unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 0);

  resetUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC);
  assert.equal(readUnitBudget(beforeKill.unclaimedUnitBudgets, PLAN_SLICE_PRE_EXEC), 0);
});
