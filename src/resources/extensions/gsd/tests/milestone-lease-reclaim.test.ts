// Project/App: gsd-pi
// File Purpose: Dead-holder reclaim of milestone leases at the shared claim
// helper and the orchestrator/worktree-safety reclaim path (#2851).

import test, { type TestContext } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { hostname, tmpdir } from "node:os";
import { join } from "node:path";

import {
  claimMilestoneLeaseReclaimingDeadHolder,
  hasHeldMilestoneLease,
  reclaimMissingMilestoneLease,
  sessionProjectRootForLeaseProbe,
  type MilestoneLeaseSession,
} from "../auto/milestone-lease-reclaim.js";
import { getAutoWorker, registerAutoWorker } from "../db/auto-workers.js";
import {
  claimMilestoneLease,
  getMilestoneLease,
  refreshMilestoneLease,
} from "../db/milestone-leases.js";
import { _getAdapter, closeDatabase, insertMilestone, openDatabase } from "../gsd-db.js";
import { CANONICAL_WORKTREES_DIRNAME } from "../worktree-placement.js";

function makeProject(t: TestContext): string {
  const base = realpathSync(mkdtempSync(join(tmpdir(), "gsd-lease-reclaim-")));
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: "M001", title: "Milestone", status: "active" });
  t.after(() => {
    closeDatabase();
    rmSync(base, { recursive: true, force: true });
  });
  return base;
}

// Seeds a holder worker row in this project whose PID is the canonical
// dead-PID fixture value, so isDeadLocalAutoWorker treats it as dead.
function seedHolder(
  base: string,
  overrides: { pid?: number; host?: string } = {},
): string {
  const holder = registerAutoWorker({ projectRootRealpath: base });
  _getAdapter()!.prepare("UPDATE workers SET pid = :pid, host = :host WHERE worker_id = :worker_id")
    .run({ ":pid": overrides.pid ?? -1, ":host": overrides.host ?? hostname(), ":worker_id": holder });
  return holder;
}

function makeSession(base: string): MilestoneLeaseSession {
  return {
    workerId: registerAutoWorker({ projectRootRealpath: base }),
    currentMilestoneId: null,
    milestoneLeaseToken: null,
    basePath: base,
    originalBasePath: base,
  };
}

test("claimMilestoneLeaseReclaimingDeadHolder reclaims a dead local holder's lease", (t) => {
  const base = makeProject(t);
  const holder = seedHolder(base);
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);
  assert.equal(held.ok && held.token, 1);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, true, `expected the reclaim to free the lease: ${JSON.stringify(claim)}`);
  assert.equal(reclaimedFrom, holder);
  assert.equal(claim.ok && claim.token, 2, "takeover must advance the fencing token");
  assert.equal(getAutoWorker(holder)?.status, "crashed", "dead holder must be marked crashed");
  const lease = getMilestoneLease("M001");
  assert.ok(lease);
  assert.equal(lease!.worker_id, workerId);
  assert.equal(lease!.status, "held");
  assert.equal(refreshMilestoneLease(holder, "M001", 1), false, "the dead holder's old token must be dead");
});

test("the reclaim is scoped to the claimed milestone and never sweeps the holder's other leases", (t) => {
  const base = makeProject(t);
  insertMilestone({ id: "M002", title: "Other", status: "active" });
  const holder = seedHolder(base);
  assert.equal(claimMilestoneLease(holder, "M001").ok, true);
  assert.equal(claimMilestoneLease(holder, "M002").ok, true);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, true);
  assert.equal(reclaimedFrom, holder);
  const m002 = getMilestoneLease("M002");
  assert.ok(m002);
  assert.equal(m002!.worker_id, holder, "the holder's other milestone lease must be untouched");
  assert.equal(m002!.status, "held");
});

test("the reclaim probes the milestone worktree identity a dispatch holder registers under", (t) => {
  const base = makeProject(t);
  // `/gsd dispatch` registers its kernel worker under the milestone worktree
  // (resolveCanonicalMilestoneRoot), not the repository root.
  const worktree = join(base, CANONICAL_WORKTREES_DIRNAME, "M001");
  mkdirSync(worktree, { recursive: true });
  writeFileSync(join(worktree, ".git"), `gitdir: ${join(base, ".git", "worktrees", "M001")}\n`);
  const holder = registerAutoWorker({ projectRootRealpath: worktree });
  _getAdapter()!.prepare("UPDATE workers SET pid = :pid WHERE worker_id = :worker_id")
    .run({ ":pid": -1, ":worker_id": holder });
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);

  // Probing from the repository root must still find the worktree-registered
  // holder — that boundary is exactly the interactive↔auto wedge (#2851).
  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, true, `expected the worktree-registered holder to be reclaimed: ${JSON.stringify(claim)}`);
  assert.equal(reclaimedFrom, holder);
  assert.equal(getAutoWorker(holder)?.status, "crashed");
});

