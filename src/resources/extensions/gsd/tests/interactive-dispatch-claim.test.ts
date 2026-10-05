// Project/App: gsd-pi
// File Purpose: Behavior tests for the Lifecycle Kernel one-unit bound (ADR-048):
// the guided flow and /gsd dispatch claim the unit they dispatch through
// kernelClaimUnit, and the claim makes an interrupted verify row history.

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  kernelClaimUnit,
  kernelSettleUnitClaim,
} from "../auto/lifecycle-kernel.ts";
import { clearStaleWorkerLock } from "../crash-recovery.ts";
import {
  _getAdapter,
  closeDatabase,
  insertMilestone,
  insertSlice,
  insertTask,
  openDatabase,
} from "../gsd-db.ts";
import {
  claimMilestoneLease,
  getMilestoneLease,
} from "../db/milestone-leases.ts";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.ts";
import {
  getDispatchById,
  getInterruptedVerifyDispatch,
  markRunning,
  recordDispatchClaim,
  setDispatchStage,
} from "../db/unit-dispatches.ts";

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-interactive-dispatch-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice", status: "pending" });
  insertTask({ id: "T01", sliceId: "S01", milestoneId: "M001", title: "Task", status: "pending" });
  t.after(() => {
    try { closeDatabase(); } catch { /* already closed */ }
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

interface ClaimOpts {
  milestoneId?: string;
  unitType?: string;
  unitId?: string;
}

function claimInteractive(base: string, opts: ClaimOpts = {}) {
  return kernelClaimUnit({
    projectRoot: base,
    milestoneId: opts.milestoneId ?? "M001",
    sliceId: "S01",
    taskId: null,
    unitType: opts.unitType ?? "plan-slice",
    unitId: opts.unitId ?? "M001/S01",
    traceId: "trace-interactive-dispatch",
  });
}

/** A dispatch row of an auto worker that a killed process left in the verify stage. */
function killPlanSliceInVerify(base: string): number {
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  if (!lease.ok) throw new Error("expected a milestone lease");
  const claimed = recordDispatchClaim({
    traceId: "trace-interactive-dispatch",
    workerId,
    milestoneLeaseToken: lease.token,
    milestoneId: "M001",
    sliceId: "S01",
    taskId: null,
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  if (!claimed.ok) throw new Error("expected a dispatch claim");
  markRunning(claimed.dispatchId);
  setDispatchStage(claimed.dispatchId, "verify");
  killWorker(base, workerId);
  const row = getDispatchById(claimed.dispatchId);
  assert.equal(row?.status, "canceled", "the crash sweep cancels the row of the dead worker");
  return claimed.dispatchId;
}

/** Mark a worker dead, then run the crash sweep of the next start. */
function killWorker(base: string, workerId: string): void {
  _getAdapter()!.prepare(
    `UPDATE workers
     SET pid = 99999, last_heartbeat_at = '1970-01-01T00:00:00.000Z'
     WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": workerId });
  clearStaleWorkerLock(base);
}

test("an interactive claim makes the interrupted verify row history", (t) => {
  const base = makeProject(t);
  const interruptedId = killPlanSliceInVerify(base);
  assert.equal(getInterruptedVerifyDispatch("M001", null)?.id, interruptedId);

  const claim = claimInteractive(base, { unitType: "plan-slice", unitId: "M001/S01" });
  assert.equal(claim.kind, "claimed");

  // The claimed row is newer, so the unit is not continued at verify: the
  // next /gsd auto does not re-run the verification gates of the unit.
  assert.equal(getInterruptedVerifyDispatch("M001", null), null);
  const row = getDispatchById((claim as { dispatchId: number }).dispatchId);
  assert.equal(row?.status, "running");
  assert.equal(row?.attempt_n, 2, "the interactive claim is the second attempt of the unit");
});

test("an interactive claim is refused while another live worker holds the milestone lease", (t) => {
  const base = makeProject(t);
  const holder = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(holder, "M001");
  if (!lease.ok) throw new Error("expected a milestone lease");
  // The holder runs on another host: the same-process re-entrance of the lease
  // does not apply, so the fresh lease of the holder refuses the claim.
  _getAdapter()!.prepare(
    `UPDATE workers SET host = 'other-host', pid = 99999 WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": holder });

  const claim = claimInteractive(base);

  assert.equal(claim.kind, "refused");
  if (claim.kind === "refused") {
    assert.match(claim.reason, /held by worker/);
  }
  const claimRow = _getAdapter()!.prepare(
    `SELECT COUNT(*) AS n FROM unit_dispatches WHERE unit_id = 'M001/S01'`,
  ).get() as { n: number };
  assert.equal(claimRow.n, 0, "no dispatch row is claimed for a refused dispatch");
});

test("a settled claim does not refuse the next dispatch of the unit", (t) => {
  const base = makeProject(t);
  const first = claimInteractive(base);
  if (first.kind !== "claimed") throw new Error("expected a claim");
  kernelSettleUnitClaim(first, "completed", "interactive-dispatch");

  const second = claimInteractive(base);

  assert.equal(second.kind, "claimed");
  const row = getDispatchById((second as { dispatchId: number }).dispatchId);
  assert.equal(row?.attempt_n, 2, "the next dispatch is the second attempt of the unit");
});

test("an interactive claim takes over the active row of a dead worker whose lease lapsed", (t) => {
  const base = makeProject(t);
  const dead = claimInteractive(base);
  if (dead.kind !== "claimed") throw new Error("expected a claim");
  // The worker died and its lease lapsed before any crash sweep ran.
  _getAdapter()!.prepare(
    `UPDATE workers
     SET pid = 99999, last_heartbeat_at = '1970-01-01T00:00:00.000Z'
     WHERE worker_id = :worker_id`,
  ).run({ ":worker_id": dead.workerId });
  _getAdapter()!.prepare(
    `UPDATE milestone_leases SET expires_at = '1970-01-01T00:00:00.000Z' WHERE milestone_id = 'M001'`,
  ).run();

  const claim = claimInteractive(base);

  assert.equal(claim.kind, "claimed");
  const row = getDispatchById((claim as { dispatchId: number }).dispatchId);
  assert.equal(row?.attempt_n, 2);
  const canceled = _getAdapter()!.prepare(
    `SELECT exit_reason FROM unit_dispatches WHERE id = :id`,
  ).get({ ":id": dead.dispatchId }) as { exit_reason: string };
  assert.equal(canceled.exit_reason, "stale-dispatch-lease-takeover");
});

test("a settle completes the row, releases the lease and retires the worker", (t) => {
  const base = makeProject(t);
  const claim = claimInteractive(base);
  if (claim.kind !== "claimed") throw new Error("expected a claim");

  kernelSettleUnitClaim(claim, "completed", "interactive-dispatch");

  const row = getDispatchById(claim.dispatchId);
  assert.equal(row?.status, "completed");
  assert.equal(row?.exit_reason, "interactive-dispatch");
  const nextWorker = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(nextWorker, "M001");
  assert.equal(lease.ok, true, "the lease of the settled claim is released");
  const worker = getAutoWorker(claim.workerId);
  assert.equal(worker?.status, "stopping");
});

test("a failed send settles the row failed", (t) => {
  const base = makeProject(t);
  const claim = claimInteractive(base);
  if (claim.kind !== "claimed") throw new Error("expected a claim");

  kernelSettleUnitClaim(claim, "failed", "send failed");

  const row = getDispatchById(claim.dispatchId);
  assert.equal(row?.status, "failed");
  assert.equal(row?.error_summary, "send failed");
});

test("a claim for a virtual milestone or an unrecorded milestone is skipped", (t) => {
  const base = makeProject(t);
  const virtual = claimInteractive(base, { milestoneId: "PROJECT", unitId: "PROJECT/setup" });
  assert.deepEqual(virtual, { kind: "skipped", reason: "virtual-milestone" });

  const unrecorded = claimInteractive(base, { milestoneId: "M099", unitId: "M099" });
  assert.deepEqual(unrecorded, { kind: "skipped", reason: "milestone-not-in-db" });
});

test("a claim with the database unavailable is skipped", (t) => {
  const base = makeProject(t);
  closeDatabase();

  const claim = claimInteractive(base);

  assert.deepEqual(claim, { kind: "skipped", reason: "db-unavailable" });
});

test("the milestone lease of a claim is held until its settle", (t) => {
  const base = makeProject(t);
  const claim = claimInteractive(base);
  if (claim.kind !== "claimed") throw new Error("expected a claim");

  const lease = getMilestoneLease("M001");
  assert.equal(lease?.status, "held");
  assert.equal(lease?.worker_id, claim.workerId);
});
