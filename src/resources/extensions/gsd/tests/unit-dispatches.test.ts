// gsd-pi + Unit dispatch ledger tests (Phase B coordination — partial unique index, retry metadata)

import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  openDatabase,
  closeDatabase,
  _getAdapter,
  insertMilestone,
  insertSlice,
} from "../gsd-db.ts";
import { registerAutoWorker } from "../db/auto-workers.ts";
import { claimMilestoneLease, releaseMilestoneLease } from "../db/milestone-leases.ts";
import {
  recordDispatchClaim,
  markRunning,
  markCompleted,
  markFailed,
  markStuck,
  markPaused,
  markCanceled,
  markActiveForWorkerCanceled,
  getRecentForUnit,
  getLatestForUnit,
  getActiveForWorker,
  getDispatchById,
} from "../db/unit-dispatches.ts";

function makeBase(): string {
  const base = mkdtempSync(join(tmpdir(), "gsd-dispatches-"));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  return base;
}

function cleanup(base: string): void {
  try { closeDatabase(); } catch { /* noop */ }
  try { rmSync(base, { recursive: true, force: true }); } catch { /* noop */ }
}

function setup(base: string): { workerId: string; leaseToken: number } {
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Test", status: "active" });
  insertSlice({ id: "S01", milestoneId: "M001", title: "Slice" });
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const lease = claimMilestoneLease(workerId, "M001");
  assert.equal(lease.ok, true);
  if (!lease.ok) throw new Error("expected test lease");
  return { workerId, leaseToken: lease.token };
}

test("recordDispatchClaim creates a claimed row", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "trace-1",
    turnId: "turn-1",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (claim.ok) {
    const row = getLatestForUnit("M001/S01");
    assert.ok(row);
    assert.equal(row!.id, claim.dispatchId);
    assert.equal(row!.status, "claimed");
    assert.equal(row!.worker_id, workerId);
    assert.equal(row!.attempt_n, 1);
  }
});

