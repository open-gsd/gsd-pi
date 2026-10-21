// Project/App: gsd-pi
// File Purpose: Hard tests for UnitRun claim resolution (ADR-048).

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import { openDatabase, closeDatabase, insertMilestone, insertSlice } from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease } from "../db/milestone-leases.ts";
import {
  recordDispatchClaim,
  getActiveForWorker,
  getDispatchById,
} from "../db/unit-dispatches.ts";
import { AutoSession } from "../auto/session.ts";
import {
  claimUnitRun,
  iterationDataForClaim,
  resolveExistingUnitRun,
} from "../auto/unit-run.ts";
import type { GSDState } from "../types.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-unit-run-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function setup(base: string): { workerId: string; leaseToken: number; session: AutoSession } {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("expected test lease");
  const session = new AutoSession();
  session.workerId = workerId;
  session.milestoneLeaseToken = lease.token;
  session.currentMilestoneId = "M001";
  return { workerId, leaseToken: lease.token, session };
}

const state = {
  phase: "executing",
  activeMilestone: { id: "M001", title: "Test" },
  activeSlice: { id: "S01" },
} as GSDState;

test("resolveExistingUnitRun resumes a claimed row when the unit is not in flight", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "resume-trace",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("expected claim");

  const resolved = resolveExistingUnitRun({
    workerId,
    unitType: "plan-slice",
    unitId: "M001/S01",
    unitExecutionInFlight: false,
  });
  assert.deepEqual(resolved, { kind: "resume", dispatchId: claim.dispatchId });
});

test("resolveExistingUnitRun skips when the same unit is in flight", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "inflight-trace",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);

  const resolved = resolveExistingUnitRun({
    workerId,
    unitType: "plan-slice",
    unitId: "M001/S01",
    unitExecutionInFlight: true,
  });
  assert.equal(resolved.kind, "skip-in-flight");
});

test("resolveExistingUnitRun cancels a different claimed unit before a fresh claim", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "supersede-trace",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("expected claim");

  const resolved = resolveExistingUnitRun({
    workerId,
    unitType: "execute-task",
    unitId: "M001/S01/T01",
    unitExecutionInFlight: false,
  });
  assert.equal(resolved.kind, "claim");
  assert.equal(getDispatchById(claim.dispatchId)?.status, "canceled");
  assert.equal(getActiveForWorker(workerId), null);
});

test("claimUnitRun opens lease and claim in one transaction", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { session } = setup(base);
  session.milestoneLeaseToken = null;

  const result = claimUnitRun({
    session,
    flowId: "flow-1",
    turnId: "turn-1",
    iterData: {
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state,
      mid: "M001",
      midTitle: "Test",
      isRetry: false,
      previousTier: undefined,
    },
    leaseDeps: {
      claimMilestoneLease,
      logLeaseRecovered() {},
      logLeaseRecoveryFailed() {},
    },
    claimDeps: {
      getRecentDispatchesForUnit: () => [],
      recordDispatchClaim,
      markDispatchRunning: () => {},
      logClaimRejected() {},
      logClaimFailed() {},
    },
  });

  assert.equal(result.kind, "opened");
  if (result.kind !== "opened") throw new Error("expected opened");
  assert.equal(typeof result.dispatchId, "number");
  assert.notEqual(result.dispatchId, null);
  const row = getDispatchById(result.dispatchId);
  assert.ok(row);
  assert.equal(row.status, "claimed");
  assert.equal(row.unit_id, "M001/S01");
});

test("claimUnitRun degrades with a reason when the worker is missing", () => {
  const session = new AutoSession();
  const result = claimUnitRun({
    session,
    flowId: "flow-missing",
    turnId: "turn-missing",
    iterData: {
      unitType: "plan-slice",
      unitId: "M001/S01",
      prompt: "",
      finalPrompt: "",
      pauseAfterUatDispatch: false,
      state,
      mid: "M001",
      midTitle: "Test",
      isRetry: false,
      previousTier: undefined,
    },
    leaseDeps: {
      claimMilestoneLease: () => {
        throw new Error("should not claim");
      },
      logLeaseRecovered() {},
      logLeaseRecoveryFailed() {},
    },
    claimDeps: {
      getRecentDispatchesForUnit: () => [],
      recordDispatchClaim: () => {
        throw new Error("should not claim");
      },
      markDispatchRunning: () => {},
      logClaimRejected() {},
      logClaimFailed() {},
    },
  });
  assert.equal(result.kind, "degraded");
  if (result.kind !== "degraded") throw new Error("expected degraded");
  assert.equal(typeof result.reason, "string");
  assert.ok(result.reason.length > 0);
});

test("resolveExistingUnitRun claims when workerId is null", () => {
  assert.deepEqual(
    resolveExistingUnitRun({
      workerId: null,
      unitType: "plan-slice",
      unitId: "M001/S01",
      unitExecutionInFlight: false,
    }),
    { kind: "claim" },
  );
});

test("iterationDataForClaim maps a null session milestone to undefined", () => {
  const session = new AutoSession();
  session.currentMilestoneId = null;
  const data = iterationDataForClaim("plan-slice", "/S01", state, session);
  assert.equal(data.mid, undefined);
  assert.equal(data.unitType, "plan-slice");
  assert.equal(data.unitId, "/S01");
});