test("claimMilestoneLeaseReclaimingDeadHolder keeps the conflict for a holder from another project", (t) => {
  const base = makeProject(t);
  // A dead worker of a DIFFERENT project that happens to share this database
  // must never be reclaimed from this project's claim.
  const foreign = seedHolder(join(base, "..", "other-project"));
  const held = claimMilestoneLease(foreign, "M001");
  assert.equal(held.ok, true);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, false, "a foreign project's dead holder must never be stolen from");
  assert.equal(reclaimedFrom, null);
  assert.equal(getAutoWorker(foreign)?.status, "active");
  assert.equal(getMilestoneLease("M001")?.worker_id, foreign);
});

test("a successful reclaim journals exactly the lease it released", (t) => {
  const base = makeProject(t);
  insertMilestone({ id: "M002", title: "Other", status: "active" });
  const holder = seedHolder(base);
  assert.equal(claimMilestoneLease(holder, "M001").ok, true);
  assert.equal(claimMilestoneLease(holder, "M002").ok, true);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, true);
  assert.equal(reclaimedFrom, holder);
  const journalled = _getAdapter()!.prepare(
    `SELECT payload_json FROM audit_events WHERE type = 'milestone-lease-reclaimed'`,
  ).all() as Array<{ payload_json: string }>;
  assert.equal(journalled.length, 1, "exactly one reclaim event for exactly one released lease");
  const payload = JSON.parse(journalled[0]!.payload_json) as {
    workerId: string; milestoneId: string; fencingToken: number; reclaimedBy: string;
  };
  assert.equal(payload.workerId, holder);
  assert.equal(payload.milestoneId, "M001", "the event names the milestone this call released");
  assert.equal(payload.fencingToken, 1, "the event names the epoch this call released");
  assert.equal(payload.reclaimedBy, workerId);
});

test("claimMilestoneLeaseReclaimingDeadHolder keeps the conflict for a live holder", (t) => {
  const base = makeProject(t);
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  assert.ok(live.pid !== undefined && live.pid > 0);
  t.after(() => live.kill());
  const holder = seedHolder(base, { pid: live.pid! });
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, false, "a live holder's lease must never be stolen");
  if (!claim.ok) {
    assert.equal(claim.error, "held_by");
    assert.equal(claim.byWorker, holder);
  }
  assert.equal(reclaimedFrom, null);
  assert.equal(getAutoWorker(holder)?.status, "active", "live holder must not be marked crashed");
  assert.equal(getMilestoneLease("M001")?.worker_id, holder);
});

test("claimMilestoneLeaseReclaimingDeadHolder keeps the conflict for a remote holder", (t) => {
  const base = makeProject(t);
  const holder = seedHolder(base, { host: "remote-host" });
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);

  const workerId = registerAutoWorker({ projectRootRealpath: base });
  const { claim, reclaimedFrom } = claimMilestoneLeaseReclaimingDeadHolder(workerId, "M001", base);

  assert.equal(claim.ok, false, "an unprobeable remote holder must never be stolen from");
  assert.equal(reclaimedFrom, null);
  assert.equal(getAutoWorker(holder)?.status, "active");
  assert.equal(getMilestoneLease("M001")?.worker_id, holder);
});

test("reclaimMissingMilestoneLease adopts the lease of a dead holder", (t) => {
  const base = makeProject(t);
  const holder = seedHolder(base);
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);

  const session = makeSession(base);
  assert.equal(sessionProjectRootForLeaseProbe(session), base);
  reclaimMissingMilestoneLease(session, "M001", "worktree", "test");

  assert.equal(hasHeldMilestoneLease(session, "M001"), true, "the session must adopt the reclaimed lease");
  assert.equal(session.milestoneLeaseToken, 2);
  assert.equal(getAutoWorker(holder)?.status, "crashed");
  assert.equal(getMilestoneLease("M001")?.worker_id, session.workerId);
});

test("reclaimMissingMilestoneLease does not steal a live holder's lease", (t) => {
  const base = makeProject(t);
  const live = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  assert.ok(live.pid !== undefined && live.pid > 0);
  t.after(() => live.kill());
  const holder = seedHolder(base, { pid: live.pid! });
  const held = claimMilestoneLease(holder, "M001");
  assert.equal(held.ok, true);

  const session = makeSession(base);
  reclaimMissingMilestoneLease(session, "M001", "worktree", "test");

  assert.equal(hasHeldMilestoneLease(session, "M001"), false);
  assert.equal(session.milestoneLeaseToken, null);
  assert.equal(getAutoWorker(holder)?.status, "active");
  assert.equal(getMilestoneLease("M001")?.worker_id, holder);
});