test("partial unique index rejects double-claim of the same active unit", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const first = recordDispatchClaim({
    traceId: "t-a",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(first.ok, true);

  // Second worker tries to claim the same unit while first is still claimed
  const second = recordDispatchClaim({
    traceId: "t-b",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(second.ok, false);
  if (!second.ok) {
    assert.equal(second.error, "already_active");
    assert.equal(second.existingWorker, workerId);
  }
});

test("recordDispatchClaim cancels stale active dispatch after lease takeover", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId: firstWorkerId, leaseToken: firstLeaseToken } = setup(base);

  const first = recordDispatchClaim({
    traceId: "t-first",
    workerId: firstWorkerId,
    milestoneLeaseToken: firstLeaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  markRunning(first.dispatchId);

  assert.equal(releaseMilestoneLease(firstWorkerId, "M001", firstLeaseToken), true);
  const takeoverWorkerId = registerAutoWorker({ projectRootRealpath: base });
  const takeoverLease = claimMilestoneLease(takeoverWorkerId, "M001");
  assert.equal(takeoverLease.ok, true);
  if (!takeoverLease.ok) return;

  const second = recordDispatchClaim({
    traceId: "t-takeover",
    workerId: takeoverWorkerId,
    milestoneLeaseToken: takeoverLease.token,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
    attemptN: 2,
  });

  assert.equal(second.ok, true);
  if (!second.ok) return;

  const recent = getRecentForUnit("M001/S01", 5);
  assert.equal(recent.length, 2);
  assert.equal(recent[0].id, second.dispatchId);
  assert.equal(recent[0].status, "claimed");
  assert.equal(recent[0].worker_id, takeoverWorkerId);
  assert.equal(recent[0].attempt_n, 2);
  assert.equal(recent[1].id, first.dispatchId);
  assert.equal(recent[1].status, "canceled");
  assert.equal(recent[1].exit_reason, "stale-dispatch-lease-takeover");
});

test("after markCompleted, a fresh claim for the same unit succeeds", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const first = recordDispatchClaim({
    traceId: "t-1",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  markRunning(first.dispatchId);
  assert.equal(markCompleted(first.dispatchId), true);

  // Re-dispatch
  const second = recordDispatchClaim({
    traceId: "t-2",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
    attemptN: 2,
  });
  assert.equal(second.ok, true);
  if (second.ok) {
    const recent = getRecentForUnit("M001/S01", 5);
    assert.equal(recent.length, 2);
    assert.equal(recent[0].status, "claimed");
    assert.equal(recent[0].attempt_n, 2);
    assert.equal(recent[1].status, "completed");
  }
});

test("markFailed records error_summary and retry metadata", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "t-1",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markRunning(claim.dispatchId);
  assert.equal(markFailed(claim.dispatchId, {
    errorSummary: "boom",
    errorCode: "test-fail",
    retryAfterMs: 5000,
  }), true);

  const row = getLatestForUnit("M001/S01")!;
  assert.equal(row.status, "failed");
  assert.equal(row.error_summary, "boom");
  assert.equal(row.exit_reason, null);
  assert.equal(row.last_error_code, "test-fail");
  assert.equal(row.retry_after_ms, 5000);
  assert.ok(row.next_run_at, "next_run_at scheduled");
});

test("markFailed records a timeout exit_reason distinguishable from a clean completion (#2218)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "t-1",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "complete-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;
  markRunning(claim.dispatchId);
  assert.equal(markFailed(claim.dispatchId, {
    errorSummary: "unit-hard-timeout",
    exitReason: "timeout",
  }), true);

  const row = getLatestForUnit("M001/S01")!;
  assert.equal(row.status, "failed");
  assert.equal(row.exit_reason, "timeout");
  assert.equal(row.error_summary, "unit-hard-timeout");
  assert.notEqual(row.status, "completed");
});

test("markStuck and markCanceled set their respective statuses", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const a = recordDispatchClaim({
    traceId: "ta", workerId, milestoneLeaseToken: leaseToken,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  assert.equal(a.ok, true);
  if (!a.ok) return;
  assert.equal(markStuck(a.dispatchId, "test-stuck"), true);
  assert.equal(getLatestForUnit("M001/S01")!.status, "stuck");

  const b = recordDispatchClaim({
    traceId: "tb", workerId, milestoneLeaseToken: leaseToken,
    milestoneId: "M001", unitType: "run-task", unitId: "M001/S01/T01",
  });
  assert.equal(b.ok, true);
  if (!b.ok) return;
  assert.equal(markCanceled(b.dispatchId, "user-cancel"), true);
  assert.equal(getLatestForUnit("M001/S01/T01")!.status, "canceled");
});

test("markActiveForWorkerCanceled cancels every active dispatch for a worker (#1773)", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const first = recordDispatchClaim({
    traceId: "tc-1", workerId, milestoneLeaseToken: leaseToken,
    milestoneId: "M001", unitType: "plan-slice", unitId: "M001/S01",
  });
  assert.equal(first.ok, true);
  if (!first.ok) return;
  _getAdapter()!.prepare(
    "UPDATE unit_dispatches SET status = 'pending' WHERE id = :id",
  ).run({ ":id": first.dispatchId });

  const second = recordDispatchClaim({
    traceId: "tc-2", workerId, milestoneLeaseToken: leaseToken,
    milestoneId: "M001", unitType: "run-task", unitId: "M001/S01/T01",
  });
  assert.equal(second.ok, true);
  if (!second.ok) return;

  const third = recordDispatchClaim({
    traceId: "tc-3", workerId, milestoneLeaseToken: leaseToken,
    milestoneId: "M001", unitType: "validate-milestone", unitId: "M001",
  });
  assert.equal(third.ok, true);
  if (!third.ok) return;
  markRunning(third.dispatchId);

  // Pending, claimed, and running rows are all canceled — sweeping only the
  // latest or only one status leaves older work orphaned forever.
  assert.equal(markActiveForWorkerCanceled(workerId, "signal-exit"), true);
  assert.equal(getLatestForUnit("M001/S01")!.status, "canceled");
  assert.equal(getLatestForUnit("M001/S01/T01")!.status, "canceled");
  const running = getLatestForUnit("M001")!;
  assert.equal(running.status, "canceled");
  assert.equal(running.exit_reason, "signal-exit");
  assert.equal(markActiveForWorkerCanceled(workerId, "signal-exit"), false);
});

test("terminal transitions do not overwrite an already terminal dispatch", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "t-terminal",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S09",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) return;

  markRunning(claim.dispatchId);
  assert.equal(markCompleted(claim.dispatchId, { exitReason: "done" }), true);
  assert.equal(markFailed(claim.dispatchId, { errorSummary: "late-failure" }), false);
  assert.equal(markStuck(claim.dispatchId, "late-stuck"), false);
  assert.equal(markPaused(claim.dispatchId), false);
  assert.equal(markCanceled(claim.dispatchId, "late-cancel"), false);

  const row = getLatestForUnit("M001/S09")!;
  assert.equal(row.status, "completed");
  assert.equal(row.exit_reason, "done");
  assert.equal(row.error_summary, null);
});

test("terminal helpers report missing dispatch ids as no-op writes", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  setup(base);

  const missingDispatchId = 999_999;

  assert.equal(markCompleted(missingDispatchId), false);
  assert.equal(markFailed(missingDispatchId, { errorSummary: "missing-failure" }), false);
  assert.equal(markStuck(missingDispatchId, "missing-stuck"), false);
  assert.equal(markPaused(missingDispatchId), false);
  assert.equal(markCanceled(missingDispatchId, "missing-cancel"), false);
});

test("recordDispatchClaim rejects claims for missing leases before insert", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  setup(base);

  const claim = recordDispatchClaim({
    traceId: "t-stale-lease",
    workerId: "missing-worker",
    milestoneLeaseToken: 1,
    milestoneId: "M001",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });

  assert.deepEqual(claim, {
    ok: false,
    error: "stale_lease",
    milestoneId: "M001",
    workerId: "missing-worker",
    milestoneLeaseToken: 1,
  });
});

test("getActiveForWorker returns the claimed or running row for this worker", (t) => {
  const base = makeBase();
  t.after(() => cleanup(base));
  const { workerId, leaseToken } = setup(base);

  const claim = recordDispatchClaim({
    traceId: "active-for-worker",
    workerId,
    milestoneLeaseToken: leaseToken,
    milestoneId: "M001",
    sliceId: "S01",
    unitType: "plan-slice",
    unitId: "M001/S01",
  });
  assert.equal(claim.ok, true);
  if (!claim.ok) throw new Error("expected claim");

  const active = getActiveForWorker(workerId);
  assert.ok(active);
  assert.equal(active.id, claim.dispatchId);
  assert.equal(active.status, "claimed");
  assert.equal(getDispatchById(claim.dispatchId)?.id, claim.dispatchId);

  markCompleted(claim.dispatchId);
  assert.equal(getActiveForWorker(workerId), null);
});
