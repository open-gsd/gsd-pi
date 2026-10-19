// Regression: a plan-milestone verify-fail on a milestone with no rendered
// projection must retry with the database-row failure, not complete silently
// (#2827).
//
// ADR-046: the database rows are the unit's result; ROADMAP/CONTEXT/RESEARCH
// are projections rendered by the save tool. When the model completes the
// planning turn without calling gsd_plan_milestone, no slice rows exist and
// no phase directory was ever rendered, so resolveExpectedArtifactPath
// resolves null. The post-unit verification-failure ladder used to require a
// resolvable path before running, which dropped the verify-fail: the unit
// settled "completed" with no rows, and the second identical dispatch tripped
// the ADR-047 completed-no-advance liveness wedge (trip-at-2) instead of
// pausing with the failure.

import test, { afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync } from "node:fs";
import { join } from "node:path";

import { postUnitPreVerification } from "../auto-post-unit.ts";
import { AutoSession } from "../auto/session.ts";
import {
  decideVerificationRetry,
  hashVerificationFailureContext,
} from "../auto/verification-retry-policy.ts";
import { invalidateAllCaches } from "../cache.ts";
import {
  closeDatabase,
  insertMilestone,
  insertSlice,
  openDatabase,
} from "../gsd-db.ts";
import { cleanup, makeTempRepo } from "./test-utils.ts";

function makePostUnitContext(base: string, s: AutoSession, notifications: string[]) {
  return {
    s,
    ctx: { ui: { notify: (message: string) => notifications.push(message) } } as any,
    pi: {} as any,
    buildSnapshotOpts: () => ({}) as any,
    lockBase: () => base,
    stopAuto: async () => {},
    pauseAuto: async () => {},
    updateProgressWidget: () => {},
  };
}

/** An active milestone row and nothing else: no slices, no rendered phase dir. */
function seedUnplannedMilestone(base: string, mid = "M002"): void {
  mkdirSync(join(base, ".gsd"), { recursive: true });
  openDatabase(join(base, ".gsd", "gsd.db"));
  insertMilestone({ id: mid, title: "Second milestone", status: "active" });
  invalidateAllCaches();
}

function planningSession(base: string, unitType: string, unitId: string): AutoSession {
  const s = new AutoSession();
  s.active = true;
  s.basePath = base;
  s.currentUnit = { type: unitType, id: unitId, startedAt: Date.now() };
  return s;
}

let base: string;

afterEach(() => {
  closeDatabase();
  invalidateAllCaches();
  cleanup(base);
});

const opts = { skipSettleDelay: true, skipWorktreeSync: true };

test("#2827 plan-milestone with zero slice rows and no rendered phase dir retries instead of completing", async () => {
  base = makeTempRepo("gsd-plan-milestone-wedge-");
  seedUnplannedMilestone(base);
  const s = planningSession(base, "plan-milestone", "M002");

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "retry");
  assert.equal(s.pendingVerificationRetry?.unitId, "M002");
  assert.ok(
    notifications.some((message) => message.includes("no slice rows in the database")),
    `expected the slice-row failure in the retry context, got: ${notifications.join("\n")}`,
  );
});

test("#2827 the retry context is stable, so an identical second failure pauses via the duplicate policy", async () => {
  base = makeTempRepo("gsd-plan-milestone-wedge-dup-");
  seedUnplannedMilestone(base);
  const s = planningSession(base, "plan-milestone", "M002");
  const pctx = makePostUnitContext(base, s, []);

  assert.equal(await postUnitPreVerification(pctx, opts), "retry");
  const firstRetry = s.pendingVerificationRetry;
  assert.ok(firstRetry);
  assert.equal(firstRetry.attempt, 1);
  const firstFailureHash = hashVerificationFailureContext(firstRetry.failureContext);

  assert.equal(await postUnitPreVerification(pctx, opts), "retry");
  const secondRetry = s.pendingVerificationRetry;
  assert.ok(secondRetry);
  assert.equal(secondRetry.attempt, 2);
  assert.equal(secondRetry.failureContext, firstRetry.failureContext);
  assert.deepEqual(
    decideVerificationRetry({
      unitType: "plan-milestone",
      retryInfo: secondRetry,
      previousFailureHash: firstFailureHash,
      random: () => 0.5,
    }),
    {
      action: "pause",
      reason: "duplicate-failure-context",
      key: "plan-milestone:M002",
      failureHash: firstFailureHash,
    },
  );
});

test("#2827 discuss-milestone with no saved CONTEXT hits the same ladder", async () => {
  base = makeTempRepo("gsd-discuss-milestone-wedge-");
  seedUnplannedMilestone(base);
  const s = planningSession(base, "discuss-milestone", "M002");

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "retry");
  assert.equal(s.pendingVerificationRetry?.unitId, "M002");
  assert.ok(
    s.pendingVerificationRetry?.failureContext.includes("no saved milestone CONTEXT in the database"),
    `expected the CONTEXT-row failure in the retry context, got: ${s.pendingVerificationRetry?.failureContext}`,
  );
});

test("#2827 research-milestone with no saved RESEARCH hits the same ladder", async () => {
  base = makeTempRepo("gsd-research-milestone-wedge-");
  seedUnplannedMilestone(base);
  const s = planningSession(base, "research-milestone", "M002");

  const result = await postUnitPreVerification(makePostUnitContext(base, s, []), opts);

  assert.equal(result, "retry");
  assert.ok(
    s.pendingVerificationRetry?.failureContext.includes("no saved milestone RESEARCH in the database"),
    `expected the RESEARCH-row failure in the retry context, got: ${s.pendingVerificationRetry?.failureContext}`,
  );
});

test("#2827 a retried plan-milestone resolves once its slices are persisted, with the retry state cleared", async () => {
  base = makeTempRepo("gsd-plan-milestone-wedge-resolve-");
  seedUnplannedMilestone(base);
  const s = planningSession(base, "plan-milestone", "M002");
  const pctx = makePostUnitContext(base, s, []);

  assert.equal(await postUnitPreVerification(pctx, opts), "retry");
  assert.ok(s.pendingVerificationRetry);

  // The model re-runs and gsd_plan_milestone persists the slices this time.
  insertSlice({ id: "S01", milestoneId: "M002", title: "Slice", status: "pending" });
  invalidateAllCaches();

  assert.equal(await postUnitPreVerification(pctx, opts), "continue");
  assert.equal(s.pendingVerificationRetry, null);
});

test("#2827 a plan-milestone whose slices were persisted still continues", async () => {
  base = makeTempRepo("gsd-plan-milestone-planned-");
  seedUnplannedMilestone(base);
  insertSlice({ id: "S01", milestoneId: "M002", title: "Slice", status: "pending" });
  invalidateAllCaches();
  const s = planningSession(base, "plan-milestone", "M002");

  const notifications: string[] = [];
  const result = await postUnitPreVerification(makePostUnitContext(base, s, notifications), opts);

  assert.equal(result, "continue");
  assert.equal(s.pendingVerificationRetry, null);
});
